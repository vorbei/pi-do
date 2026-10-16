import { describe, expect, it } from "vitest";
import { filterSnapshot, interactiveOnly, projectSnapshot, resolveControl, type AXNode, type FrameNodes } from "../src/browser/snapshot.ts";
import { PAGE } from "./fixtures/ax-page.ts";

const text = (value: string) => ({ value });
const main = (nodes: AXNode[], extra: Partial<FrameNodes> = {}): FrameNodes => ({ frameId: "main", url: "https://shop.example/", nodes, ...extra });

describe("snapshot projection", () => {
  it("renders roles, names, refs and link URLs in document order, blanking protected values", () => {
    const snapshot = projectSnapshot([main(PAGE, { protectedNodes: new Set([50]) })], "Page: Shop");
    expect(snapshot.text).toBe([
      "Page: Shop",
      '- heading "Checkout" [level=1]',
      '- form "Payment"',
      '  - textbox "Email" [ref=e1]: me@example.com',
      '  - textbox "Password" [ref=e2]',
      '  - button "Send order" [ref=e3]',
      '- link "Help" [ref=e4] [url=https://shop.example/help]',
    ].join("\n"));
    expect(snapshot.text).not.toContain("hunter2");
    expect(snapshot.refs.e3).toEqual({ backendNodeId: 60, role: "button", name: "Send order", context: "form:Payment", frameId: "main" });
  });

  it("nests each iframe's document under its iframe line, with refs bound to that frame", () => {
    const outer: AXNode[] = [
      { nodeId: "r", role: text("RootWebArea"), childIds: ["h", "f1", "f2"] },
      { nodeId: "h", parentId: "r", role: text("heading"), name: text("Outer") },
      { nodeId: "f1", parentId: "r", role: text("Iframe"), name: text("Widget"), backendDOMNodeId: 7 },
      { nodeId: "f2", parentId: "r", role: text("Iframe"), backendDOMNodeId: 8 },
    ];
    const widget: AXNode[] = [
      { nodeId: "w", role: text("RootWebArea"), childIds: ["b", "n"] },
      { nodeId: "b", parentId: "w", role: text("button"), name: text("Shadow click"), backendDOMNodeId: 11 },
      { nodeId: "n", parentId: "w", role: text("Iframe"), backendDOMNodeId: 12 },
    ];
    const nested: AXNode[] = [
      { nodeId: "x", role: text("RootWebArea"), childIds: ["u"] },
      { nodeId: "u", parentId: "x", role: text("textbox"), name: text("Username"), backendDOMNodeId: 11 },
    ];
    const snapshot = projectSnapshot([
      main(outer, { owners: new Map([[7, "widget"], [8, "gone"]]) }),
      { frameId: "widget", url: "https://widget.example/w", nodes: widget, owners: new Map([[12, "nested"]]) },
      { frameId: "nested", url: "https://widget.example/n", nodes: nested },
    ], "Page");
    expect(snapshot.text).toBe([
      "Page",
      '- heading "Outer"',
      '- iframe "Widget" [url=https://widget.example/w]',
      '  - button "Shadow click" [ref=e1]',
      "  - iframe [url=https://widget.example/n]",
      '    - textbox "Username" [ref=e2]',
      "- iframe (content not readable)",
    ].join("\n"));
    // The same backend node id in two processes stays two controls, told apart by frame.
    expect(snapshot.refs.e1).toMatchObject({ backendNodeId: 11, frameId: "widget" });
    expect(snapshot.refs.e2).toMatchObject({ backendNodeId: 11, frameId: "nested" });
    expect(interactiveOnly(snapshot.text).split("\n")).toEqual([
      "Page", '- iframe "Widget" [url=https://widget.example/w]', '  - button "Shadow click" [ref=e1]',
      "  - iframe [url=https://widget.example/n]", '    - textbox "Username" [ref=e2]', "- iframe (content not readable)",
    ]);
  });

  it("still shows a frame whose iframe element is missing from its parent's tree", () => {
    const snapshot = projectSnapshot([main(PAGE.slice(0, 2)), { frameId: "f", url: "https://ads.example/x", nodes: [
      { nodeId: "a", role: text("RootWebArea"), childIds: ["l"] },
      { nodeId: "l", parentId: "a", role: text("link"), name: text("Offer"), backendDOMNodeId: 3 },
    ] }], "Page");
    expect(snapshot.text.split("\n").slice(-2)).toEqual(["- iframe [url=https://ads.example/x]", '  - link "Offer" [ref=e1]']);
  });

  it("gives clickable elements without a control role a ref, named by their visible text", () => {
    const nodes: AXNode[] = [
      { nodeId: "r", role: text("RootWebArea"), childIds: ["d", "b"] },
      { nodeId: "d", parentId: "r", role: text("generic"), ignored: true, backendDOMNodeId: 70, childIds: ["t"] },
      { nodeId: "t", parentId: "d", role: text("StaticText"), name: text("Select a country") },
      { nodeId: "b", parentId: "r", role: text("button"), name: text("Go"), backendDOMNodeId: 71 },
    ];
    // A real button that is also cursor:pointer keeps its role.
    const snapshot = projectSnapshot([main(nodes, { clickables: new Map([[70, "Select a country"], [71, "Go"]]) })], "Page");
    expect(snapshot.text).toBe(['Page', '- clickable "Select a country" [ref=e1]', '- button "Go" [ref=e2]'].join("\n"));
    expect(snapshot.refs.e1).toMatchObject({ role: "generic", clickable: true, label: "Select a country", backendNodeId: 70 });
    expect(resolveControl(nodes, snapshot.refs.e1).nodeId).toBe("d"); // an ignored node still resolves as a clickable
  });

  it("truncates a huge page with a note instead of overflowing", () => {
    const nodes: AXNode[] = [{ nodeId: "r", role: text("RootWebArea"), childIds: [] }];
    for (let index = 0; index < 2_000; index++) {
      nodes[0].childIds!.push(`n${index}`);
      nodes.push({ nodeId: `n${index}`, parentId: "r", role: text("button"), name: text(`Button ${index}`), backendDOMNodeId: 1_000 + index });
    }
    const snapshot = projectSnapshot([main(nodes)], "Page");
    expect(snapshot.truncated).toBe(true);
    expect(snapshot.text.split("\n").length).toBeLessThanOrEqual(602);
    expect(snapshot.text).toMatch(/snapshot truncated/);
  });

  it("filters by name or value, not by role or URL, and keeps refs", () => {
    const { text: full } = projectSnapshot([main(PAGE)], "Page: Shop");
    expect(filterSnapshot(full, "order").split("\n")).toEqual(["Page: Shop", '[filter "order": 1 of 6 lines match]', '- button "Send order" [ref=e3]']);
    expect(filterSnapshot(full, "example.com")).toContain("textbox \"Email\""); // matched by value
    expect(filterSnapshot(full, "shop.example")).toContain("0 of 6"); // URLs are not matched
    expect(filterSnapshot(full, "button")).toContain("0 of 6"); // roles are not matched
    expect(interactiveOnly(full).split("\n")).toHaveLength(5);
  });
});

describe("ref resolution", () => {
  const stored = { backendNodeId: 60, role: "button", name: "Send order", context: "form:Payment", frameId: "main" };

  it("returns the original node while it still matches", () => {
    expect(resolveControl(PAGE, stored).nodeId).toBe("6");
  });

  it("finds the one re-rendered node with the same role, name and context", () => {
    const rerendered = PAGE.map(node => node.nodeId === "6" ? { ...node, backendDOMNodeId: 61 } : node);
    expect(resolveControl(rerendered, stored).backendDOMNodeId).toBe(61);
  });

  it("refuses a gone or ambiguous control rather than guessing", () => {
    expect(() => resolveControl(PAGE.filter(node => node.nodeId !== "6"), stored)).toThrow(/gone/);
    const twice = [...PAGE.map(node => node.nodeId === "6" ? { ...node, backendDOMNodeId: 61 } : node),
      { ...PAGE[6], nodeId: "7", backendDOMNodeId: 62 }];
    expect(() => resolveControl(twice, stored)).toThrow(/matches 2 controls/);
  });
});
