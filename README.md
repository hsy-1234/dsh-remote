# dsh-remote

DeepSeek Harness 远程访问管家插件：一键查看/配置 **Tailscale** 与**局域网**访问，让你在平板上输入一个地址就能看到并操作电脑上的 Harness Web UI。

> ⚠️ **安全提示**：Web UI 可以完全控制你的电脑（执行命令、读写文件、调用模型）。本项目只负责"网络可达性"，**不提供用户认证**。异地访问请使用 Tailscale 加密隧道，**切勿将 3080 端口直接暴露到公网**。

## 功能

- 📊 **状态检测**：Tailscale 安装/登录/IP/MagicDNS 名、Web UI 监听状态、profile 配置状态
- ⚙️ **一键配置**（`/remote-fix`）：把 `host: 0.0.0.0` 和 Tailscale 信任地址写入 `~/.dsh/profiles/web/cordis.patch.yml`
- 📍 **地址展示**（`/remote`）：局域网地址、Tailscale 地址、MagicDNS 域名
- 🔌 **跨平台命令**：内置 PowerShell 语法（Windows 的 `ctx.shell` 是 pwsh 执行器），并在 PATH 之外探测多个 Tailscale 安装位置

## 快速开始

### 1. 安装插件

在 dsh 的 web profile 里引用本包（本地路径或 npm 包名），在 `~/.dsh/profiles/web/cordis.patch.yml` 中追加：

```yaml
- insert:
    - id: dsh-remote
      name: 'dsh-remote'   # 或本地路径: '/path/to/dsh-remote/lib/index.js'
```

> 在仓库根目录构建：`npm install && npm run build`，产物在 `lib/`。

### 2. 使用

重启 `dsh web` 后，在会话输入框输入：

- `/remote` —— 查看远程访问状态与全部可用地址
- `/remote-fix` —— 写入远程访问配置（监听 0.0.0.0 + Tailscale 信任名单），重启后生效

### 3. 平板访问

- 电脑与平板安装 [Tailscale](https://tailscale.com/download)，登录同一账号
- 平板浏览器打开 `/remote` 显示的 Tailscale 地址（如 `http://100.x.y.z:3080`）
- 同一 WiFi 下可直接访问局域网地址（`http://192.168.x.x:3080`）

## 原理

| 组件 | 说明 |
| --- | --- |
| `webserver` 行 | dsh 默认只监听 `127.0.0.1`；插件把它改为 `0.0.0.0`（所有网卡） |
| browser-trust fence | `/api` 的信任围栏（防 DNS rebinding）；当监听为 `0.0.0.0` 时，dsh 自动信任所有本机 IPv4 地址（含 Tailscale 虚拟网卡的 `100.x.y.z`）；插件把 Tailscale 地址显式加入 `trustedHosts` 双保险 |
| 沙箱策略 | Windows 上 `ctx.shell` 是 pwsh 沙箱执行器；当默认 `workspace-write` 的 windows-acl 后端因 temp 目录位于 workspace 内而无法启动时，插件显式请求 `danger-full-access` 绕开（它管理的是机器级网络配置） |

## 开发

```bash
npm install
npm test        # vitest 单元测试（core 逻辑，无需真实环境）
npm run build   # tsc 编译到 lib/
```

## 项目结构

```
src/
  core.ts    # 纯逻辑：tailscale 探测、配置生成、URL 组装（全部可单测）
  index.ts   # Cordis 插件入口：shell/fs 接线 + /remote、/remote-fix 命令
test/
  core.test.ts
```

## 安全清单

- [ ] 不要对 3080 做路由器端口映射（DMZ/UPnP）暴露到公网
- [ ] 异地访问只用 Tailscale 或其他 VPN/加密隧道
- [ ] 了解信任围栏的边界：它验证请求 Host 头，不是用户认证

## License

MIT
