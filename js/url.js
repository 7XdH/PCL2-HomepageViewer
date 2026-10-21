const OPENABLE_PROTOCOLS = new Set([
  "http:",
  "https:",
  "mailto:",
  "minecraft:",
  "minecraft-preview:"
]);

const MINECRAFT_URL_RE = /^minecraft(?:-preview)?:\/\//i;

/**
 * Normalize a user-facing external link and reject protocols that are not
 * web links or mail links. This guard belongs to the URL layer so every
 * caller of openUrl() gets the same protection.
 */
export function normalizeExternalUrl(value) {
  const text = String(value ?? "").trim().replaceAll("\\", "/");
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
