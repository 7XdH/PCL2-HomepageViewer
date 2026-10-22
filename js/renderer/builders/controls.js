import { PclLayoutBuilders } from "./layout.js";
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

export class PclControlBuilders extends PclLayoutBuilders {
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
        img.loading = this.lazyImages ? "lazy" : "eager";
        img.decoding = "async";
        const resolvedLogo = resolveImageSource(logoSource) || NO_ICON;
        logo.append(img);
        if (/^https?:/i.test(resolvedLogo)) {
          this.loadImageSource(
            resolvedLogo,
            loaded => {
              img.src = loaded;
            },
            () => {
              img.src = NO_ICON;
            },
            img
          );
        } else {
          img.src = resolvedLogo;
          img.addEventListener("error", () => {
            img.src = NO_ICON;
          }, { once: true });
        }
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
      img.loading = this.lazyImages ? "lazy" : "eager";
      img.decoding = "async";
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
      node.append(img);

      const useFallback = () => {
        if (fallback) {
          this.loadImageSource(
            fallback,
            loaded => {
              img.src = loaded;
            },
            () => {
              img.src = NO_ICON;
            },
            img
          );
        } else {
          img.src = NO_ICON;
        }
      };

      if (/^https?:/i.test(resolved)) {
        img.src = loadingSource;
        node.classList.add("is-loading");
        this.loadImageSource(
          resolved,
          loaded => {
            img.src = loaded;
            node.classList.remove("is-loading");
          },
          () => {
            node.classList.remove("is-loading");
            useFallback();
            this.warn(`图片加载失败：${source}`);
          },
          img
        );
      } else {
        img.src = resolved;
        img.addEventListener("error", () => {
          useFallback();
          this.warn(`图片加载失败：${source}`);
        }, { once: true });
      }
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

}
