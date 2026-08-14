# 🛰️ dsh-remote

**DeepSeek Harness 远程访问管家** —— 让 Harness 的 Web UI 可以从任何设备访问：同一 WiFi 下的平板、千里之外的手机，输入一个地址（或扫一个二维码）就能看到并操作你电脑上运行中的 Harness。

**安装即永久**：🛰️ 常驻状态侧边栏、一键安装/登录 Tailscale、自动配置、旧浏览器兼容——全部内置，重启不丢。

---

## ✨ 功能特性

| 能力 | 说明 |
| --- | --- |
| 🛰️ **常驻状态侧边栏** | 会话头部 🛰️ 按钮（带状态灯）+ 右侧浮动面板，四格状态一目了然，**随 harness 主题自动适配亮暗模式**；作为独立 client bundle 内置，**重启不丢** |
| 📍 **访问地址 + 二维码** | 局域网、Tailscale IP、MagicDNS 域名自动检测（自动去重），扫码即开 |
| ⚙️ **一键配置（幂等）** | 按条目 ID 原位更新 `cordis.patch.yml`（`host: 0.0.0.0` + Tailscale 信任名单），重复执行不产生重复条目 |
| ⬇️ **一键安装 Tailscale** | 自动下载 MSI 静默安装（仅一次管理员确认），自动轮询完成状态 |
| 🚀 **一键登录 Tailscale** | 粘贴一次性密钥自动登录（手机也能操作），或唤起官方登录界面；自动轮询登录状态 |
| 📱 **旧浏览器兼容** | 自动注入 `crypto.randomUUID` polyfill（修复 iPadOS/旧 WebKit 白屏） |
| 🛡️ **自带信任围栏** | 插件端点执行与 /api 等效的浏览器信任检查（Host 头 ∈ 回环/本机 IP，含 Tailscale 网卡自动信任） |
| 🛡️ **沙箱自适应** | 显式请求 `danger-full-access`，绕开 Windows windows-acl 沙箱后端不可用问题 |
| 🔌 **多位置探测** | 自动定位 PATH / `D:\Tailscale` / `C:\Program Files\Tailscale` 中的 tailscale CLI |
| ⌨️ **Slash 命令** | `/remote` 查看状态、`/remote-fix` 写入配置（无 GUI 环境的备选入口） |

---

## 📖 工作原理

```
┌─ 你的电脑 ────────────────────────────────────────────────┐
│  dsh web (node)                                           │
│   ┌──────────────────────┐                                │
│   │ Web UI :3080         │◄── host: 0.0.0.0（插件写入）    │
│   └──────┬───────────────┘                                │
│          │  /dsh-remote/*（插件自建端点）                   │
│          │   · 自带信任围栏：Host ∈ 回环/本机 IP ✅         │
│          │   · JSON POST，浏览器 bundle 直接 fetch         │
│          ▼                                                │
│   ┌──────────────────────┐                                │
│   │ DshRemoteService     │── status / ensureConfig /      │
│   │ （loader entry）      │   install / login              │
│   └──────────────────────┘                                │
│   ┌──────────────────────┐                                │
│   │ client bundle        │── 🛰️ 侧边栏 + 面板              │
│   │ (/plugins/.../client)│   （ModuleLoader 格式）         │
│   └──────────────────────┘                                │
│   ┌──────────────────────┐                                │
│   │ Tailscale            │── 一键安装/登录                 │
│   └──────────────────────┘                                │
└──────┬────────────────────────────────────────────────────┘
       │ 加密点对点隧道（无需公网 IP / 端口映射）
       ▼
┌─ 平板 / 手机 ─────────────────────────────────────────────┐
│  Tailscale App（登录同账号）                              │
│  浏览器打开 http://100.x.y.z:3080                        │
└──────────────────────────────────────────────────────────┘
```

**四个关键设计**：

1. **永久 UI**：面板是独立的 **client bundle**（`window.__ModuleLoader__.load()` 格式 + `exports "./client"` 声明），由 dsh 的模块系统随插件包加载——**每次启动自动出现，不依赖任何临时运行**。
2. **自有传输**：插件的 Host 服务通过 `webServer.register` 暴露 `/dsh-remote/<method>` JSON 端点（绕过不可靠的 gateway @Remote 通道），每个请求执行**等效 /api 的信任围栏**（Host 头必须是回环或本机 IPv4——Tailscale 虚拟网卡 IP 自动信任）。
3. **幂等配置**：`cordis.patch.yml` 的条目按 `- id:` 原位更新，永不重复追加；`!!js` 表达式使用标量 `concat()` 写法（dsh 解析器只接受标量）。
4. **兼容与沙箱**：`crypto.randomUUID` polyfill 通过 `tapIndex` 注入页面 HTML；shell 调用显式请求 `danger-full-access`。

