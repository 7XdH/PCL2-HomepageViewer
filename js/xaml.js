import { resolvePclImage } from "./assets.js";

export class PclXamlError extends Error {
  constructor(message, options = {}) {
    super(message, options);
    this.name = "PclXamlError";
    this.cause = options.cause;
  }
}

const RESOURCE_MAP = {
  ColorBrush1: "var(--pcl-c1)",
  ColorBrush2: "var(--pcl-c2)",
  ColorBrush3: "var(--pcl-c3)",
  ColorBrush4: "var(--pcl-c4)",
  ColorBrush5: "var(--pcl-c5)",
  ColorBrush6: "var(--pcl-c6)",
  ColorBrush7: "var(--pcl-c7)",
  ColorBrush8: "var(--pcl-c8)",
  ColorBrushBg0: "var(--pcl-bg0)",
  ColorBrushBg1: "var(--pcl-bg1)",
  ColorObject1: "var(--pcl-c1)",
  ColorObject2: "var(--pcl-c2)",
  ColorObject3: "var(--pcl-c3)",
  ColorObject4: "var(--pcl-c4)",
  ColorObject5: "var(--pcl-c5)",
  ColorObject6: "var(--pcl-c6)",
  ColorObject7: "var(--pcl-c7)",
  ColorObject8: "var(--pcl-c8)",
  ColorObjectBg0: "var(--pcl-bg0)",
  ColorObjectBg1: "var(--pcl-bg1)",
  ColorBrushGray1: "var(--pcl-gray1)",
  ColorBrushGray2: "var(--pcl-gray2)",
  ColorBrushGray3: "var(--pcl-gray3)",
  ColorBrushGray4: "var(--pcl-gray4)",
  ColorBrushGray5: "var(--pcl-gray5)",
  ColorBrushGray6: "var(--pcl-gray6)",
  ColorBrushGray7: "var(--pcl-gray7)",
  ColorBrushGray8: "var(--pcl-gray8)",
  ColorObjectGray1: "var(--pcl-gray1)",
  ColorObjectGray2: "var(--pcl-gray2)",
  ColorObjectGray3: "var(--pcl-gray3)",
  ColorObjectGray4: "var(--pcl-gray4)",
  ColorObjectGray5: "var(--pcl-gray5)",
  ColorObjectGray6: "var(--pcl-gray6)",
  ColorObjectGray7: "var(--pcl-gray7)",
  ColorObjectGray8: "var(--pcl-gray8)",
  ColorBrushRedBack: "var(--pcl-red-back)",
  ColorBrushRedLight: "var(--pcl-red-light)",
  ColorBrushRedDark: "var(--pcl-red-dark)",
  ColorBrushHalfWhite: "var(--pcl-half-white)",
  ColorBrushSemiWhite: "var(--pcl-semi-white)",
  ColorBrushWhite: "#ffffff",
  ColorBrushTransparent: "transparent",
  ColorBrushSemiTransparent: "transparent",
  ColorBrushBackgroundTransparentSidebar: "var(--pcl-sidebar)"
};

const BLACKLISTED_TYPES = new Set([
  "WebBrowser",
  "Frame",
  "MediaElement",
  "ObjectDataProvider",
  "XamlReader",
  "Window",
  "XmlDataProvider",
  "SettingService"
]);

const BLACKLISTED_MEMBERS = new Set(["Code", "FactoryMethod", "Static"]);

const SIMPLE_PLACEHOLDERS = new Set([
  "pcl_version",
  "pcl_version_code",
  "pcl_version_branch",
  "pcl_build_type",
  "pcl_branch",
  "identify",
  "path",
  "path_with_name",
  "path_temp",
  "pcl_md5",
  "pcl_sha1",
  "date",
  "time",
  "java",
  "minecraft",
  "version_path",
  "verpath",
  "version_indie",
  "verindie",
  "name",
  "version",
  "forge",
  "fabric",
  "neoforge",
  "liteloader",
  "user",
  "uuid",
  "login",
  "hint",
  "cave"
]);

const PLACEHOLDER_RE = /\{(?:variable|varible):([^:}]+)(?::([^}]*))?\}|\{setup:([A-Za-z0-9_]+)\}|\{([A-Za-z0-9_]+)\}/gi;

export function escapeXml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;")
    .replaceAll("\r\n", "&#xA;")
    .replaceAll("\r", "&#xA;")
    .replaceAll("\n", "&#xA;");
}

export function resolveColor(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text) return null;
  if (text.startsWith("{")) {
    const resource = text.match(/^\{(?:Dynamic|Static)Resource\s+([^}]+)\}$/i);
    if (resource) return RESOURCE_MAP[resource[1].trim()] ?? null;
    return null;
  }
  if (text.startsWith("#")) return wpfColorToCss(text);
  return text;
}

