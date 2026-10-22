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

export const hintColors = {
  Blue: ["rgba(37, 155, 252, 0.843)", "rgba(10, 142, 252, 0.843)"],
  Green: ["rgba(33, 177, 33, 0.843)", "rgba(29, 160, 29, 0.843)"],
  Red: ["rgba(255, 53, 11, 0.843)", "rgba(255, 43, 0, 0.843)"],
  Yellow: ["rgba(245, 122, 0, 0.843)", "rgba(216, 108, 0, 0.843)"]
};

export const timeString = (date) => {
  const d = date instanceof Date ? date : new Date(date);
  return d.toLocaleTimeString("zh-CN", { hour12: false });
};
