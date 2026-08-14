/**
 * dsh-remote — Host-side Remote service.
 *
 * Exposes every plugin capability over the web server's route registry
 * (`/dsh-remote/<method>` JSON POST). The gateway's @Remote/srcClaims path
 * is unreliable across dsh builds, so this plugin owns its transport:
 * each route enforces a fence equivalent to the /api browser-trust rule
 * (request Host must be loopback or one of this machine's IPv4 addresses),
 * which auto-trusts LAN and Tailscale clients exactly like the shipped API.
 */
import os from 'node:os'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type { Context } from '@deepseek-ai/cordis'
import type { ActionResult, CmdResult, StatusPayload, TailscaleProbe } from './core.js'
import {
  buildPatchEntries,
  buildUrls,
  extractFirstIp,
  findTailscalePrefix,
  hasHostBinding,
  isLoggedInOutput,
  parseTailscaleJson,
  tailscaleCommand,
  upsertPatchEntries,
} from './core.js'

/** Shell calls run unconfined: this plugin owns machine-wide network config. */
const FREEDOM = { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() }

/** Browser-trust fence for our own routes: loopback or any local IPv4. */
function hostAllowed(hostHeader: string | undefined): boolean {
  if (!hostHeader) return false
  const hostname = hostHeader.split(':')[0].toLowerCase()
  if (hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1' || hostname === '[::1]') return true
  const interfaces = os.networkInterfaces()
  for (const addrs of Object.values(interfaces)) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && addr.address === hostname) return true
    }
  }
  return false
}