> 配置写入 `$DSH_HOME/profiles/web/cordis.patch.yml`（用户补丁层），**每次启动自动生效**。

---

## 📦 安装

### 前置条件

- Windows 10/11 电脑，已安装 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 并跑过 `dsh web`
- Node.js ≥ 20（构建插件时需要）

### 方式一：npm 包（推荐，发布后可用）

```bash
npm install dsh-remote
```

在 web profile 中注册（编辑 `~/.dsh/profiles/web/cordis.patch.yml`，**不要动 cordis.yml**）：

```yaml
- insert:
    - id: dsh-remote
      name: 'dsh-remote'
    - id: dsh-remote-service
      name: 'dsh-remote/remote'
```

### 方式二：本地构建

```bash
git clone https://github.com/hsy-1234/dsh-remote.git
cd dsh-remote
npm install
npm run build          # 产物在 lib/
```

把 `dsh-remote` 目录放进 profile 的依赖（二选一）：

```bash
# a) 在 profile 目录安装本地包
cd ~/.dsh/profiles/web
npm install file:/path/to/dsh-remote --legacy-peer-deps
npm install @deepseek-ai/dsh-typert-protocol@^0.1.0-rc.6 --legacy-peer-deps

# b) 或手动拷贝构建产物到
#   ~/.dsh/profiles/web/node_modules/dsh-remote/
#   （lib/ + package.json + node_modules 依赖）
```

然后在 `cordis.patch.yml` 按方式一注册两条 entry（包名加载，**client bundle 需要包名解析**）。

### 验证安装

重启 `dsh web` 后：
- 会话右上角出现 **🛰️ 按钮**（带状态灯），右侧出现状态面板
- 输入 `/remote` 显示文本状态
- 平板访问 Tailscale 地址不再白屏（polyfill 已注入）

---

## 🚀 快速开始（3 分钟从零到平板）

**第 1 分钟：安装插件**（见上文）并重启 `dsh web`。

**第 2 分钟：面板引导**（面板自动出现"🚀 引导"区块）：

| 你的状态 | 面板显示 | 你要做的 |
| --- | --- | --- |
| Tailscale 未安装 | `[⬇️ 自动安装 Tailscale]` | 点击，**在 UAC 弹窗点"是"**，其余自动 |
| 已安装未登录 | `打开 Tailscale 管理后台 →` + 密钥输入框 | 用**手机**打开链接生成一次性密钥 → 粘贴 → `[🚀 一键登录]`，UAC 点"是" |
| 都好了 | 四格全绿 ✅ | 点 `[一键配置]`，然后**重启一次 dsh web** |

**第 3 分钟：平板连接**

