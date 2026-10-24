// Persisted source selection, shared by the full viewer (index.html) and the
// standalone homepage view (home.html).
//
// Both pages remember the same thing: which source produced the last render, so
// the standalone view can show exactly what the viewer was showing. A preset is
// stored by key only — its XAML is re-fetched, which keeps the entry well under
// the storage quota — while file/url/code sources keep their text.

export const SOURCE_KEY = "pcl.lab.source.v1";

const TEXT_MODES = ["file", "url", "code"];
// Mirrors the proxy UA field: printable ASCII only, capped so a pasted blob
// cannot fill the quota.
const UA_LIMIT = 512;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;

function normalizeUa(value) {
  const ua = typeof value === "string" ? value.trim() : "";
  if (!ua) return "";
  if (ua.length > UA_LIMIT || !PRINTABLE_ASCII.test(ua)) return "";
  return ua;
}

// Turns the raw localStorage string into the fields both entry points need.
// Returns null for missing, unparsable or unknown state so callers can fall
// back to the tutorial preset.
export function parseSourceState(raw, presets) {
  if (!raw) return null;
  let saved;
  try {
    saved = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!saved || typeof saved !== "object") return null;

  const ua = normalizeUa(saved.ua);
  if (saved.mode === "preset" && presets && presets[saved.preset]) {
    return { mode: "preset", preset: saved.preset, ua, content: "" };
  }
  if (TEXT_MODES.includes(saved.mode) && typeof saved.content === "string") {
    return {
      mode: saved.mode,
      fileName: saved.fileName || "Custom.xaml",
      url: saved.url || "",
      ua,
      content: saved.content
    };
  }
  return null;
}

// Applies a parsed state to a mutable state object of the shape both pages use.
// Returns false when there was nothing usable to restore.
export function applySourceState(state, saved) {
  if (!saved) return false;
  state.ua = saved.ua;
  if (saved.mode === "preset") {
    state.mode = "preset";
    state.preset = saved.preset;
    return true;
  }
  state.mode = saved.mode;
  state.fileName = saved.fileName;
  state.url = saved.url;
  state.fileContent = saved.mode === "file" ? saved.content : "";
  state.urlContent = saved.mode === "url" ? saved.content : "";
  state.code = saved.mode === "code" ? saved.content : "";
  // A restored remote document still needs something to resolve its relative
  // image sources against before it is fetched again; the saved address is the
  // closest thing available, and the next successful fetch replaces it with the
  // final URL from the proxy.
  state.baseUrl = saved.mode === "url" ? saved.url : "";
  return true;
}

export function readStoredSourceState(presets, storage = window.localStorage) {
  let raw = null;
  try {
    raw = storage.getItem(SOURCE_KEY);
  } catch {
    return null;
  }
  return parseSourceState(raw, presets);
}

// Serialises the current selection. `code` mirrors the editor buffer so a code
// source can be restored without the editor being mounted; a preset stores only
// its key so the entry stays small regardless of the homepage size.
export function serializeSourceState(state, content) {
  return JSON.stringify({
    mode: state.mode,
    preset: state.preset,
    fileName: state.fileName,
    url: state.url,
    ua: state.ua,
    code: state.mode === "code" ? content : "",
    content: state.mode === "preset" ? "" : content
  });
}

export function saveStoredSourceState(serialized, storage = window.localStorage) {
  try {
    storage.setItem(SOURCE_KEY, serialized);
    return true;
  } catch {
    return false;
  }
}
