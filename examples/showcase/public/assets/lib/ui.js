/** Small DOM helpers shared by showcase pages. No framework, no build step. */

/** Create an element: h("div.card#id", { dataset, on… }, ...children). */
export const h = (selector, properties = {}, ...children) => {
  const [, tag = "div", rest = ""] = /^([a-z0-9-]+)?(.*)$/iu.exec(selector);
  const element = document.createElement(tag || "div");
  for (const token of rest.match(/[.#][^.#]+/gu) ?? []) {
    if (token[0] === ".") element.classList.add(token.slice(1));
    else element.id = token.slice(1);
  }
  for (const [key, value] of Object.entries(properties ?? {})) {
    if (value == null || value === false) continue;
    if (key === "dataset") Object.assign(element.dataset, value);
    else if (key.startsWith("on"))
      element.addEventListener(key.slice(2), value);
    else if (key === "text") element.textContent = value;
    else if (key in element && key !== "list") element[key] = value;
    else element.setAttribute(key, value === true ? "" : value);
  }
  for (const child of children.flat()) {
    if (child == null || child === false) continue;
    element.append(
      child instanceof Node ? child : document.createTextNode(String(child)),
    );
  }
  return element;
};

export const $ = (selector, root = document) => root.querySelector(selector);

/** Render sanitized Markdown with highlighted code blocks. */
export const renderMarkdown = (element, source) => {
  const html = window.marked.parse(String(source ?? ""), { gfm: true });
  element.innerHTML = window.DOMPurify.sanitize(html);
  for (const block of element.querySelectorAll("pre code")) {
    window.hljs?.highlightElement(block);
  }
};

export const highlight = (code, language) => {
  const element = h("code", { className: `language-${language}` });
  element.textContent = code;
  window.hljs?.highlightElement(element);
  return element;
};

export const formatBytes = (bytes) =>
  bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`;

export const formatDuration = (milliseconds) =>
  milliseconds < 1000
    ? `${Math.round(milliseconds)} ms`
    : `${(milliseconds / 1000).toFixed(2)} s`;

/** Position of an element's edge or center relative to a container. */
export const anchor = (element, container, side = "center") => {
  const box = element.getBoundingClientRect();
  const frame = container.getBoundingClientRect();
  const x =
    side === "left"
      ? box.left
      : side === "right"
        ? box.right
        : box.left + box.width / 2;
  const y =
    side === "top"
      ? box.top
      : side === "bottom"
        ? box.bottom
        : box.top + box.height / 2;
  return { x: x - frame.left, y: y - frame.top };
};

export const reducedMotion = () =>
  window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/**
 * Send a glowing packet along a cubic path between two points. Resolves when
 * the animation finishes. Uses CSS offset-path, set through the CSSOM so the
 * page keeps a strict Content-Security-Policy.
 */
export const sendPacket = (
  layer,
  from,
  to,
  { tone = "blue", label, duration = 650, bend = 0 } = {},
) => {
  if (reducedMotion()) return Promise.resolve();
  const packet = h(
    `div.packet.tone-${tone}`,
    {},
    label ? h("span", { text: label }) : null,
  );
  const midX = (from.x + to.x) / 2;
  packet.style.offsetPath = `path("M ${from.x} ${from.y} C ${midX} ${from.y + bend}, ${midX} ${to.y - bend}, ${to.x} ${to.y}")`;
  layer.append(packet);
  const animation = packet.animate(
    [
      { offsetDistance: "0%", opacity: 0, transform: "scale(0.6)" },
      { offsetDistance: "12%", opacity: 1, transform: "scale(1)" },
      { offsetDistance: "88%", opacity: 1, transform: "scale(1)" },
      { offsetDistance: "100%", opacity: 0, transform: "scale(0.7)" },
    ],
    { duration, easing: "cubic-bezier(.45,.05,.35,1)", fill: "forwards" },
  );
  return animation.finished.then(
    () => packet.remove(),
    () => packet.remove(),
  );
};

/** Briefly add a class to replay a CSS keyframe animation. */
export const flash = (element, className, duration = 1200) => {
  if (!element) return;
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
  setTimeout(() => element.classList.remove(className), duration);
};
