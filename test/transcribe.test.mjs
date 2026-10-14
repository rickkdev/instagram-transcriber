import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { normalizeReelUrl, transcribe } from "../transcribe.mjs";
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

test("real audio conversion sends documented multipart and removes temp files", async () => {
  const root = await mkdtemp(join(tmpdir(), "reelscribe-test-"));
  const media = join(root, "fixture.wav");
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
  try {
    const source = { kind: "upload", path: media, filename: "fixture.wav" };
    const result = await transcribe(source, {
      apiKey: "test-key",
      tempRoot: root,
      fetchImpl: async (url, options) => {
        assert.equal(url, "https://api.openai.com/v1/audio/transcriptions");
        assert.equal(options.headers.Authorization, "Bearer test-key");
        assert.equal(options.body.get("model"), "gpt-4o-mini-transcribe");
        assert.equal(options.body.get("response_format"), "json");
        assert.ok(options.body.get("file").size > 500);
        return Response.json({ text: "Fixture transcript." });
      },
    });
    assert.deepEqual(result, {
      text: "Fixture transcript.",
      source: { kind: "upload", filename: "fixture.wav" },
    });
    assert.deepEqual(await readdir(root), ["fixture.wav"]);
    await assert.rejects(
      transcribe(source, {
        apiKey: "test-key",
        tempRoot: root,
        fetchImpl: async () => Response.json({}, { status: 401 }),
      }),
      { code: "provider_failed" },
    );
    assert.deepEqual(await readdir(root), ["fixture.wav"]);
    await assert.rejects(
      transcribe(source, {
        apiKey: "test-key",
        tempRoot: root,
        fetchImpl: async () => Response.json({ text: " " }),
      }),
      { code: "no_speech" },
    );
    assert.deepEqual(await readdir(root), ["fixture.wav"]);
    const runningController = new AbortController();
    const running = transcribe(source, {
      apiKey: "test-key",
      tempRoot: root,
      signal: runningController.signal,
      fetchImpl: async () => {
        throw new Error("unexpected provider call");
      },
    });
    const timer = setTimeout(() => runningController.abort(), 5);
    await assert.rejects(
      running,
      (error) => error.code === "cancelled" || error.name === "AbortError",
    );
    clearTimeout(timer);
    assert.deepEqual(await readdir(root), ["fixture.wav"]);
    const controller = new AbortController();
    controller.abort();
    await assert.rejects(
      transcribe(source, {
        apiKey: "test-key",
        tempRoot: root,
        signal: controller.signal,
      }),
      { name: "AbortError" },
    );
    assert.deepEqual(await readdir(root), ["fixture.wav"]);
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

test("missing key returns honest setup and actionable 503", async () => {
  await withServer({ apiKey: "", prerequisites: [] }, async (base) => {
    assert.deepEqual(await (await fetch(`${base}/api/status`)).json(), {
      ready: false,
      missingKey: true,
      missingTools: [],
    });
    const response = await fetch(`${base}/api/transcribe`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: "https://instagram.com/reel/ABC/" }),
    });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "setup_required");
  });
});

test("API validates origins, body and sources, and shares upload pipeline", async () => {
  const seen = [];
  await withServer(
    {
      apiKey: "test",
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
      apiKey: "test",
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
      apiKey: "test",
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