export function wpfColorToCss(value) {
  const hex = value.slice(1).trim();
  if (/^[0-9a-f]{3}$/i.test(hex) || /^[0-9a-f]{6}$/i.test(hex)) return `#${hex}`;
  if (/^[0-9a-f]{4}$/i.test(hex)) {
    return `#${hex.slice(1, 4)}${hex.slice(0, 1)}`;
  }
  if (/^[0-9a-f]{8}$/i.test(hex)) {
    const a = parseInt(hex.slice(0, 2), 16) / 255;
    const r = parseInt(hex.slice(2, 4), 16);
    const g = parseInt(hex.slice(4, 6), 16);
    const b = parseInt(hex.slice(6, 8), 16);
    if (a >= 0.999) return `#${hex.slice(2)}`;
    return `rgba(${r}, ${g}, ${b}, ${Number(a.toFixed(3))})`;
  }
  return value;
}

export function parseDouble(value, fallback = null) {
  if (value == null || value === "") return fallback;
  const number = Number.parseFloat(String(value).replace("px", "").trim());
  return Number.isFinite(number) ? number : fallback;
}

export function parseBool(value, fallback = false) {
  if (value == null || value === "") return fallback;
  const text = String(value).trim().toLowerCase();
  if (["true", "1", "yes"].includes(text)) return true;
  if (["false", "0", "no"].includes(text)) return false;
  return fallback;
}

export function parseThickness(value) {
  if (value == null || value === "") return null;
  const parts = String(value)
    .split(/[,\s]+/)
    .map((part) => part.trim())
    .filter(Boolean);
  if (!parts.length) return null;
  const numbers = parts.map((part) => parseDouble(part, 0));
  let l;
  let t;
  let r;
  let b;
  if (numbers.length === 1) {
    [l] = numbers;
    t = l;
    r = l;
    b = l;
  } else if (numbers.length === 2) {
    [l, t] = numbers;
    r = l;
    b = t;
  } else {
    [l, t, r, b] = numbers;
  }
  return { l, t, r, b, css: `${t}px ${r}px ${b}px ${l}px` };
}

export function parseCornerRadius(value) {
  if (value == null || value === "") return null;
  const parts = String(value)
    .split(/[,\s]+/)
    .map((part) => parseDouble(part, 0));
  if (parts.length === 1) return `${parts[0]}px`;
  if (parts.length === 2) return `${parts[0]}px ${parts[1]}px`;
  if (parts.length === 3) return `${parts[0]}px ${parts[1]}px ${parts[2]}px`;
  return parts
    .slice(0, 4)
    .map((number) => `${number}px`)
    .join(" ");
}

export function parseFontWeight(value) {
  if (value == null || value === "") return null;
  const text = String(value).trim().toLowerCase();
  if (text === "bold") return "700";
  if (text === "normal") return "400";
  if (text === "light") return "300";
  if (text === "thin") return "200";
  if (text === "medium") return "500";
  if (text === "semibold") return "600";
  if (text === "black" || text === "heavy") return "900";
  const number = Number.parseInt(text, 10);
  return Number.isFinite(number) ? String(number) : null;
}

export function attributeValue(element, ...names) {
  if (!element?.attributes) return null;
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const attribute of element.attributes) {
    if (wanted.has(attribute.name.toLowerCase())) return attribute.value;
  }
  return null;
}

export function tagName(element) {
  const name = element?.nodeName || "";
  const colon = name.indexOf(":");
  return colon >= 0 ? name.slice(colon + 1) : name;
}

export function isPropertyElement(element) {
  return tagName(element).includes(".");
}

export function propertyElementName(element) {
  const name = tagName(element);
  const dot = name.lastIndexOf(".");
  return dot >= 0 ? name.slice(dot + 1) : name;
}

