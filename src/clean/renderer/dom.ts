/**
 * The renderer's element toolkit.
 *
 * The old panel rebuilt `innerHTML` for the whole window every 2.5 seconds, which is why typing
 * a tunnel ID lost the field mid-keystroke and the log jumped to the top while you were reading
 * it. Nothing here ever produces markup from a string: elements are created once and mutated in
 * place, so focus, selection, scroll position and the caret survive every update. It also means
 * there is no HTML-escaping question to get wrong — `textContent` is not a parser.
 */

/** Attribute/property bag understood by `el`. */
interface Props {
  class?: string;
  text?: string;
  title?: string;
  type?: string;
  value?: string;
  placeholder?: string;
  autocomplete?: string;
  min?: string | number;
  max?: string | number;
  step?: string | number;
  hidden?: boolean;
  disabled?: boolean;
  checked?: boolean;
  role?: string;
  style?: string;
  tabIndex?: number;
  [key: `data-${string}`]: string | undefined;
  [key: `aria-${string}`]: string | undefined;
}

type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = String(value);
    else if (key === 'text') node.textContent = String(value);
    else if (key === 'value' || key === 'checked' || key === 'disabled' || key === 'tabIndex') {
      // Properties, not attributes: an input's attribute is only its initial value, and
      // writing it would not move a control the user has already interacted with.
      (node as unknown as Record<string, unknown>)[key] = value;
    } else node.setAttribute(key, String(value));
  }
  append(node, children);
  return node;
}

export function append(parent: Node, children: Child[]): void {
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    parent.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
}

export function clear(node: Node): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Sets `textContent` only when it actually differs, so a live selection is not collapsed. */
export function setText(node: Node, text: string): void {
  if (node.textContent !== text) node.textContent = text;
}

export function setClass(node: Element, className: string): void {
  if (node.className !== className) node.className = className;
}

export function setAttr(node: Element, name: string, value: string | null): void {
  if (value === null) {
    if (node.hasAttribute(name)) node.removeAttribute(name);
  } else if (node.getAttribute(name) !== value) {
    node.setAttribute(name, value);
  }
}

/** Writes an input's value unless the user is editing it, which would fight their caret. */
export function setValueIfIdle(input: HTMLInputElement, value: string): void {
  if (document.activeElement === input) return;
  if (input.value !== value) input.value = value;
}

export function on<K extends keyof HTMLElementEventMap>(
  node: HTMLElement,
  type: K,
  handler: (event: HTMLElementEventMap[K]) => void
): void {
  node.addEventListener(type, handler);
}

/**
 * Keyed list reconciliation.
 *
 * Rows are created once per key and updated in place; only genuinely new keys allocate a node
 * and only removed keys are detached. That is what lets a checkbox inside a plugin row keep
 * focus while its sibling rows change, and what keeps the log cheap to update.
 */
export function reconcile<T>(
  container: HTMLElement,
  items: readonly T[],
  key: (item: T) => string,
  create: (item: T) => HTMLElement,
  update?: (node: HTMLElement, item: T) => void
): void {
  const existing = new Map<string, HTMLElement>();
  for (const child of Array.from(container.children)) {
    const id = (child as HTMLElement).dataset['key'];
    if (id === undefined) child.remove();
    else existing.set(id, child as HTMLElement);
  }

  let cursor: ChildNode | null = container.firstChild;
  for (const item of items) {
    const id = key(item);
    let node = existing.get(id);
    if (node) {
      existing.delete(id);
      update?.(node, item);
    } else {
      node = create(item);
      node.dataset['key'] = id;
    }
    if (cursor === node) {
      cursor = node.nextSibling;
    } else {
      container.insertBefore(node, cursor);
    }
  }
  for (const orphan of existing.values()) orphan.remove();
}

/* --------------------------------------------------------------------- icons */

/**
 * Inline 16px icons in the lucide house style (the icon set shadcn ships with), drawn here so
 * the control window keeps its zero-runtime-dependency footprint.
 */
