import { describe, expect, it } from "vitest";
import { fauxAssistantMessage, fauxToolCall, type Message } from "@earendil-works/pi-ai";
import { stubOldObservations } from "../src/worker/context.ts";

const user = (text: string): Message => ({ role: "user", content: text, timestamp: 1 });
const result = (id: string, text: string, image = false): Message => ({ role: "toolResult", toolCallId: id, toolName: "browser",
  content: [{ type: "text", text }, ...(image ? [{ type: "image" as const, data: "AAAA", mimeType: "image/jpeg" }] : [])], isError: false, timestamp: 1 });
const call = (id: string) => fauxAssistantMessage(fauxToolCall("browser", { action: "tabs" }, { id }), { stopReason: "toolUse" });

describe("observation stubs", () => {
  it("shortens old large observations and keeps only the latest screenshots (dropped in blocks)", () => {
    const big = "x".repeat(5_000);
    const messages: Message[] = [user("a")];
    for (let index = 0; index < 17; index++) messages.push(call(`c${index}`), result(`c${index}`, big, index > 0));
    const stubbed = stubOldObservations(messages);
    const texts = stubbed.filter(message => message.role === "toolResult").map(message => JSON.stringify(message));
    expect(texts[0]).toContain("older observation shortened");
    // Sixteen screenshots: twelve leave the view together, the latest four stay.
    expect(texts.filter(text => text.includes("Image omitted from this view"))).toHaveLength(12);
    expect(texts[13]).toContain('"type":"image"');
    expect(texts[16]).toContain('"type":"image"');
    expect(texts[16]).not.toContain("shortened");
    expect(messages[2]).toEqual(result("c0", big)); // the journal itself is untouched
  });
});
