// dsh-remote client bundle — DeepSeek Harness ModuleLoader format.
// Copied to lib/client.js at build time; loaded by dsh-client-modules from
// the package's dsh.client manifest + exports "./client".
//
// The remote service (namespace "dshRemote") is provided by the Host half;
// every UI action funnels through ctx.remote.dshRemote.<method>().

window.__ModuleLoader__.load({
  id: 'dsh-remote',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })
    var React = require('react')

    var name = 'dsh-remote'
    var inject = ['slots', 'remote.dshRemote']

    function apply(ctx) {
      var slots = ctx.get('slots')
      if (slots === undefined) return
      var remote = ctx.get('remote.dshRemote')
      if (remote === undefined) return

      // ── shared store ────────────────────────────────────────────────────
      var store = { open: true, status: null, listeners: [] }
      function emit() { for (var i = 0; i < store.listeners.length; i++) { try { store.listeners[i]() } catch (e) {} } }
      function useStore() {
        var force = React.useState(0)[1]
        React.useEffect(function () {
          var l = function () { force(function (x) { return x + 1 }) }
          store.listeners.push(l)
          return function () { store.listeners = store.listeners.filter(function (x) { return x !== l }) }
        }, [])
      }
      function refreshStatus() {
        remote.status().then(function (result) {
          store.status = result
          emit()
        }).catch(function (e) {
          store.status = { error: String(e) }
          emit()
        })
      }

      // ── action mapping: UI label -> remote method ───────────────────────
      function callAction(method, label, args) {
        var fn = {
          'ensure-config': function () { return remote.ensureConfig() },
          'install-tailscale': function () { return remote.installTailscale() },
          'login-authkey': function () { return remote.loginAuthkey(args || {}) },
          'login-gui': function () { return remote.loginGui() },
        }[method]
        return fn ? fn() : Promise.reject(new Error('unknown action ' + method))
      }

      // ── LoginArea ───────────────────────────────────────────────────────
      function makeLoginArea() {
        return function LoginArea() {
          var h = React.createElement
          useStore()
          var keyState = React.useState('')
          var busyState = React.useState('')
          var msgState = React.useState('')
          var pollState = React.useState(false)
          var key = keyState[0], setKey = keyState[1]
          var busy = busyState[0], setBusy = busyState[1]
          var msg = msgState[0], setMsg = msgState[1]
          var polling = pollState[0], setPolling = pollState[1]
          var st = store.status
          var ts = (st && st.tailscale) || {}
          React.useEffect(function () {
            if (!polling) return
            var timerSvc = ctx.get('timer')
            if (timerSvc === undefined) { setPolling(false); return }
            var dispose = timerSvc.interval(function () { refreshStatus() }, 3000)
            return function () { dispose() }
          }, [polling])
          React.useEffect(function () {
            if (polling && ts.installed && ts.loggedIn) setPolling(false)
          }, [ts.installed, ts.loggedIn])
          if (!st || st.error || (ts.installed && ts.loggedIn)) return null
          function runAct(method, label, args) {
            setBusy(label); setMsg('')
            callAction(method, label, args).then(function (result) {
              setMsg((result && result.message) ? result.message : ((result && result.error) ? result.error : ''))
            }).catch(function (e) { setMsg('操作失败: ' + String(e)) }).finally(function () {
              setBusy(''); setPolling(true); refreshStatus()
            })
          }
          var disabled = busy !== ''
          function btn(label, onClick) {
            return h('button', { onClick: onClick, disabled: disabled, style: loginBtn },
              busy === label ? '处理中…' : label)
          }
          var rows = []
          rows.push(h('div', { style: loginTitle }, '🚀 引导' + (ts.installed ? '登录' : '安装')))
          if (!ts.installed) {
            rows.push(h('div', { style: dim }, 'Tailscale 未安装。点击下方按钮自动下载并静默安装（会弹出一次管理员确认）。'))
            rows.push(h('div', { style: rowStyle }, btn('⬇️ 自动安装 Tailscale', function () { runAct('install-tailscale', '⬇️ 自动安装 Tailscale') })))
          } else {
            rows.push(h('div', { style: dim }, '未登录。方式一：在手机/电脑浏览器打开链接生成一次性登录密钥：'))
            rows.push(h('a', { href: 'https://login.tailscale.com/admin/settings/keys', target: '_blank', rel: 'noreferrer', style: linkStyle }, '打开 Tailscale 管理后台 →'))
            rows.push(h('input', { value: key, onChange: function (e) { setKey(e.target.value) }, placeholder: '粘贴 tskey-xxxx 密钥', style: inputStyle }))
            rows.push(h('div', { style: rowStyle },
              btn('🚀 一键登录', function () { runAct('login-authkey', '🚀 一键登录', { authkey: key }) }),
              btn('🖥️ 打开登录界面', function () { runAct('login-gui', '🖥️ 打开登录界面') }),
            ))
          }
          if (polling) rows.push(h('div', { style: pollStyle }, '⏳ 等待完成中（自动检测）…'))
          if (msg) rows.push(h('div', { style: msgStyle }, msg))
          return h('div', { style: loginBox }, rows)
        }
      }

      // ── panel body (flat = inside the floating panel surface) ──────────
      function panelBody(h, status, busy, message, onRefresh, onAct, loginArea, flat) {
        var surface = flat
          ? { padding: 0, background: 'transparent', border: 'none', borderRadius: 0 }
          : card
        if (!status) return h('div', { style: { padding: 12, color: 'var(--dsw-alias-label-secondary)' } }, '远程访问状态加载中…')
        if (status.error) return h('div', { style: { padding: 12, color: 'var(--dsw-alias-state-warn-primary)', fontFamily: 'monospace', fontSize: 11 } }, '状态获取失败: ' + String(status.error))
        var ts = status.tailscale || {}
        var cfg = status.config || {}
        var web = status.web || {}
        var port = web.port || 3080
        var urls = []
        ;(web.lanIps || []).forEach(function (ip) { urls.push({ kind: '局域网', url: 'http://' + ip + ':' + port }) })
        if (ts.ip) urls.push({ kind: 'Tailscale', url: 'http://' + ts.ip + ':' + port })
        if (ts.dnsName) urls.push({ kind: 'MagicDNS', url: 'http://' + ts.dnsName + ':' + port })
        function badge(ok, label) {
          return h('span', { style: Object.assign({}, badgeBase, ok ? badgeOk : badgeWarn) }, (ok ? '✅' : '⚠️') + ' ' + label)
        }
        function row() {
          var cells = Array.prototype.slice.call(arguments)
          return h('div', { style: rowStyle }, cells)
        }
        function button(label, onClick, disabled) {
          return h('button', {
            onClick: onClick,
            disabled: disabled || busy !== '',
            style: Object.assign({}, btn, { opacity: disabled || busy !== '' ? 0.5 : 1 }),
          }, busy === label ? '处理中…' : label)
        }
        var primaryUrl = urls.length > 0 ? urls[0].url : null
        var qrSrc = primaryUrl
          ? 'https://api.qrserver.com/v1/create-qr-code/?size=150x150&data=' + encodeURIComponent(primaryUrl)
          : null
        var children = []
        children.push(h('div', { style: headerRow }, h('span', { style: title }, '🔌 远程访问'), button('刷新', onRefresh, false)))
        children.push(h('div', { style: section }, '状态'))
        children.push(row(badge(ts.installed, 'Tailscale 已安装' + (ts.installed ? '' : '（未安装）'))))
        children.push(row(badge(ts.loggedIn, ts.installed ? (ts.loggedIn ? 'Tailscale 已登录' : 'Tailscale 未登录') : 'Tailscale 未登录')))
        children.push(row(badge(cfg.patched, cfg.patched ? '配置已写入' : '配置未写入')))
        children.push(row(badge(cfg.effective, cfg.effective ? '已生效（监听 0.0.0.0）' : '未生效（监听回环）')))
        if (loginArea) children.push(loginArea)
        children.push(h('div', { style: section }, '访问地址'))
        if (urls.length === 0) {
          children.push(row(h('span', { style: dim }, '暂无可用地址')))
        } else {
          urls.forEach(function (item) {
            children.push(row(h('span', { style: urlKind }, item.kind), h('code', { style: urlCode }, item.url)))
          })
        }
        if (qrSrc) {
          children.push(h('div', { style: qrWrap },
            h('img', { src: qrSrc, alt: 'QR', style: qrImg, width: 120, height: 120 }),
            h('div', { style: dim }, '平板扫码打开'),
          ))
        }
        if (cfg.needsRestart) children.push(row(h('span', { style: warnText }, '⚠️ 配置已写入但未生效：重启 dsh web 后生效')))
        children.push(h('div', { style: section }, '操作'))
        children.push(row(
          button('一键配置', function () { onAct('ensure-config', '一键配置') }, false),
          button('安装 Tailscale', function () { onAct('install-tailscale', '安装 Tailscale') }, ts.installed),
        ))
        if (message) children.push(row(h('span', { style: msgStyle }, message)))
        return h('div', { style: surface }, children)
      }

      // ── right-side floating panel ──────────────────────────────────────
      slots.inject('shell.overlay', function () {
        return slots.register({ name: 'shell.overlay', id: 'dsh-remote-panel' }, function () {
          var h = React.createElement
          useStore()
          var busyState = React.useState('')
          var msgState = React.useState('')
          var busy = busyState[0], setBusy = busyState[1]
          var message = msgState[0], setMessage = msgState[1]
          React.useEffect(function () { if (!store.status) refreshStatus() }, [])
          if (!store.open) return null
          function act(method, label) {
            setBusy(label); setMessage('')
            callAction(method, label).then(function (result) {
              setMessage((result && result.message) ? result.message : ((result && result.error) ? result.error : ''))
            }).catch(function (e) { setMessage('操作失败: ' + String(e)) }).finally(function () {
              setBusy(''); refreshStatus()
            })
          }
          var LoginArea = makeLoginArea()
          return h('div', { style: floatPanel },
            panelBody(h, store.status, busy, message, refreshStatus, act, h(LoginArea), true),
            h('button', { onClick: function () { store.open = false; emit() }, style: closeBtn }, '✕ 收起'),
          )
        })
      })

      // ── header toggle button ───────────────────────────────────────────
      slots.inject('conversation.session.header.utilities', function () {
        return slots.register({ name: 'conversation.session.header.utilities', id: 'dsh-remote-toggle' }, function () {
          var h = React.createElement
          useStore()
          var st = store.status
          var all = st && st.tailscale && st.tailscale.installed && st.tailscale.loggedIn && st.config && st.config.effective
          var any = st && ((st.tailscale && st.tailscale.installed) || (st.config && st.config.patched))
          var color = all ? 'var(--dsw-alias-state-success-primary)' : (any ? 'var(--dsw-alias-state-warn-primary)' : 'var(--dsw-alias-state-error-primary)')
          return h('button', {
            onClick: function () { store.open = !store.open; emit(); if (store.open) refreshStatus() },
            title: '远程访问状态',
            style: Object.assign({}, toggleBtn, { boxShadow: 'inset 0 0 0 1px ' + color }),
          },
            h('span', { style: { fontSize: 14 } }, '🛰️'),
            h('span', { style: { width: 8, height: 8, borderRadius: 999, background: color, display: 'inline-block', marginLeft: 6 } }),
          )
        })
      })

      // ── styles ─────────────────────────────────────────────────────────
      var floatPanel = { position: 'fixed', right: 16, top: 72, zIndex: 2147483000, width: 330, maxHeight: 'calc(100vh - 120px)', overflowY: 'auto', pointerEvents: 'auto', boxShadow: '0 8px 32px rgba(0,0,0,0.35)', borderRadius: 12, background: 'var(--dsw-alias-bg-overlay)', border: '1px solid var(--dsw-alias-border-l1)', padding: 12, boxSizing: 'border-box' }
      var closeBtn = { display: 'block', width: '100%', marginTop: 8, padding: '6px 0', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-secondary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, cursor: 'pointer', fontSize: 12 }
      var toggleBtn = { display: 'inline-flex', alignItems: 'center', background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '5px 10px', cursor: 'pointer', fontSize: 12 }
      var card = { border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 12, padding: 14, background: 'var(--dsw-alias-bg-overlay)', color: 'var(--dsw-alias-label-primary)', fontFamily: 'system-ui, sans-serif', fontSize: 13, lineHeight: 1.5 }
      var headerRow = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }
      var title = { fontWeight: 600, fontSize: 14 }
      var section = { marginTop: 10, marginBottom: 4, fontWeight: 600, color: 'var(--dsw-alias-label-secondary)', fontSize: 12, textTransform: 'uppercase', letterSpacing: 0.5 }
      var rowStyle = { display: 'flex', alignItems: 'center', gap: 8, marginTop: 4, flexWrap: 'wrap' }
      var badgeBase = { padding: '2px 10px', borderRadius: 999, fontSize: 12, fontWeight: 500, background: 'var(--dsw-alias-bg-layer-2)', border: '1px solid var(--dsw-alias-border-l1)' }
      var badgeOk = { color: 'var(--dsw-alias-state-success-primary)' }
      var badgeWarn = { color: 'var(--dsw-alias-state-warn-primary)' }
      var urlKind = { color: 'var(--dsw-alias-label-secondary)', minWidth: 64 }
      var urlCode = { background: 'var(--dsw-alias-bg-layer-1)', padding: '2px 8px', borderRadius: 6, color: 'var(--dsw-alias-brand-primary)', wordBreak: 'break-all' }
      var qrWrap = { display: 'flex', alignItems: 'center', gap: 12, marginTop: 10 }
      var qrImg = { borderRadius: 8, background: '#fff' }
      var dim = { color: 'var(--dsw-alias-label-secondary)', fontSize: 12 }
      var warnText = { color: 'var(--dsw-alias-state-warn-primary)' }
      var msgStyle = { color: 'var(--dsw-alias-state-success-primary)', marginTop: 6 }
      var btn = { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 8, padding: '6px 12px', cursor: 'pointer', fontSize: 12 }
      var loginBox = { marginTop: 10, border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 10, padding: 10, background: 'var(--dsw-alias-bg-layer-1)' }
      var loginTitle = { fontWeight: 600, fontSize: 12, color: 'var(--dsw-alias-brand-primary)', marginBottom: 6 }
      var loginBtn = { background: 'var(--dsw-alias-bg-layer-2)', color: 'var(--dsw-alias-brand-primary)', border: '1px solid var(--dsw-alias-border-l2)', borderRadius: 8, padding: '6px 10px', cursor: 'pointer', fontSize: 12 }
      var inputStyle = { width: '100%', boxSizing: 'border-box', marginTop: 6, padding: '6px 8px', background: 'var(--dsw-alias-bg-layer-1)', color: 'var(--dsw-alias-label-primary)', border: '1px solid var(--dsw-alias-border-l1)', borderRadius: 6, fontSize: 12, fontFamily: 'monospace' }
      var linkStyle = { color: 'var(--dsw-alias-brand-primary)', fontSize: 12, textDecoration: 'underline' }
      var pollStyle = { color: 'var(--dsw-alias-state-warn-primary)', fontSize: 12, marginTop: 6 }
    }

    module.exports = { name: name, inject: inject, apply: apply }
    return module.exports
  },
})
