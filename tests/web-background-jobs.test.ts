import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { createContext, runInContext } from "node:vm";

const app = await readFile(new URL("../web/app.js", import.meta.url), "utf8");
const escapeSource = app.slice(app.indexOf("function esc("), app.indexOf("function el("));
const statsSource = app.slice(app.indexOf("function extensionStatusClass("), app.indexOf("function backgroundJobLabel("));
const jobsSource = app.slice(app.indexOf("function backgroundJobLabel("), app.indexOf("function formatCost("));

test("only the pwsh background status becomes an escaped, keyboard accessible button", () => {
  const context = createContext({ fmtNum: String, formatCost: String });
  runInContext(`${escapeSource}\n${statsSource}`, context);
  const html = runInContext('renderStats({extensionStatuses:{"pwsh-bg":"1 bg job running <x>",other:"hello"}})', context);
  assert.match(html, /<button[^>]+data-action="background-jobs"[^>]+aria-haspopup="dialog"/);
  assert.match(html, /1 bg job running &lt;x&gt;/);
  assert.match(html, /<span[^>]+title="hello">hello<\/span>/);
});

test("log dialog refreshes, preserves reading position, switches jobs and cancels on close", async () => {
  const handlers: Record<string, (event?: any) => void> = {};
  const select = { innerHTML: "", value: "", disabled: false, addEventListener: (name: string, fn: any) => { handlers[`select:${name}`] = fn; } };
  const output = { textContent: "", scrollTop: 0, scrollHeight: 600, clientHeight: 200 };
  const status = { textContent: "" };
  const command = { textContent: "" };
  const button = { addEventListener: (name: string, fn: any) => { handlers[`button:${name}`] = fn; } };
  let removed = false;
  let focused = false;
  const dialog = { addEventListener: (name: string, fn: any) => { handlers[name] = fn; }, showModal() {}, close: () => handlers.close(), remove: () => { removed = true; } };
  const nodes: Record<string, unknown> = { select, button, ".pi-backgroundJobsOutput": output, ".pi-backgroundJobsStatus": status, ".pi-backgroundJobsCommand": command };
  const requests: { path: string; signal: AbortSignal }[] = [];
  const pending: ((result: unknown) => void)[] = [];
  let timer: (() => Promise<void>) | undefined;
  const context = createContext({
    S: { currentSessionId: "session-a" }, AbortController,
    document: { activeElement: { isConnected: true, focus() { focused = true; } }, body: { appendChild() {} } },
    el: () => dialog, $: (selector: string) => nodes[selector],
    api: (path: string, { signal }: { signal: AbortSignal }) => { requests.push({ path, signal }); return new Promise((resolve) => pending.push(resolve)); },
    setTimeout: (fn: () => Promise<void>) => { timer = fn; return 1; }, clearTimeout: () => { timer = undefined; },
  });
  runInContext(`${escapeSource}\n${jobsSource}\nopenBackgroundJobs()`, context);
  const jobs = [{ id: "call-a", jobId: "bg-1", name: "first" }, { id: "call-b", jobId: "bg-2", name: "second" }];
  const settle = async (job: object, text: string) => {
    pending.shift()!({ jobs, job, output: text, truncated: false });
    await new Promise((resolve) => setImmediate(resolve));
  };
  await settle(jobs[0], "<script>log text</script>");
  assert.equal(output.textContent, "<script>log text</script>");
  assert.equal(output.scrollTop, 600);
  output.scrollTop = 50;
  const refresh = timer!();
  await settle(jobs[0], "new log");
  await refresh;
  assert.equal(output.scrollTop, 50);
  select.value = "call-b";
  handlers["select:change"]();
  assert.match(requests.at(-1)!.path, /session-a\/background-jobs\?job=call-b$/);
  await settle(jobs[1], "second log");
  assert.equal(output.textContent, "second log");
  const inFlight = timer!();
  handlers["button:click"]();
  assert.equal(removed, true);
  assert.equal(focused, true);
  assert.equal(requests.at(-1)!.signal.aborted, true);
  await settle(jobs[1], "late response");
  await inFlight;
  assert.equal(output.textContent, "second log");
  assert.equal(timer, undefined);
});
