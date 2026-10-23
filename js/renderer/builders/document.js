import { PclControlBuilders } from "./controls.js";
import { tagName, readEvents, parseDouble, parseBool, parseThickness, extractText } from "../../xaml.js";
import { getProp, readProps, directContentChildren } from "../helpers.js";

export class PclDocumentBuilders extends PclControlBuilders {
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
      if (!Number.isFinite(configured)) {
        node.style.lineHeight = "max(20px, 1.4em)";
      } else if (configured < 20) {
        node.style.lineHeight = `max(${configured}px, 20px, 1.4em)`;
      }
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
    // PCL declares "Checked" on MyCheckBox too (its WPF counterpart's
    // IsChecked is not a member of the PCL control, so real homepages write
    // Checked="True"); keep IsChecked as a fallback for WPF-style pages.
    const checked = parseBool(getProp(props, "Checked", "IsChecked"), false);
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
    node.addEventListener("click", (event) => {
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
