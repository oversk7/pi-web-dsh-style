export interface WebSlashCommand {
  name: string;
  description: string;
  acceptsArgs?: boolean;
  source: string;
  local: boolean;
}
export const webSlashCommands: WebSlashCommand[];
export const unsupportedSlashCommands: Record<string, string>;
export function parseSlashCommand(text: string): { name: string; args: string } | null;
export function builtinCommandError(name: string): string | null;
