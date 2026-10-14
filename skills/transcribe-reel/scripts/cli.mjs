import { writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { transcribe, defaultModelPath } from "./transcribe.mjs";
import { doctor } from "./setup.mjs";

const help = `ReelScribe transcribes Instagram Reels and saved media locally.

Usage:
  node cli.mjs --url https://www.instagram.com/reel/ABC/
  node cli.mjs --file /path/to/video.mp4 [--json] [--output /path/to/transcript.txt]
  node cli.mjs --doctor [--model /path/to/ggml-model.bin]

Options:
  --url URL       Public Instagram Reel link
  --file PATH     Saved video or audio, up to 50 MB and 10 minutes
  --model PATH    Override WHISPER_MODEL_PATH
  --json          Print {text, source} as JSON
  --output PATH   Write transcript to a new file, never overwrite
  --doctor        Check local tools and model
  --help          Show this help
`;

async function main() {
  const args = process.argv.slice(2);
  const options = {};
  for (let index = 0; index < args.length; index++) {
    const flag = args[index];
    if (["--help", "--json", "--doctor"].includes(flag))
      options[flag.slice(2)] = true;
    else if (["--url", "--file", "--model", "--output"].includes(flag)) {
      const value = args[++index];
      if (!value || value.startsWith("--"))
        throw new Error(`Provide a value for ${flag}.`);
      options[flag.slice(2)] = value;
    } else throw new Error(`Unknown option ${flag}. Run --help for usage.`);
  }
  if (options.help) return console.log(help);
  const modelPath = options.model ? resolve(options.model) : defaultModelPath;
  if (options.doctor) {
    const status = doctor(modelPath);
    console.log(JSON.stringify(status));
    if (!status.ready) process.exitCode = 1;
    return;
  }
  if (Boolean(options.url) === Boolean(options.file))
    throw new Error(
      "Provide exactly one --url or --file. Run --help for usage.",
    );
  const source = options.url
    ? { kind: "reel", url: options.url }
    : {
        kind: "upload",
        path: resolve(options.file),
        filename: basename(options.file),
      };
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  const timer = setTimeout(stop, 900_000);
  try {
    const result = await transcribe(source, {
      modelPath,
      signal: controller.signal,
    });
    if (options.output)
      await writeFile(resolve(options.output), `${result.text}\n`, {
        flag: "wx",
        mode: 0o600,
      });
    console.log(options.json ? JSON.stringify(result) : result.text);
  } finally {
    clearTimeout(timer);
    process.removeListener("SIGINT", stop);
    process.removeListener("SIGTERM", stop);
  }
}

main().catch((error) => {
  const message =
    error.code === "EEXIST"
      ? "Output file already exists. Choose a new path."
      : error.code === "ENOENT"
        ? "Could not read the media file or write the output. Check the paths."
        : error.name === "AbortError"
          ? "Transcription was cancelled."
          : error.message;
  console.error(message);
  process.exitCode = 1;
});
