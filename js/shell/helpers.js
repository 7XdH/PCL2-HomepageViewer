export const PAGE_LABELS = {
  Launch: "启动",
  Download: "下载",
  Link: "联机",
  Setup: "设置",
  Other: "更多",
  Instance: "版本设置",
  InstanceSetup: "版本设置",
  Select: "版本选择",
  Speed: "下载",
  TaskManager: "任务管理",
  Resource: "资源下载",
  Help: "帮助",
  About: "关于"
};

export const NAV_FOR_PAGE = {
  Launch: "Launch",
  Instance: "Launch",
  InstanceSetup: "Launch",
  Select: "Launch",
  Download: "Download",
  Speed: "Download",
  Link: "Link",
  Setup: "Setup",
  Other: "Other",
  Help: "Other",
  About: "Other",
  TaskManager: "Other"
};

export const VERSIONS = [
  { name: "1.20.1-Fabric", meta: "Fabric 0.15.11 · 今天 14:32" },
  { name: "1.19.2-Forge", meta: "Forge 43.3.0 · 3 天前" },
  { name: "1.21.4-Vanilla", meta: "原版 1.21.4 · 上周" }
];

export const ACCOUNTS = {
  Steve: {
    name: "Steve",
    uuid: "8667ba71-b85a-4004-af54-457a9734eed7",
    login: "离线",
    skin: "Steve"
  },
  Alex: {
    name: "Alex",
    uuid: "ec561538-f3fd-461d-aff5-086b22154bce",
    login: "离线",
    skin: "Alex"
  }
};

export const SHELL_PREF_KEY = "pcl.lab.shell.v1";

const defaultShellPreferences = () => ({
  version: VERSIONS[0].name,
  account: Object.keys(ACCOUNTS)[0]
});

const getStorage = () => {
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
};

export function readShellPreferences(storage = getStorage()) {
  const fallback = defaultShellPreferences();
  try {
    const raw = storage?.getItem(SHELL_PREF_KEY);
    if (!raw) return fallback;
    const saved = JSON.parse(raw);
    if (!saved || typeof saved !== "object") return fallback;
    return {
      version: VERSIONS.some((item) => item.name === saved.version) ? saved.version : fallback.version,
      account: Object.hasOwn(ACCOUNTS, saved.account) ? saved.account : fallback.account
    };
  } catch {
    return fallback;
  }
}

export function saveShellPreferences({ version, account } = {}, storage = getStorage()) {
  const fallback = defaultShellPreferences();
  const normalized = {
    version: VERSIONS.some((item) => item.name === version) ? version : fallback.version,
    account: Object.hasOwn(ACCOUNTS, account) ? account : fallback.account
  };
  try {
    storage?.setItem(SHELL_PREF_KEY, JSON.stringify(normalized));
  } catch {
    /* Ignore quota or privacy-mode errors. */
  }
  return normalized;
}

export const COMMIT_REFRESH_MS = 10 * 60 * 1000;
export const COMMIT_TIMEOUT_MS = 8000;
export const COMMIT_SOURCE_LABELS = {
  build: "构建时记录的提交",
  local: "本地最近提交"
};
export const COMMIT_ERROR_TITLE =
  "无法读取最近提交信息。请确认 npm run build 已生成 commit.json，或使用 node server.js 本地运行。";

export const formatRelativeTime = (date) => {
  const diff = Math.max(0, Date.now() - date.getTime());
  if (diff < 60_000) return "刚刚";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)} 分钟前`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)} 小时前`;
  if (diff < 7 * 86_400_000) return `${Math.floor(diff / 86_400_000)} 天前`;
  return date.toLocaleDateString("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit" });
};

export const normalizeCommit = (data, source) => {
  const commit = data?.commit || data;
  const rawDate = data?.date || commit?.committer?.date || commit?.author?.date;
  const date = rawDate ? new Date(rawDate) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  return {
    date,
    sha: data?.sha || commit?.sha || "",
    source: data?.source || source
  };
};

export const fetchLatestCommit = async (signal) => {
  const cacheBust = Date.now();
  const isLocalHost = ["localhost", "127.0.0.1", "[::1]"].includes(window.location.hostname);
  const endpoints = [
    { url: `commit.json?t=${cacheBust}`, source: "build" },
    ...(isLocalHost ? [{ url: `api/latest-commit?t=${cacheBust}`, source: "local" }] : [])
  ];
  for (const endpoint of endpoints) {
    try {
      const response = await fetch(endpoint.url, {
        signal,
        cache: "no-store",
        headers: { Accept: "application/json" }
      });
      if (!response.ok) continue;
      const data = await response.json();
      const item = Array.isArray(data) ? data[0] : data;
      const commit = normalizeCommit(item, endpoint.source);
      if (commit) return commit;
    } catch (error) {
      if (error?.name === "AbortError") throw error;
    }
  }
  return null;
};

