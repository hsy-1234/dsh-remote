# 🛰️ dsh-remote

**DeepSeek Harness 远程访问管家** —— 让 Harness 的 Web UI 可以从任何设备访问：同一 WiFi 下的平板、千里之外的手机，输入一个地址（或扫一个二维码）就能看到并操作你电脑上运行中的 Harness。

> 一键安装 Tailscale、一键登录、自动配置、主题化状态侧边栏——**用户要做的只是打开一个链接**。

---

## ✨ 功能特性

| 能力 | 说明 |
| --- | --- |
| 🛰️ **常驻状态侧边栏** | 会话头部 🛰️ 按钮 + 右侧浮动面板，四格状态一目了然（安装/登录/配置/生效），**随 harness 主题自动适配亮暗模式** |
| 📍 **访问地址 + 二维码** | 局域网地址、Tailscale IP、MagicDNS 域名自动检测；二维码扫码即开 |
| ⚙️ **一键配置** | 自动写入 `host: 0.0.0.0` 与 Tailscale 信任名单到 `cordis.patch.yml`，重启后永久生效 |
| ⬇️ **一键安装 Tailscale** | 自动下载 MSI 并静默安装（只弹一次管理员确认），完成后自动检测 |
| 🚀 **一键登录 Tailscale** | 粘贴管理后台生成的一次性密钥（手机浏览器也能操作），或唤起官方登录界面；自动轮询登录状态 |
| 📱 **旧浏览器兼容** | 自动注入 `crypto.randomUUID` polyfill，解决 iPadOS/旧 WebKit 白屏问题（实测 iPadOS 26 也受影响） |
| 🛡️ **沙箱自适应** | 显式请求 `danger-full-access`，绕开 Windows 上 windows-acl 沙箱后端不可用导致的"命令全部静默失败"问题 |
| 🔌 **多位置探测** | 自动在 PATH 与 `D:\Tailscale`、`C:\Program Files\Tailscale`、`C:\Program Files (x86)\Tailscale` 之间定位 tailscale CLI |
| ⌨️ **Slash 命令** | `/remote` 查看状态、`/remote-fix` 写入配置（无 GUI 环境的备选入口） |

---

## 📖 工作原理

DeepSeek Harness 的 Web UI 默认只监听回环地址 `127.0.0.1:3080`，外部设备无法访问。同时它的 `/api` 有一个 **browser-trust fence**（浏览器信任围栏，防 DNS rebinding 与跨站攻击）。本插件做的事：

```
┌─ 你的电脑 ────────────────────────────────────────────┐
│  dsh web (node)                                       │
│   ┌──────────────┐    webserver 行                    │
│   │ Web UI:3080  │ ◄── host: 0.0.0.0（插件写入）       │
│   └──────┬───────┘                                    │
│          │ /api 信任围栏                               │
│          │  · 回环地址 ✅ 自动信任                      │
│          │  · 局域网 IP ✅ 自动信任（0.0.0.0 时）       │
│          │  · Tailscale IP ✅ 自动收集 + 显式声明       │
│          ▼                                            │
│   ┌──────────────┐                                    │
│   │ Tailscale    │◄── 插件一键安装/登录                │
│   └──────────────┘                                    │
└──────┬────────────────────────────────────────────────┘
       │ 加密点对点隧道（无需公网 IP / 端口映射）
       ▼
┌─ 你的平板 / 手机 ────────────────────────────────────┐
│  Tailscale App（登录同账号）                          │
│  Safari/Chrome 打开 http://100.x.y.z:3080            │
└──────────────────────────────────────────────────────┘
```

**三个关键机制**：

1. **`webserver` 行**：把监听地址改为 `0.0.0.0`。此时 dsh 自动收集本机所有非内部 IPv4（**含 Tailscale 虚拟网卡的 `100.x.y.z`**）加入信任名单——所以 Tailscale 地址的 `/api` 请求被自动放行。
2. **`web-runtime` 行**：把 Tailscale 地址（或 MagicDNS 域名）显式写进 `trustedHosts`，双保险。
3. **`sandbox-policy` 兼容**：Windows 上插件执行命令的 shell 是 pwsh 沙箱执行器；当默认 `workspace-write` 模式的 windows-acl 后端因 **temp 目录位于 workspace 内部**而无法启动时，所有命令会静默失败（`code: null`）。插件为自身调用显式请求 `danger-full-access` 绕过。

> 配置写入 `$DSH_HOME/profiles/web/cordis.patch.yml`（用户补丁层），**每次启动自动生效**，无需手动传参。

---

## 📦 安装

### 前置条件

