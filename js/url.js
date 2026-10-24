const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:", "minecraft:", "minecraft-preview:"]);

const MINECRAFT_URL_RE = /^minecraft(?:-preview)?:\/\//i;

/**
 * Normalize a user-facing external link and reject protocols that are not
 * web links or mail links. This guard belongs to the URL layer so every
 * caller of openUrl() gets the same protection.
 */
export function normalizeExternalUrl(value) {
  const text = String(value ?? "")
    .trim()
    .replaceAll("\\", "/");
  if (!text) return "";
  try {
    const url = new URL(text);
    if (!OPENABLE_PROTOCOLS.has(url.protocol)) return "";
    // PCL only accepts the double-slash form for Minecraft launcher links.
    if (url.protocol === "minecraft:" || url.protocol === "minecraft-preview:") {
      if (!MINECRAFT_URL_RE.test(text)) return "";
    }
    return url.toString();
  } catch {
    return "";
  }
}

export function isOpenableExternalUrl(value) {
  return Boolean(normalizeExternalUrl(value));
}

export function isMinecraftUrl(value) {
  return MINECRAFT_URL_RE.test(normalizeExternalUrl(value));
}

/**
 * Validate a remote homepage address before anything is fetched.
 *
 * A bare `^https?://` test lets `http://`, `http://user:pass@host/` and
 * `http://host:8080/` through to the proxy, where they either fail late with a
 * confusing message or quietly send credentials. Parse it here and say what is
 * wrong instead.
 *
 * @param {string} value
 * @returns {{ ok: true, url: string } | { ok: false, reason: string }}
 */
export function parseRemoteHomeUrl(value) {
  const text = String(value ?? "").trim();
  if (!text) return { ok: false, reason: "请填写联网主页地址。" };
  let url;
  try {
    url = new URL(text);
  } catch {
    return { ok: false, reason: "联网主页地址必须是完整的 URL，例如 https://example.com/Custom.xaml。" };
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return { ok: false, reason: "联网主页地址必须以 http:// 或 https:// 开头。" };
  }
  if (!url.hostname) return { ok: false, reason: "联网主页地址缺少主机名。" };
  if (url.username || url.password) {
    return { ok: false, reason: "联网主页地址不能包含用户名或密码，请把凭据从 URL 中移除。" };
  }
  if (url.port && url.port !== "80" && url.port !== "443") {
    return { ok: false, reason: `代理只允许 80 与 443 端口，无法访问 ${url.port} 端口。` };
  }
  return { ok: true, url: url.toString() };
}