// PCL's Modules/ModMain.vb declares `Enum HintType { Blue, Green, Red }`; the
// three gradients below are the exact 215/255-alpha colours built there. Yellow
// is a viewer-only extension for "worth noticing, not an error" states (the
// preset panel's oversize warning) and has no PCL counterpart, so a Custom.xaml
// that raises it would fail to parse `HintType` in the real launcher.
export const hintColors = {
  Blue: ["rgba(37, 155, 252, 0.843)", "rgba(10, 142, 252, 0.843)"],
  Green: ["rgba(33, 177, 33, 0.843)", "rgba(29, 160, 29, 0.843)"],
  Red: ["rgba(255, 53, 11, 0.843)", "rgba(255, 43, 0, 0.843)"],
  Yellow: ["rgba(245, 122, 0, 0.843)", "rgba(216, 108, 0, 0.843)"]
};

export const PCL_HINT_TYPES = ["Blue", "Green", "Red"];

/** Case-insensitive hint type lookup; unknown names fall back to Blue like PCL's default. */
export const resolveHintColors = (type) => {
  const normalized = String(type ?? "")
    .trim()
    .toLowerCase();
  const key = Object.keys(hintColors).find((name) => name.toLowerCase() === normalized) || "Blue";
  return { key, colors: hintColors[key] };
};

/**
 * How long a hint stays on screen, in ms.
 *
 * PCL uses `(800 + Text.Length.Clamp(5, 23) * 180) * AniSpeed` with the default
 * `SystemDebugAnim = 9` giving AniSpeed 1.0 (ModAnimation.vb:13-18), so the
 * factor is 1 unless a user turned the debug slider up.
 */
export const hintLifespan = (text, aniSpeed = 1) =>
  (800 + Math.min(23, Math.max(5, String(text ?? "").length)) * 180) * aniSpeed;

/** PCL keeps at most 20 bars on screen and drops the rest (ModMain.vb HintTick). */
export const HINT_LIMIT = 20;

/** Hide animation length: AaHeight(-26, 100) + the 150ms fade PCL runs with it. */
const HINT_HIDE_MS = 210;

const HINT_SHAKE = [
  { transform: "translateX(0)" },
  { transform: "translateX(8px)" },
  { transform: "translateX(0)" },
  { transform: "translateX(8px)" },
  { transform: "translateX(0)" }
];

/**
 * Render one runtime hint bar into `stack`, mirroring PCL's ModMain.vb HintTick:
 *
 * - newline-separated text collapses to single spaces;
 * - at most 20 bars; anything beyond is dropped instead of queued;
 * - a duplicate text reuses the existing bar, shakes it and **restarts its
 *   lifetime** (PCL re-arms the "Hint Hide" animation group), which the old
 *   code missed — the reused bar kept the first bar's timer and vanished early;
 * - a bar only counts as reusable once its entry animation finished, which here
 *   means "not already leaving".
 */
export function showRuntimeHint(stack, text, type = "Blue", { aniSpeed = 1 } = {}) {
  if (!stack) return null;
  const message = String(text ?? "")
    .replace(/\r?\n/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
  if (!message) return null;

  const { colors } = resolveHintColors(type);
  const existing = Array.from(stack.children).filter((child) => !child.classList.contains("is-leaving"));
  const duplicate = existing.find((child) => child.dataset.text === message);
  if (duplicate) {
    duplicate.animate(HINT_SHAKE, { duration: 200, easing: "ease-in-out" });
    armHintRemoval(duplicate, message, aniSpeed);
    return duplicate;
  }

  const node = document.createElement("div");
  node.className = "pcl-runtime-hint";
  node.dataset.text = message;
  node.style.setProperty("--hint-a", colors[0]);
  node.style.setProperty("--hint-b", colors[1]);
  node.textContent = message;
  // PCL only animates the height in when another bar is already showing; the
  // first bar starts at its full 26px.
  node.dataset.stacked = existing.length ? "true" : "false";
  stack.append(node);

  while (stack.children.length > HINT_LIMIT) stack.firstElementChild?.remove();
  armHintRemoval(node, message, aniSpeed);
  return node;
}

function armHintRemoval(node, message, aniSpeed) {
  if (node._hintTimer) window.clearTimeout(node._hintTimer);
  node._hintTimer = window.setTimeout(
    () => {
      node._hintTimer = 0;
      node.classList.add("is-leaving");
      window.setTimeout(() => node.remove(), HINT_HIDE_MS);
    },
    hintLifespan(message, aniSpeed)
  );
}

export const timeString = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
};

// A div with role="button" or role="tab" is announced as a button but does not
// activate on Enter/Space the way a native <button> does. This shim restores
// that behaviour, and stops Space from scrolling the page underneath.
export const bindPressable = (node, action) => {
  if (!node || typeof action !== "function") return;
  node.addEventListener("click", () => action());
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " " && event.key !== "Spacebar") return;
    if (event.target !== node) return;
    event.preventDefault();
    action();
  });
};