- Windows 10/11 电脑，已安装 [DeepSeek Harness](https://deepseek-harness.github.io/deepseek-harness/) 并跑过 `dsh web`
- Node.js ≥ 20（用于构建本插件，可选）

### 方式一：npm 包（推荐，发布后可用）

```bash
npm install dsh-remote
```

### 方式二：本地源码

```bash
git clone https://github.com/你的账号/dsh-remote.git
cd dsh-remote
npm install
npm run build     # 产物在 lib/
```

### 注册到 web profile

编辑 `~/.dsh/profiles/web/cordis.patch.yml`（**不要动 cordis.yml**），追加：

```yaml
- insert:
    - id: dsh-remote
      name: 'dsh-remote'                      # npm 包名
      # 或本地路径: name: 'C:/path/to/dsh-remote/lib/index.js'
```

重启：

```bash
dsh web
```

> **注意**：插件写配置需要一次重启才能让 `host: 0.0.0.0` 生效（监听地址在启动时绑定）。重启后一切自动。

### 验证安装

启动后：
- 会话右上角出现 **🛰️ 按钮**（带状态灯）
- 右侧出现**状态面板**
- 或输入 `/remote` 查看文本状态

---

## 🚀 快速开始（3 分钟从零到平板）

**第 1 分钟：安装插件**（见上文）并重启 `dsh web`。

**第 2 分钟：在面板上完成引导**（面板会自动出现"🚀 引导"区块）：

| 你的状态 | 面板显示 | 你要做的 |
| --- | --- | --- |
| Tailscale 未安装 | `[⬇️ 自动安装 Tailscale]` | 点击，**在 UAC 弹窗点"是"**，其余自动 |
| 已安装未登录 | `打开 Tailscale 管理后台 →` + 密钥输入框 | 用**手机**打开链接生成一次性密钥 → 粘贴 → `[🚀 一键登录]`，UAC 点"是" |
| 都好了 | 四格全绿 ✅ | 点 `[一键配置]`，然后**重启一次 dsh web** |

**第 3 分钟：平板连接**

1. 平板安装 [Tailscale](https://tailscale.com/download) App，**登录与电脑相同的账号**
2. 打开面板里的 **Tailscale 地址**（如 `http://100.85.33.103:3080`）——或直接**扫面板二维码**
3. 完成！平板可以操作电脑上的 Harness 了

> 同一 WiFi 下也可以直接访问**局域网地址**（`http://192.168.x.x:3080`），平板无需 Tailscale。

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
  局域网   http://192.168.3.165:3080
  Tailscale http://100.85.33.103:3080
  MagicDNS http://laptop.xxx.ts.net:3080
  [二维码]
操作
  [一键配置]  [安装 Tailscale]
```

| 区块 | 含义 |
| --- | --- |
| 🛰️ 头部按钮 | 开关右侧面板；状态灯：绿=全就绪 / 黄=部分 / 红=未安装 |
| 状态徽章 | 四项关键状态；黄色 ⚠️ 表示该项未就绪 |
| 访问地址 | 三类地址自动检测；`code` 样式可长按复制 |
| 二维码 | 扫码即开第一个可用地址（平板最方便） |
| 操作 | 一键配置（写 cordis.patch.yml）/ 安装 Tailscale |

### Slash 命令

| 命令 | 作用 |
| --- | --- |
| `/remote` | 文本形式查看完整状态与地址（无 GUI 环境可用） |
| `/remote-fix` | 写入远程访问配置（等价面板"一键配置"） |

### 日常操作

- **新增设备**：新设备装 Tailscale App → 登录同账号 → 浏览器打开 Tailscale 地址
- **异地访问**：确保电脑 Tailscale 客户端在运行、电脑未休眠
- **彻底关闭远程**：编辑 `cordis.patch.yml` 删除插件写入的条目，重启 dsh web
- **日志**：插件命令执行失败时，面板会显示具体 stderr

---

## 🔧 配置详解

插件自动维护 `cordis.patch.yml` 中的以下条目（**面板"一键配置"写入**）：

```yaml
# 1. Web 服务监听所有网卡（默认只监听 127.0.0.1）
- id: webserver
  config:
    host: '0.0.0.0'
    port: 3080

# 2. 信任围栏：显式声明 Tailscale 地址（LAN 地址由 dsh 自动信任）
- id: web-runtime
  config:
    printUrl: true
    surfaceContext: true
    trustedHosts: !!js [...ctx.webStartup.trustedHosts, '100.85.33.103']

# 3.（推荐，部署级）默认沙箱模式与 settings.yaml 的权限预设一致
- id: sandbox-policy
  config:
    mode: !!js process.env.DSH_PERMISSION_MODE ?? 'danger-full-access'
    workspaceRoot: !!js process.cwd()
```

### 相关概念

| 概念 | 说明 |
| --- | --- |
| `trustedHosts` | 信任围栏白名单：`host` 或 `host:port`；**IP 字面量匹配任意端口**，域名精确匹配 |
| MagicDNS | Tailscale 域名服务（`机器名.尾网.ts.net`）；需在管理后台开启，用于 IP 变化的场景 |
| `DSH_PERMISSION_MODE` | 沙箱模式环境变量：`read-only` / `workspace-write` / `danger-full-access`；未设置时默认 `workspace-write` |

---

## 🛡️ 安全说明（务必阅读）

> **信任围栏 ≠ 用户认证。** fence 只验证请求的 Host 头（防 DNS rebinding），任何能访问到地址的人都能通过检查并获得 Harness 的**完整控制权**（`danger-full-access`）。

**安全清单**：

- [ ] **不要**对 3080 端口做路由器端口映射（DMZ / UPnP）暴露到公网
- [ ] 异地访问只使用 Tailscale 或其他加密隧道；Tailscale 地址只分享给可信的人
- [ ] 面板二维码/地址不要发到公开群聊
- [ ] 定期检查监听：`netstat -ano | findstr :3080`
- [ ] 如需公网直接访问，请自行增加认证层（如 Cloudflare Access / 反向代理 basic auth）

---

## 💻 兼容性

| 平台 | 状态 | 说明 |
| --- | --- | --- |
| Windows 10/11（电脑端） | ✅ 已验证/预期可用 | 插件自身命令为 PowerShell 语法（dsh 在 Windows 的 shell 执行器） |
| iPadOS（平板端） | ✅ 实测通过 | 含旧 WebKit 的 `randomUUID` polyfill；Tailscale App + Safari |
| Android（手机端） | ✅ 预期可用 | Tailscale App + Chrome |
| macOS / Linux（电脑端） | 🚧 计划中 | 需要 bash 语法分支（当前命令为 PowerShell 语法） |
| 无 Tailscale 的环境 | ✅ 局域网模式仍可用 | 只展示局域网地址 |

---

## ❓ 常见问题（FAQ）

**Q：平板打开页面是白的/侧边栏空白？**
A：旧 WebKit 缺少 `crypto.randomUUID`，前端初始化崩溃。插件已自动注入 polyfill；若仍异常请**清除浏览器缓存**后重开（Safari：设置 → Safari → 清除历史记录与网站数据）。

**Q：面板显示"Tailscale 未安装"但明明装好了？**
A：tailscale 不在标准安装位置且不在 PATH。插件探测 `D:\Tailscale`、`Program Files` 等位置；如装在别处，把目录加入 PATH 或反馈 issue。

**Q：插件所有命令都失败（exitCode: null）？**
A：典型的 windows-acl 沙箱后端不可用（temp 目录位于 workspace 内部）。插件已显式请求 `danger-full-access`；部署级修复见"配置详解"第 3 条。

**Q：平板能开页面但操作报错（403/forbidden）？**
A：请求的地址不在信任名单。确认使用面板显示的地址（LAN IP / Tailscale IP），或运行"一键配置"把地址写入 `trustedHosts` 后重启。

**Q：Tailscale 安装器反复卡死？**
A：官方 bootstrapper 走系统代理时可能挂起。插件使用 MSI 直连下载 + 静默安装，绕开 bootstrapper。

**Q：平板看到的工作区与电脑不同步？**
A：工作区数据是共享的（同一后端），但**每台设备的浏览状态独立**——平板默认显示欢迎页，手动选择工作区即可看到全部会话。

---

## 🛠️ 开发

```bash
npm install
npm test          # vitest 单元测试（core 纯逻辑，无需真实环境）
npm run build     # tsc 编译到 lib/
```

```
src/
  core.ts     # 纯逻辑：tailscale 探测、配置生成、URL 组装（全部可单测）
  index.ts    # Cordis 插件入口：shell/fs 接线、RPC、命令
test/
  core.test.ts
```

### 路线图

- [x] 状态检测 / 一键配置 / 一键安装 / 一键登录
- [x] 主题化右侧侧边栏（dsw alias tokens）
- [x] 旧浏览器 polyfill
- [ ] 侧边栏面板同步进静态仓库（当前为动态插件验证版）
- [ ] macOS / Linux 的 bash 语法分支
- [ ] Cloudflare 公网隧道模式（移动端零安装）
- [ ] 注册表探测 Tailscale 安装位置

---

## 📄 License

MIT
