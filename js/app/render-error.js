// Turning a thrown error into the dialog the user sees.
//
// This used to live inline in `renderCurrent()` and recognised network failures
// by looking for 「无法拉取联网主页」 inside the message. That only worked by
// accident: the nested proxy error keeps that prefix, but `fetchRemoteText()`
// replaces the message outright when the request times out
// (`请求超时（22 秒）。`), so a timed-out remote preset was reported as
// 「加载主页失败 / 主页内容编写有误」 with a retry button that replayed the
// same failure. Classifying on the stable `code` the loader attaches keeps the
// wording correct whatever the underlying message says.

/** Codes thrown by the source loader, mapped to their dialog heading. */
const CODE_TITLES = {
  SOURCE_TOO_LARGE: "主页内容过大",
  REMOTE_URL_INVALID: "网址无效",
  PRESET_FETCH_FAILED: "PCL2 预设加载失败",
  // Shipped preset files that 404 - a deployment problem, not a user mistake.
  PRESET_ASSET_FAILED: "预设文件加载失败"
};

// Neither of these gets a "重试" button: the content is already local, so
// retrying re-reads the same bytes and shows the same dialog again.
const NON_RETRYABLE = new Set(["SOURCE_TOO_LARGE", "REMOTE_URL_INVALID"]);

/**
 * @param {unknown} error
 * @param {{ mode?: string }} [state]
 * @returns {{ title: string, detail: string, retryable: boolean }}
 *   `detail` is `"own"` when the message stands on its own, or `"xaml"` when it
 *   needs the 「主页内容编写有误」 preamble.
 */
export function classifyRenderError(error, state = {}) {
  const message = String(error?.message ?? error ?? "");
  const code = String(error?.code || "");

  if (CODE_TITLES[code]) {
    return {
      title: CODE_TITLES[code],
      detail: "own",
      retryable: !NON_RETRYABLE.has(code)
    };
  }

  // A homepage URL that never arrived is a fetch problem too, even though the
  // loader reports it without a dedicated code.
  if (state.mode === "url" && message.includes("无法拉取联网主页")) {
    return { title: "联网主页加载失败", detail: "own", retryable: true };
  }

  return { title: "加载主页失败", detail: "xaml", retryable: true };
}

/** The caption text for a classified error. */
export function renderErrorCaption(error, classification) {
  const message = String(error?.message ?? error ?? "");
  return classification.detail === "xaml" ? `主页内容编写有误，请根据下列错误信息进行检查：\n\n${message}` : message;
}
