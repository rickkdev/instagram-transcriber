# ReelScribe

Transcribe an Instagram Reel or a saved video inside Codex, Claude Code, or T3 Code. Speech recognition runs locally with [whisper.cpp](https://github.com/ggml-org/whisper.cpp). No transcription API key is required.

Your existing Codex or Claude login runs the agent conversation. The plugin downloads Reel audio with yt-dlp and transcribes it on your machine. It does not read or reuse agent authentication tokens. Subscription login is not a general audio API credential. See the [Codex authentication documentation](https://learn.chatgpt.com/docs/auth).

Whisper uses CPU mode so it can run inside agent sandboxes that restrict GPU access.

## Install the plugin

Requires Node.js 22 or later, Python 3, ffmpeg, and whisper-cli. On macOS:

```sh
brew install node python ffmpeg whisper-cpp
```

On Linux, install ffmpeg and Python through your package manager and build or install [whisper.cpp](https://github.com/ggml-org/whisper.cpp#quick-start) with `whisper-cli` on your PATH. The runtime currently targets macOS and Linux.

### Codex

```sh
codex plugin marketplace add rickkdev/instagram-transcriber
codex plugin add reelscribe@reelscribe
```

Start a new Codex session. Invoke the skill or ask it to transcribe a Reel:

```text
$reelscribe:transcribe-reel https://www.instagram.com/reel/SHORTCODE/
```

### Claude Code

```sh
claude plugin marketplace add rickkdev/instagram-transcriber
claude plugin install reelscribe@reelscribe
```

Alternatively, install from inside Claude Code:

```text
/plugin install reelscribe --marketplace rickkdev/instagram-transcriber
```

Start a new Claude Code session and run:

```text
/reelscribe:transcribe-reel https://www.instagram.com/reel/SHORTCODE/
```

### T3 Code

Install for the provider you use with the commands above, then start a fresh T3 Code thread with that provider so its agent loads the plugin. Invoke the ReelScribe skill or ask, "Use ReelScribe to transcribe this Reel," followed by the URL. The plugin runs through the provider's normal local tools. No separate login bridge, MCP server, or web app is required.

On first use, the skill runs its setup script. Setup installs yt-dlp into a private Python environment and downloads the multilingual Whisper base model, about 142 MiB. The model is cached under `~/.cache/reelscribe/models/` and checked against a pinned SHA-256. Subsequent transcriptions reuse it. Model quality depends on the recording and the model. Use a larger compatible model through `WHISPER_MODEL_PATH` if needed.

## Run without an agent

Clone the repository and set up the local tools:

```sh
git clone https://github.com/rickkdev/instagram-transcriber.git
cd instagram-transcriber
npm run setup
```

Print a transcript:

```sh
node skills/transcribe-reel/scripts/cli.mjs --url 'https://www.instagram.com/reel/SHORTCODE/'
```

Transcribe a saved file and save the text:

```sh
node skills/transcribe-reel/scripts/cli.mjs --file '/path/to/video.mp4' --output transcript.txt
```

Use `--json` for structured output, `--doctor` to check setup, and `--help` for available options. The CLI uses Node's built-in modules and does not require `npm install`.

## Open the optional web app

```sh
npm install
npm start
```

Open [the local app](http://127.0.0.1:3000). Paste a Reel link or upload a saved video, then copy the transcript or download a `.txt` file. The app uses the same local pipeline as the skill. Run `npm run dev` to restart automatically when server files change.

## Limits and configuration

Inputs must be under 50 MB and 10 minutes. The web server handles one transcription at a time and binds to loopback. Temporary media is deleted after success, failure, or cancellation. Original files remain untouched. There is no transcript history database.

Instagram can refuse downloads, require login, or rate-limit requests. Upload or pass a saved video in that case. The plugin does not read browser cookies. Set `IG_COOKIES_FILE` only if you explicitly choose to use an exported Netscape cookies file. Keep that file outside the repository.

Optional environment variables are `WHISPER_MODEL_PATH`, `WHISPER_PATH`, `YT_DLP_PATH`, `IG_COOKIES_FILE`, and `PORT`. The web server can load them from an ignored `.env` file. The agent CLI reads its process environment. No `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` is used.

## Verify

Run `npm test` after installing the web dependencies. Tests cover URL boundaries, local media conversion, transcription process errors, API contracts, cancellation, and cleanup. Plugin manifests can be checked with `claude plugin validate .` and the Codex plugin installer. A real transcription can be checked with the CLI after local setup.

The implementation was built with GPT-6.1-Sol through the Codex harness in T3 Code. Licensed under MIT.
