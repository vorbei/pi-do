// Accessibility-tree snapshots with refs (pure), across the main frame and its iframes. Adapted
// from X Gardener src/browser/ax.js (projection, protected fields, semantic re-resolution) and
// src/browser/agent/snapshot-filter.js. Refs live only in the extension; the page DOM is never modified.

export interface AXValue { type?: string; value?: unknown; }
export interface AXProperty { name: string; value: AXValue; }
export interface AXNode {
  nodeId: string; ignored?: boolean; role?: AXValue; name?: AXValue; value?: AXValue;
  properties?: AXProperty[]; parentId?: string; childIds?: string[]; backendDOMNodeId?: number;
}

/**
 * What the extension remembers about a ref: enough to find the same control again, in its frame.
 * `role` and `name` are the accessibility node's; a clickable element without a control role
 * (`clickable`) is shown and confirmed by its visible text, `label`.
 */
export interface StoredControl { backendNodeId: number; role: string; name: string; context: string; frameId: string; clickable?: true; label?: string; }

/** How a control is named to the model and the user: `button "Send"`, `clickable "Select a country"`. */
export const shownRole = (control: StoredControl) => control.clickable ? "clickable" : control.role;
export const shownName = (control: StoredControl) => control.clickable ? control.label || control.name : control.name;

export interface Snapshot { text: string; refs: Record<string, StoredControl>; truncated: boolean; }

/**
 * One document's accessibility tree. `owners` maps an iframe element (backend node id) in this
 * document to the frame it shows; `protectedNodes` are fields whose values must not be shown.
 */
export interface FrameNodes {
  frameId: string; url: string; nodes: AXNode[]; owners?: Map<number, string>; protectedNodes?: Set<number>;
  /** Clickable elements without a control role (cursor:pointer, onclick, tabindex), by backend node id, with their text. */
  clickables?: Map<number, string>;
}

export const CONTROL_ROLES = new Set(["button", "link", "checkbox", "radio", "tab", "menuitem", "menuitemcheckbox", "menuitemradio",
  "switch", "option", "treeitem", "textbox", "searchbox", "combobox", "listbox", "slider", "spinbutton"]);
export const EDITABLE_ROLES = new Set(["textbox", "searchbox", "combobox"]);
export const FRAME_ROLES = new Set(["Iframe", "IframePresentational"]);
const SKIPPED_ROLES = new Set(["generic", "none", "presentation", "InlineTextBox", "LineBreak", "RootWebArea", "WebArea", "ignored"]);
const MAX_LINES = 600;
const MAX_CHARS = 30_000;

export const axText = (value?: AXValue) => typeof value?.value === "string" ? value.value.replace(/\s+/g, " ").trim().slice(0, 300) : "";
const axValue = (value?: AXValue) => ["string", "number"].includes(typeof value?.value) ? String(value!.value).slice(0, 500) : "";
const property = (node: AXNode, name: string) => node.properties?.find(item => item.name === name)?.value?.value;

/**
 * Renders the main frame's tree (the first entry) as `- role "name" [attrs]` lines in document
 * order, with each iframe's document indented under its `- iframe` line. Controls get refs
 * numbered from 1 across all frames; values of protected fields (passwords, one-time codes) are blanked.
 */
