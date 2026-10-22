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
} from "./xaml.js";
import { PclDocumentBuilders } from "./renderer/builders/document.js";
import {
  RESOURCE_REF_RE,
  getProp,
  hasProp,
  readProps,
  alignmentMap,
  parseSize,
  appendTextNode,
  findPropertyElement,
  directContentChildren,
  measurePath,
  buildPathSvg
} from "./renderer/helpers.js";

export class PclRenderer extends PclDocumentBuilders {
  constructor({ root, runtime, getProxyUa, getProxyUas, lazyImages = true } = {}) {
    super();
    this.root = root;
    this.runtime = runtime;
    this.getProxyUa = getProxyUa;
    this.getProxyUas = getProxyUas;
    this.lazyImages = lazyImages;
    this.warnings = [];
    this.controlCount = 0;
    this.resources = new Map();
    this.implicitStyles = new Map();
    this.resourceNodes = new WeakSet();
  }

  proxyImageSource(source, ua) {
    if (!/^https?:/i.test(source)) return source;
    if (location.protocol !== "http:" && location.protocol !== "https:") return source;
    const proxy = new URL("api/proxy", document.baseURI);
    proxy.searchParams.set("url", source);
    proxy.searchParams.set("image", "1");
    if (ua) proxy.searchParams.set("ua", ua);
    return proxy.toString();
  }

  loadImageSource(source, onLoad, onError, target = null) {
    const candidates = [source];
    const uas = this.getProxyUas?.() ?? [this.getProxyUa?.()];
    for (const ua of uas) {
      const proxied = this.proxyImageSource(source, ua);
      if (proxied !== source && !candidates.includes(proxied)) candidates.push(proxied);
    }

    let index = 0;
    const attempt = () => {
      if (index >= candidates.length) {
        onError?.();
        return;
      }
      const candidate = candidates[index++];
      // Keep the legacy preload path for eager/test renderers; the visible
      // element is used directly only when native lazy loading is enabled.
      const image = target && this.lazyImages ? target : new Image();
      image.referrerPolicy = "no-referrer";
      image.onload = () => onLoad?.(candidate);
      image.onerror = attempt;
      image.src = candidate;
    };
    attempt();
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

  resolveStyleFor(element) {
    const styleRef = attributeValue(element, "Style");
    return this.resolveStyleElement(styleRef) || this.implicitStyles.get(tagName(element).toLowerCase()) || null;
  }

  findStyleTemplate(style, propertyName) {
    if (!style) return null;
    const wanted = String(propertyName).toLowerCase();
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
      if (String(attributeValue(setter, "Property") || "").toLowerCase() !== wanted) continue;
      const referenced = this.resolveResourceElement(attributeValue(setter, "Value"));
      if (referenced && tagName(referenced) === "DataTemplate") return referenced;
      const valueProperty = findPropertyElement(setter, "Value");
      const template = valueProperty?.children?.[0];
      if (template) return template;
    }
    return null;
  }

  resolveTemplate(element, props, propertyName) {
    const referenced = this.resolveResourceElement(getProp(props, propertyName));
    if (referenced && tagName(referenced) === "DataTemplate") return referenced;

    const direct = findPropertyElement(element, propertyName);
    const template = direct?.children?.[0];
    if (template) return template;

    const seen = new Set();
    let style = this.resolveStyleFor(element);
    while (style && !seen.has(style)) {
      seen.add(style);
      const found = this.findStyleTemplate(style, propertyName);
      if (found) return found;
      style = this.resolveStyleElement(attributeValue(style, "BasedOn"));
    }
    return null;
  }

  findTemplateTextBlock(template) {
    if (!template) return null;
    if (tagName(template) === "TextBlock") return template;
    return Array.from(template.querySelectorAll("*")).find(node => tagName(node) === "TextBlock") || null;
  }

  buildTemplateText(template, text, className, layoutKind) {
    const textBlock = this.findTemplateTextBlock(template);
    if (!textBlock) return null;
    const node = this.buildTextBlock(textBlock, { kind: layoutKind });
    node.classList.add(className);
    node.textContent = text ?? "";
    return node;
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

}
