import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, rm } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import {
  defaultModelPath,
  downloaderPath,
  whisperPath,
} from "./transcribe.mjs";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const modelChecksum =
  "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe";

export function doctor(modelPath = defaultModelPath, ytPath = downloaderPath) {
  const tools = [
    ["Python 3", "python3", ["--version"]],
    ["ffmpeg", "ffmpeg", ["-version"]],
    ["ffprobe", "ffprobe", ["-version"]],
    ["whisper-cli", whisperPath, ["--help"]],
    ["yt-dlp", ytPath, ["--version"]],
  ];
  const missing = tools
    .filter(([, command, args]) => {
      const result = spawnSync(command, args, {
        stdio: "ignore",
        timeout: 10_000,
      });
      return result.error || result.status !== 0;
    })
    .map(([name]) => name);
  if (Number(process.versions.node.split(".")[0]) < 22)
    missing.unshift("Node.js 22+");
  return {
    ready: !missing.length && existsSync(modelPath),
    missingTools: missing,
    missingModel: !existsSync(modelPath),
  };
}

async function downloadModel(modelPath) {
  if (existsSync(modelPath)) return;
  await mkdir(dirname(modelPath), { recursive: true });
  const temporary = `${modelPath}.${randomUUID()}.part`;
  let handle;
  try {
    const response = await fetch(
      "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",
      { signal: AbortSignal.timeout(300_000) },
    );
    if (!response.ok || !response.body)
      throw new Error(
        "Could not download the Whisper model. Check your connection and rerun setup.",
      );
    handle = await open(temporary, "wx", 0o600);
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 200 * 1024 * 1024)
        throw new Error("Whisper model download exceeded the expected size.");
      hash.update(chunk);
      await handle.writeFile(chunk);
    }
    if (hash.digest("hex") !== modelChecksum)
      throw new Error(
        "Whisper model checksum did not match. Rerun setup to retry.",
      );
    await handle.close();
    handle = undefined;
    await rename(temporary, modelPath);
  } finally {
    await handle?.close();
    await rm(temporary, { force: true });
  }
}

async function setup() {
  if (Number(process.versions.node.split(".")[0]) < 22)
    throw new Error("Install Node.js 22 or later.");
  const venv = join(scriptDirectory, "../.venv");
  for (const [command, args] of [
    ["python3", ["-m", "venv", venv]],
    [
      join(venv, "bin/python"),
      ["-m", "pip", "install", "-r", join(scriptDirectory, "requirements.txt")],
    ],
  ]) {
    const result = spawnSync(command, args, { stdio: "inherit" });
    if (result.error || result.status !== 0)
      throw new Error(
        "Could not install yt-dlp. Install Python 3 with venv support and rerun setup.",
      );
  }
  const status = doctor(defaultModelPath, join(venv, "bin/yt-dlp"));
  if (status.missingTools.length)
    throw new Error(
      `Install ${status.missingTools.join(", ")} before rerunning setup. On macOS use brew install ffmpeg whisper-cpp.`,
    );
  await downloadModel(defaultModelPath);
  console.log("Local transcription is ready. No API key is needed.");
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  setup().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
