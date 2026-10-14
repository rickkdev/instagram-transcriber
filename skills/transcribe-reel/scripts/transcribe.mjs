import { spawn } from "node:child_process";
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
export const defaultModelPath =
  process.env.WHISPER_MODEL_PATH ||
  join(homedir(), ".cache/reelscribe/models/ggml-base.bin");
export const whisperPath = process.env.WHISPER_PATH || "whisper-cli";
export const downloaderPath =
  process.env.YT_DLP_PATH ||
  [
    join(scriptDirectory, "../.venv/bin/yt-dlp"),
    join(scriptDirectory, "../../../.venv/bin/yt-dlp"),
  ].find((path) => existsSync(path)) ||
  "yt-dlp";

export class AppError extends Error {
  constructor(code, message, status = 422) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export function normalizeReelUrl(input) {
  const invalid = () =>
    new AppError(
      "invalid_url",
      "Paste an Instagram Reel link, such as https://www.instagram.com/reel/ABC123/.",
      400,
    );
  if (typeof input !== "string" || input.length > 2048) throw invalid();
  let url;
  try {
    url = new URL(input.trim());
  } catch {
    throw invalid();
  }
  if (
    !["https:", "http:"].includes(url.protocol) ||
    !["instagram.com", "www.instagram.com", "m.instagram.com"].includes(
      url.hostname,
    ) ||
    url.username ||
    url.password ||
    url.port ||
    !/^\/reels?\/[A-Za-z0-9_-]+\/?$/.test(url.pathname)
  )
    throw invalid();
  return `https://www.instagram.com/reel/${url.pathname.split("/")[2]}/`;
}

function run(command, args, signal, timeout = 120_000) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(command, args, {
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    let failure;
    let hardKill;
    const stop = (error) => {
      if (failure) return;
      failure = error;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      hardKill = setTimeout(() => {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 500);
    };
    const abort = () =>
      stop(new AppError("cancelled", "Transcription was cancelled.", 499));
    signal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          new AppError(
            "timeout",
            "This video took too long to process. Try a shorter video.",
            504,
          ),
        ),
      timeout,
    );
    child.once("error", () => {
      failure = new AppError(
        "dependency_missing",
        `Install ffmpeg, yt-dlp, and whisper-cli, then run setup again.`,
        503,
      );
    });
    child.once("close", (code) => {
      clearTimeout(timer);
      clearTimeout(hardKill);
      signal?.removeEventListener("abort", abort);
      if (failure) reject(failure);
      else if (code !== 0)
        reject(
          new AppError(
            "media_failed",
            "The video could not be read. Try uploading a saved video with audio.",
          ),
        );
      else resolve();
    });
  });
}

export async function transcribe(
  source,
  {
    modelPath = defaultModelPath,
    whisperBinary = whisperPath,
    cookiesFile = process.env.IG_COOKIES_FILE,
    signal,
    tempRoot = tmpdir(),
  } = {},
) {
  if (!existsSync(modelPath))
    throw new AppError(
      "setup_required",
      "Run npm run setup to install the local Whisper model, or set WHISPER_MODEL_PATH.",
      503,
    );
  const sourceUrl =
    source.kind === "reel" ? normalizeReelUrl(source.url) : undefined;
  const directory = await mkdtemp(join(tempRoot, "reelscribe-"));
  try {
    let media = source.path;
    if (sourceUrl) {
      const args = [
        "--ignore-config",
        "--no-playlist",
        "--no-progress",
        "--no-warnings",
        "--restrict-filenames",
        "--max-filesize",
        "50M",
        "--match-filter",
        "duration <=? 600",
        "--socket-timeout",
        "15",
        "--retries",
        "1",
        "--fragment-retries",
        "1",
        "--concurrent-fragments",
        "1",
        "--format",
        "bestaudio/best",
        "--output",
        join(directory, "source.%(ext)s"),
      ];
      if (cookiesFile) args.push("--cookies", cookiesFile);
      args.push("--", sourceUrl);
      try {
        await run(downloaderPath, args, signal);
      } catch (error) {
        if (error.code !== "media_failed") throw error;
        throw new AppError(
          "instagram_unavailable",
          "Instagram could not provide this Reel. It may need login, be private, or be rate limited. Upload a saved video instead.",
        );
      }
      const files = await readdir(directory);
      const file = files.find((name) => /^source\.[a-zA-Z0-9]+$/.test(name));
      if (!file)
        throw new AppError(
          "instagram_unavailable",
          "Instagram did not provide a video under 10 minutes. Upload a saved video instead.",
        );
      media = join(directory, file);
    }
    if ((await stat(media)).size > 50 * 1024 * 1024)
      throw new AppError("too_large", "Choose a video smaller than 50 MB.");
    const audio = join(directory, "audio.wav");
    try {
      await run(
        "ffmpeg",
        [
          "-nostdin",
          "-v",
          "error",
          "-protocol_whitelist",
          "file,pipe",
          "-format_whitelist",
          "mov,mp4,m4a,3gp,3g2,mj2,matroska,webm,avi,wav,mp3,aac,flac,ogg",
          "-i",
          media,
          "-t",
          "601",
          "-vn",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-y",
          audio,
        ],
        signal,
      );
    } catch (error) {
      if (error.code === "media_failed")
        throw new AppError(
          "invalid_audio",
          "This video has no readable audio. Try another saved video with speech.",
        );
      throw error;
    }
    const audioSize = (await stat(audio)).size;
    if (audioSize < 500 || audioSize > 20 * 1024 * 1024)
      throw new AppError(
        "invalid_audio",
        "The video has no usable audio or is too large to transcribe.",
      );
    const duration = await audioDuration(audio, signal);
    if (duration > 600)
      throw new AppError("too_long", "Choose a video shorter than 10 minutes.");
    const output = join(directory, "transcript");
    try {
      await run(
        whisperBinary,
        [
          "-m",
          modelPath,
          "-f",
          audio,
          "-l",
          "auto",
          "-otxt",
          "-of",
          output,
          "-np",
          "-ng",
        ],
        signal,
        600_000,
      );
    } catch (error) {
      if (error.code === "media_failed")
        throw new AppError(
          "transcription_failed",
          "Local Whisper could not transcribe the audio. Check the model with --doctor and try again.",
        );
      throw error;
    }
    let text;
    try {
      text = (await readFile(`${output}.txt`, "utf8")).trim();
    } catch {
      throw new AppError(
        "transcription_failed",
        "Local Whisper did not produce a transcript. Check the model with --doctor.",
      );
    }
    if (!text)
      throw new AppError("no_speech", "No speech was detected in this video.");
    return {
      text,
      source: sourceUrl
        ? { kind: "reel", url: sourceUrl }
        : { kind: "upload", filename: source.filename },
    };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function audioDuration(path, signal) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "format=duration",
        "-of",
        "default=noprint_wrappers=1:nokey=1",
        path,
      ],
      { stdio: ["ignore", "pipe", "ignore"] },
    );
    let output = "";
    child.stdout.on("data", (data) => {
      if (output.length < 1024) output += data;
    });
    const abort = () => child.kill("SIGKILL");
    const timer = setTimeout(abort, 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.on("error", () =>
      reject(
        new AppError(
          "dependency_missing",
          "Install ffmpeg, including ffprobe, then restart the app.",
          503,
        ),
      ),
    );
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      const duration = Number(output.trim());
      if (code !== 0 || !Number.isFinite(duration) || duration <= 0)
        reject(new AppError("invalid_audio", "The video has no usable audio."));
      else resolve(duration);
    });
  });
}
