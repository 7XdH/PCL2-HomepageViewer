import { parseXaml, tagName, isPropertyElement, propertyElementName, attributeValue } from "./xaml.js";
import { PclDocumentBuilders } from "./renderer/builders/document.js";
import { RESOURCE_REF_RE, getProp, findPropertyElement } from "./renderer/helpers.js";
import { classifyAttribute, isSupportedSetterProperty, locateAttribute } from "./renderer/known-attributes.js";

export class PclRenderer extends PclDocumentBuilders {
  constructor({ root, runtime, getProxyUa, getProxyUas, lazyImages = true } = {}) {
    super();
    this.root = root;
    this.runtime = runtime;
    this.getProxyUa = getProxyUa;
    this.getProxyUas = getProxyUas;
    this.lazyImages = lazyImages;
    // Base URI of the document being rendered. PCL loads Custom.xaml through
    // XamlReader.Load(Stream), so a relative `Source="images/a.png"` resolves
    // against the downloaded file's folder. The viewer keeps the final URL of
    // the fetched document here; custom code and local files leave it empty.
    this.baseUrl = "";
    this.baseUrlSources = new Set();
    this.warnings = [];
    this.issues = [];
    this.controlCount = 0;
    this.resources = new Map();
    this.implicitStyles = new Map();
    this.resourceNodes = new WeakSet();
    // Bumped by every render(). Image callbacks compare against it so a request
    // started for the previous document cannot write into the new one.
    this.imageGeneration = 0;
    this.pendingImages = new Set();
  }

  cancelPendingImages() {
    for (const entry of this.pendingImages) {
      const { image } = entry;
      image.onload = null;
      image.onerror = null;
      // A detached Image() keeps downloading until its src is cleared. An
      // element still in the tree belongs to the document that is about to be
      // replaced, so the browser drops it with the subtree anyway.
      if (image && !image.isConnected) image.src = "";
    }
    this.pendingImages.clear();
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

    const generation = this.imageGeneration;
    const entry = { image: null };
    let index = 0;
    const settle = (callback, value) => {
      this.pendingImages.delete(entry);
      // A callback that outlives its render must be a no-op: it would otherwise
      // patch the new document with the old document's image.
      if (generation !== this.imageGeneration) return;
      callback?.(value);
    };
    const attempt = () => {
      if (index >= candidates.length) {
        settle(onError);
        return;
      }
      const candidate = candidates[index++];
      // Keep the legacy preload path for eager/test renderers; the visible
      // element is used directly only when native lazy loading is enabled.
      const image = target && this.lazyImages ? target : new Image();
      entry.image = image;
      if (generation !== this.imageGeneration) return;
      this.pendingImages.add(entry);
      image.referrerPolicy = "no-referrer";
      image.onload = () => settle(onLoad, candidate);
      image.onerror = attempt;
      image.src = candidate;
    };
    attempt();
  }

  /**
   * @param {string} source
   * @param {{ baseUrl?: string }} [options] URL the document was fetched from,
   * used to resolve its relative image sources the way WPF's base URI does.
   */
  render(source, { baseUrl = "" } = {}) {
    const started = performance.now();
    this.baseUrl = String(baseUrl || "");
    // Drop callbacks of the document that is being replaced before building the
    // new one, so a slow image cannot patch the new DOM when it finally lands.
    this.imageGeneration += 1;
    this.cancelPendingImages();
    this.warnings = [];
    this.baseUrlSources.clear();
    this.controlCount = 0;
    const documentRoot = parseXaml(source, this.runtime.context);
    const elements = this.collectResources(documentRoot);
    this.applyStyles(documentRoot, elements);
    this.resolveResourceReferences(documentRoot, elements);
    this.auditAttributes(documentRoot, source);
    const stack = document.createElement("div");
    stack.className = "pcl-xaml-root";

    for (const child of documentRoot.children) {
      if (isPropertyElement(child)) continue;
      const node = this.buildNode(child, { kind: "stack-v" });
      if (node) stack.append(node);
    }

    this.root.replaceChildren(stack);
    this.syncGroupBoxFrames();
    this.clampCardTexts();
    this.root.scrollTop = 0;
    this.reportBaseUrlExtension();
    const duration = Math.max(1, Math.round(performance.now() - started));
    return {
      controls: this.controlCount,
      duration,
      warnings: this.warnings.slice(),
      issues: this.issues.slice()
    };
  }

