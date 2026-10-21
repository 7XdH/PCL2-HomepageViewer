const OPENABLE_PROTOCOLS = new Set(["http:", "https:", "mailto:"]);

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
    return url.toString();
  } catch {
    return "";
  }
}

export function isOpenableExternalUrl(value) {
  return Boolean(normalizeExternalUrl(value));
}
