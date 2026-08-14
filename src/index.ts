/**
 * dsh-remote — remote access manager for the DeepSeek Harness Web UI.
 *
 * A host-side Cordis plugin that:
 *   - provides the `dshRemote` Typert Remote service (status / ensure-config /
 *     install / login) consumed by the browser client bundle,
 *   - injects a `crypto.randomUUID` polyfill for older WebKit browsers,
 *   - registers `/remote` and `/remote-fix` slash commands.
 *
 * The pure logic lives in `./core.ts` and is unit-tested in `test/`.
 *
 * Platform notes:
 *  - On Windows `ctx.shell` is the pwsh sandbox executor; this plugin
 *    requests `danger-full-access` for its own calls because the
 *    windows-acl backend refuses to start when its temp root lies inside
 *    the workspace root.
 *  - `inject: ['shell']` makes Cordis wait for the executor (which has its
 *    own inject chain) before applying, so the plugin never disables itself
 *    with a premature "shell service unavailable".
 */
import type { Context } from '@deepseek-ai/cordis'
import { DshRemoteService } from './remote.js'

export const name = 'dsh-remote'

export const inject = ['shell']

/** crypto.randomUUID polyfill for browsers < Safari 15.4 / old WebKit. */
const RANDOM_UUID_POLYFILL = `<script>(function(){try{if(window.crypto&&typeof window.crypto.randomUUID==='function')return}catch(e){}var c=window.crypto=window.crypto||{};if(typeof c.getRandomValues==='function'){c.randomUUID=function(){var b=new Uint8Array(16);c.getRandomValues(b);b[6]=(b[6]&15)|64;b[8]=(b[8]&63)|128;var h=[];for(var i=0;i<16;i++)h.push((b[i]<16?'0':'')+b[i].toString(16));return h[0]+h[1]+h[2]+h[3]+'-'+h[4]+h[5]+'-'+h[6]+h[7]+'-'+h[8]+h[9]+'-'+h[10]+h[11]+h[12]+h[13]+h[14]+h[15]}}else{c.randomUUID=function(){var u='xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g,function(ch){var r=Math.random()*16|0;var v=ch==='x'?r:(r&3|8);return v.toString(16)});return u}}})();</script>`

export function apply(ctx: Context): void {
  // 1. Remote service: the browser bundle calls ctx.remote.dshRemote.*
  const fs = ctx.get('fs') as
    | {
        resolve(p: string): Promise<unknown>
        readText(t: unknown): Promise<string>
        writeText(t: unknown, c: string): Promise<unknown>
      }
    | undefined
  ctx.plugin(DshRemoteService, fs)

  // 2. Old-browser compatibility: crypto.randomUUID polyfill
  const webServer = ctx.get('webServer') as
    | { tapIndex?(transform: (html: string) => string): unknown }
    | undefined
  if (webServer !== undefined && typeof webServer.tapIndex === 'function') {
    webServer.tapIndex((html) => {
      if (html.includes('crypto-randomuuid-polyfill')) return html
      return html.replace('</head>', RANDOM_UUID_POLYFILL + '</head>')
    })
  }

  // 3. Slash commands (also available without the browser bundle)
  const commands = ctx.get('commands') as
    | {
        register(def: {
          name: string
          description: string
          handler(inv: unknown): unknown
        }): unknown
      }
    | undefined
  if (commands !== undefined) {
    commands.register({
      name: 'remote',
      description: '显示远程访问状态（Tailscale / 局域网 / 配置）',
      handler: async () => {
        const svc = ctx.get('dshRemote') as DshRemoteService | undefined
        if (svc === undefined) return { kind: 'error' as const, text: 'dsh-remote 服务尚未就绪，请稍后重试' }
        try {
          return { kind: 'success' as const, text: await svc.describeStatus() }
        } catch (error) {
          return { kind: 'error' as const, text: `状态获取失败: ${String(error)}` }
        }
      },
    })

    commands.register({
      name: 'remote-fix',
      description: '写入远程访问配置（host 0.0.0.0 + Tailscale 信任名单，幂等）',
      handler: async () => {
        const svc = ctx.get('dshRemote') as DshRemoteService | undefined
        if (svc === undefined) return { kind: 'error' as const, text: 'dsh-remote 服务尚未就绪，请稍后重试' }
        try {
          const result = await svc.ensureConfig()
          return { kind: 'success' as const, text: result.message }
        } catch (error) {
          return { kind: 'error' as const, text: `写入失败: ${String(error)}` }
        }
      },
    })
  }
}