  auditAttributes(documentRoot, source) {
    // PCL feeds Custom.xaml to XamlReader, so a member the target type does not
    // declare aborts the load with 「无法设置未知成员…，行号为 N，行位置为 M」.
    // The previewer keeps rendering by design, but the same members are
    // reported here with the matching line/position so a page that only works
    // in the previewer is obvious.
    this.issues = [];
    if (!source) return;
    const text = String(source);
    let cursor = 0;
    for (const element of documentRoot.querySelectorAll("*")) {
      const tag = tagName(element);
      if (!tag || tag === "PCLRoot") continue;
      for (const attribute of Array.from(element.attributes)) {
        const finding = classifyAttribute(tag.toLowerCase(), attribute.name, tag);
        if (!finding) continue;
        const position = locateAttribute(text, attribute.name, cursor);
        cursor = position.cursor;
        const location = position.line ? `，行号为“${position.line}”，行位置为“${position.column}”` : "";
        const message =
          finding.severity === "error"
            ? `『无法设置未知成员“${finding.member}”。』${location}`
            : `${finding.reason}${location}`;
        this.issues.push({
          severity: finding.severity,
          tag: tag,
          member: finding.member,
          line: position.line,
          column: position.column,
          message
        });
        this.warn(finding.severity === "error" ? `PCL 会拒绝该属性：${message}` : message);
      }
    }
  }

  syncGroupBoxFrames() {
    // WPF's Aero2 GroupBox template spans the header presenter over two rows
    // that are each half of its height, so the frame's top edge cuts through
    // the middle of the header. Header height depends on the font, so measure
    // it once the subtree is attached instead of hard-coding a value.
    for (const box of this.root.querySelectorAll(".pcl-groupbox")) {
      const header = box.querySelector(".pcl-groupbox__header");
      const headerStyle = header ? getComputedStyle(header) : null;
      const height = headerStyle ? Number.parseFloat(headerStyle.height) : 0;
      const width = headerStyle ? Number.parseFloat(headerStyle.width) : 0;
      box.style.setProperty("--groupbox-frame-top", `${Number.isFinite(height) ? height / 2 : 0}px`);
      // BorderGapMaskConverter uses the "Header" border's ActualWidth and a
      // fixed 7px offset for the left edge of the erased gap.
      box.style.setProperty("--groupbox-gap-width", `${Number.isFinite(width) ? width : 0}px`);
    }
  }

  clampCardTexts() {
    // Fixed-height wrapped text (e.g. Height="36") fits a fractional number of
    // lines in WPF; TextTrimming then ends the last complete line with an
    // ellipsis. Reproduce that by trimming the text itself to the longest
    // prefix that still fits the whole lines the height allows. The element
    // keeps its authored height, so the WPF centering/gaps stay untouched.
    for (const body of this.root.querySelectorAll(".pcl-card__body")) {
      for (const text of body.querySelectorAll(".pcl-text")) {
        if (text.scrollHeight <= text.clientHeight + 1) continue;
        const style = getComputedStyle(text);
        const lineHeight = Number.parseFloat(style.lineHeight);
        if (!Number.isFinite(lineHeight) || lineHeight <= 0) continue;
        const paddingY = (Number.parseFloat(style.paddingTop) || 0) + (Number.parseFloat(style.paddingBottom) || 0);
        const lines = Math.max(1, Math.floor((text.clientHeight - paddingY) / lineHeight));
        const maxHeight = lines * lineHeight + paddingY + 1;
        const full = text.textContent || "";
        if (!full.trim()) continue;
        // Measure with a free height so scrollHeight reports the content size
        // (a fixed height makes scrollHeight clamp to clientHeight).
        const savedHeight = text.style.height;
        const savedAlign = text.style.alignSelf;
        text.style.height = "auto";
        text.style.alignSelf = "start";
        // offsetHeight is an unscaled layout value, unlike
        // getBoundingClientRect().height, which carries the stage's
        // --pcl-scale. Comparing the scaled rect against this unscaled line
        // budget made every prefix fail once the preview zoomed past ~1.02, so
        // the whole text collapsed to a single ellipsis. scrollHeight is no
        // good either: glyph ink spilling out of the line box counts as
        // scrollable overflow and overstates the height by one or two pixels.
        const fits = (length) => {
          text.textContent = `${full.slice(0, length).trimEnd()}…`;
          return text.offsetHeight <= maxHeight;
        };
        let low = 0;
        let high = full.length;
        while (low < high) {
          const mid = Math.ceil((low + high) / 2);
          if (fits(mid)) low = mid;
          else high = mid - 1;
        }
        // Only add an ellipsis when something was actually cut. A prefix that
        // measures as fitting may still be the whole string, and appending an
        // ellipsis there leaves a stray dot on every re-render.
        text.textContent = low < full.length ? `${full.slice(0, low).trimEnd()}…` : full;
        text.style.height = savedHeight;
        text.style.alignSelf = savedAlign;
      }
    }
  }

