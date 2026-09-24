<div align="center">

# Pi Web

**Your agent. Your workspace. Any screen.**

A browser interface for [Pi Coding Agent](https://pi.dev), inspired by DeepSeek Harness.

[![npm](https://img.shields.io/npm/v/%40oversk7%2Fpi-web-dsh-style?style=flat-square&color=18181b)](https://www.npmjs.com/package/@oversk7/pi-web-dsh-style)
[![Windows](https://img.shields.io/badge/platform-Windows-18181b?style=flat-square)](#requirements)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](https://github.com/oversk7/pi-web-dsh-style/blob/main/LICENSE)

[English](#english) · [简体中文](#简体中文) · [Pi package](https://pi.dev/packages/@oversk7/pi-web-dsh-style) · [Issues](https://github.com/oversk7/pi-web-dsh-style/issues)

</div>

## English

Pi Web brings your Pi sessions to desktop and mobile browsers. Run multiple workspaces and sessions, inspect streaming replies and tool calls, preview files, revisit conversation branches, and use models, slash commands, extensions and skills. Pi and its tools keep running on your own computer. Choose light or dark themes and a custom chat background.

### Requirements

- Windows 10 or 11
- Node.js 22.19 or later
- Pi Coding Agent 0.85.0 or later

### Quick start

Install the extension:

```powershell
pi install npm:@oversk7/pi-web-dsh-style
```

Restart Pi, then launch the web interface:

```powershell
pi --web
```

You can also enter `/web` in an existing Pi terminal. The page opens on your computer; the default local address is `http://127.0.0.1:18789`. To stop the service, run `/web --stop` or exit the host Pi process. Closing the browser tab alone does not stop it.

The interface starts in Chinese. To switch to English, open **设置 (Settings) → 外观 (Appearance) → 界面语言 (Interface language) → English**. Your choice is saved in this browser.

### Phone and remote access

For a phone on the same trusted Wi-Fi, open **Settings → Connection** on the computer, choose **Local network**, and save. Set a password under **Settings → Security** before signing in from your phone. Open the access URL shown in Connection. You can also start with `pi --web-lan` or `/web --lan`. Keep your computer awake and allow Node.js through the Windows firewall for your trusted network. Direct LAN access uses HTTP, so use it only on a trusted network.

For access outside your LAN, select **Server relay** under **Settings → Connection**. This requires your own server with frp (`frps` and an STCP visitor `frpc`), Nginx, and an HTTPS domain. Enter your server address, frps port and token, public HTTPS URL, and the Windows `frpc.exe` path. Download the generated `frps.toml`, `visitor.toml`, and `nginx.conf` from the settings page; adjust the certificate paths and deploy them on your server. The computer running Pi must stay online. See the [detailed guide (Chinese)](https://github.com/oversk7/pi-web-dsh-style/blob/main/docs/guide.md) for the full relay procedure.

### Contributing

Issues and pull requests are welcome. To check a local checkout:

```powershell
git clone https://github.com/oversk7/pi-web-dsh-style.git
cd pi-web-dsh-style
npm install
npm run verify
```

## 简体中文

Pi Web 为 [Pi Coding Agent](https://pi.dev) 提供浏览器界面，灵感来自 DeepSeek Harness。在桌面或手机上切换多个工作区与会话，查看流式回答、工具调用和文件预览，浏览会话分支，并使用模型、斜杠命令、扩展与技能。Pi 和工具仍运行在自己的电脑上。支持明暗主题和自定义聊天背景。

### 系统要求

- Windows 10 或 11
- Node.js 22.19 或更高版本
- Pi Coding Agent 0.85.0 或更高版本

### 快速开始

安装扩展：

```powershell
pi install npm:@oversk7/pi-web-dsh-style
```

重启 Pi，然后启动网页界面：

```powershell
pi --web
```

也可以在已有的 Pi 终端中输入 `/web`。网页会在本机打开，默认地址为 `http://127.0.0.1:18789`。执行 `/web --stop` 或退出宿主 Pi 可停止服务；仅关闭浏览器标签页不会停止服务。

界面默认使用中文。打开 **设置 → 外观 → 界面语言**，即可一键切换中文或 English；选择会保存在当前浏览器。

### 手机与远程访问

手机与电脑在同一可信 Wi-Fi 下时，在电脑网页的 **设置 → 连接** 中选择 **局域网** 并保存，然后到 **设置 → 安全** 设置访问密码。手机打开连接页面显示的地址并输入密码即可使用。也可以用 `pi --web-lan` 或 `/web --lan` 启动。电脑需保持运行，Windows 防火墙需允许 Node.js 在可信网络内通信。局域网直连使用 HTTP，请只在可信网络使用。

跨网络访问可在 **设置 → 连接** 中选择 **服务器中转**。这需要自有服务器运行 frp（`frps` 与 STCP 访问端 `frpc`）、Nginx 和 HTTPS 域名。填写服务器地址、frps 端口及密钥、公开 HTTPS 地址和电脑上的 `frpc.exe` 路径；从设置页下载生成的 `frps.toml`、`visitor.toml` 与 `nginx.conf`，调整证书路径后部署到服务器。运行 Pi 的电脑需保持在线。完整步骤见[使用指南](https://github.com/oversk7/pi-web-dsh-style/blob/main/docs/guide.md)。

### 参与开发

欢迎通过 [Issues](https://github.com/oversk7/pi-web-dsh-style/issues) 或 PR 反馈问题和改进。在本地验证源码：

```powershell
git clone https://github.com/oversk7/pi-web-dsh-style.git
cd pi-web-dsh-style
npm install
npm run verify
```

## Credits / 致谢

Built on [Pi](https://pi.dev). Inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness). This is an independent community extension and is not affiliated with either project.

基于 [Pi](https://pi.dev)，界面灵感来自 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)。这是独立的社区扩展，与双方官方均无隶属关系。

Another extension by the same author / 同一作者的其他扩展：[pi-pwsh-notify](https://github.com/oversk7/pi-pwsh-notify) (PowerShell 7 tools and background job notifications / PowerShell 7 工具与后台任务通知)。

[MIT](https://github.com/oversk7/pi-web-dsh-style/blob/main/LICENSE) · [Third-party notices / 第三方许可](https://github.com/oversk7/pi-web-dsh-style/blob/main/THIRD_PARTY_NOTICES.md)
