export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const SOURCE_STATE_PERSIST_LIMIT = 500000;

export function formatByteSize(bytes) {
  const value = Math.max(0, Number(bytes) || 0);
  if (value >= 1024 * 1024) {
    const mib = value / (1024 * 1024);
    return `${mib >= 10 ? mib.toFixed(0) : mib.toFixed(1)} MiB`;
  }
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KiB`;
  return `${value} B`;
}

export function sourceByteLength(value) {
  return new TextEncoder().encode(String(value ?? "")).byteLength;
}

export function sourceLimitError(bytes, label = "主页内容") {
  const error = new Error(
    `${label}大小为 ${formatByteSize(bytes)}，超过 ${formatByteSize(MAX_SOURCE_BYTES)} 上限。\n\n` +
      "请精简内容或移除内嵌的大图片；渲染器不会截断过大的 XAML。"
  );
  error.code = "SOURCE_TOO_LARGE";
  return error;
}

export function assertSourceWithinLimit(value, label = "主页内容") {
  const bytes = sourceByteLength(value);
  if (bytes > MAX_SOURCE_BYTES) throw sourceLimitError(bytes, label);
  return value;
}
