// Paths contain object keys or array indices. Operations are set, delete (object
// field), append (string suffix), and truncate (array length). A root set resets
// structure. Paths traverse only own properties, including ordinary JSON keys
// such as __proto__; assignments cannot invoke prototype setters.
const own = (value, key) => Object.prototype.hasOwnProperty.call(value, key);
function setOwn(value, key, item) {
  Object.defineProperty(value, key, { value: item, enumerable: true, writable: true, configurable: true });
}

export function canonicalizeJson(value) {
  const ancestors = new Set();
  function visit(input, key = "") {
    if (input && typeof input.toJSON === "function") input = input.toJSON(key);
    if (input === null || typeof input === "string" || typeof input === "boolean") return input;
    if (typeof input === "number") return Number.isFinite(input) ? input : null;
    if (typeof input === "bigint") throw new TypeError("BigInt is not JSON data");
    if (typeof input !== "object") return undefined;
    if (ancestors.has(input)) throw new TypeError("Circular JSON data");
    ancestors.add(input);
    let result;
    if (Array.isArray(input)) {
      result = Array.from({ length: input.length }, (_, i) => visit(input[i], String(i)) ?? null);
    } else {
      result = {};
      for (const key of Object.keys(input)) {
        const item = visit(input[key], key);
        if (item !== undefined) setOwn(result, key, item);
      }
    }
    ancestors.delete(input);
    return result;
  }
  return visit(value);
}

// Compare detached canonical JSON without serializing unchanged history strings.
export function diffSessionSnapshots(previous, next) {
  const patches = [];
  function walk(before, after, path) {
    if (before === after) return;
    if (typeof before === "string" && typeof after === "string" && after.startsWith(before)) {
      patches.push({ op: "append", path, value: after.slice(before.length) });
    } else if (Array.isArray(before) && Array.isArray(after)) {
      const common = Math.min(before.length, after.length);
      for (let i = 0; i < common; i++) walk(before[i], after[i], [...path, i]);
      for (let i = common; i < after.length; i++) patches.push({ op: "set", path: [...path, i], value: after[i] });
      if (after.length < before.length) patches.push({ op: "truncate", path, length: after.length });
    } else if (before && after && typeof before === "object" && typeof after === "object" && !Array.isArray(before) && !Array.isArray(after)) {
      for (const key of Object.keys(before)) {
        if (!own(after, key)) patches.push({ op: "delete", path: [...path, key] });
      }
      for (const key of Object.keys(after)) {
        if (own(before, key)) walk(before[key], after[key], [...path, key]);
        else patches.push({ op: "set", path: [...path, key], value: after[key] });
      }
    } else {
      patches.push({ op: "set", path, value: after });
    }
  }
  walk(previous, next, []);
  return patches;
}

// Rebuild only modified paths; the input snapshot and unchanged branches retain
// their identity. Invalid operations throw before any input can be mutated.
export function applySessionPatches(snapshot, patches) {
  if (!Array.isArray(patches)) throw new TypeError("Expected patches array");
  let result = snapshot;
  for (const patch of patches) {
    if (!patch || !["set", "delete", "append", "truncate"].includes(patch.op) || !Array.isArray(patch.path)) throw new TypeError("Invalid patch");
    for (const key of patch.path) {
      if (typeof key !== "string" && (!Number.isSafeInteger(key) || key < 0)) throw new TypeError("Invalid patch path");
    }
    function update(current, depth) {
      if (depth === patch.path.length) {
        if (patch.op === "set") {
          if (!own(patch, "value")) throw new TypeError("Missing patch value");
          const value = canonicalizeJson(patch.value);
          if (value === undefined) throw new TypeError("Invalid patch value");
          return value;
        }
        if (patch.op === "append" && typeof current === "string" && typeof patch.value === "string") return current + patch.value;
        if (patch.op === "truncate" && Array.isArray(current) && Number.isSafeInteger(patch.length) && patch.length >= 0 && patch.length <= current.length) return current.slice(0, patch.length);
        throw new TypeError("Invalid patch target");
      }
      const key = patch.path[depth];
      if (!current || typeof current !== "object") throw new TypeError("Invalid patch parent");
      const array = Array.isArray(current);
      if (array ? typeof key !== "number" || key > current.length : typeof key !== "string") throw new TypeError("Invalid patch key");
      const leaf = depth === patch.path.length - 1;
      const exists = own(current, key);
      if (!exists && !(leaf && patch.op === "set")) throw new TypeError("Missing patch path");
      const copy = array ? current.slice() : { ...current };
      if (leaf && patch.op === "delete") {
        if (array) throw new TypeError("Use truncate for arrays");
        delete copy[key];
      } else {
        setOwn(copy, key, update(exists ? current[key] : undefined, depth + 1));
      }
      return copy;
    }
    result = update(result, 0);
  }
  return result;
}