  warn(message) {
    this.warnings.push(message);
    console.warn("[PCL Renderer]", message);
  }

  /**
   * Callback for `resolveImageSource`: records a source that only resolved
   * because the viewer knows the document URL.
   */
  noteBaseUrlSource(source, resolved) {
    this.baseUrlSources.add(`${source} → ${resolved}`);
  }

  reportBaseUrlExtension() {
    // PCL hands XamlReader.Load a MemoryStream without a base URI
    // (ModBase.vb:1130-1145), so every relative `Source="images/a.png"`
    // resolves to nothing there. Resolving it is a viewer extension; say so
    // once per document instead of leaving the page silently non-portable.
    if (!this.baseUrlSources.size) return;
    const samples = [...this.baseUrlSources].slice(0, 3).join("、");
    const more = this.baseUrlSources.size > 3 ? " 等" : "";
    this.warn(
      `相对图片路径按文档 URL 解析了 ${this.baseUrlSources.size} 处（${samples}${more}）；PCL 的 XamlReader 没有基地址，这些图在真实启动器中会丢失。`
    );
  }

  count(node) {
    this.controlCount += 1;
    return node;
  }

  collectResources(root) {
    this.resources = new Map();
    this.implicitStyles = new Map();
    this.resourceNodes = new WeakSet();

    const register = (resource) => {
      this.markResource(resource);
      const key = attributeValue(resource, "x:Key", "Key");
      if (key) {
        this.resources.set(key.trim(), resource);
        return;
      }
      if (tagName(resource) === "Style") {
        const target = String(attributeValue(resource, "TargetType") || "")
          .split(":")
          .pop();
        if (target) this.implicitStyles.set(target.toLowerCase(), resource);
      }
    };

    const elements = Array.from(root.querySelectorAll("*"));
    for (const element of elements) {
      if (!isPropertyElement(element) || propertyElementName(element).toLowerCase() !== "resources") continue;
      for (const resource of element.children) {
        if (tagName(resource) === "ResourceDictionary") {
          for (const item of resource.children) register(item);
        } else {
          register(resource);
        }
      }
    }
    return elements;
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
    return Array.from(template.querySelectorAll("*")).find((node) => tagName(node) === "TextBlock") || null;
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
    return Array.from(element.attributes).some((attribute) => attribute.name.toLowerCase() === wanted);
  }

  applyStyles(root, elements = root.querySelectorAll("*")) {
    for (const element of elements) {
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
      // A Style is remote input too: only hand it attributes the renderer reads.
      if (!isSupportedSetterProperty(property)) continue;
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

  resolveResourceReferences(root, elements = root.querySelectorAll("*")) {
    const primitiveTypes = new Set(["String", "Double", "Int32", "Int64", "Boolean", "Color"]);
    for (const element of elements) {
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
