import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

interface ReadResult {
  kind: "missing" | "present";
  raw?: string;
}

async function readOptional(path: string): Promise<ReadResult> {
  try {
    return { kind: "present", raw: await readFile(path, "utf8") };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { kind: "missing" };
    throw new Error(`Unable to read pi-web state at ${path}`, { cause: error });
  }
}

function parseState<T>(path: string, raw: string, validate: (value: unknown) => value is T): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new Error(`Invalid JSON in pi-web state at ${path}`, { cause: error });
  }
  if (!validate(parsed)) throw new Error(`Invalid pi-web state structure at ${path}`);
  return parsed;
}

export async function writeJsonAtomically(path: string, value: unknown): Promise<void> {
  await writeTextAtomically(path, `${JSON.stringify(value, null, 2)}\n`);
}

export async function writeTextAtomically(path: string, content: string): Promise<void> {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  await mkdir(dirname(path), { recursive: true });
  try {
    await writeFile(tmp, content, "utf8");
    await rename(tmp, path);
  } catch (error) {
    await unlink(tmp).catch(() => {});
    throw new Error(`Unable to write pi-web state at ${path}`, { cause: error });
  }
}

export async function loadJsonWithLegacyMigration<T>(options: {
  stateFile: string;
  legacyStateFile?: string;
  validate: (value: unknown) => value is T;
}): Promise<T | undefined> {
  const current = await readOptional(options.stateFile);
  if (current.kind === "present") {
    return parseState(options.stateFile, current.raw!, options.validate);
  }

  const legacyPath = options.legacyStateFile;
  if (!legacyPath || resolve(legacyPath) === resolve(options.stateFile)) return undefined;
  const legacy = await readOptional(legacyPath);
  if (legacy.kind === "missing") return undefined;

  const parsed = parseState(legacyPath, legacy.raw!, options.validate);
  await writeTextAtomically(options.stateFile, legacy.raw!);
  return parsed;
}