export function projectSnapshot(frames: FrameNodes[], header: string): Snapshot {
  const byFrame = new Map(frames.map(frame => [frame.frameId, frame]));
  const lines: string[] = [header];
  const refs: Record<string, StoredControl> = {};
  const rendered = new Set<string>();
  let chars = header.length;
  let truncated = false;
  let next = 1;
  const push = (line: string, depth: number): boolean => {
    const indented = `${"  ".repeat(depth)}${line}`;
    if (lines.length >= MAX_LINES || chars + indented.length > MAX_CHARS) { truncated = true; return false; }
    lines.push(indented);
    chars += indented.length + 1;
    return true;
  };
  const renderFrame = (frame: FrameNodes, startDepth: number) => {
    rendered.add(frame.frameId);
    const byId = new Map(frame.nodes.map(node => [node.nodeId, node]));
    const root = frame.nodes.find(node => !node.parentId || !byId.has(node.parentId));
    const seen = new Set<string>();
    const visit = (node: AXNode, depth: number, parentName: string) => {
      if (truncated || seen.has(node.nodeId)) return;
      seen.add(node.nodeId);
      const role = axText(node.role);
      const name = axText(node.name);
      if (FRAME_ROLES.has(role)) {
        const childId = node.backendDOMNodeId === undefined ? undefined : frame.owners?.get(node.backendDOMNodeId);
        const child = childId === undefined ? undefined : byFrame.get(childId);
        const readable = child && child.nodes.length && !rendered.has(child.frameId);
        const url = child ? safeUrl(child.url) : null;
        if (!push(`- iframe${name ? ` ${JSON.stringify(name)}` : ""}${url ? ` [url=${url}]` : ""}${readable ? "" : " (content not readable)"}`, depth)) return;
        if (readable) renderFrame(child, depth + 1);
        return;
      }
      let line: string | null = null;
      let lineName = name;
      const clickable = node.backendDOMNodeId !== undefined && !CONTROL_ROLES.has(role) ? frame.clickables?.get(node.backendDOMNodeId) : undefined;
      if (clickable !== undefined) {
        const ref = `e${next++}`;
        lineName = clickable || name;
        refs[ref] = { backendNodeId: node.backendDOMNodeId!, role, name, context: axContext(node, byId), frameId: frame.frameId, clickable: true, label: lineName };
        line = `- clickable${lineName ? ` ${JSON.stringify(lineName)}` : ""} [${[`ref=${ref}`, ...states(node)].join("] [")}]`;
      } else if (!node.ignored && !SKIPPED_ROLES.has(role)) {
        if (CONTROL_ROLES.has(role) && Number.isInteger(node.backendDOMNodeId)) {
          const ref = `e${next++}`;
          refs[ref] = { backendNodeId: node.backendDOMNodeId!, role, name, context: axContext(node, byId), frameId: frame.frameId };
          const attrs = [`ref=${ref}`, ...states(node)];
          const href = role === "link" ? linkHref(node) : null;
          if (href) attrs.push(`url=${href}`);
          const value = EDITABLE_ROLES.has(role) ? (frame.protectedNodes?.has(node.backendDOMNodeId!) ? "" : axValue(node.value)) : "";
          line = `- ${role}${name ? ` ${JSON.stringify(name)}` : ""} [${attrs.join("] [")}]${value ? `: ${value}` : ""}`;
        } else if (role === "StaticText") {
          if (name && name !== parentName) line = `- text: ${JSON.stringify(name)}`;
        } else if (name) {
          const level = role === "heading" ? property(node, "level") : undefined;
          line = `- ${role} ${JSON.stringify(name)}${level ? ` [level=${level}]` : ""}`;
        }
      }
      if (line && !push(line, depth)) return;
      for (const childId of node.childIds ?? []) {
        const child = byId.get(childId);
        if (child) visit(child, line ? depth + 1 : depth, line ? lineName : parentName);
      }
    };
    if (root) visit(root, startDepth, "");
  };
  if (frames[0]) renderFrame(frames[0], 0);
  // Frames whose iframe element is not in their parent's tree (hidden, or the parent was unreadable).
  for (const frame of frames) {
    if (truncated || rendered.has(frame.frameId) || !frame.nodes.length) continue;
    const url = safeUrl(frame.url);
    if (push(`- iframe${url ? ` [url=${url}]` : ""}`, 0)) renderFrame(frame, 1);
  }
  if (truncated) lines.push("[snapshot truncated: use filter or read_text for the rest]");
  return { text: lines.join("\n"), refs, truncated };
}

