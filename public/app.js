const $ = (id) => document.getElementById(id);
let state = { kind: "idle" };
let configuration = { ready: false };
function render() {
  const working = state.kind === "working";
  const success = state.kind === "success";
  $("transcribe-button").disabled = working || !configuration.ready;
  $("upload-button").disabled = working || !configuration.ready;
  $("reel-url").disabled = working;
  $("output").setAttribute("aria-busy", String(working));
  $("empty-state").hidden = working || success;
  $("working-state").hidden = !working;
  $("transcript-text").hidden = !success;
  $("actions").hidden = !success;
  $("transcribe-button").firstChild.textContent = working
    ? "Transcribing "
    : "Transcribe ";
  $("feedback").hidden = state.kind !== "error";
  if (state.kind === "error") $("feedback").textContent = state.message;
  $("source-label").textContent = success
    ? state.transcript.source.kind === "upload"
      ? state.transcript.source.filename
      : "Transcribed from your Instagram Reel."
    : "A little space for the words that matter.";
  if (success) $("transcript-text").textContent = state.transcript.text;
}
async function submit(path, body, headers) {
  state = { kind: "working" };
  $("copy-button").textContent = "Copy text";
  render();
  try {
    const response = await fetch(path, { method: "POST", headers, body });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error?.message || "Something went wrong. Try again.",
      );
    state = { kind: "success", transcript: data };
  } catch (error) {
    state = {
      kind: "error",
      message:
        error.message ||
        "Could not reach the local server. Check that it is running.",
    };
  }
  render();
}
$("reel-form").addEventListener("submit", (event) => {
  event.preventDefault();
  if (configuration.ready && state.kind !== "working")
    submit("/api/transcribe", JSON.stringify({ url: $("reel-url").value }), {
      "Content-Type": "application/json",
    });
});
$("reel-url").addEventListener("drop", (event) => {
  const value =
    event.dataTransfer
      .getData("text/uri-list")
      .split("\n")
      .find((line) => line && !line.startsWith("#")) ||
    event.dataTransfer.getData("text/plain");
  if (value) {
    event.preventDefault();
    $("reel-url").value = value.trim();
  }
});
$("upload-button").addEventListener("click", () => $("video-file").click());
$("video-file").addEventListener("change", () => {
  const file = $("video-file").files[0];
  if (!file) return;
  if (file.size > 50 * 1024 * 1024) {
    state = { kind: "error", message: "Choose a video smaller than 50 MB." };
    render();
  } else {
    const body = new FormData();
    body.set("file", file);
    submit("/api/transcribe/upload", body);
  }
  $("video-file").value = "";
});
$("copy-button").addEventListener("click", async () => {
  if (state.kind !== "success") return;
  try {
    await navigator.clipboard.writeText(state.transcript.text);
    $("copy-button").textContent = "Copied!";
  } catch {
    $("copy-button").textContent = "Select text to copy";
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents($("transcript-text"));
    selection.removeAllRanges();
    selection.addRange(range);
  }
});
$("download-button").addEventListener("click", () => {
  if (state.kind !== "success") return;
  const url = URL.createObjectURL(
    new Blob([state.transcript.text + "\n"], {
      type: "text/plain;charset=utf-8",
    }),
  );
  const link = document.createElement("a");
  link.href = url;
  link.download = "reel-transcript.txt";
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
for (const id of ["setup-button", "setup-details"])
  $(id).addEventListener("click", () => $("setup-dialog").showModal());
for (const id of ["close-setup", "done-setup"])
  $(id).addEventListener("click", () => $("setup-dialog").close());
async function loadStatus() {
  try {
    const response = await fetch("/api/status");
    if (!response.ok) throw new Error();
    configuration = await response.json();
    $("setup-banner").hidden = configuration.ready;
    $("setup-summary").textContent = configuration.missingModel
      ? "Run npm run setup to install the local Whisper model and start transcribing."
      : `Install ${configuration.missingTools.join(", ")} on the local server to start transcribing.`;
  } catch {
    state = {
      kind: "error",
      message:
        "Could not reach the local server. Start it with npm start, then reload this page.",
    };
  }
  render();
}
render();
loadStatus();
