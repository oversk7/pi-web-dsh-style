import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { readFile, writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { setTimeout as delay } from "node:timers/promises";

const file = fileURLToPath(import.meta.url);
const [mode, marker] = process.argv.slice(2);
if (mode === "service") {
  const server = createServer();
  server.listen(0, "127.0.0.1", async () => {
    await writeFile(marker, JSON.stringify({ pid: process.pid, port: server.address().port }));
  });
} else if (mode === "intermediate") {
  const service = spawn(process.execPath, [file, "service", marker], { detached: true, stdio: "ignore", windowsHide: true });
  service.unref();
} else {
  const lines = createInterface({ input: process.stdin });
  setInterval(() => {}, 1000);
  lines.on("close", () => {
    if (!process.argv.includes("stubborn")) process.exit(0);
  });
  lines.on("line", async (line) => {
    const command = JSON.parse(line);
    if (command.type === "hang") return;
    if (command.type === "crash") process.exit(17);
    if (command.type === "start_service") {
      const intermediate = spawn(process.execPath, [file, "intermediate", command.marker], {
        detached: true, stdio: "ignore", windowsHide: true,
      });
      intermediate.unref();
      for (let attempt = 0; attempt < 200; attempt++) {
        try {
          const service = JSON.parse(await readFile(command.marker, "utf8"));
          process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true,
            data: { ...service, rootPid: process.pid, intermediatePid: intermediate.pid, args: process.argv.slice(2) } }) + "\n");
          return;
        } catch { await delay(25); }
      }
      throw new Error("Detached service did not start");
    }
    process.stdout.write(JSON.stringify({ type: "response", id: command.id, success: true, data: {} }) + "\n");
  });
}
