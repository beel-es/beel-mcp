/// <reference lib="dom" />
/**
 * A minimal element builder. Text always goes in as text nodes, so nothing an
 * API returns can become markup: there is no innerHTML anywhere in the app.
 */
export type Child = Node | string | false | null | undefined;

type Handlers = { [K in keyof HTMLElementEventMap]?: (event: HTMLElementEventMap[K]) => void };

interface Props {
  class?: string;
  /** Attributes; `false` and `undefined` leave one out, `true` sets it empty. */
  attrs?: Record<string, string | number | boolean | undefined>;
  on?: Handlers;
}

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: Props = {},
  ...children: Array<Child | Child[]>
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (props.class) el.className = props.class;
  for (const [name, value] of Object.entries(props.attrs ?? {})) {
    if (value === undefined || value === false) continue;
    el.setAttribute(name, value === true ? '' : String(value));
  }
  for (const [type, handler] of Object.entries(props.on ?? {})) {
    el.addEventListener(type, handler as EventListener);
  }
  for (const child of children.flat()) {
    if (child === null || child === undefined || child === false) continue;
    el.appendChild(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

/** Parse one of the app's own SVG assets (never data) into an element. */
export function svg(markup: string): Element {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  return document.importNode(doc.documentElement, true);
}
