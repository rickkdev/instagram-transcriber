# ReelScribe

Paste an Instagram Reel link to get its spoken words as text. Copy the transcript or download a `.txt` file. If Instagram blocks the link, upload a saved video instead.

## Run locally

1. Install Node.js 22 or later, Python 3, and ffmpeg. On macOS, run `brew install node python ffmpeg`.
2. Run `npm install`.
3. Run `npm run setup:downloader` to install current yt-dlp in the project's private `.venv`.
4. Run `cp .env.example .env`.
5. Set `OPENAI_API_KEY` in `.env` to your OpenAI API key.
6. Run `npm start` and open `http://127.0.0.1:3000`.

Use `npm run dev` to restart automatically when server files change. Restart after editing `.env`. Set `PORT` in `.env` to choose another local port.

OpenAI API usage is billed to your API account. The server uses `gpt-4o-mini-transcribe` through OpenAI's audio transcription API. The API key stays on the server. There is no browser key field.

Instagram can require login or refuse downloads. The app does not read browser cookies. If needed, explicitly configure `IG_COOKIES_FILE` with an exported Netscape cookies file. Keep this file private. Alternatively, upload the video you saved. Set `YT_DLP_PATH` only to select another installed downloader. The app prefers `.venv/bin/yt-dlp` and otherwise uses the global command.

Uploads are limited to 50 MB. Videos must be under 10 minutes. One transcription runs at a time. The server removes temporary media after success, failure, or cancellation. It does not store transcript history. Audio is sent to OpenAI for processing.

## Verify

Run `npm test`. Tests check URL boundaries, API setup and origin handling, upload and URL contracts, real ffmpeg audio conversion, provider error handling, and temporary file cleanup. Provider requests are mocked in tests. A live API key and accessible video are required to verify real transcription.
