const SVG_SECURITY_HEADERS = Object.freeze({
  "Content-Security-Policy":
    "default-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; " +
    "script-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; sandbox"
});

function isSvgType(contentType) {
  return /^image\/svg\+xml(?:;|$)/i.test(String(contentType || "").trim());
}

export function isSvgResponse(contentType, finalUrl) {
  if (isSvgType(contentType)) return true;
  let pathname = "";
  try {
    pathname = new URL(finalUrl).pathname.toLowerCase();
  } catch {
    pathname = "";
  }
  return /\.svg$/i.test(pathname) && (!contentType || /octet-stream/i.test(contentType));
}

export function svgResponseHeaders() {
  return { ...SVG_SECURITY_HEADERS };
}
