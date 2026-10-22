import {
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
} from "../../xaml.js";
import {
  SVG_NS,
  NO_ICON,
  RESOURCE_REF_RE,
  getProp,
  hasProp,
  readProps,
  alignmentMap,
  parseSize,
  appendTextNode,
  findPropertyElement,
  directContentChildren,
  normalizeFillRule,
  fallbackBBox,
  measurePath,
  buildPathSvg
} from "../helpers.js";

export class PclLayoutBuilders {
  buildNode(element, layout) {
    const name = tagName(element);
    switch (name) {
      case "StackPanel": return this.buildStackPanel(element, layout);
      case "WrapPanel": return this.buildWrapPanel(element, layout);
      case "Grid": return this.buildGrid(element, layout);
      case "UniformGrid": return this.buildUniformGrid(element, layout);
      case "Canvas": return this.buildCanvas(element, layout);
      case "Border": return this.buildBorder(element, layout);
      case "GroupBox": return this.buildGroupBox(element, layout);
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
      case "uniformgrid":
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
    if (lineHeight != null) {
      // WPF 的 LineStackingStrategy 默认是 MaxHeight：行框高度取 LineHeight
      // 与字体实际行高的较大值。直接使用 LineHeight 会让 LineHeight=12、
      // FontSize=14 的段落发生行间重叠；BlockLineHeight 才严格使用该值。
      const stacking = String(getProp(props, "LineStackingStrategy") || "MaxHeight").toLowerCase();
      node.style.lineHeight = stacking === "blocklineheight"
        ? `${lineHeight}px`
        : `max(${lineHeight}px, 1.4em)`;
    }
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

  buildUniformGrid(element, layout) {
    const props = readProps(element);
    const children = directContentChildren(element);
    const node = document.createElement("div");
    node.className = "pcl-uniformgrid";
    node.dataset.pclType = "UniformGrid";
    this.count(node);

    const count = children.length;
    const firstColumn = Math.max(0, Math.trunc(parseDouble(getProp(props, "FirstColumn"), 0)));
    let columns = Math.max(0, Math.trunc(parseDouble(getProp(props, "Columns"), 0)));
    let rows = Math.max(0, Math.trunc(parseDouble(getProp(props, "Rows"), 0)));

    if (count > 0) {
      if (columns === 0 && rows === 0) {
        columns = Math.ceil(Math.sqrt(count));
        rows = Math.ceil((count + firstColumn) / columns);
      } else if (columns === 0) {
        columns = Math.max(1, Math.ceil((count + firstColumn) / rows));
      } else if (rows === 0) {
        rows = Math.max(1, Math.ceil((count + firstColumn) / columns));
      }
    } else {
      columns = Math.max(1, columns);
      rows = Math.max(1, rows);
    }

    node.style.gridTemplateColumns = `repeat(${Math.max(1, columns)}, minmax(0, 1fr))`;
    node.style.gridTemplateRows = `repeat(${Math.max(1, rows)}, minmax(0, 1fr))`;
    node.style.gridAutoFlow = "row";

    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);

    children.forEach((child, index) => {
      const childNode = this.buildNode(child, { kind: "uniformgrid" });
      if (!childNode) return;
      if (index === 0 && firstColumn > 0) childNode.style.gridColumnStart = String(firstColumn + 1);
      node.append(childNode);
    });
    this.bindEvents(node, element);
    return node;
  }

  buildGroupBox(element, layout) {
    const props = readProps(element);
    const node = document.createElement("div");
    node.className = "pcl-groupbox";
    node.dataset.pclType = "GroupBox";
    this.count(node);

    const background = resolveColor(getProp(props, "Background"));
    if (background) node.style.background = background;
    const borderBrush = resolveColor(getProp(props, "BorderBrush"));
    if (borderBrush) node.style.setProperty("--groupbox-border", borderBrush);
    const borderThickness = parseThickness(getProp(props, "BorderThickness"));
    if (borderThickness) {
      const visible = Math.max(borderThickness.l, borderThickness.t, borderThickness.r, borderThickness.b) > 0;
      if (visible) {
        node.style.borderStyle = "solid";
        node.style.borderWidth = `${borderThickness.t}px ${borderThickness.r}px ${borderThickness.b}px ${borderThickness.l}px`;
      } else {
        node.style.border = "0";
      }
    }
    const padding = parseThickness(getProp(props, "Padding"));
    if (padding) node.style.padding = padding.css;
    this.applyBox(node, props);
    this.applyAlignment(node, props, layout);

    let header = getProp(props, "Header");
    if (header == null) {
      const headerProperty = findPropertyElement(element, "Header");
      if (headerProperty) header = headerProperty.textContent.trim();
    }
    if (header != null) {
      const headerNode = document.createElement("div");
      headerNode.className = "pcl-groupbox__header";
      const templated = this.buildTemplateText(
        this.resolveTemplate(element, props, "HeaderTemplate"),
        header,
        "pcl-groupbox__header-text",
        "groupbox"
      );
      if (templated) headerNode.append(templated);
      else headerNode.textContent = header;
      node.append(headerNode);
    }

    const contentProperty = findPropertyElement(element, "Content");
    const contentSource = contentProperty || element;
    const contentChildren = directContentChildren(contentSource);
    let contentText = getProp(props, "Content");
    if (contentText == null && contentProperty && contentChildren.length === 0) {
      contentText = contentProperty.textContent.trim();
    }

    if (contentText != null || contentChildren.length) {
      const content = document.createElement("div");
      content.className = "pcl-groupbox__content";
      const isText = contentText != null && contentChildren.length === 0;
      if (isText) content.classList.add("is-text");

      if (isText) {
        const templated = this.buildTemplateText(
          this.resolveTemplate(element, props, "ContentTemplate"),
          contentText,
          "pcl-groupbox__content-text",
          "groupbox-content"
        );
        if (templated) {
          content.append(templated);
        } else {
          const text = document.createElement("div");
          text.className = "pcl-groupbox__content-text";
          text.textContent = contentText;
          content.append(text);
        }
      } else {
        for (const child of contentChildren) {
          const childNode = this.buildNode(child, { kind: "groupbox-content" });
          if (childNode) content.append(childNode);
        }
      }

      const horizontal = String(getProp(props, "HorizontalContentAlignment") || (isText ? "Center" : "Stretch")).toLowerCase();
      const vertical = String(getProp(props, "VerticalContentAlignment") || (isText ? "Center" : "Stretch")).toLowerCase();
      content.style.justifyContent = alignmentMap[horizontal] || (isText ? "center" : "stretch");
      content.style.alignItems = alignmentMap[vertical] || (isText ? "center" : "stretch");
      node.append(content);
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


}
