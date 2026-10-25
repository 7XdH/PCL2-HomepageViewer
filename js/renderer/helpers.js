import {
  isPropertyElement,
  propertyElementName,
  parseDouble,
  resolveColor,
  resolveImageSource,
  tagName
} from "../xaml.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const NO_ICON = "assets/pcl/images/Icons/NoIcon.png";
export const RESOURCE_REF_RE = /^\{(?:Static|Dynamic)Resource\s+([^}]+)\}$/i;
export const BBOX_CACHE_LIMIT = 512;
export const bboxCache = new Map();

export function rememberBBox(data, box) {
  if (bboxCache.size >= BBOX_CACHE_LIMIT) {
    const oldest = bboxCache.keys().next().value;
    if (oldest !== undefined) bboxCache.delete(oldest);
  }
  bboxCache.set(data, box);
}

export const getProp = (props, ...names) => {
  for (const name of names) {
    const value = props.get(String(name).toLowerCase());
    if (value !== undefined) return value;
  }
  return null;
};

export const hasProp = (props, ...names) => names.some((name) => props.has(String(name).toLowerCase()));

export const readProps = (element) => {
  const props = new Map();
  for (const attribute of element.attributes) {
    const name = attribute.name.toLowerCase();
    props.set(name, attribute.value);
    const local = name.split(":").pop();
    if (local && !props.has(local)) props.set(local, attribute.value);
    if (attribute.localName && !props.has(attribute.localName.toLowerCase())) {
      props.set(attribute.localName.toLowerCase(), attribute.value);
    }
  }
  return props;
};

export const alignmentMap = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
  stretch: "stretch",
  top: "flex-start",
  bottom: "flex-end"
};

export function parseSize(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || /^auto$/i.test(text) || text.startsWith("{")) return null;
  const number = parseDouble(text);
  return number == null ? null : number;
}

export function appendTextNode(container, text) {
  if (!text) return;
  let value = String(text)
    .replace(/\r\n|\r|\n/g, " ")
    .replace(/\t/g, " ");
  if (!value.trim() && container.childNodes.length) return;
  value = value.replace(/ {2,}/g, " ");
  if (!container.childNodes.length) value = value.replace(/^ +/, "");
  if (!value) return;
  container.append(document.createTextNode(value));
}

export function findPropertyElement(element, ...names) {
  const wanted = new Set(names.map((name) => name.toLowerCase()));
  for (const child of element.children) {
    if (!isPropertyElement(child)) continue;
    const name = propertyElementName(child).toLowerCase();
    if (wanted.has(name)) return child;
  }
  return null;
}

export function directContentChildren(element) {
  return Array.from(element.children).filter((child) => !isPropertyElement(child));
}

function parsePoint(value, fallback) {
  const parts = String(value ?? "")
    .split(/[,\s]+/)
    .map((part) => parseDouble(part))
    .filter((part) => part != null);
  return {
    x: parts[0] ?? fallback.x,
    y: parts[1] ?? fallback.y
  };
}

function gradientStops(element) {
  const stops = Array.from(element.querySelectorAll("GradientStop"))
    .map((stop, index) => {
      const props = readProps(stop);
      return {
        color: resolveColor(getProp(props, "Color")),
        offset: parseDouble(getProp(props, "Offset"), index)
      };
    })
    .filter((stop) => stop.color);
  return stops
    .map((stop, index) => ({
      ...stop,
      offset: Math.max(0, Math.min(1, stop.offset ?? index))
    }))
    .sort((a, b) => a.offset - b.offset)
    .map((stop) => `${stop.color} ${(stop.offset * 100).toFixed(2)}%`);
}

// Map a WPF Stretch/Alignment pair onto the CSS background-size /
// background-position pair that paints the same way.
const IMAGE_BRUSH_SIZE = {
  uniformtofill: "cover",
  uniform: "contain",
  fill: "100% 100%",
  none: "auto"
};

function imageBrushAlignment(value) {
  switch (String(value || "Center").toLowerCase()) {
    case "left":
    case "top":
      return "0%";
    case "right":
    case "bottom":
      return "100%";
    default:
      return "50%";
  }
}

