import { getAgentDir, SettingsManager } from "@earendil-works/pi-coding-agent";

type PackageEntry = ReturnType<SettingsManager["getPackages"]>[number];
type ManagedPackage = Exclude<PackageEntry, string> & { piWebExtensionFilter?: string[] };

export function togglePackage(entry: PackageEntry, enabled: boolean): PackageEntry {
  const next: ManagedPackage = typeof entry === "string" ? { source: entry } : { ...entry };
  const disabled = Array.isArray(next.extensions) && next.extensions.length === 0;
  if (enabled === !disabled) return entry;
  if (enabled) {
    if (next.piWebExtensionFilter) next.extensions = next.piWebExtensionFilter;
    else delete next.extensions;
    delete next.piWebExtensionFilter;
  } else {
    if (next.extensions) next.piWebExtensionFilter = next.extensions;
    next.extensions = [];
  }
  return next;
}

export async function extensionSettings(cwd: string, change?: { scope: "global" | "project"; source: string; enabled: boolean }, agentDir = getAgentDir()) {
  const manager = SettingsManager.create(cwd, agentDir, { projectTrusted: true });
  const checkErrors = () => {
    const errors = manager.drainErrors();
    if (errors.length) throw new Error(errors.map((item) => item.error.message).join("\n"));
  };
  checkErrors();
  if (change) {
    const settings = change.scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings();
    const packages = settings.packages ?? [];
    if (!packages.some((entry) => (typeof entry === "string" ? entry : entry.source) === change.source)) throw new Error("扩展包配置已变化，请刷新列表");
    const next = packages.map((entry) => (typeof entry === "string" ? entry : entry.source) === change.source ? togglePackage(entry, change.enabled) : entry);
    if (change.scope === "global") manager.setPackages(next);
    else manager.setProjectPackages(next);
    await manager.flush();
    checkErrors();
  }
  return {
    cwd,
    packages: (["global", "project"] as const).flatMap((scope) => {
      const settings = scope === "global" ? manager.getGlobalSettings() : manager.getProjectSettings();
      return (settings.packages ?? []).map((entry) => ({
        scope,
        source: typeof entry === "string" ? entry : entry.source,
        enabled: typeof entry === "string" || entry.extensions?.length !== 0,
        filtered: typeof entry !== "string" && Boolean(entry.extensions?.length),
      }));
    }),
  };
}
