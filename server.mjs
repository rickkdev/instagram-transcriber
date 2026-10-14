import express from "express";
import multer from "multer";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  AppError,
  normalizeReelUrl,
  transcribe,
  downloaderPath,
} from "./transcribe.mjs";

function parseRequest(parser, req, res, signal) {
  return new Promise((resolve, reject) => {
    const abort = () =>
      reject(new AppError("cancelled", "The upload was cancelled.", 499));
    if (signal.aborted) return abort();
    signal.addEventListener("abort", abort, { once: true });
    parser(req, res, (error) => {
      signal.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve();
    });
  });
}

export function createApp({
  apiKey = process.env.OPENAI_API_KEY,
  cookiesFile = process.env.IG_COOKIES_FILE,
  transcribeImpl = transcribe,
  prerequisites = ["ffmpeg", "ffprobe", downloaderPath]
    .filter(
      (command) =>
        spawnSync(
          command,
          [
            command === "ffmpeg" || command === "ffprobe"
              ? "-version"
              : "--version",
          ],
          { stdio: "ignore" },
        ).error,
    )
    .map((command) => (command === downloaderPath ? "yt-dlp" : command)),
} = {}) {
  const app = express();
  let active = false;
  app.disable("x-powered-by");
  app.use((req, res, next) => {
    const host = req.headers.host;
    if (!host || !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host))
      return res
        .status(403)
        .json({
          error: {
            code: "origin_rejected",
            message: "Open this app through its local address.",
          },
        });
    if (
      req.method === "POST" &&
      ((req.headers.origin && req.headers.origin !== `http://${host}`) ||
        req.headers["sec-fetch-site"] === "cross-site")
    )
      return res
        .status(403)
        .json({
          error: {
            code: "origin_rejected",
            message: "Submit from this app’s local page.",
          },
        });
    res.set("Cache-Control", "no-store");
    res.set("X-Content-Type-Options", "nosniff");
    res.set(
      "Content-Security-Policy",
      "default-src 'self'; connect-src 'self'; style-src 'self'; script-src 'self'; img-src 'self'; object-src 'none'; frame-ancestors 'none'; base-uri 'none'",
    );
    next();
  });
  const publicPath = join(dirname(fileURLToPath(import.meta.url)), "public");
  for (const file of ["index.html", "app.js", "styles.css", "mark.svg"])
    app.get(file === "index.html" ? "/" : `/${file}`, (req, res) =>
      res.sendFile(join(publicPath, file)),
    );
  app.get("/api/status", (req, res) =>
    res.json({
      ready: Boolean(apiKey) && prerequisites.length === 0,
      missingKey: !apiKey,
      missingTools: prerequisites,
    }),
  );
  const upload = multer({
    limits: { fileSize: 50 * 1024 * 1024, files: 1, fields: 0, parts: 1 },
    storage: multer.diskStorage({
      destination: (req, file, cb) => cb(null, req.uploadDirectory),
      filename: (req, file, cb) => cb(null, "video"),
    }),
  }).single("file");
  app.post(
    ["/api/transcribe", "/api/transcribe/upload"],
    async (req, res, next) => {
      let directory;
      let ownsSlot = false;
      const controller = new AbortController();
      const disconnect = () => {
        if (!res.writableEnded) controller.abort();
      };
      let deadline;
      try {
        if (!apiKey)
          throw new AppError(
            "setup_required",
            "Add OPENAI_API_KEY to your .env file and restart the app.",
            503,
          );
        if (prerequisites.length)
          throw new AppError(
            "dependency_missing",
            `Install ${prerequisites.join(", ")} and restart the app.`,
            503,
          );
        if (active)
          throw new AppError(
            "busy",
            "A video is already being transcribed. Try again when it finishes.",
            429,
          );
        active = true;
        ownsSlot = true;
        deadline = setTimeout(() => {
          controller.abort();
          if (!req.complete) req.destroy();
        }, 240_000);
        res.on("close", disconnect);
        req.on("aborted", disconnect);
        let source;
        if (req.path.endsWith("/upload")) {
          if (!req.is("multipart/form-data"))
            throw new AppError(
              "invalid_request",
              "Choose a video file to upload.",
              400,
            );
          directory = await mkdtemp(join(tmpdir(), "reelscribe-upload-"));
          req.uploadDirectory = directory;
          await parseRequest(upload, req, res, controller.signal);
          if (!req.file)
            throw new AppError(
              "invalid_request",
              "Choose a video file to upload.",
              400,
            );
          source = {
            kind: "upload",
            path: req.file.path,
            filename: req.file.originalname.slice(0, 200),
          };
        } else {
          if (!req.is("application/json"))
            throw new AppError(
              "invalid_request",
              "Send an Instagram Reel link as JSON.",
              415,
            );
          await parseRequest(
            express.json({ limit: "4kb", strict: true }),
            req,
            res,
            controller.signal,
          );
          source = { kind: "reel", url: normalizeReelUrl(req.body?.url) };
        }
        const result = await transcribeImpl(source, {
          apiKey,
          cookiesFile,
          signal: controller.signal,
        });
        if (!controller.signal.aborted) res.json(result);
        else if (!res.destroyed)
          throw new AppError(
            "timeout",
            "Transcription took too long. Try a shorter video.",
            504,
          );
      } catch (error) {
        if (!res.destroyed) next(error);
      } finally {
        clearTimeout(deadline);
        res.removeListener("close", disconnect);
        req.removeListener("aborted", disconnect);
        if (directory) await rm(directory, { recursive: true, force: true });
        if (ownsSlot) active = false;
      }
    },
  );
  app.use((error, req, res, next) => {
    let failure = error;
    if (error instanceof multer.MulterError)
      failure = new AppError(
        "invalid_upload",
        error.code === "LIMIT_FILE_SIZE"
          ? "Choose a video smaller than 50 MB."
          : "Upload one video file, smaller than 50 MB.",
        413,
      );
    if (error.type === "entity.too.large")
      failure = new AppError("invalid_request", "The link is too long.", 413);
    if (error.type === "entity.parse.failed")
      failure = new AppError(
        "invalid_request",
        "The request was not valid JSON.",
        400,
      );
    res
      .status(failure instanceof AppError ? failure.status : 500)
      .json({
        error: {
          code: failure instanceof AppError ? failure.code : "internal_error",
          message:
            failure instanceof AppError
              ? failure.message
              : "Something went wrong. Try again.",
        },
      });
  });
  return app;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const port = Number(process.env.PORT || 3000);
  const server = createApp().listen(port, "127.0.0.1", () =>
    console.log(`ReelScribe is ready at http://127.0.0.1:${port}`),
  );
  server.on("error", () => {
    console.error("Could not start ReelScribe. Check that PORT is available.");
    process.exitCode = 1;
  });
}
