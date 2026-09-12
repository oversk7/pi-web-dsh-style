import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const manifest = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

assert.equal(manifest.name, "@oversk7/pi-web-dsh-style");
assert.notEqual(manifest.private, true);
assert.ok(manifest.keywords?.includes("pi-package"));
assert.ok(manifest.keywords?.includes("dsh"));
assert.deepEqual(manifest.os, ["win32"]);
assert.equal(manifest.publishConfig?.access, "public");
assert.equal(manifest.publishConfig?.registry, "https://registry.npmjs.org");
assert.equal(manifest.publishConfig?.tag, "latest");
assert.match(manifest.version, /^\d+\.\d+\.\d+$/);
const lock = JSON.parse(await readFile(new URL("../package-lock.json", import.meta.url), "utf8"));
assert.equal(lock.version, manifest.version);
assert.equal(lock.packages?.[""]?.version, manifest.version);
assert.ok(manifest.pi?.extensions?.includes("./index.ts"));
assert.equal(manifest.peerDependencies?.["@earendil-works/pi-coding-agent"], "*");
assert.equal(manifest.peerDependencies?.["@earendil-works/pi-ai"], "*");
assert.ok(Array.isArray(manifest.files));
for (const required of ["windows-rpc-job.ps1", "network-access.ts", "network-settings.ts", "frp-process.ts"]) assert.ok(manifest.files.includes(required), `Missing runtime file: ${required}`);
assert.ok((await readFile(new URL("../windows-rpc-job.ps1", import.meta.url), "utf8")).includes("JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE"));
assert.ok(!manifest.files.some((path) => /(^|\/)state\.json$/i.test(path)));

const sourceFiles = manifest.files.filter((path) => path.endsWith(".ts"));
const forbidden = [
  /dist[\\/]bundle[\\/]cli\.js/,
  /dist[\\/]utils[\\/]/,
  /resolvePiDistDir/,
  /import\.meta\.resolve\(["']@earendil-works\/pi-coding-agent/,
];
for (const path of sourceFiles) {
  const source = await readFile(new URL(`../${path}`, import.meta.url), "utf8");
  for (const pattern of forbidden) {
    assert.ok(!pattern.test(source), `${path} contains private pi path dependency: ${pattern}`);
  }
}

console.log("package boundary checks passed");
