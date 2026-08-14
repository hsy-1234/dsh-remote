import { describe, expect, it } from 'vitest'
import {
  buildPatchEntries,
  buildUrls,
  extractFirstIp,
  findTailscalePrefix,
  hasHostBinding,
  hasTrustedAuthority,
  isLoggedInOutput,
  parseTailscaleJson,
  tailscaleCommand,
  upsertPatchEntries,
} from '../src/core.js'
import type { CmdResult } from '../src/core.js'

const ok = (stdout: string, exitCode = 0): CmdResult => ({ exitCode, stdout, stderr: '' })
const fail = (stderr = ''): CmdResult => ({ exitCode: 1, stdout: '', stderr })

describe('isLoggedInOutput', () => {
  it('accepts a normal status dump', () => {
    expect(isLoggedInOutput('100.85.33.103  laptop  user@  windows  -', 0)).toBe(true)
  })
  it('rejects logged-out markers', () => {
    expect(isLoggedInOutput('Logged out.', 0)).toBe(false)
    expect(isLoggedInOutput('To authenticate, run: tailscale login', 1)).toBe(false)
  })
  it('rejects non-zero exit', () => {
    expect(isLoggedInOutput('', 1)).toBe(false)
  })
})

describe('extractFirstIp', () => {
  it('takes the first token', () => {
    expect(extractFirstIp('100.85.33.103\n100.66.107.54\n')).toBe('100.85.33.103')
  })
  it('returns null for empty output', () => {
    expect(extractFirstIp('   \n')).toBeNull()
  })
})

describe('parseTailscaleJson', () => {
  it('extracts DNSName and first TailscaleIP', () => {
    const json = JSON.stringify({
      Self: { DNSName: 'laptop.tail123.ts.net.', TailscaleIPs: ['100.85.33.103', 'fd7a:115c:a1e0::1'] },
    })
    expect(parseTailscaleJson(json)).toEqual({
      dnsName: 'laptop.tail123.ts.net',
      ip: '100.85.33.103',
    })
  })
  it('tolerates garbage', () => {
    expect(parseTailscaleJson('not json')).toEqual({ dnsName: null, ip: null })
    expect(parseTailscaleJson('{}')).toEqual({ dnsName: null, ip: null })
  })
})

describe('buildPatchEntries', () => {
  it('includes the trust line with an authority', () => {
    const entries = buildPatchEntries('100.85.33.103', 3080)
    expect(entries.map((e) => e.id)).toEqual(['webserver', 'web-runtime'])
    expect(entries[0].block).toContain("host: '0.0.0.0'")
    expect(entries[0].block).toContain('port: 3080')
    expect(entries[1].block).toContain("trustedHosts: !!js \"ctx.webStartup.trustedHosts.concat(['100.85.33.103'])\"")
  })
  it('omits the authority when not logged in', () => {
    const entries = buildPatchEntries(null, 3080)
    expect(entries[1].block).not.toContain('100.85')
    expect(entries[1].block).toContain('trustedHosts: !!js ctx.webStartup.trustedHosts')
  })
})

describe('hasHostBinding / hasTrustedAuthority', () => {
  it('detects the 0.0.0.0 binding', () => {
    expect(hasHostBinding("host: '0.0.0.0'")).toBe(true)
    expect(hasHostBinding('host: 127.0.0.1')).toBe(false)
    expect(hasHostBinding('[]')).toBe(false)
  })
  it('detects a trusted authority', () => {
    expect(hasTrustedAuthority("trustedHosts: ['100.85.33.103']", '100.85.33.103')).toBe(true)
    expect(hasTrustedAuthority('trustedHosts: []', '100.85.33.103')).toBe(false)
  })
})