function states(node: AXNode): string[] {
  const out: string[] = [];
  for (const name of ["disabled", "checked", "expanded", "selected", "focused"]) {
    const value = property(node, name);
    if (value === true || value === "true") out.push(name);
    else if (value === "mixed") out.push(`${name}=mixed`);
    else if (value === false && (name === "checked" || name === "expanded")) out.push(`${name}=false`);
  }
  return out;
}

function linkHref(node: AXNode): string | null {
  const raw = property(node, "url");
  return typeof raw === "string" ? safeUrl(raw) : null;
}

/** An http(s) URL without credentials, cut to 200 characters; anything else is not shown. */
function safeUrl(raw: string): string | null {
  try {
    const url = new URL(raw);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password ? url.href.slice(0, 200) : null;
  } catch { return null; }
}

/** Named ancestors, used to tell apart controls with the same role and name. */
export function axContext(node: AXNode, byId: Map<string, AXNode>): string {
  const parts: string[] = [];
  let parent = node.parentId ? byId.get(node.parentId) : undefined;
  for (let depth = 0; parent && depth < 4; depth++) {
    const role = axText(parent.role);
    const name = axText(parent.name);
    // The document title (RootWebArea) is left out: titles change with unread counts and the like.
    if (name && !["generic", "none", "StaticText", "RootWebArea", "WebArea"].includes(role)) parts.unshift(`${role}:${name.slice(0, 120)}`);
    parent = parent.parentId ? byId.get(parent.parentId) : undefined;
  }
  return parts.join(" > ");
}

/**
 * Finds the stored control in the current tree of its frame: the same node if it still
 * matches, else the one node with the same role, name and context. Anything else is a stale or
 * ambiguous ref.
 */
export function resolveControl(nodes: AXNode[], stored: StoredControl): AXNode {
  const byId = new Map(nodes.map(node => [node.nodeId, node]));
  const matches = (node: AXNode) => (!node.ignored || stored.clickable) && axText(node.role) === stored.role && axText(node.name) === stored.name
    && axContext(node, byId) === stored.context;
  const original = nodes.find(node => node.backendDOMNodeId === stored.backendNodeId && matches(node));
  if (original) return original;
  const candidates = nodes.filter(node => matches(node) && Number.isInteger(node.backendDOMNodeId));
  if (candidates.length === 1) return candidates[0];
  throw Object.assign(new Error(candidates.length
    ? `The ref matches ${candidates.length} controls now; take a fresh snapshot`
    : "The ref's control is gone; take a fresh snapshot"), { code: candidates.length ? "REF_AMBIGUOUS" : "REF_STALE" });
}

/**
 * The snapshot cut to lines whose name or value contains one of the words (case-insensitive),
 * without ancestors. Roles, refs and URLs are not matched. Refs stay valid for the whole page.
 */
export function filterSnapshot(text: string, filter: string): string {
  const words = filter.toLowerCase().split(/\s+/).filter(Boolean);
  const [header, ...lines] = text.split("\n");
  const kept = lines.map(line => line.trim()).filter(line => {
    const visible = visibleText(line).toLowerCase();
    return words.some(word => visible.includes(word));
  });
  return [header, `[filter "${filter}": ${kept.length} of ${lines.length} lines match]`, ...kept].join("\n");
}

/** Controls only, plus the iframe lines that tell which frame a control is in. */
export function interactiveOnly(text: string): string {
  const [header, ...lines] = text.split("\n");
  return [header, ...lines.filter(line => /\[ref=e\d+\]/.test(line) || /^\s*- iframe\b/.test(line))].join("\n");
}

// A rendered line is `- role "name" [attrs]: value`; the name is JSON-quoted.
function visibleText(line: string): string {
  const parsed = line.match(/^- \S+?:? ("(?:[^"\\]|\\.)*")?(.*)$/);
  if (!parsed) return line;
  let name = "";
  try { name = parsed[1] ? JSON.parse(parsed[1]) : ""; } catch { name = parsed[1] ?? ""; }
  const rest = parsed[2] ?? "";
  const value = rest.lastIndexOf("]: ");
  return value < 0 ? name : `${name}\n${rest.slice(value + 3)}`;
}
