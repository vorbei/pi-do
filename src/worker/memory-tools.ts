// The model's long-term memory tools (search_memory, remember, forget_memory): agent-core's memory
// tool envelope (shared with X Gardener) as Pi tools with pi-do's schemas, prose and result shapes.
// What a call may change is checked per call against the message's memory permission
// (agent-core memoryToolPermission); the model can never confirm an instruction, only the user can,
// in the side panel's Memory view. A call that changes memory runs
// under agent-core's tool receipt (`record`, from turns.ts): a recovered or replayed call gets the
// recorded result and changes nothing twice.
import { Type, type TSchema } from "@earendil-works/pi-ai";
import { MEMORY_INSTRUCTION_MAX, MEMORY_TOOL_NAMES, memoryStore, memoryToolPermission, offeredMemoryTools, runMemoryTool, type MemoryRow } from "agent-core/memory";
import { toolReceipt } from "agent-core/runtime";
import type { MemoryPermission } from "../shared/protocol.ts";
import type { Storage } from "./schema.ts";
import { MEMORY_TOOL_DESCRIPTIONS } from "./prompt.ts";

export const MEMORY_TOOLS = MEMORY_TOOL_NAMES;
const DENIED = "MEMORY_UPDATE_NOT_ALLOWED: the user has not allowed memory updates for this message. Only a new standing instruction can be saved (it waits for the user's confirmation). Tell the user what you would have saved instead of retrying.";

/** A tool as the Pi session registers it (agent-core PiAttempt `tools`). */
export interface PiTool {
  name: string; label: string; description: string; parameters: TSchema; executionMode?: "sequential";
  execute(toolCallId: string, params: any): Promise<{ content: ({ type: "text"; text: string } | { type: "image"; data: string; mimeType: string })[]; details: unknown; terminate?: boolean }>;
}

const text = (value: unknown) => ({ content: [{ type: "text" as const, text: JSON.stringify(value) }], details: {} });

type TextResult = { content: { type: "text"; text: string }[]; details: Record<string, unknown> };
/** Runs `change` once per tool-call id under a durable receipt and returns its result. */
export type RecordChange = (name: string, toolCallId: string, params: Record<string, unknown>, change: () => TextResult) => Promise<TextResult>;

/**
 * The memory tools for one turn. `reserve` counts a call against the turn's tool budget and
 * returns false when it is used up. forget_memory is offered only with the update permission.
 */
export function memoryTools(storage: Storage, turnId: string, permission: MemoryPermission, reserve: (toolCallId: string) => boolean,
  record: RecordChange): PiTool[] {
  const budgeted = (toolCallId: string) => {
    if (!reserve(toolCallId)) throw new Error("The tool call budget of this turn is used up. Answer with what you have.");
  };
  // A memory change runs once per tool-call id: a repeated call (a replay after recovery) gets the
  // recorded result before any check; the checks run before the receipt is opened, so a refused
  // call leaves no unresolved intent behind.
  const replayed = (toolCallId: string) => {
    const receipt = toolReceipt(storage, turnId, toolCallId);
    return receipt?.status === "completed" ? JSON.parse(receipt.result_json) as TextResult : null;
  };
  const once = (toolCallId: string, toolName: string, params: unknown, change: () => unknown) =>
    record(toolName, toolCallId, params as Record<string, unknown>, () => text(change()));
  const store = memoryStore(storage);
  const allowed = (name: string, input: unknown) => memoryToolPermission(name, input) !== "update" || permission.update;
  const search: PiTool = {
    name: "search_memory", label: "Search memory", description: MEMORY_TOOL_DESCRIPTIONS.search_memory, executionMode: "sequential",
    parameters: Type.Object({ query: Type.Optional(Type.String({ maxLength: 200 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 20 })) }),
    async execute(toolCallId, params) {
      budgeted(toolCallId);
      const { query = "", limit = 10 } = params as { query?: string; limit?: number };
      return text({ memories: (runMemoryTool(store, "search_memory", { query: String(query).slice(0, 200), limit }) as MemoryRow[]).map(row => ({
        memoryId: row.memory_id, kind: row.kind, content: row.content, confirmed: row.source_type === "user_confirmed",
        updatedAt: row.updated_at, expiresAt: row.expires_at })) });
    },
  };
  const save: PiTool = {
    name: "remember", label: "Remember", description: MEMORY_TOOL_DESCRIPTIONS.remember, executionMode: "sequential",
    parameters: Type.Object({
      kind: Type.Union([Type.Literal("fact"), Type.Literal("event"), Type.Literal("instruction")]),
      content: Type.String({ minLength: 1, maxLength: 2_000 }),
      supersedes: Type.Optional(Type.String({ maxLength: 160 })),
      expiresAt: Type.Optional(Type.String({ description: "ISO 8601 time when a temporary memory ends" })),
    }),
    async execute(toolCallId, params) {
      const replay = replayed(toolCallId);
      if (replay) return replay;
      const input = params as { kind: "fact" | "event" | "instruction"; content: string; supersedes?: string; expiresAt?: string };
      if (input.kind === "instruction" && input.content.length > MEMORY_INSTRUCTION_MAX) {
        throw new Error(`An instruction is at most ${MEMORY_INSTRUCTION_MAX} characters; split it into shorter rules`);
      }
      if (input.expiresAt !== undefined && Number.isNaN(Date.parse(input.expiresAt))) throw new Error("expiresAt must be an ISO 8601 time");
      if (!allowed("remember", input)) throw new Error(DENIED);
      budgeted(toolCallId);
      return once(toolCallId, "remember", params, () => {
        const saved: MemoryRow = runMemoryTool(store, "remember", { kind: input.kind, content: input.content.trim(), supersedes: input.supersedes,
          expiresAt: input.expiresAt }, { turnId });
        return { saved: { memoryId: saved.memory_id, kind: saved.kind, content: saved.content },
          ...(saved.replacement ? { replacement: saved.replacement } : {}),
          ...(input.kind === "instruction" && saved.source_type !== "user_confirmed" ? { note: "Saved; it applies once the user confirms it in Memory." } : {}) };
      });
    },
  };
  const forget: PiTool = {
    name: "forget_memory", label: "Forget memory", description: MEMORY_TOOL_DESCRIPTIONS.forget_memory, executionMode: "sequential",
    parameters: Type.Object({ memoryId: Type.String({ minLength: 1, maxLength: 160 }) }),
    async execute(toolCallId, params) {
      const replay = replayed(toolCallId);
      if (replay) return replay;
      if (!allowed("forget_memory", params)) throw new Error(DENIED);
      budgeted(toolCallId);
      // The agent's forget is never user-initiated: agent-core keeps a memory the user confirmed.
      return once(toolCallId, "forget_memory", params, () => runMemoryTool(store, "forget_memory", params));
    },
  };
  const tools: Record<string, PiTool> = { search_memory: search, remember: save, forget_memory: forget };
  return offeredMemoryTools(permission).map(name => tools[name]);
}
