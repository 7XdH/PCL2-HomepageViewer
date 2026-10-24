export const MAX_SOURCE_BYTES = 4 * 1024 * 1024;
export const SOURCE_STATE_PERSIST_LIMIT = 500000;

// Budgets for the parsed tree. A 4 MiB document can still hold hundreds of
// thousands of elements, or nest far deeper than any hand-written homepage, and
// either would freeze the previewer (or blow the stack) while building nodes and
// walking resources. PCL's own Custom.xaml stays in the low hundreds of elements
// at a depth under 20, so these caps leave a wide margin.
export const MAX_XAML_NODES = 20000;
export const MAX_XAML_DEPTH = 64;

// Long-lived collections. Each cached preset source can be up to
// MAX_SOURCE_BYTES, help history holds whole rendered documents, and the event
// log keeps a single `data` string per event, so all three need a ceiling that
// used to be missing.
export const PRESET_CACHE_LIMIT = 10;
export const HELP_HISTORY_LIMIT = 20;
export const EVENT_LOG_LIMIT = 100;
export const EVENT_DATA_LIMIT = 400;

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

/**
 * Refuse a parsed tree that is too large or too deep to build safely.
 *
 * @param {Element} root parsed <PCLRoot>
 * @param {(message: string) => Error} makeError
 */
export function assertTreeWithinBudget(root, makeError) {
  let count = 0;
  let deepest = 0;
  // Explicit stack: measuring depth recursively would itself overflow on the
  // very input this guard exists to reject.
  const stack = [{ node: root, depth: 0 }];
  while (stack.length) {
    const { node, depth } = stack.pop();
    count += 1;
    if (depth > deepest) deepest = depth;
    if (count > MAX_XAML_NODES) {
      throw makeError(`主页元素数量超过 ${MAX_XAML_NODES} 个上限，请精简内容后再试。`);
    }
    if (depth > MAX_XAML_DEPTH) {
      throw makeError(`主页嵌套层级超过 ${MAX_XAML_DEPTH} 层上限，请精简结构后再试。`);
    }
    for (const child of node.children) stack.push({ node: child, depth: depth + 1 });
  }
  return { count, depth: deepest };
}
