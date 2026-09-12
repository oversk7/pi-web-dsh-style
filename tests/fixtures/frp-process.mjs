import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const [mode, marker, control] = process.argv.slice(2);
if (mode === "owner") {
  const { FrpProcess } = await import("../../frp-process.ts");
  const frp = new FrpProcess();
  await frp.start({ executable: process.execPath, args: [fileURLToPath(import.meta.url), "tree", marker, control], cwd: process.cwd() });
  setInterval(() => {}, 1000);
} else if (mode === "leaf") {
  setInterval(() => {}, 1000);
} else {
  const leaf = mode === "tree" ? spawn(process.execPath, [process.argv[1], "leaf"], { stdio: "ignore", windowsHide: true }) : undefined;
  writeFileSync(marker, JSON.stringify({ pid: process.pid, leaf: leaf?.pid, args: process.argv.slice(5) }));
  let previous = "";
  setInterval(() => {
    if (!existsSync(control)) return;
    const command = readFileSync(control, "utf8");
    if (command === previous) return;
    previous = command;
    if (command === "exit") process.exit(3);
    else if (command.startsWith("stderr:")) process.stderr.write(command.slice(7) + "\n");
    else if (command.startsWith("split:")) {
      const text = command.slice(6);
      process.stdout.write(text.slice(0, 8));
      setTimeout(() => process.stdout.write(text.slice(8) + "\n"), 30);
    } else process.stdout.write(command + "\n");
  }, 20);
}