const PATHS: Record<string, string> = {
  activity: 'M3 12h4l3 8 4-16 3 8h4',
  folder: 'M3 7a2 2 0 0 1 2-2h3.9a2 2 0 0 1 1.69.9l.82 1.2a2 2 0 0 0 1.68.9H19a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z',
  shield: 'M12 3l7 3v5.5c0 4.2-2.9 8.1-7 9.5-4.1-1.4-7-5.3-7-9.5V6z',
  puzzle: 'M9 3.5a1.8 1.8 0 0 1 3.6 0V5H15a1 1 0 0 1 1 1v2.4h1.5a1.8 1.8 0 0 1 0 3.6H16V15a1 1 0 0 1-1 1h-2.4v1.5a1.8 1.8 0 0 1-3.6 0V16H6a1 1 0 0 1-1-1v-3h1.2a1.8 1.8 0 0 0 0-3.6H5V6a1 1 0 0 1 1-1h3z',
  terminal: 'M5 8l4 4-4 4M12.5 16H19',
  settings: 'M12 15.2a3.2 3.2 0 1 0 0-6.4 3.2 3.2 0 0 0 0 6.4zM19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-1.8-.3 1.6 1.6 0 0 0-1 1.5v.2a2 2 0 1 1-4 0v-.1a1.6 1.6 0 0 0-1-1.5 1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0 .3-1.8 1.6 1.6 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.6 1.6 0 0 0 1.5-1 1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H9a1.6 1.6 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V9a1.6 1.6 0 0 0 1.5 1h.2a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z',
  gauge: 'M12 20a8 8 0 1 1 8-8M12 12l4.5-3.5',
  plus: 'M12 5v14M5 12h14',
  trash: 'M4 7h16M9.5 7V5.5A1.5 1.5 0 0 1 11 4h2a1.5 1.5 0 0 1 1.5 1.5V7M6.5 7l.8 12a1.5 1.5 0 0 0 1.5 1.4h6.4a1.5 1.5 0 0 0 1.5-1.4L17.5 7',
  external: 'M14 4h6v6M20 4l-8.5 8.5M18 13.5V19a1.5 1.5 0 0 1-1.5 1.5H5A1.5 1.5 0 0 1 3.5 19V7.5A1.5 1.5 0 0 1 5 6h5.5',
  copy: 'M9 9V5.5A1.5 1.5 0 0 1 10.5 4h8A1.5 1.5 0 0 1 20 5.5v8a1.5 1.5 0 0 1-1.5 1.5H15M5.5 9h8A1.5 1.5 0 0 1 15 10.5v8a1.5 1.5 0 0 1-1.5 1.5h-8A1.5 1.5 0 0 1 4 18.5v-8A1.5 1.5 0 0 1 5.5 9z',
  download: 'M12 4v10m0 0l-4-4m4 4l4-4M4 18h16',
  eraser: 'M4 19h16M6.5 16.5l-2-2a1.5 1.5 0 0 1 0-2.1l7-7a1.5 1.5 0 0 1 2.1 0l4.5 4.5a1.5 1.5 0 0 1 0 2.1L14 16.5z',
  search: 'M11 18a7 7 0 1 0 0-14 7 7 0 0 0 0 14zM20 20l-4-4',
  chevron: 'M6 9l6 6 6-6',
  refresh: 'M20 11a8 8 0 1 0-.7 4.5M20 5v6h-6',
  power: 'M12 4v8M7.5 6.8a8 8 0 1 0 9 0',
  link: 'M10 13.5a4 4 0 0 0 5.7.2l2.6-2.6a4 4 0 0 0-5.7-5.7l-1.5 1.5M14 10.5a4 4 0 0 0-5.7-.2l-2.6 2.6a4 4 0 0 0 5.7 5.7l1.5-1.5',
  key: 'M15.5 4a4.5 4.5 0 1 0-4.3 5.9L4 17.1V20h3l1-1v-2h2v-2h2l1.1-1.1A4.5 4.5 0 0 0 15.5 4z',
  check: 'M5 12.5l4.5 4.5L19 7',
  alert: 'M12 8.5v5m0 3.2v.1M10.3 4.3 2.9 17a2 2 0 0 0 1.7 3h14.8a2 2 0 0 0 1.7-3L13.7 4.3a2 2 0 0 0-3.4 0z',
  info: 'M12 21a9 9 0 1 0 0-18 9 9 0 0 0 0 18zM12 11v5M12 7.8v.1',
  play: 'M7 5l11 7-11 7z',
  down: 'M12 5v13m0 0l-5-5m5 5l5-5',
  pin: 'M9 4h6M12 4v6.5l3.5 4V17h-7v-2.5L12 10.5M12 17v3'
};

export function icon(name: keyof typeof PATHS | string, size = 14): SVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('width', String(size));
  svg.setAttribute('height', String(size));
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.7');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', 'icon');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', PATHS[name] ?? PATHS['info']!);
  svg.appendChild(path);
  return svg;
}
