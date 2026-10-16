// A pure transform of a turn's history before it reaches the model: `stubOldObservations` is the
// cheap, model-free context bound (the idea of X Gardener src/pi/observation-stubs.js, for pi-do's
// browser results): old page observations shrink to a short receipt, and older screenshots leave
// the view in blocks (agent-core pruneToolImages, shared with Gardener).
import type { Message } from "@earendil-works/pi-ai";
import { pruneToolImages } from "agent-core/runtime";

const KEEP_RECENT_OBSERVATIONS = 4;
const STUB_ABOVE_CHARS = 1_500;

/** Shrinks all but the most recent browser observations; keeps only the latest images. */
export function stubOldObservations(messages: Message[]): Message[] {
  const results = messages.map((message, index) => ({ message, index })).filter(({ message }) => message.role === "toolResult");
  const recent = new Set(results.slice(-KEEP_RECENT_OBSERVATIONS).map(({ index }) => index));
  const shortened = messages.map((message, index) => {
    if (message.role !== "toolResult" || recent.has(index)) return message;
    const content = message.content.map(part => part.type === "text" && part.text.length > STUB_ABOVE_CHARS
      ? { type: "text" as const, text: `${part.text.slice(0, 300)}\n[older observation shortened from ${part.text.length} characters; observe again if needed]` }
      : part);
    return content.every((part, position) => part === message.content[position]) ? message : { ...message, content };
  });
  return pruneToolImages(shortened);
}