/** Collect a bounded JSON request body. */
function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    let size = 0
    req.on('data', (chunk: Buffer) => {
      size += chunk.length
      if (size > 1_000_000) {
        reject(new Error('body too large'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try {
        resolve(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch (error) {
        reject(error)
      }
    })
    req.on('error', reject)
  })
}

interface WebServerLike {
  register(route: {
    kind: 'exact'
    path: string
    handler: (req: IncomingMessage, res: ServerResponse) => void | Promise<void>
  }): unknown
}

interface ShellLike {
  resolve(request: {
    command: string
    timeoutMs?: number
    stdoutMaxBytes?: number
    sandboxPolicy?: { mode: string; workspaceRoot: string }
  }): unknown
  run(spec: unknown): Promise<{
    exitCode: number | null
    stdout?: { text?: string }
    stderr?: { text?: string }
  }>
}

interface FsLike {
  resolve(path: string): Promise<unknown>
  readText(target: unknown): Promise<string>
  writeText(target: unknown, content: string): Promise<unknown>
}

class DshRemoteService extends TypertRemoteService {  private readonly shell: ShellLike
  private tsPrefix: string | null = null
  private tsProbeDone = false

  /** Routes need the web server; wait for it before constructing. */
  static inject = ['webServer']

  constructor(ctx: Context, private readonly fs: FsLike | undefined) {
    super(ctx, 'dshRemote')
    console.log('[dsh-remote] DshRemoteService constructed')
    this.shell = ctx.get('shell') as ShellLike
    const webServer = ctx.get('webServer') as WebServerLike | undefined
    if (webServer !== undefined) this.registerRoutes(webServer)
  }

  // ── HTTP routes: /dsh-remote/<method> with the browser-trust fence ────
  registerRoutes(webServer: WebServerLike): void {
    const methods: Array<{ path: string; handle: (args: unknown) => Promise<unknown> }> = [
      { path: '/dsh-remote/status', handle: () => this.status() },
      { path: '/dsh-remote/ensureConfig', handle: () => this.ensureConfig() },
      { path: '/dsh-remote/installTailscale', handle: () => this.installTailscale() },
      { path: '/dsh-remote/loginAuthkey', handle: (args) => this.loginAuthkey(args as { authkey?: string }) },
      { path: '/dsh-remote/loginGui', handle: () => this.loginGui() },
    ]
    for (const m of methods) {
      webServer.register({
        kind: 'exact',
        path: m.path,
        handler: async (req, res) => {
          if (!hostAllowed(req.headers.host)) {
            res.writeHead(403, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'forbidden' }))
            return
          }
          if (req.method !== 'POST') {
            res.writeHead(405, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: 'method not allowed' }))
            return
          }
          let args: unknown
          try {
            args = await readJsonBody(req)
          } catch (error) {
            res.writeHead(400, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(error) }))
            return
          }
          try {
            const value = await m.handle(args)
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end(JSON.stringify(value))
          } catch (error) {
            res.writeHead(500, { 'content-type': 'application/json' })
            res.end(JSON.stringify({ error: String(error) }))
          }
        },
      })
    }
    console.log('[dsh-remote] routes registered')
  }

  // ── shell helpers ─────────────────────────────────────────────────────
  private async run(command: string, timeoutMs = 20000): Promise<CmdResult> {
    try {
      const spec = this.shell.resolve({
        command,
        timeoutMs,
        stdoutMaxBytes: 400_000,
        sandboxPolicy: FREEDOM,
      })
      const result = await this.shell.run(spec)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout?.text ?? '',
        stderr: result.stderr?.text ?? '',
      }
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: String(error) }
    }
  }

  private async winHome(): Promise<string | null> {
    for (const cmd of [
      `[Environment]::GetFolderPath('UserProfile')`,
      `$env:USERPROFILE`,
    ]) {
      const r = await this.run(cmd, 10_000)
      const home = r.stdout.trim()
      if (r.exitCode === 0 && home.length > 2 && !home.includes('$')) {
        return home.replaceAll('\\', '/')
      }
    }
    return null
  }

  private tailscaleCmd(sub: string): string {
    return this.tsPrefix === null || this.tsPrefix === ''
      ? `tailscale ${sub}`
      : `& '${this.tsPrefix}' ${sub}`
  }

  private async findTailscale(): Promise<boolean> {
    if (this.tsProbeDone) return this.tsPrefix !== null
    this.tsProbeDone = true
    const candidates = [
      { prefix: '', check: 'tailscale version 2>&1' },
      { prefix: 'D:/Tailscale/tailscale.exe', check: "& 'D:/Tailscale/tailscale.exe' version 2>&1" },
      { prefix: '/c/Tailscale/tailscale.exe', check: "& '/c/Tailscale/tailscale.exe' version 2>&1" },
      { prefix: 'C:/Program Files/Tailscale/tailscale.exe', check: "& 'C:/Program Files/Tailscale/tailscale.exe' version 2>&1" },
      { prefix: 'C:/Program Files (x86)/Tailscale/tailscale.exe', check: "& 'C:/Program Files (x86)/Tailscale/tailscale.exe' version 2>&1" },
    ]
    for (const c of candidates) {
      const r = await this.run(c.check, 8000)
      if (r.exitCode === 0 && /tailscale/i.test(`${r.stdout}${r.stderr}`)) {
        this.tsPrefix = c.prefix
        return true
      }
    }
    this.tsPrefix = null
    return false
  }

  private async tsExePath(): Promise<string | null> {
    if (this.tsPrefix) return this.tsPrefix
    const r = await this.run(
      `(Get-Command tailscale -ErrorAction SilentlyContinue).Source`,
      8000,
    )
    return r.stdout.trim() || null
  }

  private async probeTailscale(): Promise<TailscaleProbe> {
    if (!(await this.findTailscale())) {
      return { installed: false, loggedIn: false, ip: null, dnsName: null }
    }
    const status = await this.run(this.tailscaleCmd('status 2>&1'), 8000)
    const loggedIn = isLoggedInOutput(status.stdout, status.exitCode)
    if (!loggedIn) return { installed: true, loggedIn: false, ip: null, dnsName: null }
    const ipRun = await this.run(this.tailscaleCmd('ip -4 2>&1'), 8000)
    const ip = extractFirstIp(ipRun.stdout)
    const jsonRun = await this.run(this.tailscaleCmd('status --json 2>&1'), 8000)
    const parsed = parseTailscaleJson(jsonRun.stdout)
    return { installed: true, loggedIn: true, ip: ip ?? parsed.ip, dnsName: parsed.dnsName }
  }

  private async lanIps(): Promise<string[]> {
    const cmd =
      `(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^127\\.' ` +
      `-and $_.IPAddress -notmatch '^169\\.254' -and $_.PrefixOrigin -ne 'WellKnown' } ` +
      `| Select-Object -ExpandProperty IPAddress) -join ','`
    const r = await this.run(cmd, 15_000)
    if (r.exitCode !== 0) return []
    const text = r.stdout.trim()
    if (text.includes(',')) return text.split(',').map((s) => s.trim()).filter(Boolean)
    return text ? [text] : []
  }

  private patchPath(): Promise<string | null> {
    return this.winHome().then((home) => (home ? `${home}/.dsh/profiles/web/cordis.patch.yml` : null))
  }

  private async readPatch(path: string): Promise<string> {
    if (this.fs === undefined) return ''
    try {
      const target = await this.fs.resolve(path)
      return await this.fs.readText(target)
    } catch {
      return ''
    }
  }

  // ── Remote: status ────────────────────────────────────────────────────
  @Remote('status')
  async status(): Promise<StatusPayload> {
    const home = await this.winHome()
    const path = home ? `${home}/.dsh/profiles/web/cordis.patch.yml` : null
    const [ts, ips, patch] = await Promise.all([
      this.probeTailscale(),
      this.lanIps(),
      path ? this.readPatch(path) : Promise.resolve(''),
    ])
    const ws = this.ctx.get('webServer') as { host?: string; port?: number } | undefined
    const host = ws?.host ?? null
    const port = ws?.port ?? null
    const patched = hasHostBinding(patch)
    return {
      tailscale: ts,
      web: { host, port, lanIps: ips },
      config: {
        patched,
        trusted: ts.ip !== null && patch.includes(ts.ip),
        effective: host === '0.0.0.0',
        needsRestart: patched && host !== '0.0.0.0',
        path,
      },
      home,
    }
  }

  /** Human-readable one-line status (used by the /remote command). */
  async describeStatus(): Promise<string> {
    const s = await this.status()
    const { tailscale: ts, config: cfg } = s
    const port = s.web.port ?? 3080
    const urls = buildUrls(s.web.lanIps, ts.ip, ts.dnsName, port)
    const lines = [
      '🔌 dsh-remote 远程访问状态',
      `- Tailscale 已安装: ${ts.installed ? '✅' : '❌'}`,
      `- Tailscale 已登录: ${ts.loggedIn ? '✅' : '❌'}`,
      `- 配置已写入: ${cfg.patched ? '✅' : '❌'}`,
      `- 已生效 (0.0.0.0): ${cfg.effective ? '✅' : '❌'}`,
    ]
    if (urls.length > 0) {
      lines.push('访问地址:')
      for (const u of urls) lines.push(`  - ${u.kind}: ${u.url}`)
    }
    if (cfg.needsRestart) lines.push('⚠️ 配置已写入但尚未生效：请重启 dsh web')
    if (!cfg.patched) lines.push('提示: 运行 /remote-fix 写入配置')
    return lines.join('\n')
  }

  // ── Remote: ensure-config (idempotent) ────────────────────────────────
  @Remote('ensureConfig')
  async ensureConfig(): Promise<ActionResult> {
    try {
      if (this.fs === undefined) return { ok: false, message: 'fs service unavailable' }
      const home = await this.winHome()
      if (!home) return { ok: false, message: 'cannot resolve home directory' }
      const path = `${home}/.dsh/profiles/web/cordis.patch.yml`
      const ts = await this.probeTailscale()
      const authority = ts.loggedIn ? (ts.dnsName ?? ts.ip) : null
      const entries = buildPatchEntries(authority, (this.ctx.get('webServer') as { port?: number } | undefined)?.port ?? 3080)
      const merged = upsertPatchEntries(await this.readPatch(path), entries)
      const target = await this.fs.resolve(path)
      await this.fs.writeText(target, merged)
      return {
        ok: true,
        needsRestart: true,
        message:
          authority !== null
            ? `配置已写入，Tailscale 地址 ${authority} 已加入信任名单。重启 dsh web 后生效。`
            : '配置已写入（LAN 模式）。Tailscale 登录后再次点击一键配置可加入信任名单。重启 dsh web 后生效。',
      }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }

  // ── Remote: install-tailscale (MSI silent, one UAC) ───────────────────
  @Remote('installTailscale')
  async installTailscale(): Promise<ActionResult> {
    try {
      if (await this.findTailscale()) {
        return { ok: true, message: 'Tailscale 已安装，无需重复安装' }
      }
      const home = await this.winHome()
      if (!home) return { ok: false, message: 'cannot resolve home directory' }
      const msi = `${home}/tailscale-setup-latest-amd64.msi`
      const dl = await this.run(
        `curl.exe -L --fail --silent --show-error -o '${msi}' 'https://pkgs.tailscale.com/stable/tailscale-setup-latest-amd64.msi'`,
        240_000,
      )
      if (dl.exitCode !== 0) return { ok: false, message: `下载失败: ${dl.stderr || dl.stdout}` }
      const launch = await this.run(
        `Start-Process msiexec -ArgumentList '/i','${msi}','/quiet','/norestart' -Verb RunAs`,
        15_000,
      )
      return {
        ok: true,
        message:
          launch.exitCode === 0
            ? '安装已开始：请在弹窗中点击「是」允许安装，完成后会自动检测。'
            : `安装器启动失败: ${launch.stderr || launch.stdout}`,
      }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }

  // ── Remote: login with auth key ───────────────────────────────────────
  @Remote('loginAuthkey')
  async loginAuthkey(args: { authkey?: string }): Promise<ActionResult> {
    try {
      const key = String(args?.authkey ?? '').trim()
      if (!/^tskey-/.test(key)) {
        return { ok: false, message: '无效的登录密钥：应以 tskey- 开头（在管理后台生成）' }
      }
      const exe = await this.tsExePath()
      if (!exe) return { ok: false, message: '找不到 tailscale，请先安装' }
      const launch = await this.run(
        `Start-Process -FilePath '${exe}' -ArgumentList 'up','--authkey=${key}' -Verb RunAs`,
        15_000,
      )
      return {
        ok: true,
        message:
          launch.exitCode === 0
            ? '登录已启动：请在弹窗中点击「是」确认，稍候会自动完成登录。'
            : `登录启动失败: ${launch.stderr || launch.stdout}`,
      }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }

  // ── Remote: open official GUI login ───────────────────────────────────
  @Remote('loginGui')
  async loginGui(): Promise<ActionResult> {
    try {
      const exe = await this.tsExePath()
      if (!exe) return { ok: false, message: '找不到 tailscale，请先安装' }
      const ipn = `${exe.replace(/tailscale\.exe$/i, '')}tailscale-ipn.exe`
      const launch = await this.run(`Start-Process -FilePath '${ipn}'`, 10_000)
      return {
        ok: true,
        message:
          launch.exitCode === 0
            ? '已打开 Tailscale 登录界面：在打开的窗口/浏览器中完成授权即可。'
            : `打开失败: ${launch.stderr || launch.stdout}`,
      }
    } catch (error) {
      return { ok: false, message: String(error) }
    }
  }
}

// Loader-entry form: module.exports IS the plugin class (same shape the
// shipped @Remote services use), so the Cordis loader instantiates it.
export = DshRemoteService
