export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export type SessionPatch =
  | { op: "set"; path: (string | number)[]; value: JsonValue }
  | { op: "delete"; path: (string | number)[] }
  | { op: "append"; path: (string | number)[]; value: string }
  | { op: "truncate"; path: (string | number)[]; length: number };
/** Detached JSON normalization: undefined object fields disappear; array holes become null. */
export function canonicalizeJson(value: unknown): JsonValue | undefined;
/** Compare canonical JSON, emitting string suffixes and changes to individual paths. */
export function diffSessionSnapshots(previous: JsonValue, next: JsonValue): SessionPatch[];
/** Immutable application with structural sharing; invalid or unsafe paths throw. */
export function applySessionPatches<T extends JsonValue>(snapshot: T, patches: readonly SessionPatch[]): T;
