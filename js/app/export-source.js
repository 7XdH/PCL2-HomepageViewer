// What the「导出」button should write to disk.
//
// It used to export `lastRenderedContent || editor.value || FALLBACK_XAML`, so
// editing the code pane without pressing「渲染」exported the previous version -
// the one visible in the preview, not the one in the editor. Pick the content by
// the *current* source instead, and say so when the editor holds unrendered
// edits.

const INVALID_FILE_CHARS = /[\\/:*?"<>|\u0000-\u001f]/g;

/** Keep a preset title usable as a file name on every platform. */
export function safeFileName(name, fallback = "Custom.xaml") {
  const cleaned = String(name ?? "")
    .replace(INVALID_FILE_CHARS, "_")
    .replace(/\s+/g, " ")
    .trim();
  return cleaned || fallback;
}

/**
 * File name to save under. A local file keeps its own name; a remote homepage
 * borrows the last path segment, falling back to `Custom.xaml` when the URL is
 * a bare host or a directory.
 */
export function exportFileName(state, presetTitle = "") {
  if (state.mode === "file" && state.fileName) return safeFileName(state.fileName);
  if (state.mode === "preset") return safeFileName(presetTitle ? `${presetTitle}.xaml` : "");
  if (state.mode === "url" && state.url) {
    try {
      const parsed = new URL(state.url);
      const segment = parsed.pathname.split("/").filter(Boolean).pop() || "";
      const named = segment.includes(".") ? segment : "";
      if (named) return safeFileName(decodeURIComponent(named));
    } catch {
      // Fall through to the default name.
    }
  }
  return "Custom.xaml";
}

/**
 * @param {object} state          app state (`mode`, `code`, `fileContent`, `urlContent`, `fileName`, `url`)
 * @param {object} [options]
 * @param {string} [options.editorText]     current code editor buffer
 * @param {string} [options.lastRendered]   content of the last successful render
 * @param {string} [options.presetTitle]    title of the active preset
 * @param {string} [options.fallback]       content when the source is empty
 * @returns {{ content: string, fileName: string, dirty: boolean }}
 */
export function resolveExportSource(state, options = {}) {
  const { editorText = "", lastRendered = "", presetTitle = "", fallback = "" } = options;
  const fileName = exportFileName(state, presetTitle);

  switch (state.mode) {
    case "code": {
      const content = editorText || state.code || lastRendered || fallback;
      return { content, fileName, dirty: Boolean(editorText) && editorText !== lastRendered };
    }
    case "file":
      return { content: state.fileContent || "", fileName, dirty: false };
    case "url":
      return { content: state.urlContent || "", fileName, dirty: false };
    default:
      // Presets are rendered from cache, so the rendered text is authoritative.
      return { content: lastRendered || fallback, fileName, dirty: false };
  }
}
