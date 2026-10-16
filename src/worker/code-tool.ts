// The model's run_code tool: the code (JavaScript or bash) is queued for the extension as an
// executor call, like a browser action, after it is counted against the turn's code runs; the
// extension runs it in agent-core's code sandbox, and the settled result is what the model reads.
import { Type } from "@earendil-works/pi-ai";
import { insertFunctionCall } from "agent-core/runtime";
import { executorWaitingResult, type TurnDriverHost } from "agent-core/pi";
import { parseRunCode, ProtocolError, RUN_CODE_LIMITS, RUN_CODE_MAX_CHARS, RUN_CODE_TOOL, type RunCodeResult } from "../shared/protocol.ts";
import type { PiTool } from "./memory-tools.ts";
import { RUN_CODE_TOOL_DESCRIPTION, runCodeLimit } from "./prompt.ts";
import { one } from "./schema.ts";

/**
 * `reserve` counts a call against the turn's code runs (agent-core's codeExec) and returns false
 * when they are used up; the attempt already counts every tool call against the tool budget.
 */
export function runCodeTool(driver: TurnDriverHost, turnId: string, codeRuns: number, reserve: (toolCallId: string) => boolean): PiTool {
  return {
    name: RUN_CODE_TOOL,
    label: "Run code",
    description: RUN_CODE_TOOL_DESCRIPTION,
    parameters: Type.Object({
      language: Type.Optional(Type.Union([Type.Literal("js"), Type.Literal("bash")], { description: "js (default) or bash" })),
      code: Type.String({ minLength: 1, maxLength: RUN_CODE_MAX_CHARS }),
      files: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "files the run starts with: path -> text" })),
    }),
    executionMode: "sequential",
    // The run is queued for the extension; the turn resumes when the extension settles it.
    async execute(toolCallId, params) {
      let call;
      try { call = parseRunCode(params); }
      catch (error) { throw new Error(`Invalid run_code call: ${error instanceof ProtocolError ? error.message : String(error)}`); }
      if (!reserve(toolCallId)) throw new Error(runCodeLimit(codeRuns));
      const accountId = one<{ account_id: string }>(driver.storage, "SELECT account_id FROM agent_turns WHERE turn_id = ?", turnId)!.account_id;
      const callId = insertFunctionCall(driver, { turnId, accountId, toolCallId, functionName: RUN_CODE_TOOL, input: call });
      return executorWaitingResult({ callId, functionName: RUN_CODE_TOOL }) as Awaited<ReturnType<PiTool["execute"]>>;
    },
  };
}

/** What the model reads of a run: the value (js) or the output and exit status (bash), the console lines, or why it failed. */
export function runCodeText(result: RunCodeResult): string {
  const cut = result.truncated ? `\n[cut at ${RUN_CODE_LIMITS.maxOutputChars} characters]` : "";
  const logs = result.logs.length ? `\nconsole:\n${result.logs.join("\n")}` : "";
  const shell = result.exitCode === undefined ? ""
    : `${result.stdout ?? ""}${cut}${result.stderr ? `\nstderr:\n${result.stderr}` : ""}\nexit status ${result.exitCode}`;
  if (!result.ok) {
    const error = result.error!;
    return `run_code failed (${error.code}): ${error.name ? `${error.name}: ` : ""}${error.message}${shell ? `\n${shell}` : ""}${logs}`;
  }
  return shell || `${result.value ?? ""}${cut}${logs}`;
}
