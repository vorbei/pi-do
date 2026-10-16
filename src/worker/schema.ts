// The AccountDO's SQLite schema and the storage interface the turn runtime needs.
import { MEMORY_SCHEMA } from "agent-core/memory";
import { PI_JOURNAL_SCHEMA } from "agent-core/pi";
import { ALARM_JOBS_SCHEMA, THREAD_COLUMNS, THREADS_SCHEMA } from "agent-core/routine";
import { RUNTIME_SCHEMA } from "agent-core/runtime";
// The interface is the subset of Durable Object storage used here, so tests can back it
// with node:sqlite.

export interface Sql { exec(query: string, ...bindings: any[]): { toArray(): unknown[] }; }
export interface Storage { sql: Sql; transactionSync<T>(closure: () => T): T; }

const STATEMENTS = [
  `CREATE TABLE IF NOT EXISTS account (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    account_id TEXT NOT NULL, token_hash TEXT NOT NULL, created_at INTEGER NOT NULL, last_claim_at INTEGER)`,
  // The images the user attached to a message, by its turn and their order (protocol.ts bounds a
  // message's images to one SQLite value); its turn's input_json names only their types.
  `CREATE TABLE IF NOT EXISTS turn_images (
    turn_id TEXT NOT NULL, position INTEGER NOT NULL, mime_type TEXT NOT NULL, data TEXT NOT NULL,
    PRIMARY KEY (turn_id, position))`,
  // PDF conversions (Workers AI markdown) by SHA-256 of the fetched URL; see pdf-cache.ts.
  `CREATE TABLE IF NOT EXISTS pdf_cache (
    key TEXT PRIMARY KEY, markdown TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL, used_at INTEGER NOT NULL)`,
];

// pi-do kept its conversation in tables of its own: 0.1.6 and older its turns, browser calls,
// events and memory-tool effects; then a flat message journal and stored summaries beside
// agent-core's turn tables. The conversation now lives in agent-core's branch journal
// (pi_journal_entries) like X Gardener's. pi-do is unreleased, so the old rows are dropped, not
// converted, with the turns that referred to them: such an account starts with no threads and
// keeps its account, memories and PDF cache. Removal condition: no Durable Object created by a pi-do
// with a `turns` or a flat `journal` table remains (only development deployments exist); test:
// "drops the tables of earlier pi-do versions once" in test/turns.test.ts.
const RETIRED_TABLES = ["turns", "browser_calls", "events", "tool_effects", "journal", "compactions"];
const RUNTIME_ROWS = ["agent_turns", "agent_turn_steps", "agent_function_calls", "agent_tool_receipts", "idempotency_records"];

export function migrate(storage: Storage): void {
  const tables = new Set(rows<{ name: string }>(storage, "SELECT name FROM sqlite_master WHERE type = 'table'").map(row => row.name));
  if (tables.has("turns") || tables.has("journal")) {
    for (const table of RETIRED_TABLES) storage.sql.exec(`DROP TABLE IF EXISTS ${table}`);
    for (const table of RUNTIME_ROWS) if (tables.has(table)) storage.sql.exec(`DELETE FROM ${table}`);
  }
  // The answer so far moved from pi-do's turn_partials table to agent-core's agent_turns.partial_text
  // (the table only ever held a running turn's transient text, so nothing is copied). Removal
  // condition: no Durable Object created by a pi-do with turn_partials remains (only development
  // deployments exist); test: "an account from before agent_turns.partial_text gets the column" in test/turns.test.ts.
  storage.sql.exec("DROP TABLE IF EXISTS turn_partials");
  if (tables.has("agent_turns") && !rows<{ name: string }>(storage, "PRAGMA table_info(agent_turns)").some(column => column.name === "partial_text")) {
    storage.sql.exec("ALTER TABLE agent_turns ADD COLUMN partial_text TEXT");
  }
  // Threads gained the columns a Routine and its runs use (agent-core's thread table): an account from
  // before Routines keeps its rows, each a chat. Removal condition: no Durable Object created by a
  // pi-do 0.1.9 or older remains; test: "an account from before Routines keeps its threads" in test/routines.test.ts.
  // When a side panel last claimed browser calls (a scheduled Routine run is recorded offline
  // without one). Removal condition: no Durable Object created by a pi-do 0.1.9 or older remains;
  // test: "an account from before Routines keeps its threads" in test/routines.test.ts.
  if (tables.has("account") && !rows<{ name: string }>(storage, "PRAGMA table_info(account)").some(column => column.name === "last_claim_at")) {
    storage.sql.exec("ALTER TABLE account ADD COLUMN last_claim_at INTEGER");
  }
  if (tables.has("agent_threads")) {
    const columns = new Set(rows<{ name: string }>(storage, "PRAGMA table_info(agent_threads)").map(column => column.name));
    for (const [name, definition] of THREAD_COLUMNS) if (!columns.has(name)) storage.sql.exec(`ALTER TABLE agent_threads ADD COLUMN ${name} ${definition}`);
  }
  // Threads and Routines, the alarm's jobs, long-term memory, the turn queue and the Pi journal are
  // agent-core's tables (shared with X Gardener). A thread's row is written with its first message
  // (the thread list comes from the turns) and records its deletion, which archives it.
  for (const statement of [...STATEMENTS, ...THREADS_SCHEMA, ...ALARM_JOBS_SCHEMA, ...RUNTIME_SCHEMA, ...PI_JOURNAL_SCHEMA, ...MEMORY_SCHEMA]) storage.sql.exec(statement);
}

export function rows<T>(storage: Storage, query: string, ...bindings: unknown[]): T[] {
  return storage.sql.exec(query, ...bindings).toArray() as T[];
}

export function one<T>(storage: Storage, query: string, ...bindings: unknown[]): T | null {
  return rows<T>(storage, query, ...bindings)[0] ?? null;
}

export function run(storage: Storage, query: string, ...bindings: unknown[]): void {
  storage.sql.exec(query, ...bindings).toArray();
}
