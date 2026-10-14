import test from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  readdir,
  rm,
  writeFile,
  cp,
  readFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  normalizeReelUrl,
  transcribe,
} from "../skills/transcribe-reel/scripts/transcribe.mjs";
import { createApp } from "../server.mjs";

test("canonical Reel links strip tracking and reject other destinations", () => {
  assert.equal(
    normalizeReelUrl(" https://m.instagram.com/reels/ABC-123_/?igsh=secret#x "),
    "https://www.instagram.com/reel/ABC-123_/",
  );
  for (const value of [
    "https://instagram.com.evil/reel/x",
    "https://localhost/reel/x",
    "https://instagram.com/p/x/",
    "file:///tmp/test",
    "https://a:b@instagram.com/reel/x",
    "https://instagram.com:3000/reel/x",
    "https://instagram.com/reel/x/more",
    "bad",
    null,
  ])
    assert.throws(() => normalizeReelUrl(value), { code: "invalid_url" });
});

test("real audio conversion runs local Whisper and cleans success, failure, and cancellation", async () => {
  const root = await mkdtemp(join(tmpdir(), "reelscribe-test-"));
  const media = join(root, "fixture.wav");
  const modelPath = join(root, "model.bin");
  const whisperBinary = join(root, "whisper-fixture");
  await writeFile(modelPath, "fixture model");
  await writeFile(
    whisperBinary,
    `#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import assert from 'node:assert/strict';
const args = process.argv.slice(2);
const audio = readFileSync(args[args.indexOf('-f') + 1]);
assert.equal(audio.toString('ascii', 0, 4), 'RIFF');
assert.equal(audio.readUInt16LE(22), 1);
assert.equal(audio.readUInt32LE(24), 16000);
assert.equal(audio.readUInt16LE(34), 16);
assert.equal(args[args.indexOf('-l') + 1], 'auto');
writeFileSync(args[args.indexOf('-of') + 1] + '.txt', ' Fixture transcript.\\n');
`,
    { mode: 0o700 },
  );
  assert.equal(
    spawnSync("ffmpeg", [
      "-nostdin",
      "-v",
      "error",
      "-f",
      "lavfi",
      "-i",
      "sine=frequency=440:duration=1",
      media,
    ]).status,
    0,
  );
  const source = { kind: "upload", path: media, filename: "fixture.wav" };
  const options = { modelPath, whisperBinary, tempRoot: root };
  const expectedFiles = ["fixture.wav", "model.bin", "whisper-fixture"];
  try {
    assert.deepEqual(await transcribe(source, options), {
      text: "Fixture transcript.",
      source: { kind: "upload", filename: "fixture.wav" },
    });
    assert.deepEqual((await readdir(root)).sort(), expectedFiles);
    await writeFile(whisperBinary, "#!/bin/sh\nexit 1\n", { mode: 0o700 });
    await assert.rejects(transcribe(source, options), {
      code: "transcription_failed",
    });
    assert.deepEqual((await readdir(root)).sort(), expectedFiles);
    await writeFile(
      whisperBinary,
      '#!/bin/sh\nwhile [ "$1" != "-of" ]; do shift; done\nshift\nprintf " " > "$1.txt"\n',
      { mode: 0o700 },
    );
    await assert.rejects(transcribe(source, options), { code: "no_speech" });
    assert.deepEqual((await readdir(root)).sort(), expectedFiles);
    const controller = new AbortController();
    const pending = transcribe(source, {
      ...options,
      signal: controller.signal,
    });
    const timer = setTimeout(() => controller.abort(), 5);
    await assert.rejects(
      pending,
      (error) => error.code === "cancelled" || error.name === "AbortError",
    );
    clearTimeout(timer);
    assert.deepEqual((await readdir(root)).sort(), expectedFiles);
    await assert.rejects(
      transcribe(source, { ...options, modelPath: join(root, "missing") }),
      { code: "setup_required" },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function withServer(options, callback) {
  const server = createApp(options).listen(0, "127.0.0.1");
  await new Promise((resolve) => server.once("listening", resolve));
  try {
    await callback(`http://127.0.0.1:${server.address().port}`);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

test("the local page and assets load from a project inside a hidden directory", async () => {
  await withServer(
    { modelAvailable: false, prerequisites: [] },
    async (base) => {
      const page = await fetch(base);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<title>ReelScribe/);
      for (const asset of ["app.js", "styles.css", "mark.svg"]) {
        assert.equal((await fetch(`${base}/${asset}`)).status, 200);
      }
      assert.equal((await fetch(`${base}/.env`)).status, 404);
    },
  );
});

test("missing local model returns honest setup and actionable 503", async () => {
  await withServer(
    { modelAvailable: false, prerequisites: [] },
    async (base) => {
      assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), {
        ready: false,
        missingModel: true,
        missingTools: [],
      });
      const response = await fetch(`${base}/api/transcribe`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://instagram.com/reel/ABC/" }),
      });
      assert.equal(response.status, 503);
      assert.equal((await response.json()).error.code, "setup_required");
    },
  );
});

test("API validates origins, body and sources, and shares upload pipeline", async () => {
  const seen = [];
  await withServer(
    {
      modelAvailable: true,
      prerequisites: [],
      transcribeImpl: async (source) => {
        seen.push(source);
        return { text: "Fixture transcript.", source: { kind: source.kind } };
      },
    },
    async (base) => {
      const post = (body, headers = { "Content-Type": "application/json" }) =>
        fetch(`${base}/api/transcribe`, { method: "POST", headers, body });
      assert.equal(
        (
          await post("{}", {
            "Content-Type": "application/json",
            Origin: "https://evil.example",
          })
        ).status,
        403,
      );
      assert.equal(
        (await post("{}", { "Content-Type": "text/plain" })).status,
        415,
      );
      assert.equal((await post("{")).status, 400);
      assert.equal(
        (await post(JSON.stringify({ url: "https://localhost/reel/a" })))
          .status,
        400,
      );
      assert.equal(
        (await post(JSON.stringify({ url: "x".repeat(5000) }))).status,
        413,
      );
      const result = await post(
        JSON.stringify({ url: "https://instagram.com/reel/ABC/?secret=1" }),
      );
      assert.equal(result.status, 200);
      assert.equal(seen[0].url, "https://www.instagram.com/reel/ABC/");
      const form = new FormData();
      form.set("file", new Blob(["fixture"]), "video.mp4");
      const uploaded = await fetch(`${base}/api/transcribe/upload`, {
        method: "POST",
        body: form,
      });
      assert.equal(uploaded.status, 200);
      assert.equal(seen[1].kind, "upload");
      assert.equal(seen[1].filename, "video.mp4");
      await new Promise((resolve) => setTimeout(resolve, 30));
      await assert.rejects(
        import("node:fs/promises").then((fs) => fs.stat(seen[1].path)),
        { code: "ENOENT" },
      );
    },
  );
});

test("one request owns the server slot and a disconnect aborts its signal", async () => {
  let started;
  const ready = new Promise((resolve) => {
    started = resolve;
  });
  await withServer(
    {
      modelAvailable: true,
      prerequisites: [],
      transcribeImpl: async (source, { signal }) => {
        started();
        await new Promise((resolve) =>
          signal.addEventListener("abort", resolve, { once: true }),
        );
        throw new Error("cancelled fixture");
      },
    },
    async (base) => {
      const controller = new AbortController();
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://instagram.com/reel/ABC/" }),
      };
      const pending = fetch(`${base}/api/transcribe`, {
        ...options,
        signal: controller.signal,
      }).catch((error) => error);
      await ready;
      assert.equal(
        (await fetch(`${base}/api/transcribe`, options)).status,
        429,
      );
      controller.abort();
      assert.equal((await pending).name, "AbortError");
    },
  );
});

test("a partial upload disconnect releases the request slot", async () => {
  const { request } = await import("node:http");
  await withServer(
    {
      modelAvailable: true,
      prerequisites: [],
      transcribeImpl: async () => ({
        text: "Fixture transcript.",
        source: { kind: "reel" },
      }),
    },
    async (base) => {
      const partial = request(`${base}/api/transcribe/upload`, {
        method: "POST",
        headers: {
          "Content-Type": "multipart/form-data; boundary=test-boundary",
          "Content-Length": "1000000",
        },
      });
      partial.on("error", () => {});
      partial.write(
        '--test-boundary\r\nContent-Disposition: form-data; name="file"; filename="video.mp4"\r\nContent-Type: video/mp4\r\n\r\npartial',
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      const options = {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: "https://instagram.com/reel/ABC/" }),
      };
      assert.equal(
        (await fetch(`${base}/api/transcribe`, options)).status,
        429,
      );
      partial.destroy();
      await new Promise((resolve) => setTimeout(resolve, 30));
      assert.equal(
        (await fetch(`${base}/api/transcribe`, options)).status,
        200,
      );
    },
  );
});

