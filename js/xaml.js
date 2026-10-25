import { resolvePclImage } from "./assets.js";
import { assertTreeWithinBudget } from "./limits.js";

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

// Colour values that arrive from a remote XAML must not be able to smuggle CSS
// in. A WPF colour is a named colour or a hex literal, so anything else is
// rejected instead of being pasted into a style rule verbatim.
const WPF_NAMED_COLORS = new Set([
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "transparent",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen"
]);

// A colour we are willing to hand to CSS: hex, a functional rgb()/rgba()/hsl()
// built from numbers only, one of PCL's theme variables, or a WPF named colour.
const CSS_FUNCTION_COLOR_RE = /^(?:rgba?|hsla?)\(\s*[-\d.%\s,/]+\)$/i;
const CSS_VAR_COLOR_RE = /^var\(--pcl-[a-z0-9-]+\)$/i;
const HEX_COLOR_RE = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/**
 * True when `text` is a self-contained CSS colour with no escaping room.
 * @param {string} text
 * @returns {boolean}
 */
export function isSafeCssColor(text) {
  const value = String(text ?? "").trim();
  if (!value) return false;
  if (HEX_COLOR_RE.test(value)) return true;
  if (CSS_VAR_COLOR_RE.test(value)) return true;
  if (CSS_FUNCTION_COLOR_RE.test(value)) return true;
  return WPF_NAMED_COLORS.has(value.toLowerCase());
}

// Cursor keywords WPF/CSS share. `Hand` is mapped to `pointer` at the call
// site; anything not in here (notably `url(...)`) is refused.
const ALLOWED_CURSORS = new Set([
  "arrow",
  "appstarting",
  "auto",
  "busy",
  "cross",
  "crosshair",
  "default",
  "hand",
  "help",
  "ibeam",
  "move",
  "no",
  "none",
  "not-allowed",
  "pointer",
  "progress",
  "sizeall",
  "sizens",
  "sizenwse",
  "sizewe",
  "text",
  "uparrow",
  "wait",
  "col-resize",
  "row-resize",
  "grab",
  "grabbing"
]);

/**
 * Map a WPF Cursor value onto a CSS cursor, refusing anything that could load a
 * resource (`url(...)`) or escape the declaration.
 * @param {string} value
 * @returns {string | null}
 */
export function resolveCursor(value) {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase().replace(/\s+/g, "");
  if (!text || text.startsWith("{")) return null;
  const keyword = text === "hand" ? "pointer" : text;
  return ALLOWED_CURSORS.has(keyword) ? keyword : null;
}

/**
 * Keep a WPF font family usable in CSS: strip quotes/backslashes and refuse
 * constructs that start a new declaration or load a resource.
 * @param {string} value
 * @returns {string | null}
 */
export function sanitizeFontFamily(value) {
  if (value == null) return null;
  const text = String(value)
    .replace(/[\r\n]/g, " ")
    .trim();
  if (!text || text.startsWith("{")) return null;
  if (/url\(|expression|@import|[;{}\\"']/i.test(text)) return null;
  return text;
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
  return isSafeCssColor(text) ? text : null;
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
  // A malformed literal must not be handed to CSS as-is: that is the door a
  // crafted value would use to append further declarations.
  return null;
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
  } else if (numbers.length === 3) {
    // WPF's ThicknessConverter only takes 1, 2 or 4 numbers. Three is a typo,
    // so read it as CSS does (top, left+right, bottom) instead of leaving the
    // fourth side undefined.
    [t, l, b] = numbers;
    r = l;
  } else {
    // Four or more: WPF would throw; keep the first four so a stray extra value
    // cannot produce undefined sides either.
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

/**
 * Turn an authored image source into something the browser can load.
 *
 * The old version could only map a source onto PCL's bundled images, so every
 * `Source="images/a.png"` in a remote homepage fell through to `null` and the
 * picture disappeared (README listed this as a known limitation). A remote
 * document now carries its own URL, and relative references are resolved
 * against it the way any other relative URL would be. Note this is a viewer
 * convenience: PCL itself feeds `XamlReader.Load(Stream)` a MemoryStream that
 * has no base URI (ModBase.vb:1130-1145), so a relative source fails there.
 *
 * The bundled map still wins over the base URL: `pack://` bitmaps and PCL's own
 * `Heads/x.png` / `Blocks/Grass.png` names must never turn into network hits.
 *
 * @param {unknown} source
 * @param {string} [baseUrl] URL of the document that contains the source
 * @param {(source: string, resolved: string) => void} [onBaseUrl] called when a
 * source is only resolved because of `baseUrl`, so the caller can log that the
 * page relies on a viewer extension
 */
export function resolveImageSource(source, baseUrl = "", onBaseUrl = null) {
  const value = String(source ?? "").trim();
  if (!value) return null;
  if (/^(https?:|data:|blob:)/i.test(value)) return value;
  if (/^pack:\/\/application:,,,\/images\//i.test(value)) {
    return resolvePclImage(value.replace(/^pack:\/\/application:,,,\/images\//i, ""));
  }
  if (/^pack:\/\//i.test(value)) return null;
  // `assets/…` and `./…` address the viewer itself, never the remote document.
  if (/^\.\//.test(value) || /^assets\//i.test(value)) return value;
  const local = resolvePclImage(value);
  if (local) return local;
  if (baseUrl) {
    try {
      const resolved = new URL(value, baseUrl);
      if (/^https?:$/i.test(resolved.protocol)) {
        const url = resolved.toString();
        // PCL hands XamlReader a MemoryStream without a base URI, so this
        // success is the viewer's own extension. Report it instead of letting
        // a page look portable when only the browser finds its images.
        onBaseUrl?.(value, url);
        return url;
      }
    } catch {
      /* An unusable base URL simply means "no resolution", like before. */
    }
  }
  if (/^\//.test(value)) return value;
  return null;
}

const IMAGE_SOURCE_EXTENSION = /\.(png|jpe?g|webp|gif|bmp|ico|svg)(?:[?#]|$)/i;

/**
 * Whether a logo/source string names a bitmap rather than a Path geometry.
 *
 * MyListItem.xaml.vb:220-252 draws `Logo` as either a MyImage (when the value
 * starts with "http") or a bitmap-backed Canvas (when it ends with .png/.jpg/
 * .webp) and only falls back to a Path for everything else. The old inline
 * regex here missed `blob:` URLs and every pack:// bitmap whose resolved asset
 * path has no extension, so those logos were handed to the geometry parser and
 * disappeared. Anything that resolves to a bundled asset counts as an image
 * too, and `.svg` joins the list because the viewer can display it where WPF's
 * GeometryConverter would simply fail.
 */
export function isImageSource(source) {
  const value = String(source ?? "").trim();
  if (!value) return false;
  if (/^(https?:|data:|blob:)/i.test(value)) return true;
  const resolved = resolveImageSource(value);
  if (resolved && /^(https?:|data:|blob:)/i.test(resolved)) return true;
  if (resolved && /^assets\//i.test(resolved)) return true;
  return IMAGE_SOURCE_EXTENSION.test(resolved || value);
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
  assertTreeWithinBudget(root, (message) => new PclXamlError(message));
  return root;
}