describe('upsertPatchEntries', () => {
  it('replaces the empty default file', () => {
    const entries = [{ id: 'webserver', block: 'BLOCK-A' }, { id: 'web-runtime', block: 'BLOCK-B' }]
    expect(upsertPatchEntries('[]', entries)).toBe('BLOCK-ABLOCK-B')
    expect(upsertPatchEntries('', entries)).toBe('BLOCK-ABLOCK-B')
  })
  it('appends to an existing patch while keeping unrelated entries', () => {
    const existing = '- id: something\n  config:\n    a: 1\n'
    const entries = [{ id: 'webserver', block: 'BLOCK-A' }]
    expect(upsertPatchEntries(existing, entries)).toBe(`${existing}BLOCK-A`)
  })
  it('replaces matching entries in place instead of duplicating them', () => {
    const existing = '- id: webserver\n  config:\n    host: 127.0.0.1\n- id: other\n  config:\n    x: 1\n'
    const entries = [{ id: 'webserver', block: '- id: webserver\n  config:\n    host: 0.0.0.0\n' }]
    const out = upsertPatchEntries(existing, entries)
    expect(out).toContain('host: 0.0.0.0')
    expect(out).not.toContain('127.0.0.1')
    expect(out).toContain('- id: other')
    // idempotent: applying again yields the same result
    expect(upsertPatchEntries(out, entries)).toBe(out)
  })
  it('inserts a line break when the existing file has no trailing newline', () => {
    // regression: previously the appended block glued onto the last line
    // (`...remote'- id: webserver`) which made the YAML unparseable
    const existing = "# comment\n- insert:\n    - id: dsh-remote\n      name: 'dsh-remote'"
    const entries = [{ id: 'webserver', block: '- id: webserver\n  config:\n    host: 0.0.0.0\n' }]
    const out = upsertPatchEntries(existing, entries)
    expect(out).toContain("name: 'dsh-remote'\n- id: webserver")
    expect(out).not.toContain("dsh-remote'- id: webserver")
    // and idempotency still holds
    expect(upsertPatchEntries(out, entries)).toBe(out)
  })
})

describe('buildUrls', () => {
  it('lists LAN then Tailscale then MagicDNS', () => {
    const urls = buildUrls(['192.168.3.165'], '100.85.33.103', 'laptop.tail.ts.net', 3080)
    expect(urls).toEqual([
      { kind: 'LAN', url: 'http://192.168.3.165:3080' },
      { kind: 'Tailscale', url: 'http://100.85.33.103:3080' },
      { kind: 'MagicDNS', url: 'http://laptop.tail.ts.net:3080' },
    ])
  })
  it('deduplicates when the tailscale IP also appears among LAN IPs', () => {
    const urls = buildUrls(['192.168.3.165', '100.85.33.103'], '100.85.33.103', null, 3080)
    expect(urls).toEqual([
      { kind: 'LAN', url: 'http://192.168.3.165:3080' },
      { kind: 'Tailscale', url: 'http://100.85.33.103:3080' },
    ])
  })
})

describe('findTailscalePrefix', () => {
  it('prefers the PATH resolution', async () => {
    const run = async (command: string): Promise<CmdResult> =>
      command === 'tailscale version 2>&1' ? ok('tailscale 1.102.2') : fail()
    expect(await findTailscalePrefix(run)).toBe('')
  })
  it('falls back to an absolute install location', async () => {
    const run = async (command: string): Promise<CmdResult> =>
      command.includes('D:/Tailscale') ? ok('tailscale 1.102.2') : fail()
    expect(await findTailscalePrefix(run)).toBe('D:/Tailscale/tailscale.exe')
  })
  it('returns null when nothing works', async () => {
    expect(await findTailscalePrefix(async () => fail('nope'))).toBeNull()
  })
})

describe('tailscaleCommand', () => {
  it('builds a bare command', () => {
    expect(tailscaleCommand(null, 'status')).toBe('tailscale status')
    expect(tailscaleCommand('', 'status')).toBe('tailscale status')
  })
  it('builds a call-operator command for an absolute path', () => {
    expect(tailscaleCommand('D:/Tailscale/tailscale.exe', 'ip -4')).toBe(
      "& 'D:/Tailscale/tailscale.exe' ip -4",
    )
  })
})
