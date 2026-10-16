// The user's Memory view: what the side panel lists from long-term memory, and the changes the
// user makes there (confirm an instruction, remove any memory), over agent-core's memory store.
import { confirmInstruction, forgetMemory, listInstructions } from "agent-core/memory";
import type { MemoryEntry, MemoryView } from "../shared/protocol.ts";
import { rows, type Storage } from "./schema.ts";

/** Active standing instructions, and active, unexpired facts and events, newest first. */
export function memoryView(storage: Storage, now = new Date().toISOString()): MemoryView {
  const memories = rows<{ memory_id: string; kind: "fact" | "event"; content: string; created_at: string; expires_at: string | null }>(storage,
    `SELECT memory_id, kind, content, created_at, expires_at FROM memories WHERE status = 'active' AND kind IN ('fact', 'event')
      AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT 200`, now)
    .map((row): MemoryEntry => ({ memoryId: row.memory_id, kind: row.kind, content: row.content, createdAt: row.created_at, expiresAt: row.expires_at || null }));
  return { instructions: listInstructions(storage), memories };
}

/** Only the user confirms an instruction (from the side panel); the agent cannot. */
export function confirmByUser(storage: Storage, memoryId: string) {
  return confirmInstruction(storage, memoryId);
}

/** The user removes a memory, including one they confirmed: the forget is user-initiated. */
export function forgetByUser(storage: Storage, memoryId: string) {
  return forgetMemory(storage, memoryId, { userInitiated: true });
}
