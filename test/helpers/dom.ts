// Test helper: a linkedom document with the browser globals React and the panel use; `restore()`
// puts the old ones back.
import { parseHTML } from "linkedom";

export function browserGlobals(html = "<html><body></body></html>") {
  const { document, window } = parseHTML(html);
  const values: Record<string, unknown> = { window, document, IS_REACT_ACT_ENVIRONMENT: true };
  const originals = Object.fromEntries(Object.keys(values).map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  for (const [name, value] of Object.entries(values)) Object.defineProperty(globalThis, name, { value, configurable: true, writable: true });
  const event = (type: string, init: EventInit = { bubbles: true }) => new (window as unknown as typeof globalThis).Event(type, init);
  return {
    document: document as unknown as Document,
    /** Dispatches a bubbling event of `type` at `element`. */
    fire(element: Element, type: string) { element.dispatchEvent(event(type)); },
    restore() {
      for (const [name, descriptor] of Object.entries(originals)) {
        if (descriptor) Object.defineProperty(globalThis, name, descriptor);
        else delete (globalThis as Record<string, unknown>)[name];
      }
    },
  };
}
