/**
 * dsh-remote — pure, platform-independent core logic.
 *
 * Everything in this module is side-effect free and unit-testable without a
 * running harness. The Cordis plugin in `index.ts` wires these functions to
 * the real `ctx.shell` / `ctx.fs` services.
 */

export interface TailscaleProbe {
  installed: boolean
  loggedIn: boolean
  ip: string | null
  dnsName: string | null
}

/** One probe result: exit code plus merged output. */
export interface CmdResult {
  exitCode: number | null
  stdout: string
  stderr: string
}

/**
 * Candidate tailscale invocations, tried in order. The bare entry resolves
 * through PATH; the others are well-known Windows install locations called
 * with the PowerShell call operator (`& 'path' ...`).
 */
export const TAILSCALE_CANDIDATES: ReadonlyArray<{ prefix: string; check: string }> = [
  { prefix: '', check: 'tailscale version 2>&1' },
  { prefix: 'D:/Tailscale/tailscale.exe', check: "& 'D:/Tailscale/tailscale.exe' version 2>&1" },
  { prefix: '/c/Tailscale/tailscale.exe', check: "& '/c/Tailscale/tailscale.exe' version 2>&1" },
  { prefix: 'C:/Program Files/Tailscale/tailscale.exe', check: "& 'C:/Program Files/Tailscale/tailscale.exe' version 2>&1" },
  { prefix: 'C:/Program Files (x86)/Tailscale/tailscale.exe', check: "& 'C:/Program Files (x86)/Tailscale/tailscale.exe' version 2>&1" },
]

/** Text markers that mean `tailscale status` is reporting a logged-out state. */
const LOGGED_OUT_MARKERS = /logged out|needslogin|login required/i

/** Whether a `tailscale status` probe means the tailnet session is up. */
export function isLoggedInOutput(text: string, exitCode: number | null): boolean {
  return exitCode === 0 && !LOGGED_OUT_MARKERS.test(text)
}

/** Extract the first whitespace-separated token of `tailscale ip -4` output. */
export function extractFirstIp(text: string): string | null {
  const first = text.trim().split(/\s+/)[0]
  return first && first.length > 0 ? first : null
}

/** Parse `tailscale status --json` output for the self DNS name and IPv4. */
export function parseTailscaleJson(
  text: string,
): { dnsName: string | null; ip: string | null } {
  try {
    const parsed = JSON.parse(text) as {
      Self?: { DNSName?: string; TailscaleIPs?: string[] }
    }
    const self = parsed.Self
    if (!self) return { dnsName: null, ip: null }
    const dnsName = self.DNSName ? self.DNSName.replace(/\.$/, '') : null
    const ip = self.TailscaleIPs?.[0] ?? null
    return { dnsName, ip }
  } catch {
    return { dnsName: null, ip: null }
  }
}

/**
 * Build the cordis.patch.yml block this plugin manages. When `authority` is
 * set (a Tailscale IP or MagicDNS name) it is declared on the /api
 * browser-trust fence; otherwise the fence keeps the invocation defaults
 * (LAN literals are auto-trusted by dsh when the server binds 0.0.0.0).
 */
export function buildPatchBlock(authority: string | null, port: number): string {
  const trustedLine = authority
    ? `    trustedHosts: !!js [...ctx.webStartup.trustedHosts, '${authority}']`
    : '    trustedHosts: !!js ctx.webStartup.trustedHosts'
  return [
    '# Managed by dsh-remote (remote access)',
    '- id: webserver',
    '  config:',
    "    host: '0.0.0.0'",
    `    port: ${port}`,
    '- id: web-runtime',
    '  config:',
    '    printUrl: true',
    '    surfaceContext: true',
    trustedLine,
    '',
  ].join('\n')
}

/** Whether the patch already binds the web server to all interfaces. */
export function hasHostBinding(content: string): boolean {
  return /host:\s*'?0\.0\.0\.0'?/.test(content)
}

/** Whether the patch already declares a given trust authority. */
export function hasTrustedAuthority(content: string, authority: string): boolean {
  return content.includes(authority)
}

/**
 * Merge a managed block into existing patch content: an empty or default
 * (`[]`) file is replaced; anything else keeps its entries and the block is
 * appended to the array.
 */
export function mergePatchContent(existing: string, block: string): string {
  const trimmed = existing.trim()
  if (trimmed === '' || trimmed === '[]') return block
  return `${existing.replace(/\s*$/, '\n')}${block}`
}

/** Access URLs offered to the user, LAN first, then Tailscale. */
export function buildUrls(
  lanIps: readonly string[],
  tailscaleIp: string | null,
  dnsName: string | null,
  port: number,
): Array<{ kind: string; url: string }> {
  const urls: Array<{ kind: string; url: string }> = []
  for (const ip of lanIps) urls.push({ kind: 'LAN', url: `http://${ip}:${port}` })
  if (tailscaleIp) urls.push({ kind: 'Tailscale', url: `http://${tailscaleIp}:${port}` })
  if (dnsName) urls.push({ kind: 'MagicDNS', url: `http://${dnsName}:${port}` })
  return urls
}

/**
 * Probe the tailscale CLI across PATH and known install locations, returning
 * the invocation prefix to use for later calls ('' = bare command name).
 * `run` is injected so tests can stub it.
 */
export async function findTailscalePrefix(
  run: (command: string) => Promise<CmdResult>,
): Promise<string | null> {
  for (const candidate of TAILSCALE_CANDIDATES) {
    const r = await run(candidate.check)
    if (r.exitCode === 0 && /tailscale/i.test(`${r.stdout}${r.stderr}`)) {
      return candidate.prefix
    }
  }
  return null
}

/** Build one command string from a resolved prefix and a tailscale subcommand. */
export function tailscaleCommand(prefix: string | null, sub: string): string {
  if (prefix === null || prefix === '') return `tailscale ${sub}`
  return `& '${prefix}' ${sub}`
}
