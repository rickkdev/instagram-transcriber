import { spawnSync } from "node:child_process";
for (const [command, args] of [
  ["python3", ["-m", "venv", ".venv"]],
  [".venv/bin/python", ["-m", "pip", "install", "-r", "requirements.txt"]],
]) {
  const result = spawnSync(command, args, { stdio: "inherit" });
  if (result.error || result.status !== 0) process.exit(1);
}