export function resolveImageSource(source) {
  const value = String(source ?? "").trim();
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (/^pack:\/\/application:,,,\/images\//i.test(value)) {
    return resolvePclImage(value.replace(/^pack:\/\/application:,,,\/images\//i, ""));
  }
  if (/^pack:\/\//i.test(value)) return null;
  if (/^\.?\//.test(value) || /^assets\//i.test(value)) return value;
  return resolvePclImage(value);
}

export function extractText(element) {
  if (!element) return "";
  let result = "";
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE) result += node.nodeValue;
    else if (node.nodeType === Node.ELEMENT_NODE) {
      const name = tagName(node);
      if (name === "LineBreak") result += "\n";
      else if (["Run", "Bold", "Italic", "Underline", "Span", "Hyperlink", "TextBlock"].includes(name)) {
        result += attributeValue(node, "Text") ?? extractText(node);
      }
    }
  }
  return result;
}

export function readEvents(element) {
  const events = [];
  const pushEvent = (node) => {
    const type = attributeValue(node, "Type", "EventType");
    if (!type || type === "None") return;
    events.push({
      type: String(type).trim(),
      data: attributeValue(node, "Data", "EventData") ?? ""
    });
  };

  for (const child of element.children) {
    const name = tagName(child);
    if (name.endsWith("CustomEventService.Events") || name === "Events" || name === "CustomEventCollection") {
      for (const node of child.querySelectorAll("*")) {
        if (tagName(node) === "CustomEvent") pushEvent(node);
      }
    } else if (name === "CustomEvent") {
      pushEvent(child);
    }
  }

  const attachedType = attributeValue(element, "local:CustomEventService.EventType", "EventType");
  const attachedData = attributeValue(element, "local:CustomEventService.EventData", "EventData") ?? "";
  if (attachedType && attachedType !== "None") {
    events.push({ type: String(attachedType).trim(), data: attachedData });
  }
  return events;
}

function resolveSimplePlaceholder(name, context) {
  switch (name) {
    case "hint":
      return context.randomHint?.() ?? "";
    case "cave":
      return context.randomCave?.() ?? "";
    case "user":
      return context.user?.name ?? "Steve";
    case "uuid":
      return context.user?.uuid ?? "00000000-0000-0000-0000-000000000000";
    case "login":
      return context.user?.login ?? "离线";
    default:
      return "";
  }
}

export function substitutePlaceholders(source, context = {}, { escape = true } = {}) {
  return String(source ?? "").replace(
    PLACEHOLDER_RE,
    (match, variableName, variableFallback, settingName, simpleName) => {
      let value = "";
      if (variableName) {
        value = context.getVariable?.(variableName, variableFallback ?? "") ?? variableFallback ?? "";
      } else if (settingName) {
        value = context.getSetting?.(settingName) ?? "";
      } else if (simpleName) {
        const name = simpleName.toLowerCase();
        if (!SIMPLE_PLACEHOLDERS.has(name)) return match;
        value = context.getPlaceholder?.(name);
        if (value === undefined || value === null) value = resolveSimplePlaceholder(name, context);
      }
      return escape ? escapeXml(value) : String(value ?? "");
    }
  );
}

function verifySecurity(root) {
  for (const element of root.querySelectorAll("*")) {
    const name = tagName(element);
    if (BLACKLISTED_TYPES.has(name)) {
      throw new PclXamlError(`基于安全考虑，不允许使用 ${name} 类型。`);
    }
    for (const attribute of element.attributes) {
      const attributeLocal = (attribute.name.split(":").pop() || "").trim();
      if (BLACKLISTED_MEMBERS.has(attributeLocal)) {
        throw new PclXamlError(`基于安全考虑，不允许使用 ${attributeLocal} 成员。`);
      }
      if (/\{x:(?:Static|Code)\b/i.test(attribute.value)) {
        throw new PclXamlError("基于安全考虑，不允许使用 x:Static 或 x:Code。");
      }
    }
  }
}

export function parseXaml(source, context = {}) {
  if (source == null) throw new PclXamlError("主页内容为空。");
  let content = String(source)
    .replace(/^\uFEFF/, "")
    .trim();
  if (!content) throw new PclXamlError("主页内容为空。");

  content = content.replace(/<\?xml[\s\S]*?\?>/gi, "");
  content = substitutePlaceholders(content, context);
  content = content.replace(/\sxmlns(?::[\w.-]+)?\s*=\s*(?:"[^"]*"|'[^']*')/gi, "");

  // WPF accepts clr-namespace URIs with spaces; DOMParser requires a valid URI.
  // Prefixes are resolved by local name in the renderer, so any stable URI works.
  const namespaceRoot = [
    'xmlns="http://schemas.microsoft.com/winfx/2006/xaml/presentation"',
    'xmlns:sys="urn:pcl:sys"',
    'xmlns:x="http://schemas.microsoft.com/winfx/2006/xaml"',
    'xmlns:local="urn:pcl:local"',
    'xmlns:core="urn:meloongcore"',
    'xmlns:corewpf="urn:meloongcore:wpf"'
  ].join(" ");

  const wrapped = `<PCLRoot ${namespaceRoot}>${content}</PCLRoot>`;
  let document;
  try {
    document = new DOMParser().parseFromString(wrapped, "application/xml");
  } catch (error) {
    throw new PclXamlError(`XML 解析失败：${error.message}`, { cause: error });
  }

  const parserError =
    document.querySelector("parsererror") ||
    (document.documentElement?.nodeName.toLowerCase() === "parsererror" ? document.documentElement : null);
  if (parserError) {
    const message = parserError.textContent.trim().replace(/\s+/g, " ").slice(0, 900);
    throw new PclXamlError(`XAML 格式有误：${message}`);
  }

  const root = document.documentElement;
  if (!root || tagName(root) !== "PCLRoot") {
    throw new PclXamlError("无法创建 XAML 根节点。");
  }
  verifySecurity(root);
  return root;
}