test("standalone copied skill CLI emits JSON and refuses output overwrite", async () => {
  const root = await mkdtemp(join(tmpdir(), "reelscribe-cli-"));
  try {
    await cp(resolve("skills/transcribe-reel/scripts"), join(root, "scripts"), {
      recursive: true,
    });
    const media = join(root, "fixture.wav");
    const model = join(root, "model.bin");
    const whisper = join(root, "whisper-fixture");
    const output = join(root, "transcript.txt");
    await writeFile(model, "fixture model");
    await writeFile(
      whisper,
      '#!/bin/sh\nwhile [ "$1" != "-of" ]; do shift; done\nshift\nprintf "Standalone transcript." > "$1.txt"\n',
      { mode: 0o700 },
    );
    assert.equal(
      spawnSync("ffmpeg", [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=1",
        media,
      ]).status,
      0,
    );
    const cli = join(root, "scripts/cli.mjs");
    const args = [
      cli,
      "--file",
      media,
      "--model",
      model,
      "--json",
      "--output",
      output,
    ];
    const options = {
      cwd: tmpdir(),
      encoding: "utf8",
      env: { ...process.env, WHISPER_PATH: whisper },
    };
    const result = spawnSync(process.execPath, args, options);
    assert.equal(result.status, 0, result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), {
      text: "Standalone transcript.",
      source: { kind: "upload", filename: "fixture.wav" },
    });
    assert.equal(await readFile(output, "utf8"), "Standalone transcript.\n");
    const again = spawnSync(process.execPath, args, options);
    assert.equal(again.status, 1);
    assert.equal(again.stdout, "");
    assert.match(again.stderr, /already exists/);
    const invalid = spawnSync(
      process.execPath,
      [cli, "--url", "https://evil.example/reel/x", "--model", model],
      options,
    );
    assert.equal(invalid.status, 1);
    assert.equal(invalid.stdout, "");
    assert.match(invalid.stderr, /Instagram Reel link/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
