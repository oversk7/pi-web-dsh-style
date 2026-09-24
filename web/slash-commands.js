// Shared by the browser and server so built-in commands never fall through to RPC prompts.
export const webSlashCommands = [
  { name: "settings", description: "打开界面与运行时设置" },
  { name: "model", description: "选择当前模型", acceptsArgs: true },
  { name: "thinking", description: "选择思考强度", acceptsArgs: true },
  { name: "export", description: "将当前会话下载为 HTML" },
  { name: "copy", description: "复制最后一条助手回复" },
  { name: "name", description: "设置当前会话名称", acceptsArgs: true },
  { name: "session", description: "显示会话统计信息" },
  { name: "new", description: "在当前工作区创建新会话" },
  { name: "resume", description: "打开侧栏搜索并切换会话" },
  { name: "rewind", description: "回溯对话，可选择同步恢复文件" },
  { name: "tree", description: "打开当前会话的分支树" },
  { name: "compact", description: "压缩当前会话，可附加压缩要求", acceptsArgs: true },
  { name: "reload", description: "重新加载当前会话的扩展与配置" },
].map((command) => ({ ...command, source: "builtin", local: true }));

export const unsupportedSlashCommands = {
  "scoped-models": "Web 暂不支持终端模型轮换范围，请使用 /model 选择模型。",
  import: "Web 暂不支持从命令导入 JSONL 文件，请在 Pi 终端执行 /import。",
  share: "Web 暂不支持发布 GitHub gist，请使用 /export 下载会话，或在 Pi 终端执行 /share。",
  fork: "Web 暂不支持创建分叉副本，请在 Pi 终端执行 /fork；同一会话内切换分支可使用 /tree。",
  clone: "Web 暂不支持复制整个会话，请在 Pi 终端执行 /clone。",
  trust: "项目信任设置需要在 Pi 终端中通过 /trust 管理。",
  changelog: "Web 暂不展示 Pi 更新日志，请在 Pi 终端执行 /changelog。",
  hotkeys: "终端快捷键不适用于网页。网页输入框支持 Enter 发送、Shift+Enter 换行，命令菜单支持方向键选择和 Tab 补全。",
  debug: "此调试命令仅支持 Pi 终端。",
  arminsayshi: "此彩蛋命令仅支持 Pi 终端。",
  dementedelves: "此彩蛋命令仅支持 Pi 终端。",
  login: "Web 暂不支持登录流程，请在启动 Pi 的终端执行 /login。",
  logout: "Web 暂不支持注销流程，请在启动 Pi 的终端执行 /logout。",
  quit: "请关闭网页标签页；如需退出 Pi，请在启动 Pi 的终端执行 /quit。",
};

export function parseSlashCommand(text) {
  const match = /^\/([^\s]+)(?:\s+([\s\S]*))?$/.exec(text.trim());
  return match ? { name: match[1], args: (match[2] || "").trim() } : null;
}

export function builtinCommandError(name) {
  if (Object.hasOwn(unsupportedSlashCommands, name)) return unsupportedSlashCommands[name];
  if (webSlashCommands.some((command) => command.name === name)) {
    return `/${name} 需要由 Web 命令入口执行，请刷新网页后重试。`;
  }
  return null;
}
