<div align="center">

# Pi Web

**Your agent. Your workspace. Any screen.**

为 [Pi Coding Agent](https://pi.dev) 打开一个浏览器窗口。

[![npm](https://img.shields.io/npm/v/%40oversk7%2Fpi-web-dsh-style?style=flat-square&color=18181b)](https://www.npmjs.com/package/@oversk7/pi-web-dsh-style)
[![Windows](https://img.shields.io/badge/platform-Windows-18181b?style=flat-square)](#quick-start)
[![MIT](https://img.shields.io/badge/license-MIT-18181b?style=flat-square)](LICENSE)

[快速开始](#quick-start) · [使用指南](https://github.com/oversk7/pi-web-dsh-style/blob/main/docs/guide.md) · [Pi 扩展目录](https://pi.dev/packages/@oversk7/pi-web-dsh-style) · [反馈与建议](https://github.com/oversk7/pi-web-dsh-style/issues)

</div>

---

灵感来自 DeepSeek Harness 的界面，熟悉的 Pi 工作流。
在桌面展开工作区，在手机接着看进度。模型、工具和会话仍运行在自己的电脑上。

## Highlights

- **并行工作** — 多工作区、多会话，随时切换正在进行的任务。
- **保留上下文** — 浏览会话分支，回到之前的检查点，继续探索。
- **看清过程** — 流式回答、工具调用、思考过程和文件预览。
- **随处接入** — 桌面与手机，共用同一套会话；支持局域网和自托管中转。
- **延续习惯** — 模型切换、斜杠命令、扩展与技能，融入浏览器界面。
- **自己的风格** — 明暗主题、配色与自定义背景。

## Quick start

需要 **Windows 10/11**、**Node.js ≥ 22.19** 和 **Pi ≥ 0.85.0**。

```powershell
pi install npm:@oversk7/pi-web-dsh-style
```

重启 Pi，然后启动：

```powershell
pi --web
```

也可以在已有 Pi 终端中输入 `/web`。

手机访问从 **设置 → 手机访问** 开始。更多配置见[使用指南](https://github.com/oversk7/pi-web-dsh-style/blob/main/docs/guide.md)。

## Contributing

欢迎 Issue 和 PR。Bug、想法、使用体验，都可以从[这里](https://github.com/oversk7/pi-web-dsh-style/issues)开始。

```powershell
git clone https://github.com/oversk7/pi-web-dsh-style.git
cd pi-web-dsh-style
npm install
npm run verify
```

## Credits

Built on [Pi](https://pi.dev). Inspired by [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).

这是一个社区扩展，与 Pi 和 DeepSeek 官方无隶属关系。

另一个小工具：[pi-pwsh-notify](https://github.com/oversk7/pi-pwsh-notify) — 为 Pi 带来 PowerShell 7 与后台任务通知。

[MIT](LICENSE) · [Third-party notices](THIRD_PARTY_NOTICES.md)
