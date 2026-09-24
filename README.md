# @oversk7/pi-web-dsh-style

[GitHub 源码](https://github.com/oversk7/pi-web-dsh-style) · [问题与建议](https://github.com/oversk7/pi-web-dsh-style/issues) · [npm](https://www.npmjs.com/package/@oversk7/pi-web-dsh-style) · [Pi 扩展目录](https://pi.dev/packages/@oversk7/pi-web-dsh-style)

采用 DeepSeek Harness（DSH）视觉风格、面向 Windows 的非官方 Pi Coding Agent 本地浏览器界面扩展。后端使用 Pi 的公开 RPC 模式，每个会话对应独立的 RPC 进程；历史会话可直接从 Pi 会话文件恢复和渲染。

> 仅承诺 Windows 10/11。首次启动只监听 `127.0.0.1`；电脑网页的“设置 → 手机访问”可配置仅本机、局域网和服务器中转。之后 `pi --web` 使用已保存的模式。

## 安装

需要 Node.js 22.19 或更高版本，以及 Pi Coding Agent 0.85.0 或更高版本。

```powershell
pi install npm:@oversk7/pi-web-dsh-style
```

也可以从源码目录安装：

```powershell
pi install C:\path\to\pi-web
```

安装后重启 Pi，或执行 `/reload`。

## 使用

直接启动：

```powershell
pi --web
```

也可以在 Pi 终端中执行：

```text
/web
/web --no-open
/web --port 18789
/web --lan
/web --relay
/web --local
/web --stop
```

### 网页会话中的斜杠命令

输入 `/` 可查看当前可用命令。Web 内置命令包括 `/settings`、`/model`、`/thinking`、`/export`、`/copy`、`/name`、`/session`、`/new`、`/resume`、`/rewind`、`/tree`、`/compact` 和 `/reload`。

- `/model provider/model` 精确匹配时切换模型；未唯一匹配时打开带搜索词的模型选择器。`/thinking high` 切换当前模型支持的思考强度，两者不带参数时打开选择器。
- `/compact 压缩要求` 会将要求传给 Pi；`/name 名称` 修改会话名称，不带参数时显示当前名称。
- `/resume` 打开侧栏会话搜索；`/export` 下载 HTML 到浏览器下载目录，暂不接受导出路径或 JSONL 格式参数。
- 网页会话中的 `/reload` 只重载当前会话的扩展与配置。要重载整个 Web 服务，请使用设置中的“重新加载”或在宿主 Pi 终端执行 `/reload`。

扩展命令、提示词模板和 `/skill:名称` 由当前会话的 Pi RPC 进程执行。未知命令会报错并保留草稿，不会作为普通消息发送给模型；普通消息需要避免以 `/` 开头。

`/scoped-models`、`/import`、`/share`、`/fork`、`/clone`、`/trust`、`/changelog`、`/hotkeys`、`/login`、`/logout` 和 `/quit` 尚未提供对应的 Web 操作，输入时会显示说明。需要这些 Pi 功能时请使用终端。

### 手机通过局域网访问

电脑和手机连接同一 Wi-Fi，在电脑本机网页“设置 → 手机访问”中选择“局域网”并保存。也可以执行 `/web --lan`，或直接以 `pi --web-lan` 启动。首次使用时，在同一设置中设置固定密码；之后手机打开显示的地址，输入该密码即可登录。界面只显示一个手机访问地址，优先使用 Wi-Fi，并过滤 WSL、Hyper-V 等虚拟网卡。

手机登录状态保留 30 天。密码在服务重启后继续有效，可在电脑本机网页中修改；修改密码后，已登录的手机需要重新登录。

手机与电脑共用工作区和会话，可各自切换、发送消息、停止生成及回答扩展提问。手机上点击左上角按钮展开会话列表；输入框回车换行，点击发送按钮提交；图片按钮选择手机图片。手机切回前台或网络重连时会刷新会话内容。

设置面板及 `/web --lan`、`/web --relay`、`/web --local` 会保存模式并切换正在运行的服务，保留后台会话进程。切换时浏览器实时连接会重新连接。执行 `/reload` 会保留端口和访问模式；重载或重启服务会保留密码和未过期的登录状态。

首次开启时，如 Windows 弹出防火墙提示，请允许 Node.js 在当前可信网络上接收连接。若手机仍无法打开，检查防火墙是否允许该端口，以及 Wi-Fi 是否启用了客户端隔离。电脑需要保持运行且未休眠。

局域网直连使用 HTTP，请只在可信局域网内使用。

### 通过服务器中转

电脑运行扩展和原生 `frpc`，服务器运行 `frps`、作为 STCP 访问端的 `frpc` 以及 Nginx。手机通过服务器的 HTTPS 域名访问，适用于校园网客户端隔离等无法直连的网络。电脑上的 `frpc` 由扩展启动和关闭，中转请求直接进入扩展的 Web 服务。

1. 从 [frp 官方 Releases](https://github.com/fatedier/frp/releases) 下载电脑对应架构的 Windows 版本，将 `frpc.exe` 解压到固定位置。客户端和服务器建议使用相同版本（已验证 0.70.1）。
2. 在电脑网页“设置 → 手机访问”选择“服务器中转”，填写服务器域名或 IPv4、frps 端口（默认 `7000`）、frps 认证密钥、手机 HTTPS 入口（如 `https://web.example.com`），以及 `frpc.exe` 路径。路径留空时从 PATH 查找 `frpc`；相对路径以状态目录为基准。认证密钥留空会保留已保存的值。
3. 保存后，下载设置中生成的 `frps.toml`、`visitor.toml` 和 `nginx.conf`。隧道名称和私有密钥自动生成；隧道名称及服务器内部端口可在高级配置中调整。将域名 DNS 指向服务器，并为该域名准备有效的 HTTPS 证书。
4. 服务器安装原生 frp 和 Nginx。新服务器使用 `frps -c frps.toml`，访问端使用 `frpc -c visitor.toml`，并用 systemd 等服务管理器保持运行。已有 frps 时复用现有端口和认证密钥，保留其配置。把生成的 Nginx 配置中的证书路径替换成实际证书路径，再安装到 Nginx 的站点配置目录，执行 `nginx -t` 验证并重载。

手机打开显示的 HTTPS 地址，输入原有固定密码即可使用。设置会显示 frpc 的连接或错误状态；服务器暂时不可达时 frpc 自动重连，本机网页仍可使用。后续执行 `pi --web` 会自动恢复保存的中转模式；也可以用 `pi --web-relay` 或 `/web --relay` 明确启用已配置的中转。

服务器需开放 HTTPS 端口和 frps 控制端口；生成的 STCP 访问端仅监听服务器 `127.0.0.1`，无须开放其内部端口。Nginx 配置保留域名 Host、附加代理密钥、限制登录请求速率，并关闭缓冲以支持实时消息。公网访问由扩展直接验证来源和固定密码，登录 Cookie 带有 `Secure` 标记。中转模式下，电脑 Web 服务仅监听本机回环地址。

网络配置和服务器配置下载仅对电脑本机网页开放。更换服务器域名、隧道名称、认证密钥或服务器内部端口后，需要同步部署重新下载的服务器配置。电脑上的 Pi Web 需要保持运行且未休眠。

## 功能

- 多工作区、多会话和后台会话并行运行。
- 按需启动 Pi RPC 进程，最多保留一个空闲进程。
- Windows 会话使用 Job Object 托管进程树：停止 Web 或宿主退出时，清理 RPC 及其启动的后台服务、子进程和孙进程。
- 模型、思考等级、中断、压缩和扩展交互对话框。
- 运行中逐条显示待处理消息，可单条撤回并重新编辑；`Alt+Q` 可将全部队列消息恢复到输入框。
- 会话历史保留完整分支与检查点，支持回溯后返回切换前的位置，以及 `pi-rewind` 文件恢复。
- Windows 系统剪贴板图片和文本粘贴；手机支持选择或粘贴本机图片。
- 会话中的本地文件链接可在右侧分栏预览，支持语法高亮、行定位和拖拽调整宽度。
- 设置面板内更新扩展并热重载 Pi 运行时，无需退出 Web UI。
- 会话 HTML 导出。

## 进程生命周期

`/web --stop`、宿主 Pi 退出或运行时重载会关闭扩展托管的 frpc 和 Web 会话进程及其后代，包括 detached 后台进程；即使宿主被强制结束，Windows 托管进程也会检测到宿主退出并清理整棵进程树。不会扫描或结束工作区外独立启动的进程，也不会结束其他 Pi 实例。

单个 RPC 进程退出、异常终止或被空闲进程回收时，它启动的后台进程也会一起结束。需要独立于会话长期运行的服务，应从 Web 会话之外的终端启动。通过系统服务管理器、计划任务等外部机制启动的进程不属于此进程树。

只关闭浏览器标签页不会停止 Web 服务或后台会话；要结束它们，请执行 `/web --stop` 或退出宿主 Pi。进程托管依赖 Windows 10/11 自带的 Windows PowerShell 和 Win32 Job Object；如果无法建立托管，RPC 启动会失败，不会回退为无托管进程。

## 数据与升级

运行状态保存在：

```text
~/.pi/agent/pi-web/state.json
```

访问密码的加盐哈希和登录签名密钥保存在同一目录的 `auth.json` 中，不保存明文密码。

访问模式及中转配置保存在同一目录的 `network.json` 中。中转所需的 frps 认证密钥、STCP 私有密钥和代理密钥保存在此文件；普通设置响应不返回这些密钥，服务器配置下载会包含部署所需的密钥。配置文件不属于发布包。运行时的 frpc 配置写入状态目录下的 `runtime/`，正常停止时清理。

从旧版目录安装首次升级时，如果新位置尚无状态文件，扩展会从扩展目录中的旧 `state.json` 原样复制并继续使用。旧文件不会被删除或改写，可作为迁移备份。

可用环境变量：

- `PI_WEB_STATE_DIR`：覆盖状态目录。
- `PI_WEB_STATE_FILE`：覆盖状态文件。
- `PI_WEB_LEGACY_STATE_FILE`：指定迁移来源。
- `PI_WEB_RPC_ENTRY`：覆盖 Pi 的公开 RPC 入口文件。
- `PI_WEB_PI_CLI`：兼容旧版的 Pi CLI 路径覆盖。
- `PI_WEB_POWERSHELL`：覆盖用于剪贴板读取的 `powershell.exe`。

截图会临时写入系统临时目录，并在 24 小时后或服务停止时清理。Pi 会话内容仍由 Pi 自身保存在其会话目录中。

## 开发验证

```powershell
npm install
npm run verify
npm pack --dry-run
```

发布正式版：

```powershell
npm login --registry=https://registry.npmjs.org
npm publish --access public --tag latest
```

## 反馈与相关扩展

欢迎通过 [GitHub Issues](https://github.com/oversk7/pi-web-dsh-style/issues) 反馈问题、提出建议，或分享使用场景。报告问题时，请附上扩展版本、Pi 版本、Windows 版本和复现步骤；涉及手机访问时，请说明使用的是局域网还是服务器中转。

同一作者的 [pi-pwsh-notify](https://github.com/oversk7/pi-pwsh-notify) 为 Pi 提供 Windows PowerShell 7 工具，以及后台任务完成自动通知功能。

## 许可证

原创代码使用 MIT License。Web UI 的部分样式和设计 token 改编自 DeepSeek Harness，字体资源来自 KaTeX，代码高亮使用 highlight.js。完整归属与许可证见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
