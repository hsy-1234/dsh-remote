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
 * Build the cordis.patch.yml entries this plugin manages. When `authority`
 * is set (a Tailscale IP or MagicDNS name) it is declared on the /api
 * browser-trust fence; otherwise the fence keeps the invocation defaults
 * (LAN literals are auto-trusted by dsh when the server binds 0.0.0.0).
 */
export function buildPatchEntries(
  authority: string | null,
  port: number,
): Array<{ id: string; block: string }> {
  // NOTE: the !!js YAML tag only accepts SCALAR values (dsh-app-boot's
  // entry-list dialect), so the expression must be a quoted scalar — an
  // inline flow sequence like `[...]` fails to parse.
  const trustedLine = authority
    ? `    trustedHosts: !!js "ctx.webStartup.trustedHosts.concat(['${authority}'])"`
    : '    trustedHosts: !!js ctx.webStartup.trustedHosts'
  return [
    {
      id: 'webserver',
      block: [
        '- id: webserver',
        '  config:',
        "    host: '0.0.0.0'",
        `    port: ${port}`,
        '',
      ].join('\n'),
    },
    {
      id: 'web-runtime',
      block: [
        '- id: web-runtime',
        '  config:',
        '    printUrl: true',
        '    surfaceContext: true',
        trustedLine,
        '',
      ].join('\n'),
    },
  ]
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
 * Merge managed patch entries into existing content with ID-level
 * idempotency: an empty or default (`[]`) file is replaced; otherwise every
 * entry whose `- id:` already exists is replaced in place and all other
 * entries are preserved — repeated calls never accumulate duplicates.
 */
export function upsertPatchEntries(
  existing: string,
  entries: ReadonlyArray<{ id: string; block: string }>,
): string {
  const trimmed = existing.trim()
  if (trimmed === '' || trimmed === '[]') {
    return entries.map((e) => e.block).join('')
  }
  const ids = new Set(entries.map((e) => e.id))
  // Split on entry boundaries: each chunk starts with "- id: ".
  const kept = existing.split(/^(?=- id: )/m).filter((chunk) => {
    const m = chunk.match(/^- id: (\S+)/)
    return !m || !ids.has(m[1])
  })
  return kept.join('') + entries.map((e) => e.block).join('')
}

/** Access URLs offered to the user, LAN first, then Tailscale. */
export function buildUrls(
  lanIps: readonly string[],
  tailscaleIp: string | null,
  dnsName: string | null,
  port: number,
): Array<{ kind: string; url: string }> {
  // Map preserves insertion order and later keys override earlier ones, so a
  // Tailscale IP that also shows up among LAN IPs keeps the Tailscale label.
  const byUrl = new Map<string, string>()
  for (const ip of lanIps) byUrl.set(`http://${ip}:${port}`, 'LAN')
  if (tailscaleIp) byUrl.set(`http://${tailscaleIp}:${port}`, 'Tailscale')
  if (dnsName) byUrl.set(`http://${dnsName}:${port}`, 'MagicDNS')
  return [...byUrl.entries()].map(([url, kind]) => ({ kind, url }))
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
