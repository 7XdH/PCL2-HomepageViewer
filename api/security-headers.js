const DOCUMENT_CSP = [
  "default-src 'self'",
  "base-uri 'none'",
  "object-src 'none'",
  "frame-ancestors 'none'",
  "form-action 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob: https: http:",
  "font-src 'self' data:",
  "connect-src 'self' https: http:",
  "media-src 'self' https: http:",
  "manifest-src 'self'",
  "worker-src 'self' blob:",
  "frame-src 'none'"
].join("; ");

const BASE_SECURITY_HEADERS = Object.freeze({
  "X-Content-Type-Options": "nosniff",
  "X-Frame-Options": "DENY",
  "Referrer-Policy": "no-referrer",
  "Permissions-Policy":
    "camera=(), geolocation=(), microphone=(), payment=(), usb=(), " +
    "accelerometer=(), gyroscope=(), magnetometer=(), " +
    "clipboard-read=(), clipboard-write=(self)",
  "Cross-Origin-Opener-Policy": "same-origin",
  "Cross-Origin-Resource-Policy": "same-origin",
  "X-Permitted-Cross-Domain-Policies": "none"
});

export function baseSecurityHeaders() {
  return { ...BASE_SECURITY_HEADERS };
}

export function documentSecurityHeaders() {
  return { "Content-Security-Policy": DOCUMENT_CSP };
}

export { DOCUMENT_CSP };
