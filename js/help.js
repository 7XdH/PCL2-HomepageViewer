const decodeXmlText = (value) => {
  const area = document.createElement("textarea");
  area.innerHTML = String(value ?? "");
  return area.value;
};

const normalizeHelpAddress = (raw) =>
  String(raw ?? "")
    .trim()
    .replaceAll("\\", "/");

/**
 * PCL 的“打开帮助”事件通常指向帮助 JSON；真正的页面内容是同目录下同名 .xaml。
 * 与 .NET 的 Path.ChangeExtension 一致：支持 .json / .xaml，也支持无扩展名或
 * 其他扩展名的地址。只有 http(s) 地址会交给远程渲染器。
 */
export function resolveHelpUrls(raw) {
  const address = normalizeHelpAddress(raw);
  if (!/^https?:\/\//i.test(address)) return null;

  let url;
  try {
    url = new URL(address);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;

  const extension = url.pathname.match(/\.([^./]*)$/)?.[1]?.toLowerCase() || "";
  const basePath = extension ? url.pathname.replace(/\.[^./]*$/, "") : url.pathname;
  const jsonUrl = new URL(url);
  const xamlUrl = new URL(url);
  jsonUrl.pathname = `${basePath}.json`;
  xamlUrl.pathname = `${basePath}.xaml`;

  return {
    jsonUrl: jsonUrl.toString(),
    xamlUrl: xamlUrl.toString()
  };
}

export function resolveHelpXamlUrl(raw) {
  return resolveHelpUrls(raw)?.xamlUrl || "";
}

export function helpJsonTitle(source, fallback = "") {
  try {
    const data = JSON.parse(String(source ?? "").replace(/^\uFEFF/, ""));
    const title = typeof data?.Title === "string" ? data.Title.trim() : "";
    return title || fallback;
  } catch {
    return fallback;
  }
}

export function helpTitleFromXaml(xaml, fallback = "PCL 帮助") {
  const source = String(xaml ?? "");
  const patterns = [
    /<(?:[\w.-]+:)?MyCard\b[^>]*\bTitle\s*=\s*(?:"([^"]*)"|'([^']*)')/i,
    /<(?:[\w.-]+:)?TextBlock\b[^>]*\bText\s*=\s*(?:"([^"]*)"|'([^']*)')/i
  ];
  for (const pattern of patterns) {
    const match = source.match(pattern);
    const title = match
      ? decodeXmlText(match[1] ?? match[2] ?? "")
          .replace(/\{[^}]*\}/g, "")
          .replace(/\s+/g, " ")
          .trim()
      : "";
    if (title) return title;
  }
  return fallback;
}
