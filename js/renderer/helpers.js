import { isPropertyElement, propertyElementName, parseDouble } from "../xaml.js";

export const SVG_NS = "http://www.w3.org/2000/svg";
export const NO_ICON = "assets/pcl/images/Icons/NoIcon.png";
export const RESOURCE_REF_RE = /^\{(?:Static|Dynamic)Resource\s+([^}]+)\}$/i;
export const bboxCache = new Map();

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
  if (bboxCache.has(data)) return bboxCache.get(data);
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
  bboxCache.set(data, result);
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
