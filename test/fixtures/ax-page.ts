import type { AXNode } from "../../src/browser/snapshot.ts";

const text = (value: string) => ({ value });
// A small page: heading, a form with an email field, a password field and a Send button, a link.
export const PAGE: AXNode[] = [
  { nodeId: "1", role: text("RootWebArea"), name: text("Shop"), childIds: ["2", "3", "8"] },
  { nodeId: "2", parentId: "1", role: text("heading"), name: text("Checkout"), properties: [{ name: "level", value: { value: 1 } }], childIds: ["2t"] },
  { nodeId: "2t", parentId: "2", role: text("StaticText"), name: text("Checkout") },
  { nodeId: "3", parentId: "1", role: text("form"), name: text("Payment"), childIds: ["4", "5", "6"] },
  { nodeId: "4", parentId: "3", role: text("textbox"), name: text("Email"), value: text("me@example.com"), backendDOMNodeId: 40 },
  { nodeId: "5", parentId: "3", role: text("textbox"), name: text("Password"), value: text("hunter2"), backendDOMNodeId: 50 },
  { nodeId: "6", parentId: "3", role: text("button"), name: text("Send order"), backendDOMNodeId: 60, properties: [{ name: "disabled", value: { value: false } }] },
  { nodeId: "8", parentId: "1", role: text("link"), name: text("Help"), backendDOMNodeId: 80, properties: [{ name: "url", value: { value: "https://shop.example/help" } }] },
];
