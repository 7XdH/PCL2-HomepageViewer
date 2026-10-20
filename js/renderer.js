import {
  parseXaml,
  tagName,
  isPropertyElement,
  propertyElementName,
  readEvents,
  resolveColor,
  parseDouble,
  parseBool,
  parseThickness,
  parseCornerRadius,
  parseFontWeight,
  resolveImageSource,
  extractText,
  attributeValue
} from "./xaml.js?v=20261020f";

const SVG_NS = "http://www.w3.org/2000/svg";
const NO_ICON = "assets/pcl/images/Icons/NoIcon.png";
const RESOURCE_REF_RE = /^\{(?:Static|Dynamic)Resource\s+([^}]+)\}$/i;
const bboxCache = new Map();

const getProp = (props, ...names) => {
  for (const name of names) {
    const value = props.get(String(name).toLowerCase());
    if (value !== undefined) return value;
  }
  return null;
};

const hasProp = (props, ...names) => names.some(name => props.has(String(name).toLowerCase()));

const readProps = element => {
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

const alignmentMap = {
  left: "flex-start",
  center: "center",
  right: "flex-end",
  stretch: "stretch",
  top: "flex-start",
  bottom: "flex-end"
};

function parseSize(value) {
  if (value == null) return null;
  const text = String(value).trim();
  if (!text || /^auto$/i.test(text) || text.startsWith("{")) return null;
  const number = parseDouble(text);
  return number == null ? null : number;
}

function appendTextNode(container, text) {
  if (!text) return;
  let value = String(text).replace(/\r\n|\r|\n/g, " ").replace(/\t/g, " ");
  if (!value.trim() && container.childNodes.length) return;
  value = value.replace(/ {2,}/g, " ");
  if (!container.childNodes.length) value = value.replace(/^ +/, "");
  if (!value) return;
  container.append(document.createTextNode(value));
}

function findPropertyElement(element, ...names) {
  const wanted = new Set(names.map(name => name.toLowerCase()));
  for (const child of element.children) {
    if (!isPropertyElement(child)) continue;
    const name = propertyElementName(child).toLowerCase();
    if (wanted.has(name)) return child;
  }
  return null;
}

function directContentChildren(element) {
  return Array.from(element.children).filter(child => !isPropertyElement(child));
}

function normalizeFillRule(data) {
  const match = String(data).trim().match(/^F([01])\s+/i);
  if (!match) return { data: String(data).trim(), rule: "nonzero" };
  return { data: String(data).trim().slice(match[0].length), rule: match[1] === "0" ? "evenodd" : "nonzero" };
}

function fallbackBBox(data) {
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

function measurePath(data) {
  if (bboxCache.has(data)) return bboxCache.get(data);
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("viewBox", "0 0 1000 1000");
  svg.style.cssText = "position:fixed;left:-10000px;top:-10000px;width:1000px;height:1000px;overflow:visible;visibility:hidden";
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

function buildPathSvg(data, options = {}) {
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
  svg.setAttribute("preserveAspectRatio", stretch === "fill" ? "none" : stretch === "uniformtofill" ? "xMidYMid slice" : "xMidYMid meet");
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

export class PclRenderer {
  constructor({ root, runtime }) {
    this.root = root;
    this.runtime = runtime;
    this.warnings = [];
    this.controlCount = 0;
    this.resources = new Map();
    this.implicitStyles = new Map();
    this.resourceNodes = new WeakSet();
  }

  render(source) {
    const started = performance.now();
    this.warnings = [];
    this.controlCount = 0;
    const documentRoot = parseXaml(source, this.runtime.context);
    this.collectResources(documentRoot);
    this.applyStyles(documentRoot);
    this.resolveResourceReferences(documentRoot);
    const stack = document.createElement("div");
    stack.className = "pcl-xaml-root";

    for (const child of documentRoot.children) {
      if (isPropertyElement(child)) continue;
      const node = this.buildNode(child, { kind: "stack-v" });
      if (node) stack.append(node);
    }

    this.root.replaceChildren(stack);
    this.root.scrollTop = 0;
    const duration = Math.max(1, Math.round(performance.now() - started));
    return { controls: this.controlCount, duration, warnings: this.warnings.slice() };
  }

  warn(message) {
    this.warnings.push(message);
    console.warn("[PCL Renderer]", message);
  }

  count(node) {
    this.controlCount += 1;
    return node;
  }

  collectResources(root) {
    this.resources = new Map();
    this.implicitStyles = new Map();
    this.resourceNodes = new WeakSet();

    const register = resource => {
      this.markResource(resource);
      const key = attributeValue(resource, "x:Key", "Key");
      if (key) {
        this.resources.set(key.trim(), resource);
        return;
      }
      if (tagName(resource) === "Style") {
        const target = String(attributeValue(resource, "TargetType") || "").split(":").pop();
        if (target) this.implicitStyles.set(target.toLowerCase(), resource);
      }
    };

    for (const element of root.querySelectorAll("*")) {
      if (!isPropertyElement(element) || propertyElementName(element).toLowerCase() !== "resources") continue;
      for (const resource of element.children) {
        if (tagName(resource) === "ResourceDictionary") {
          for (const item of resource.children) register(item);
        } else {
          register(resource);
        }
      }
    }
  }

  markResource(node) {
    this.resourceNodes.add(node);
    for (const child of node.children) this.markResource(child);
  }

  resolveStyleElement(value) {
    const match = String(value ?? "").match(RESOURCE_REF_RE);
    if (!match) return null;
    const resource = this.resources.get(match[1].trim());
    if (!resource) return null;
    return tagName(resource) === "Style" ? resource : null;
  }

  resolveResourceElement(value) {
    const match = String(value ?? "").match(RESOURCE_REF_RE);
    if (!match) return null;
    return this.resources.get(match[1].trim()) || null;
  }

  hasAttribute(element, name) {
    const wanted = String(name).toLowerCase();
    return Array.from(element.attributes).some(attribute => attribute.name.toLowerCase() === wanted);
  }

  applyStyles(root) {
    for (const element of root.querySelectorAll("*")) {
      if (element === root || this.resourceNodes.has(element) || isPropertyElement(element)) continue;
      const styleRef = attributeValue(element, "Style");
      const style = this.resolveStyleElement(styleRef) || this.implicitStyles.get(tagName(element).toLowerCase());
      if (style) this.applyStyle(element, style, new Set());
    }
  }

  applyStyle(element, style, seen) {
    if (!style || seen.has(style)) return;
    seen.add(style);
    const basedOn = this.resolveStyleElement(attributeValue(style, "BasedOn"));
    if (basedOn) this.applyStyle(element, basedOn, seen);

    const setters = [];
    for (const child of style.children) {
      if (tagName(child) === "Setter") {
        setters.push(child);
      } else if (isPropertyElement(child) && propertyElementName(child).toLowerCase() === "setters") {
        for (const setter of child.children) {
          if (tagName(setter) === "Setter") setters.push(setter);
        }
      }
    }

    for (const setter of setters) {
      const property = attributeValue(setter, "Property");
      if (!property || property.toLowerCase() === "template") continue;
      if (this.hasAttribute(element, property)) continue;
      const value = attributeValue(setter, "Value");
      if (value == null) continue;
      try {
        element.setAttribute(property, value);
      } catch {
        /* Ignore setter names that are not valid XML attributes. */
      }
    }
  }

  resolveResourceReferences(root) {
    const primitiveTypes = new Set(["String", "Double", "Int32", "Int64", "Boolean", "Color"]);
    for (const element of root.querySelectorAll("*")) {
      if (this.resourceNodes.has(element) || isPropertyElement(element)) continue;
      for (const attribute of Array.from(element.attributes)) {
        const name = attribute.name.toLowerCase();
        if (name === "style" || name === "basedon" || name === "template") continue;
        const resource = this.resolveResourceElement(attribute.value);
        if (!resource || !primitiveTypes.has(tagName(resource))) continue;
        try {
          element.setAttribute(attribute.name, resource.textContent.trim());
        } catch {
          /* Ignore malformed resource values. */
        }
      }
    }
  }

  buildNode(element, layout) {
    const name = tagName(element);
    switch (name) {
      case "StackPanel": return this.buildStackPanel(element, layout);
      case "WrapPanel": return this.buildWrapPanel(element, layout);
      case "Grid": return this.buildGrid(element, layout);
      case "Canvas": return this.buildCanvas(element, layout);
      case "Border": return this.buildBorder(element, layout);
      case "ScrollViewer": return this.buildScrollViewer(element, layout);
      case "Viewbox": return this.buildViewbox(element, layout);
      case "TextBlock": return this.buildTextBlock(element, layout);
      case "Image":
      case "MyImage": return this.buildImage(element, layout);
      case "Path": return this.buildPath(element, layout);
      case "Rectangle":
      case "Ellipse":
      case "Line":
      case "Polygon":
      case "Polyline": return this.buildShape(element, layout, name);
      case "MyCard": return this.buildMyCard(element, layout);
      case "MyHint": return this.buildMyHint(element, layout);
      case "MyButton": return this.buildMyButton(element, layout);
      case "MyTextButton": return this.buildMyTextButton(element, layout);
      case "MyIconButton": return this.buildMyIconButton(element, layout);
      case "MyIconTextButton": return this.buildMyIconTextButton(element, layout);
      case "MyListItem": return this.buildMyListItem(element, layout);
      case "MyLoading": return this.buildMyLoading(element, layout);
      case "FlowDocumentScrollViewer": return this.buildFlowDocumentScrollViewer(element, layout);
      case "FlowDocument": return this.buildFlowDocument(element, layout);
      case "Paragraph": return this.buildFlowParagraph(element, layout);
      case "Section": return this.buildFlowSection(element, layout);
      case "List": return this.buildFlowList(element, layout);
      case "ListItem": return this.buildFlowListItem(element, layout);
      case "ContentControl": return this.buildContentControl(element, layout);
      case "TextBox": return this.buildTextBox(element, layout);
      case "MyCheckBox":
      case "MyRadioBox":
      case "MyRadioButton": return this.buildCheck(element, layout, name);
      default: return this.buildUnsupported(element, layout, name);
    }
  }

  applyBox(node, props) {
    const width = parseSize(getProp(props, "Width"));
    const height = parseSize(getProp(props, "Height"));
    const minWidth = parseSize(getProp(props, "MinWidth"));
    const minHeight = parseSize(getProp(props, "MinHeight"));
    const maxWidth = parseSize(getProp(props, "MaxWidth"));
    const maxHeight = parseSize(getProp(props, "MaxHeight"));
    const margin = parseThickness(getProp(props, "Margin"));

    if (width != null) node.style.width = `${width}px`;
    if (height != null) node.style.height = `${height}px`;
    if (minWidth != null) node.style.minWidth = `${minWidth}px`;
    if (minHeight != null) node.style.minHeight = `${minHeight}px`;
    if (maxWidth != null) node.style.maxWidth = `${maxWidth}px`;
    if (maxHeight != null) node.style.maxHeight = `${maxHeight}px`;
    if (margin) node.style.margin = margin.css;

    const opacity = parseDouble(getProp(props, "Opacity"));
    if (opacity != null) node.style.opacity = String(Math.max(0, Math.min(1, opacity)));

    const visibility = (getProp(props, "Visibility") || "Visible").toLowerCase();
    if (visibility === "collapsed") node.style.display = "none";
    else if (visibility === "hidden") node.style.visibility = "hidden";

    if (!parseBool(getProp(props, "IsHitTestVisible"), true)) node.style.pointerEvents = "none";

    const tooltip = getProp(props, "ToolTip");
    if (tooltip && !String(tooltip).trim().startsWith("{")) node.dataset.tooltip = tooltip;

    const cursor = getProp(props, "Cursor");
    if (cursor && !String(cursor).startsWith("{")) {
      node.style.cursor = String(cursor).toLowerCase() === "hand" ? "pointer" : cursor;
    }

    const zIndex = parseDouble(getProp(props, "Panel.ZIndex", "ZIndex"));
    if (zIndex != null) node.style.zIndex = String(zIndex);

    return { width, height };
  }


  applyAlignment(node, props, layout, defaults = {}) {
    const horizontal = (getProp(props, "HorizontalAlignment") || defaults.horizontal || "Stretch").toLowerCase();
    const vertical = (getProp(props, "VerticalAlignment") || defaults.vertical || "Stretch").toLowerCase();
    const h = alignmentMap[horizontal] || "stretch";
    const v = alignmentMap[vertical] || "stretch";

    switch (layout.kind) {
      case "stack-v":
        node.style.alignSelf = h;
        break;
      case "stack-h":
      case "wrap-h":
        node.style.alignSelf = v;
        break;
      case "wrap-v":
        node.style.alignSelf = h;
        break;
      case "grid":
        node.style.justifySelf = h;
        node.style.alignSelf = v;
        break;
      case "border":
      case "scroll":
        node.style.alignSelf = h;
        if (vertical === "center") {
          node.style.marginTop = "auto";
          node.style.marginBottom = "auto";
        } else if (vertical === "bottom") {
          node.style.marginTop = "auto";
        }
        break;
      case "canvas":
        break;
      default:
        node.style.alignSelf = h;
    }
  }

  applyEnabled(node, props) {
    const enabled = parseBool(getProp(props, "IsEnabled"), true);
    if (!enabled) {
      node.classList.add("is-disabled");
      node.setAttribute("aria-disabled", "true");
      if ("disabled" in node) node.disabled = true;
    }
    return enabled;
  }

  bindEvents(node, element, { stopPropagation = true } = {}) {
    const events = readEvents(element);
    if (!events.length) return events;
    node.__pclEvents = events;
    node.classList.add("has-pcl-events");
    node.addEventListener("click", event => {
      if (stopPropagation) event.stopPropagation();
      this.runtime.raise(events, node);
    });
    return events;
  }

  applyForeground(node, props) {
    const foreground = resolveColor(getProp(props, "Foreground"));
    if (foreground) node.style.color = foreground;
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
  }


  applyInlineStyles(node, props) {
    const foreground = resolveColor(getProp(props, "Foreground"));
    if (foreground) node.style.color = foreground;
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    const fontSize = parseDouble(getProp(props, "FontSize"));
    if (fontSize != null) node.style.fontSize = `${fontSize}px`;
    const weight = parseFontWeight(getProp(props, "FontWeight"));
    if (weight) node.style.fontWeight = weight;
    const style = getProp(props, "FontStyle");
    if (style && /italic|oblique/i.test(style)) node.style.fontStyle = "italic";
    const decorations = getProp(props, "TextDecorations");
    if (decorations && /underline/i.test(decorations)) node.style.textDecoration = "underline";
    if (decorations && /strikethrough/i.test(decorations)) node.style.textDecoration = "line-through";
    const lineHeight = parseDouble(getProp(props, "LineHeight"));
    if (lineHeight != null) node.style.lineHeight = `${lineHeight}px`;
  }

  appendInlines(element, container) {
    for (const node of element.childNodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        appendTextNode(container, node.nodeValue);
        continue;
      }
      if (node.nodeType !== Node.ELEMENT_NODE) continue;
      if (isPropertyElement(node)) continue;
      const name = tagName(node);
      const props = readProps(node);

      if (name === "LineBreak") {
        container.append(document.createElement("br"));
      } else if (name === "Run") {
        const span = document.createElement("span");
        span.className = "pcl-inline-run";
        this.applyInlineStyles(span, props);
        const text = getProp(props, "Text");
        if (text != null) span.textContent = text;
        else this.appendInlines(node, span);
        container.append(span);
      } else if (["Bold", "Italic", "Underline", "Span", "TextBlock"].includes(name)) {
        const span = document.createElement("span");
        if (name === "Bold") span.classList.add("pcl-inline-bold");
        if (name === "Italic") span.classList.add("pcl-inline-italic");
        if (name === "Underline") span.classList.add("pcl-inline-underline");
        this.applyInlineStyles(span, props);
        const text = getProp(props, "Text");
        if (text != null) span.textContent = text;
        else this.appendInlines(node, span);
        container.append(span);
      } else if (name === "Hyperlink") {
        const url = getProp(props, "NavigateUri");
        const link = document.createElement("span");
        link.className = "pcl-inline-link";
        if (url && /^(https?|mailto):/i.test(String(url).trim())) {
          const anchor = document.createElement("a");
          anchor.href = url;
          anchor.target = "_blank";
          anchor.rel = "noopener noreferrer";
          anchor.className = "pcl-inline-link";
          this.appendInlines(node, anchor);
          link.append(anchor);
        } else {
          this.appendInlines(node, link);
        }
        container.append(link);
      } else if (name === "TextBox") {
        container.append(this.buildTextBox(node, { kind: "inline" }));
      } else if (name === "MyTextButton") {
        container.append(this.buildMyTextButton(node, { kind: "inline" }));
      } else {
        appendTextNode(container, extractText(node));
      }
    }
  }

  applyTextStyles(node, props) {
    this.applyInlineStyles(node, props);
    const padding = parseThickness(getProp(props, "Padding"));
    if (padding) node.style.padding = padding.css;
    const align = getProp(props, "TextAlignment");
    if (align) node.style.textAlign = String(align).toLowerCase();
    const wrapping = (getProp(props, "TextWrapping") || "").toLowerCase();
    if (wrapping === "wrap" || wrapping === "wrapwithoverflow") node.classList.add("is-wrap");
    const trimming = (getProp(props, "TextTrimming") || "").toLowerCase();
    if (trimming === "none") node.classList.add("is-clip");
    const textProps = getProp(props, "TextOptions.TextFormattingMode");
    if (textProps) node.style.textRendering = "optimizeLegibility";
  }

  buildTextBlock(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-text";
    node.dataset.pclType = "TextBlock";
    this.count(node);
    this.applyTextStyles(node, props);
    const text = getProp(props, "Text");
    if (text != null) node.textContent = text;
    this.appendInlines(element, node);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildStackPanel(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    const horizontal = String(getProp(props, "Orientation") || "Vertical").toLowerCase() === "horizontal";
    node.className = `pcl-stack${horizontal ? " pcl-stack--h" : ""}`;
    node.dataset.pclType = "StackPanel";
    this.count(node);
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    const childLayout = { kind: horizontal ? "stack-h" : "stack-v" };
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, childLayout);
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }


  buildGridTrack(raw, min, max) {
    const text = String(raw ?? "1*").trim();
    const minValue = parseDouble(min);
    const minPart = minValue != null ? `${minValue}px` : "0px";
    if (/^\*$/.test(text)) return `minmax(${minPart}, 1fr)`;
    if (/^\d*\.?\d+\*$/.test(text)) {
      const star = Number.parseFloat(text) || 1;
      return `minmax(${minPart}, ${star}fr)`;
    }
    if (/^auto$/i.test(text)) return minValue != null ? `minmax(${minValue}px, auto)` : "auto";
    const fixed = parseDouble(text);
    if (fixed != null) {
      const maxValue = parseDouble(max);
      if (maxValue != null && maxValue >= fixed) return `minmax(${fixed}px, ${maxValue}px)`;
      return `${fixed}px`;
    }
    return "auto";
  }

  readDefinitions(element, propertyName, isColumn) {
    const property = findPropertyElement(element, propertyName);
    if (!property) return null;
    const result = [];
    for (const definition of property.children) {
      if (tagName(definition) !== (isColumn ? "ColumnDefinition" : "RowDefinition")) continue;
      const props = readProps(definition);
      const size = getProp(props, isColumn ? "Width" : "Height");
      const min = getProp(props, isColumn ? "MinWidth" : "MinHeight");
      const max = getProp(props, isColumn ? "MaxWidth" : "MaxHeight");
      result.push(this.buildGridTrack(size, min, max));
    }
    return result.length ? result : null;
  }

  buildGrid(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-grid";
    node.dataset.pclType = "Grid";
    this.count(node);
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    const columns = this.readDefinitions(element, "ColumnDefinitions", true) || ["minmax(0, 1fr)"];
    const rows = this.readDefinitions(element, "RowDefinitions", false) || ["auto"];
    node.style.gridTemplateColumns = columns.join(" ");
    node.style.gridTemplateRows = rows.join(" ");
    node.style.gridAutoRows = "auto";
    node.style.gridAutoColumns = "auto";
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);

    for (const child of directContentChildren(element)) {
      const childProps = readProps(child);
      const childNode = this.buildNode(child, { kind: "grid" });
      if (!childNode) continue;
      const column = Math.max(0, Math.trunc(parseDouble(getProp(childProps, "Grid.Column", "Column"), 0)));
      const row = Math.max(0, Math.trunc(parseDouble(getProp(childProps, "Grid.Row", "Row"), 0)));
      const columnSpan = Math.max(1, Math.trunc(parseDouble(getProp(childProps, "Grid.ColumnSpan", "ColumnSpan"), 1)));
      const rowSpan = Math.max(1, Math.trunc(parseDouble(getProp(childProps, "Grid.RowSpan", "RowSpan"), 1)));
      childNode.style.gridColumn = `${column + 1} / span ${columnSpan}`;
      childNode.style.gridRow = `${row + 1} / span ${rowSpan}`;
      node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildWrapPanel(element, layout) {
    const props = readProps(element);
    const horizontal = String(getProp(props, "Orientation") || "Horizontal").toLowerCase() === "horizontal";
    const node = document.createElement("div");
    node.className = `pcl-wrap${horizontal ? "" : " pcl-wrap--vertical"}`;
    node.dataset.pclType = "WrapPanel";
    this.count(node);
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: horizontal ? "wrap-h" : "wrap-v" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }


  buildCanvas(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-canvas";
    node.dataset.pclType = "Canvas";
    this.count(node);
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childProps = readProps(child);
      const childNode = this.buildNode(child, { kind: "canvas" });
      if (!childNode) continue;
      childNode.style.position = "absolute";
      const left = parseDouble(getProp(childProps, "Canvas.Left", "Left"), 0);
      const top = parseDouble(getProp(childProps, "Canvas.Top", "Top"), 0);
      childNode.style.left = `${left}px`;
      childNode.style.top = `${top}px`;
      node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildBorder(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-border";
    node.dataset.pclType = "Border";
    this.count(node);
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    const radius = parseCornerRadius(getProp(props, "CornerRadius"));
    if (radius) node.style.borderRadius = radius;
    const thickness = parseThickness(getProp(props, "BorderThickness"));
    if (thickness) {
      const visible = Math.max(thickness.l, thickness.t, thickness.r, thickness.b) > 0;
      if (visible) {
        node.style.borderStyle = "solid";
        node.style.borderWidth = `${thickness.t}px ${thickness.r}px ${thickness.b}px ${thickness.l}px`;
        node.style.borderColor = resolveColor(getProp(props, "BorderBrush")) || "transparent";
      }
    }
    const padding = parseThickness(getProp(props, "Padding"));
    if (padding) node.style.padding = padding.css;
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);

    const childProperty = findPropertyElement(element, "Child");
    const children = childProperty ? directContentChildren(childProperty) : directContentChildren(element);
    if (children.length === 1) {
      const childNode = this.buildNode(children[0], { kind: "border" });
      if (childNode) node.append(childNode);
    } else if (children.length > 1) {
      const stack = document.createElement("div");
      stack.className = "pcl-stack";
      for (const child of children) {
        const childNode = this.buildNode(child, { kind: "stack-v" });
        if (childNode) stack.append(childNode);
      }
      node.append(stack);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildScrollViewer(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-scrollviewer pcl-scroll";
    node.dataset.pclType = "ScrollViewer";
    this.count(node);
    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    const padding = parseThickness(getProp(props, "Padding"));
    if (padding) node.style.padding = padding.css;
    const vertical = (getProp(props, "VerticalScrollBarVisibility") || "Auto").toLowerCase();
    const horizontal = (getProp(props, "HorizontalScrollBarVisibility") || "Disabled").toLowerCase();
    node.style.overflowY = vertical === "disabled" || vertical === "hidden" ? "hidden" : "auto";
    node.style.overflowX = horizontal === "disabled" || horizontal === "hidden" ? "hidden" : "auto";
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "scroll" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildViewbox(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-viewbox";
    node.dataset.pclType = "Viewbox";
    this.count(node);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "border" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }


  buildMyCard(element, layout) {
    const props = readProps(element);
    const canSwap = parseBool(getProp(props, "CanSwap"), false);
    const isSwapped = canSwap && parseBool(getProp(props, "IsSwapped", "IsSwaped"), false);
    const swapRight = parseBool(getProp(props, "SwapLogoRight"), false);
    const useAnimation = parseBool(getProp(props, "UseAnimation"), true);
    const hasMouseAnimation = parseBool(getProp(props, "HasMouseAnimation"), true);
    const explicitHeight = parseSize(getProp(props, "Height"));

    const card = document.createElement("div");
    card.className = "pcl-card";
    card.dataset.pclType = "MyCard";
    if (hasMouseAnimation) card.classList.add("has-mouse-animation");
    if (swapRight) card.classList.add("swap-right");
    this.count(card);
    this.applyBox(card, props);
    this.applyAlignment(card, props, layout);

    let title = getProp(props, "Title");
    if (title == null) {
      const titleProperty = findPropertyElement(element, "Title");
      if (titleProperty) title = titleProperty.textContent.trim();
    }
    const titleNode = document.createElement("div");
    titleNode.className = "pcl-card__title";
    titleNode.textContent = title ?? "";
    card.append(titleNode);

    if (canSwap) {
      const chevron = document.createElement("div");
      chevron.className = "pcl-card__chevron";
      const { svg } = buildPathSvg("M2,4 l-2,2 10,10 10,-10 -2,-2 -8,8 -8,-8 z", { stretch: "Uniform", fill: "currentColor" });
      svg.setAttribute("viewBox", "0 4 20 12");
      svg.setAttribute("preserveAspectRatio", "none");
      chevron.append(svg);
      card.append(chevron);

      const header = document.createElement("div");
      header.className = "pcl-card__header";
      card.append(header);
    }

    const body = document.createElement("div");
    body.className = "pcl-card__body";
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "stack-v" });
      if (childNode) body.append(childNode);
    }
    card.append(body);

    const events = readEvents(element);
    if (events.length) card.__pclEvents = events;

    const setSwapped = target => {
      if (!canSwap) return;
      const currently = card.classList.contains("is-swapped");
      if (target === currently) return;
      card.setAttribute("aria-expanded", String(!target));

      if (!useAnimation) {
        card.classList.toggle("is-swapped", target);
        card.style.height = target ? "40px" : explicitHeight != null ? `${explicitHeight}px` : "";
        return;
      }

      card.style.overflow = "hidden";
      const startHeight = card.offsetHeight;
      card.style.height = `${startHeight}px`;

      const onHeightTransition = (finish) => event => {
        if (event.target !== card || event.propertyName !== "height") return;
        finish();
      };

      if (target) {
        card.classList.remove("is-swapped");
        void card.offsetHeight;
        card.style.height = "40px";
        const finish = () => {
          card.style.transition = "none";
          card.classList.add("is-swapped");
          card.style.height = "";
          card.style.overflow = "";
          void card.offsetHeight;
          card.style.transition = "";
          card.removeEventListener("transitionend", listener);
        };
        const listener = onHeightTransition(finish);
        card.addEventListener("transitionend", listener);
        window.setTimeout(() => {
          if (!card.classList.contains("is-swapped")) finish();
        }, 340);
      } else {
        card.classList.remove("is-swapped");
        void card.offsetHeight;
        const targetHeight = explicitHeight != null ? explicitHeight : Math.max(40, body.scrollHeight);
        card.style.height = `${targetHeight}px`;
        const finish = () => {
          card.style.transition = "none";
          card.style.height = explicitHeight != null ? `${explicitHeight}px` : "";
          card.style.overflow = "";
          void card.offsetHeight;
          card.style.transition = "";
          card.removeEventListener("transitionend", listener);
        };
        const listener = onHeightTransition(finish);
        card.addEventListener("transitionend", listener);
        window.setTimeout(() => {
          if (card.style.height !== `${targetHeight}px`) return;
          finish();
        }, 340);
      }
    };

    card.__pclToggle = setSwapped;

    if (isSwapped) {
      card.classList.add("is-swapped");
    }

    card.addEventListener("click", event => {
      if (event.target.closest("button, a, .pcl-button, .pcl-textbutton, .pcl-iconbutton, .pcl-icontextbutton, .pcl-listitem, .pcl-hint__close")) return;
      const collapsed = card.classList.contains("is-swapped");
      const rect = card.getBoundingClientRect();
      const scale = card.offsetHeight ? rect.height / card.offsetHeight : 1;
      const y = scale ? (event.clientY - rect.top) / scale : 0;
      if (canSwap && (collapsed || y <= 34)) setSwapped(!collapsed);
      if (events.length) this.runtime.raise(events, card);
    });

    if (canSwap) {
      card.tabIndex = 0;
      card.setAttribute("role", "button");
      card.setAttribute("aria-expanded", String(!isSwapped));
      card.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        const collapsed = card.classList.contains("is-swapped");
        setSwapped(!collapsed);
        if (events.length) this.runtime.raise(events, card);
      });
    }

    return card;
  }


  buildMyHint(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-hint";
    node.dataset.pclType = "MyHint";
    this.count(node);

    let theme = (getProp(props, "Theme") || "Red").toLowerCase();
    if (hasProp(props, "IsWarn")) theme = parseBool(getProp(props, "IsWarn"), true) ? "red" : "blue";
    const themeMap = {
      blue: ["#d9ecff", "#1172D4", "#0F64B8"],
      red: ["#ffdddf", "#d82929", "#bf0b0b"],
      yellow: ["#ffebd7", "#f57a00", "#d86c00"]
    };
    const colors = themeMap[theme] || themeMap.red;
    node.style.setProperty("--hint-bg", colors[0]);
    node.style.setProperty("--hint-border", colors[1]);
    node.style.setProperty("--hint-fg", colors[2]);
    if (parseBool(getProp(props, "HasBorder"), false)) {
      node.style.border = `1px solid ${colors[1]}`;
      node.style.borderLeftWidth = "3px";
    }

    const textNode = document.createElement("div");
    textNode.className = "pcl-hint__text";
    const text = getProp(props, "Text");
    if (text != null) textNode.textContent = text;
    this.appendInlines(element, textNode);
    node.append(textNode);

    const relativeSetup = getProp(props, "RelativeSetup");
    const storageKey = relativeSetup ? `pcl.hint.${relativeSetup}` : null;
    let dismissed = false;
    if (storageKey) {
      try {
        dismissed = localStorage.getItem(storageKey) === "true";
      } catch {
        dismissed = false;
      }
    }

    if (parseBool(getProp(props, "CanClose"), false)) {
      const close = document.createElement("button");
      close.type = "button";
      close.className = "pcl-hint__close";
      close.title = "不再提示";
      close.setAttribute("aria-label", "不再提示");
      const { svg } = buildPathSvg("F1 M2,0 L0,2 8,10 0,18 2,20 10,12 18,20 20,18 12,10 20,2 18,0 10,8 2,0Z", { stretch: "Uniform", fill: "currentColor" });
      close.append(svg);
      close.addEventListener("click", event => {
        event.stopPropagation();
        if (storageKey) {
          try {
            localStorage.setItem(storageKey, "true");
          } catch {
            /* ignore */
          }
        }
        node.classList.add("is-dismissing");
        window.setTimeout(() => {
          node.style.display = "none";
        }, 210);
      });
      node.append(close);
    }

    const events = readEvents(element);
    if (events.length) {
      node.__pclEvents = events;
      node.addEventListener("click", event => {
        if (event.target.closest(".pcl-hint__close")) return;
        this.runtime.raise(events, node);
      });
    }

    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    if (dismissed) node.style.display = "none";
    return node;
  }

  buildMyButton(element, layout) {
    const props = readProps(element);
    const node = document.createElement("button");
    node.type = "button";
    const colorType = (getProp(props, "ColorType") || "Normal").toLowerCase();
    node.className = `pcl-button pcl-button--${colorType === "highlight" ? "highlight" : colorType === "red" ? "red" : "normal"}`;
    node.dataset.pclType = "MyButton";
    this.count(node);

    const face = document.createElement("span");
    face.className = "pcl-button__face";
    const padding = parseThickness(getProp(props, "Padding"));
    if (padding) face.style.padding = padding.css;

    const text = document.createElement("span");
    text.className = "pcl-button__text";
    const textPadding = parseThickness(getProp(props, "TextPadding"));
    if (textPadding) text.style.padding = textPadding.css;
    const label = getProp(props, "Text");
    if (label != null) text.textContent = label;
    this.appendInlines(element, text);
    face.append(text);
    node.append(face);

    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    const enabled = this.applyEnabled(node, props);
    if (enabled) {
      node.addEventListener("pointerdown", () => face.classList.add("is-pressed"));
      const release = () => face.classList.remove("is-pressed");
      node.addEventListener("pointerup", release);
      node.addEventListener("pointerleave", release);
      node.addEventListener("pointercancel", release);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildMyTextButton(element, layout) {
    const props = readProps(element);
    const node = document.createElement("button");
    node.type = "button";
    node.className = "pcl-textbutton";
    node.dataset.pclType = "MyTextButton";
    this.count(node);
    const text = getProp(props, "Text");
    if (text != null) node.textContent = text;
    this.appendInlines(element, node);
    const padding = parseThickness(getProp(props, "Padding"));
    if (padding) node.style.padding = padding.css;
    this.applyTextStyles(node, props);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.applyEnabled(node, props);
    this.bindEvents(node, element);
    return node;
  }


  buildMyIconButton(element, layout) {
    const props = readProps(element);
    const node = document.createElement("button");
    node.type = "button";
    const theme = (getProp(props, "Theme") || "Color").toLowerCase();
    const themeClass = ["white", "red", "black", "custom"].includes(theme) ? theme : "color";
    node.className = `pcl-iconbutton pcl-iconbutton--${themeClass}`;
    node.dataset.pclType = "MyIconButton";
    this.count(node);

    if (themeClass === "custom") {
      const foreground = resolveColor(getProp(props, "Foreground")) || "#808080";
      node.style.setProperty("--ib-fill", `color-mix(in srgb, ${foreground} 62.7%, transparent)`);
      node.style.setProperty("--ib-hover", foreground);
    }

    const width = parseSize(getProp(props, "Width"));
    const height = parseSize(getProp(props, "Height"));
    if (width == null && height == null) {
      node.style.width = "24px";
      node.style.height = "24px";
    } else if (width == null) {
      node.style.width = `${height}px`;
    } else if (height == null) {
      node.style.height = `${width}px`;
    }

    const logoScale = parseDouble(getProp(props, "LogoScale"), 1);
    node.style.setProperty("--logo-scale", String(logoScale));

    const face = document.createElement("span");
    face.className = "pcl-iconbutton__face";
    const logo = getProp(props, "Logo");
    if (logo) {
      const { svg } = buildPathSvg(logo, { stretch: "Uniform", fill: "currentColor" });
      svg.classList.add("pcl-iconbutton__svg");
      face.append(svg);
    }
    node.append(face);

    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    const enabled = this.applyEnabled(node, props);
    const canClick = enabled && parseBool(getProp(props, "CanClick"), true);
    if (canClick) {
      node.addEventListener("pointerdown", () => face.classList.add("is-pressed"));
      const release = () => {
        if (!face.classList.contains("is-pressed")) return;
        face.classList.remove("is-pressed");
        face.classList.add("is-releasing");
        window.setTimeout(() => face.classList.remove("is-releasing"), 280);
      };
      node.addEventListener("pointerup", release);
      node.addEventListener("pointerleave", () => face.classList.remove("is-pressed"));
      node.addEventListener("pointercancel", () => face.classList.remove("is-pressed"));
      this.bindEvents(node, element);
    }
    return node;
  }

  buildMyIconTextButton(element, layout) {
    const props = readProps(element);
    const node = document.createElement("button");
    node.type = "button";
    const colorType = (getProp(props, "ColorType") || "Black").toLowerCase();
    node.className = `pcl-icontextbutton pcl-icontextbutton--${colorType === "highlight" ? "highlight" : "black"}`;
    node.dataset.pclType = "MyIconTextButton";
    this.count(node);
    const logoScale = parseDouble(getProp(props, "LogoScale"), 1);
    node.style.setProperty("--logo-scale", String(logoScale));

    const logo = getProp(props, "Logo");
    if (logo) {
      const { svg } = buildPathSvg(logo, { stretch: "Uniform", fill: "currentColor" });
      svg.classList.add("pcl-icontextbutton__logo");
      node.append(svg);
    }

    const text = document.createElement("span");
    text.className = "pcl-icontextbutton__text";
    if (!logo) text.style.marginLeft = "12px";
    const label = getProp(props, "Text");
    if (label != null) text.textContent = label;
    this.appendInlines(element, text);
    node.append(text);

    this.applyBox(node, props);
    this.applyAlignment(node, props, layout, { horizontal: "Center" });
    this.applyEnabled(node, props);
    this.bindEvents(node, element);
    return node;
  }


  buildMyListItem(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-listitem";
    node.dataset.pclType = "MyListItem";
    this.count(node);

    const type = String(getProp(props, "Type") || "None").toLowerCase();
    const clickable = type !== "none";
    if (clickable) node.classList.add("is-clickable");

    const height = parseDouble(getProp(props, "Height"), 42);
    node.style.height = `${height}px`;
    const checkWidth = height < 40 ? 4 : 2;
    const logoSource = getProp(props, "Logo");
    const logoWidth = logoSource ? (height < 40 ? 34 : 38) : 0;
    const paddingLeft = parseDouble(getProp(props, "PaddingLeft"), 0);
    const paddingRight = Math.max(4, parseDouble(getProp(props, "MinPaddingRight"), 4));
    node.style.gridTemplateColumns = `${checkWidth}px ${paddingLeft}px ${logoWidth}px minmax(0, 1fr) ${paddingRight}px`;

    const back = document.createElement("div");
    back.className = "pcl-listitem__back";
    node.append(back);

    if (logoSource) {
      const logo = document.createElement("div");
      logo.className = "pcl-listitem__logo";
      const logoScale = parseDouble(getProp(props, "LogoScale"), 1);
      logo.style.transform = `scale(${logoScale})`;
      const isImage = /^(https?:|data:)|\.(png|jpe?g|webp)(\?|$)/i.test(String(logoSource));
      if (isImage) {
        const img = document.createElement("img");
        img.alt = "";
        img.draggable = false;
        img.referrerPolicy = "no-referrer";
        img.src = resolveImageSource(logoSource) || NO_ICON;
        img.addEventListener("error", () => {
          img.src = NO_ICON;
        }, { once: true });
        logo.append(img);
      } else {
        const { svg } = buildPathSvg(logoSource, { stretch: "Uniform", fill: "currentColor" });
        logo.append(svg);
      }
      node.append(logo);
    }

    const body = document.createElement("div");
    body.className = "pcl-listitem__body";
    const title = document.createElement("div");
    title.className = "pcl-listitem__title";
    const fontSize = parseDouble(getProp(props, "FontSize"), 14);
    title.style.fontSize = `${fontSize}px`;
    const titleText = getProp(props, "Title");
    if (titleText != null) title.textContent = titleText;
    else this.appendInlines(element, title);
    body.append(title);

    const info = getProp(props, "Info");
    if (info) {
      node.classList.add("has-info");
      const infoNode = document.createElement("div");
      infoNode.className = "pcl-listitem__info";
      infoNode.textContent = info;
      body.append(infoNode);
    }
    node.append(body);

    const foreground = resolveColor(getProp(props, "Foreground"));
    if (foreground) node.style.color = foreground;

    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.applyEnabled(node, props);

    const events = readEvents(element);
    if (events.length) node.__pclEvents = events;
    if (clickable) {
      node.tabIndex = 0;
      node.setAttribute("role", "button");
      const activate = event => {
        event.stopPropagation();
        if (events.length) this.runtime.raise(events, node);
      };
      node.addEventListener("click", activate);
      node.addEventListener("keydown", event => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        activate(event);
      });
    }
    return node;
  }


  buildImage(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-image-wrap";
    node.dataset.pclType = tagName(element);
    this.count(node);

    const width = parseSize(getProp(props, "Width"));
    const height = parseSize(getProp(props, "Height"));
    const source = getProp(props, "Source");
    const fallbackSource = getProp(props, "FallbackSource");
    const loadingSource = resolveImageSource(getProp(props, "LoadingSource")) || NO_ICON;
    const resolved = resolveImageSource(source);
    const fallback = resolveImageSource(fallbackSource);
    const stretch = String(getProp(props, "Stretch") || "Uniform").toLowerCase();
    const objectFit = stretch === "fill" ? "fill" : stretch === "uniformtofill" ? "cover" : stretch === "none" ? "none" : "contain";

    if (source != null && resolved) {
      const img = document.createElement("img");
      img.alt = "";
      img.draggable = false;
      img.referrerPolicy = "no-referrer";
      img.style.objectFit = objectFit;
      if (width != null && height != null) {
        node.classList.add("pcl-image-wrap--fill");
        img.style.width = "100%";
        img.style.height = "100%";
      } else if (height != null) {
        img.style.height = `${height}px`;
      } else if (width != null) {
        img.style.width = `${width}px`;
      }

      const useFallback = () => {
        if (fallback) {
          img.src = fallback;
          img.addEventListener("error", () => {
            img.src = NO_ICON;
          }, { once: true });
        } else {
          img.src = NO_ICON;
        }
      };

      if (/^https?:/i.test(resolved)) {
        img.src = loadingSource;
        node.classList.add("is-loading");
        const preload = new Image();
        preload.referrerPolicy = "no-referrer";
        preload.onload = () => {
          img.src = resolved;
          node.classList.remove("is-loading");
        };
        preload.onerror = () => {
          node.classList.remove("is-loading");
          useFallback();
          this.warn(`图片加载失败：${source}`);
        };
        preload.src = resolved;
      } else {
        img.src = resolved;
        img.addEventListener("error", () => {
          useFallback();
          this.warn(`图片加载失败：${source}`);
        }, { once: true });
      }
      node.append(img);
    }

    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildPath(element, layout) {
    const props = readProps(element);
    const dataElement = findPropertyElement(element, "Data");
    const data = getProp(props, "Data") ?? dataElement?.textContent?.trim();
    const node = document.createElement("div");
    node.className = "pcl-path";
    node.dataset.pclType = "Path";
    this.count(node);
    if (!data) {
      this.applyBox(node, props);
      this.applyAlignment(node, props, layout);
      this.bindEvents(node, element);
      return node;
    }

    const stretch = getProp(props, "Stretch") || "None";
    const fill = resolveColor(getProp(props, "Fill"));
    const stroke = resolveColor(getProp(props, "Stroke"));
    const strokeThickness = parseDouble(getProp(props, "StrokeThickness"), 1);
    const { svg, box } = buildPathSvg(data, {
      stretch,
      fill: fill || "none",
      stroke,
      strokeThickness
    });

    const width = parseSize(getProp(props, "Width"));
    const height = parseSize(getProp(props, "Height"));
    if (width != null && height == null) node.style.height = `${width * box.height / box.width}px`;
    else if (height != null && width == null) node.style.width = `${height * box.width / box.height}px`;
    else if (width == null && height == null) {
      node.style.width = `${box.width}px`;
      node.style.height = `${box.height}px`;
    }
    node.append(svg);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }


  buildShape(element, layout, kind) {
    const props = readProps(element);
    const node = document.createElement("div");
    const fill = resolveColor(getProp(props, "Fill")) || "transparent";
    const stroke = resolveColor(getProp(props, "Stroke"));
    const strokeThickness = parseDouble(getProp(props, "StrokeThickness"), 0);

    if (kind === "Line") {
      const x1 = parseDouble(getProp(props, "X1"), 0);
      const y1 = parseDouble(getProp(props, "Y1"), 0);
      const x2 = parseDouble(getProp(props, "X2"), 0);
      const y2 = parseDouble(getProp(props, "Y2"), 0);
      const w = Math.max(1, Math.abs(x2 - x1));
      const h = Math.max(1, Math.abs(y2 - y1));
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", `0 0 ${w} ${h}`);
      svg.setAttribute("preserveAspectRatio", "none");
      const line = document.createElementNS(SVG_NS, "line");
      line.setAttribute("x1", String(x1));
      line.setAttribute("y1", String(y1));
      line.setAttribute("x2", String(x2));
      line.setAttribute("y2", String(y2));
      line.setAttribute("stroke", stroke || "currentColor");
      line.setAttribute("stroke-width", String(Math.max(1, strokeThickness || 1)));
      svg.append(line);
      node.className = "pcl-path";
      if (parseSize(getProp(props, "Width")) == null) node.style.width = `${w}px`;
      if (parseSize(getProp(props, "Height")) == null) node.style.height = `${h}px`;
      node.append(svg);
      this.count(node);
      this.applyBox(node, props);
      this.applyAlignment(node, props, layout);
      this.bindEvents(node, element);
      return node;
    }

    if (kind === "Polygon" || kind === "Polyline") {
      const points = getProp(props, "Points") || "";
      const values = points.split(/[,\s]+/).map(Number).filter(Number.isFinite);
      const xs = values.filter((_, index) => index % 2 === 0);
      const ys = values.filter((_, index) => index % 2 === 1);
      const minX = xs.length ? Math.min(...xs) : 0;
      const minY = ys.length ? Math.min(...ys) : 0;
      const maxX = xs.length ? Math.max(...xs) : 24;
      const maxY = ys.length ? Math.max(...ys) : 24;
      const svg = document.createElementNS(SVG_NS, "svg");
      svg.setAttribute("viewBox", `${minX} ${minY} ${Math.max(1, maxX - minX)} ${Math.max(1, maxY - minY)}`);
      svg.setAttribute("preserveAspectRatio", "xMidYMid meet");
      const shape = document.createElementNS(SVG_NS, kind === "Polygon" ? "polygon" : "polyline");
      shape.setAttribute("points", points);
      shape.setAttribute("fill", kind === "Polygon" ? fill : "none");
      shape.setAttribute("stroke", stroke || "currentColor");
      shape.setAttribute("stroke-width", String(Math.max(1, strokeThickness || 1)));
      svg.append(shape);
      node.className = "pcl-path";
      node.append(svg);
      this.count(node);
      this.applyBox(node, props);
      this.applyAlignment(node, props, layout);
      this.bindEvents(node, element);
      return node;
    }

    node.className = `pcl-shape pcl-shape--${kind === "Ellipse" ? "ellipse" : "rect"}`;
    node.style.background = fill;
    if (stroke && strokeThickness > 0) node.style.border = `${strokeThickness}px solid ${stroke}`;
    if (kind === "Rectangle") {
      const radius = parseCornerRadius(getProp(props, "RadiusX", "RadiusY"));
      if (radius) node.style.borderRadius = radius;
    }
    this.count(node);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildMyLoading(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-loading";
    node.dataset.pclType = "MyLoading";
    this.count(node);
    const ring = document.createElement("span");
    ring.className = "pcl-loading__ring";
    const text = document.createElement("span");
    text.className = "pcl-loading__text";
    text.textContent = getProp(props, "Text") || "正在加载…";
    node.append(ring, text);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildFlowDocumentScrollViewer(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-flowdoc-scroll";
    node.dataset.pclType = "FlowDocumentScrollViewer";
    this.count(node);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "flow" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildFlowDocument(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-flowdoc";
    node.dataset.pclType = "FlowDocument";
    this.count(node);
    this.applyTextStyles(node, props);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "flow" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildFlowSection(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-flowdoc__section";
    node.dataset.pclType = "Section";
    this.count(node);
    this.applyTextStyles(node, props);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "flow" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildFlowParagraph(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-flowdoc__paragraph";
    node.dataset.pclType = "Paragraph";
    this.count(node);
    this.applyTextStyles(node, props);
    const indent = parseDouble(getProp(props, "TextIndent"));
    if (indent != null) node.style.textIndent = `${indent}px`;
    const text = getProp(props, "Text");
    if (text != null) node.textContent = text;
    this.appendInlines(element, node);
    if (node.querySelector(".pcl-inline-code")) {
      node.classList.add("has-inline-code");
      const configured = Number.parseFloat(node.style.lineHeight);
      if (!Number.isFinite(configured) || configured < 20) node.style.lineHeight = "20px";
    }
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildFlowList(element, layout) {
    const props = readProps(element);
    const node = document.createElement("ul");
    node.className = "pcl-flowdoc__list";
    node.dataset.pclType = "List";
    this.count(node);
    this.applyTextStyles(node, props);
    const padding = parseThickness(getProp(props, "Padding"));
    const left = Math.max(22, padding?.l ?? 0);
    node.style.padding = `${padding?.t ?? 0}px ${padding?.r ?? 0}px ${padding?.b ?? 0}px ${left}px`;
    const marker = parseDouble(getProp(props, "MarkerStyle"), 1);
    if (marker === 0) node.style.listStyleType = "none";
    else if (marker === 2) node.style.listStyleType = "circle";
    else if (marker === 3) node.style.listStyleType = "square";
    else if (marker === 9) node.style.listStyleType = "decimal";
    else node.style.listStyleType = "disc";
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "flow-list" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildFlowListItem(element, layout) {
    const props = readProps(element);
    const node = document.createElement("li");
    node.className = "pcl-flowdoc__listitem";
    node.dataset.pclType = "ListItem";
    this.count(node);
    this.applyTextStyles(node, props);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    for (const child of directContentChildren(element)) {
      const childNode = this.buildNode(child, { kind: "flow-listitem" });
      if (childNode) node.append(childNode);
    }
    this.bindEvents(node, element);
    return node;
  }

  buildContentControl(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.dataset.pclType = "ContentControl";
    this.count(node);
    const content = getProp(props, "Content");
    const templateRef = getProp(props, "Template");
    const template = this.resolveResourceElement(templateRef);
    const isSeparator =
      Boolean(templateRef) &&
      (/separator/i.test(String(templateRef)) ||
        (template && tagName(template) === "ControlTemplate" && Boolean(template.querySelector("Line"))));
    if (isSeparator) {
      node.className = "pcl-flow-separator";
      const lineLeft = document.createElement("span");
      lineLeft.className = "pcl-flow-separator__line";
      const text = document.createElement("span");
      text.className = "pcl-flow-separator__text";
      text.textContent = content != null ? content : extractText(element);
      const lineRight = document.createElement("span");
      lineRight.className = "pcl-flow-separator__line";
      node.append(lineLeft, text, lineRight);
    } else {
      node.className = "pcl-contentcontrol";
      if (content != null) node.textContent = content;
      else {
        for (const child of directContentChildren(element)) {
          const childNode = this.buildNode(child, { kind: "content" });
          if (childNode) node.append(childNode);
        }
      }
    }
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildTextBox(element, layout) {
    const props = readProps(element);
    const styleRef = String(getProp(props, "Style") || "");
    const isInlineCode =
      /InlineCode/i.test(styleRef) ||
      /consolas/i.test(String(getProp(props, "FontFamily") || "")) ||
      parseDouble(getProp(props, "Height")) === 18;
    const node = document.createElement("span");
    node.className = isInlineCode ? "pcl-inline-code" : "pcl-textbox";
    node.dataset.pclType = "TextBox";
    this.count(node);
    const text = getProp(props, "Text");
    node.textContent = text != null ? text : extractText(element);
    this.applyInlineStyles(node, props);
    this.applyBox(node, props);
    if (isInlineCode) {
      node.style.marginBottom = "0";
      node.style.verticalAlign = "-2px";
    }
    this.applyAlignment(node, props, layout);
    this.bindEvents(node, element);
    return node;
  }

  buildCheck(element, layout, kind) {
    const props = readProps(element);
    const node = document.createElement("div");
    const isRadio = kind !== "MyCheckBox";
    node.className = `pcl-check${isRadio ? " pcl-check--radio" : ""}`;
    node.dataset.pclType = kind;
    this.count(node);
    const checked = parseBool(getProp(props, isRadio ? "Checked" : "IsChecked"), false);
    if (checked) node.classList.add("is-checked");
    const box = document.createElement("span");
    box.className = "pcl-check__box";
    const text = document.createElement("span");
    const label = getProp(props, "Text", "Content");
    if (label != null) text.textContent = label;
    this.appendInlines(element, text);
    node.append(box, text);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    const events = readEvents(element);
    node.addEventListener("click", event => {
      event.stopPropagation();
      const next = !node.classList.contains("is-checked");
      node.classList.toggle("is-checked", next);
      node.setAttribute("aria-checked", String(next));
      if (events.length) this.runtime.raise(events, node);
    });
    node.setAttribute("role", isRadio ? "radio" : "checkbox");
    node.setAttribute("aria-checked", String(checked));
    node.tabIndex = 0;
    return node;
  }

  buildUnsupported(element, layout, name) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-unsupported";
    node.textContent = `不支持的控件类型：${name}`;
    this.warn(`不支持的控件类型：${name}`);
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);
    return node;
  }
}