1. 平板安装 [Tailscale](https://tailscale.com/download) App，**登录与电脑相同的账号**
2. 打开面板里的 **Tailscale 地址**（如 `http://100.85.33.103:3080`）——或直接**扫面板二维码**
3. 完成！平板可以操作电脑上的 Harness 了

---

## 🎮 使用指南

### 状态面板

```
🔌 远程访问                    [刷新]
状态
  ✅ Tailscale 已安装
  ✅ Tailscale 已登录
  ✅ 配置已写入
  ✅ 已生效（监听 0.0.0.0）
访问地址
  局域网    http://192.168.3.165:3080
  Tailscale http://100.85.33.103:3080
  MagicDNS  http://laptop.xxx.ts.net:3080
  [二维码]
操作
  [一键配置]  [安装 Tailscale]
```

| 区块 | 含义 |
| --- | --- |
| 🛰️ 头部按钮 | 开关右侧面板；状态灯：绿=全就绪 / 黄=部分 / 红=未安装 |
| 状态徽章 | 四项关键状态；黄色 ⚠️ 表示该项未就绪 |
| 访问地址 | 三类地址自动检测并去重；`code` 样式可长按复制 |
| 二维码 | 扫码即开第一个可用地址 |
| 操作 | 一键配置（幂等写 cordis.patch.yml）/ 安装 Tailscale |

### Slash 命令

| 命令 | 作用 |
| --- | --- |
| `/remote` | 文本形式查看完整状态与地址 |
| `/remote-fix` | 写入远程访问配置（等价面板"一键配置"） |

---

## 🔧 配置详解

插件维护/依赖 `cordis.patch.yml` 中的条目（面板"一键配置"幂等写入前两条）：

```yaml
# 1. Web 服务监听所有网卡（默认只监听 127.0.0.1）
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080

# 2. 信任围栏：显式声明 Tailscale 地址（LAN 地址由 dsh 自动信任）
#    ⚠️ !!js 标签只接受标量：必须用 concat() 表达式写法
- id: web-runtime
  config:
    printUrl: true
    surfaceContext: true
    trustedHosts: !!js "ctx.webStartup.trustedHosts.concat(['100.85.33.103'])"

# 3.（推荐，部署级）默认沙箱模式与权限预设一致
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'
    workspaceRoot: !!js process.cwd()

# 4.（⚠️ 覆盖 sandbox-policy 后必须同时设置）PermissionPresetService 在
#    构造时读取补丁 config 而非 settings.yaml；不设置会报
#    "composed sandbox and approval defaults match no preset"
- id: permission
  config:
    defaultPreset: danger-full-access
```

---

## 🛡️ 安全说明（务必阅读）

> **信任围栏 ≠ 用户认证。** 插件端点（以及 /api）只验证请求的 Host 头，任何能访问到地址的人都能获得 Harness 的**完整控制权**（`danger-full-access`）。

**安全清单**：

- [ ] **不要**对 3080 端口做路由器端口映射（DMZ / UPnP）暴露到公网
- [ ] 异地访问只使用 Tailscale 或其他加密隧道；地址只分享给可信的人
- [ ] 面板二维码/地址不要发到公开群聊
- [ ] 定期检查监听：`netstat -ano | findstr :3080`
- [ ] 如需公网直接访问，请自行增加认证层（如 Cloudflare Access / 反向代理 basic auth）

---

## 💻 兼容性

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11（电脑端） | ✅ 已验证 | 插件命令为 PowerShell 语法（dsh 在 Windows 的 shell 执行器） |
| iPadOS（平板端） | ✅ 实测通过 | 含 `randomUUID` polyfill（iPadOS 26 也受影响，已注入修复）；Tailscale App + Safari |
| Android（手机端） | ✅ 预期可用 | Tailscale App + Chrome |
| macOS / Linux（电脑端） | 🚧 计划中 | 需要 bash 语法分支（当前命令为 PowerShell 语法） |

---

## ❓ 常见问题（FAQ）

**Q：平板打开页面白屏/工作区不显示？**
A：旧 WebKit 缺 `crypto.randomUUID`，前端初始化崩溃。插件已自动注入 polyfill；若仍异常请**清除浏览器缓存**后重开（Safari：设置 → Safari → 清除历史记录与网站数据）。

**Q：面板显示"fs service unavailable"？**
A：确认使用 v0.0.4+（服务从 ctx 获取 fs）。重启 dsh web 后自动解决。

**Q：面板显示"Tailscale 未安装"但明明装好了？**
A：tailscale 不在标准位置且不在 PATH。插件探测 `D:\Tailscale`、`Program Files` 等位置；装在别处请加入 PATH 或反馈 issue。

**Q：插件所有命令失败（exitCode: null）？**
A：windows-acl 沙箱后端不可用（temp 位于 workspace 内）。插件已显式请求 `danger-full-access`；部署级修复见"配置详解"第 3、4 条。

**Q：平板上看到的工作区与电脑不同步？**
A：工作区数据共享（同一后端），但**每台设备的浏览状态独立**——平板默认显示欢迎页，手动选择工作区即可看到全部会话。

---

## 🛠️ 开发

```bash
npm install
npm test          # vitest 单元测试（core 纯逻辑，21 个用例）
npm run build     # tsc 编译 host 到 lib/ + 拷贝 client bundle
npm pack          # 生成发布 tarball（dsh-remote-0.0.4.tgz）
```

```
src/
  core.ts     # 纯逻辑：tailscale 探测、配置生成、URL 组装（全部可单测）
  remote.ts   # Host 服务：webServer 路由 + 信任围栏 + 业务方法
  index.ts    # 插件入口：polyfill 注入 + slash 命令
client/
  client.js   # client bundle 源（ModuleLoader 格式，fetch 调用端点）
test/
  core.test.ts
```

---

## 📄 版本历史

| 版本 | 内容 |
| --- | --- |
| v0.0.4 | **永久 UI**：client bundle 内置侧边栏/面板；webServer 路由 + 自带信任围栏；修复 fs 服务获取 |
| v0.0.3 | 修复 shell 加载时序（`inject: ['shell']`）与配置幂等合并 |
| v0.0.1 ~ 0.0.2 | 已撤回（配置解析 bug） |

## 📄 License

MIT
