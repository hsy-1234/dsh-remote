/**
 * dsh-remote — remote access manager for the DeepSeek Harness Web UI.
 *
 * A host-side Cordis plugin that:
 *   - probes Tailscale (install / login / IP / MagicDNS name),
 *   - reports the Web UI bind state and the profile patch state,
 *   - offers `/remote` (status) and `/remote-fix` (write the patch) commands.
 *
 * The pure logic lives in `./core.ts` and is unit-tested in `test/`.
 *
 * Platform note: on Windows the `ctx.shell` executor is the pwsh sandbox.
 * The default sandbox policy can be `workspace-write`, whose windows-acl
 * backend refuses to start when its temp root lies inside the workspace
 * root — so this plugin requests `danger-full-access` for its own calls
 * (it manages machine-wide network configuration by design).
 */
import process from 'node:process'
import type { Context } from '@deepseek-ai/cordis'
import type { CmdResult, TailscaleProbe } from './core.js'
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

export const name = 'dsh-remote'

/** Shell calls run unconfined: this plugin owns machine-wide network config. */
const FREEDOM = { mode: 'danger-full-access' as const, workspaceRoot: process.cwd() }

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

export function apply(ctx: Context): void {
  const shell = ctx.get('shell') as ShellLike | undefined
  if (shell === undefined) {
    console.warn('[dsh-remote] shell service unavailable; plugin disabled')
    return
  }

  const run = async (command: string, timeoutMs = 20000): Promise<CmdResult> => {
    try {
      const spec = shell.resolve({
        command,
        timeoutMs,
        stdoutMaxBytes: 400_000,
        sandboxPolicy: FREEDOM,
      })
      const result = await shell.run(spec)
      return {
        exitCode: result.exitCode,
        stdout: result.stdout?.text ?? '',
        stderr: result.stderr?.text ?? '',
      }
    } catch (error) {
      return { exitCode: null, stdout: '', stderr: String(error) }
    }
  }

  // ── probes ────────────────────────────────────────────────────────────
  const winHome = async (): Promise<string | null> => {
    for (const cmd of [
      `[Environment]::GetFolderPath('UserProfile')`,
      `$env:USERPROFILE`,
    ]) {
      const r = await run(cmd, 10_000)
      const home = r.stdout.trim()
      if (r.exitCode === 0 && home.length > 2 && !home.includes('$')) {
        return home.replaceAll('\\', '/')
      }
    }
    return null
  }

  const lanIps = async (): Promise<string[]> => {
    const cmd =
      `(Get-NetIPAddress -AddressFamily IPv4 | Where-Object { $_.IPAddress -notmatch '^127\\.' ` +
      `-and $_.IPAddress -notmatch '^169\\.254' -and $_.PrefixOrigin -ne 'WellKnown' } ` +
      `| Select-Object -ExpandProperty IPAddress) -join ','`
    const r = await run(cmd, 15_000)
    if (r.exitCode !== 0) return []
    const text = r.stdout.trim()
    if (text.includes(',')) return text.split(',').map((s) => s.trim()).filter(Boolean)
    return text ? [text] : []
  }

  let tsPrefix: string | null = null
  const probeTailscale = async (): Promise<TailscaleProbe> => {
    if (tsPrefix === null) {
      tsPrefix = await findTailscalePrefix(run)
      if (tsPrefix === null) {
        return { installed: false, loggedIn: false, ip: null, dnsName: null }
      }
    }
    const status = await run(tailscaleCommand(tsPrefix, 'status 2>&1'), 8000)
    const loggedIn = isLoggedInOutput(status.stdout, status.exitCode)
    if (!loggedIn) return { installed: true, loggedIn: false, ip: null, dnsName: null }
    const ipRun = await run(tailscaleCommand(tsPrefix, 'ip -4 2>&1'), 8000)
    const ip = extractFirstIp(ipRun.stdout)
    const jsonRun = await run(tailscaleCommand(tsPrefix, 'status --json 2>&1'), 8000)
    const parsed = parseTailscaleJson(jsonRun.stdout)
    return {
      installed: true,
      loggedIn: true,
      ip: ip ?? parsed.ip,
      dnsName: parsed.dnsName,
    }
  }

  const patchPath = async (): Promise<string | null> => {
    const home = await winHome()
    return home ? `${home}/.dsh/profiles/web/cordis.patch.yml` : null
  }

  const readPatch = async (path: string): Promise<string> => {
    const fs = ctx.get('fs') as
      | { resolve(p: string): Promise<unknown>; readText(t: unknown): Promise<string> }
      | undefined
    if (fs === undefined) return ''
    try {
      const target = await fs.resolve(path)
      return await fs.readText(target)
    } catch {
      return ''
    }
  }

  const writePatch = async (path: string, content: string): Promise<void> => {
    const fs = ctx.get('fs') as
      | { resolve(p: string): Promise<unknown>; writeText(t: unknown, c: string): Promise<unknown> }
      | undefined
    if (fs === undefined) throw new Error('fs service unavailable')
    const target = await fs.resolve(path)
    await fs.writeText(target, content)
  }

  const webInfo = (): { host: string | null; port: number | null } => {
    const ws = ctx.get('webServer') as { host?: string; port?: number } | undefined
    return { host: ws?.host ?? null, port: ws?.port ?? null }
  }

  interface Status {
    tailscale: TailscaleProbe
    lanIps: string[]
    config: {
      patched: boolean
      trusted: boolean
      effective: boolean
      needsRestart: boolean
      path: string | null
    }
    web: { host: string | null; port: number | null }
  }

  const collectStatus = async (): Promise<Status> => {
    const path = await patchPath()
    const [ts, ips, patch] = await Promise.all([
      probeTailscale(),
      lanIps(),
      path ? readPatch(path) : Promise.resolve(''),
    ])
    const web = webInfo()
    const patched = hasHostBinding(patch)
    return {
      tailscale: ts,
      lanIps: ips,
      web,
      config: {
        patched,
        trusted: ts.ip !== null && patch.includes(ts.ip),
        effective: web.host === '0.0.0.0',
        needsRestart: patched && web.host !== '0.0.0.0',
        path,
      },
    }
  }

  const renderStatus = (s: Status): string => {
    const { tailscale: ts, config: cfg, lanIps } = s
    const port = s.web.port ?? 3080
    const urls = buildUrls(lanIps, ts.ip, ts.dnsName, port)
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
    if (cfg.needsRestart) {
      lines.push('⚠️ 配置已写入但尚未生效：请重启 dsh web')
    }
    if (!cfg.patched) {
      lines.push('提示: 运行 /remote-fix 写入配置')
    }
    return lines.join('\n')
  }

  // ── commands ──────────────────────────────────────────────────────────
  const commands = ctx.get('commands') as
    | { register(def: { name: string; description: string; handler(inv: unknown): unknown }): () => void }
    | undefined

  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: '显示远程访问状态（Tailscale / 局域网 / 配置）',
      handler: async () => {
        try {
          return { kind: 'success' as const, text: renderStatus(await collectStatus()) }
        } catch (error) {
          return { kind: 'error' as const, text: `状态获取失败: ${String(error)}` }
        }
      },
    })

    commands.register({
      name: 'remote-fix',
      description: '写入远程访问配置（host 0.0.0.0 + Tailscale 信任名单）',
      handler: async () => {
        try {
          const path = await patchPath()
          if (!path) return { kind: 'error' as const, text: '无法解析 home 目录' }
          const ts = await probeTailscale()
          const authority = ts.loggedIn ? (ts.dnsName ?? ts.ip) : null
          const entries = buildPatchEntries(authority, webInfo().port ?? 3080)
          const merged = upsertPatchEntries(await readPatch(path), entries)
          await writePatch(path, merged)
          return {
            kind: 'success' as const,
            text:
              authority !== null
                ? `配置已写入，Tailscale 地址 ${authority} 已加入信任名单。重启 dsh web 后生效。`
                : '配置已写入（LAN 模式）。Tailscale 登录后再次运行 /remote-fix 加入信任名单。重启 dsh web 后生效。',
          }
        } catch (error) {
          return { kind: 'error' as const, text: `写入失败: ${String(error)}` }
        }
      },
    })
  }
}
