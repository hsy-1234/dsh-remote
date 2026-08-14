import { describe, expect, it } from 'vitest'
import {
  buildPatchBlock,
  buildUrls,
  extractFirstIp,
  findTailscalePrefix,
  hasHostBinding,
  hasTrustedAuthority,
  isLoggedInOutput,
  mergePatchContent,
  parseTailscaleJson,
  tailscaleCommand,
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

describe('buildPatchBlock', () => {
  it('includes the trust line with an authority', () => {
    const block = buildPatchBlock('100.85.33.103', 3080)
    expect(block).toContain("host: '0.0.0.0'")
    expect(block).toContain('port: 3080')
    expect(block).toContain("trustedHosts: !!js [...ctx.webStartup.trustedHosts, '100.85.33.103']")
  })
  it('omits the authority when not logged in', () => {
    const block = buildPatchBlock(null, 3080)
    expect(block).not.toContain('100.85')
    expect(block).toContain('trustedHosts: !!js ctx.webStartup.trustedHosts')
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

describe('mergePatchContent', () => {
  it('replaces the empty default file', () => {
    expect(mergePatchContent('[]', 'BLOCK')).toBe('BLOCK')
    expect(mergePatchContent('', 'BLOCK')).toBe('BLOCK')
  })
  it('appends to an existing patch while keeping entries', () => {
    const existing = '- id: something\n  config:\n    a: 1\n'
    expect(mergePatchContent(existing, 'BLOCK')).toBe(`${existing}BLOCK`)
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