// Resolve a WPF Brush object (usually inside a property element such as
// <Rectangle.Fill>) to a CSS paint description. Returns a CSS color/gradient
// string for solid and gradient brushes, or an object describing a tiled or
// stretched bitmap for <ImageBrush>, which PCL homepages use for full-bleed
// wallpaper backgrounds.
export function resolveBrush(element, baseUrl = "", onBaseUrl = null) {
  if (!element) return null;
  const name = tagName(element);
  const props = readProps(element);

  if (name === "SolidColorBrush") {
    return resolveColor(getProp(props, "Color")) || null;
  }

  if (name === "LinearGradientBrush") {
    const stops = gradientStops(element);
    if (!stops.length) return null;
    const start = parsePoint(getProp(props, "StartPoint"), { x: 0, y: 0 });
    const end = parsePoint(getProp(props, "EndPoint"), { x: 1, y: 1 });
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const angle = dx === 0 && dy === 0 ? 180 : ((Math.atan2(dx, -dy) * 180) / Math.PI + 360) % 360;
    return `linear-gradient(${angle.toFixed(2)}deg, ${stops.join(", ")})`;
  }

  if (name === "RadialGradientBrush") {
    const stops = gradientStops(element);
    return stops.length ? `radial-gradient(circle at 50% 50%, ${stops.join(", ")})` : null;
  }

  if (name === "ImageBrush") {
    const source = resolveImageSource(getProp(props, "ImageSource"), baseUrl, onBaseUrl);
    if (!source) return null;
    const stretch = String(getProp(props, "Stretch") || "Fill").toLowerCase();
    return {
      image: `url("${source.replace(/"/g, "%22")}")`,
      size: IMAGE_BRUSH_SIZE[stretch] || "100% 100%",
      position: `${imageBrushAlignment(getProp(props, "AlignmentX"))} ${imageBrushAlignment(
        getProp(props, "AlignmentY")
      )}`,
      repeat: /^(tile|repeat)$/i.test(String(getProp(props, "TileMode") || "")) ? "repeat" : "no-repeat"
    };
  }

  return null;
}

// Paint a resolved brush onto an element: colors and gradients go through
// background, bitmaps through the matching background-* longhands.
export function applyBrush(node, brush) {
  if (!brush) return false;
  if (typeof brush === "string") {
    node.style.background = brush;
    return true;
  }
  node.style.backgroundColor = "transparent";
  node.style.backgroundImage = brush.image;
  node.style.backgroundSize = brush.size;
  node.style.backgroundPosition = brush.position;
  node.style.backgroundRepeat = brush.repeat;
  return true;
}

export function normalizeFillRule(data) {
  const match = String(data)
    .trim()
    .match(/^F([01])\s+/i);
  if (!match) return { data: String(data).trim(), rule: "nonzero" };
  return { data: String(data).trim().slice(match[0].length), rule: match[1] === "0" ? "evenodd" : "nonzero" };
}

export function fallbackBBox(data) {
  const numbers = (String(data).match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) || []).map(Number).filter(Number.isFinite);
  if (!numbers.length) return { x: 0, y: 0, width: 24, height: 24 };
  const min = Math.min(...numbers, 0);
  const max = Math.max(...numbers, 24);
  return {
    x: Math.min(0, min),
    y: Math.min(0, min),
    width: Math.max(1, max - Math.min(0, min)),
    height: Math.max(1, max - Math.min(0, min))
  };
}

export function measurePath(data) {
  if (bboxCache.has(data)) {
    const cached = bboxCache.get(data);
    bboxCache.delete(data);
    bboxCache.set(data, cached);
    return cached;
  }
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.style.cssText =
    "position:fixed;left:-10000px;top:-10000px;width:1000px;height:1000px;overflow:visible;visibility:hidden";
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", data);
  svg.appendChild(path);
  document.body.appendChild(svg);
  let box;
  try {
    box = path.getBBox();
  } catch {
    box = null;
  }
  svg.remove();
  if (!box || !Number.isFinite(box.width) || !Number.isFinite(box.height) || box.width <= 0 || box.height <= 0) {
    box = fallbackBBox(data);
  }
  const result = { x: box.x, y: box.y, width: box.width, height: box.height };
  rememberBBox(data, result);
  return result;
}

export function buildPathSvg(data, options = {}) {
  const safeData = String(data ?? "").trim();
  if (!safeData || safeData.startsWith("{")) {
    return {
      svg: document.createElementNS(SVG_NS, "svg"),
      box: { x: 0, y: 0, width: 1, height: 1 }
    };
  }
  const normalized = normalizeFillRule(safeData);
  const box = measurePath(normalized.data);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", `${box.x} ${box.y} ${box.width} ${box.height}`);
  const stretch = String(options.stretch || "Uniform").toLowerCase();
  svg.setAttribute(
    "preserveAspectRatio",
    stretch === "fill" ? "none" : stretch === "uniformtofill" ? "xMidYMid slice" : "xMidYMid meet"
  );
  svg.setAttribute("focusable", "false");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute("d", normalized.data);
  path.setAttribute("fill-rule", normalized.rule);
  path.setAttribute("fill", options.fill ?? "currentColor");
  if (options.stroke) {
    path.setAttribute("stroke", options.stroke);
    path.setAttribute("stroke-width", String(options.strokeThickness ?? 1));
    path.setAttribute("stroke-linecap", "round");
    path.setAttribute("stroke-linejoin", "round");
  } else {
    path.setAttribute("stroke", "none");
  }
  svg.appendChild(path);
  return { svg, box };
}
