// End-to-end smoke in a disposable headless Chrome for Testing profile, entirely local:
//   fixture page server  <-  extension (built from dist/extension, loaded over CDP)
//   extension side panel ->  `wrangler dev` Worker + AccountDO  ->  scripted fake model server
//                                     PDF reads              ->  fake toMarkdown converter
// Nothing reaches Cloudflare or OpenRouter. Usage: npm run build:extension && node scripts/smoke-chrome.ts
// CHROME_BINARY overrides the browser (default: Playwright's Chrome for Testing, else Google Chrome).
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { makePdf } from "../test/fixtures/pdf.ts";
import { VISION_MODEL_NAME, modelProfile } from "../src/config.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(join(tmpdir(), "pi-do-smoke-"));
const children: ChildProcess[] = [];
const servers: Server[] = [];
const BOOTSTRAP_SECRET = "smoke-bootstrap-secret";

// ---------------------------------------------------------------- local servers

function listen(server: Server): Promise<number> {
  servers.push(server);
  return new Promise(resolve => server.listen(0, "127.0.0.1", () => resolve((server.address() as { port: number }).port)));
}

async function readBody(request: IncomingMessage): Promise<string> {
  let body = "";
  for await (const chunk of request) body += chunk;
  return body;
}

type ChatMessage = { role: string; content: unknown };
const textOf = (content: unknown): string => typeof content === "string" ? content
  : Array.isArray(content) ? content.map(part => (part as { text?: string }).text ?? "").join("") : "";

// Measured through the fake model: from sending a tool call to receiving its result (this
// includes the claim, which waits on the Worker for the call, and the click's 500 ms settle).
const metrics: { backgroundClickMs?: number } = {};
// The code runs' round trips (run_code calls of the "Compute with code" turn), in order.
const codeRunMs: number[] = [];
let codeSentAt = 0;
let clickSentAt = 0;
// The "Wait for my signal" task browses until the smoke releases it (after a cancel, for the retry).
let released = false;

// The scripted model: a fixed tool plan per task, keyed by the user's words, reading refs
// from the extension's real snapshots.
function plan(messages: ChatMessage[], request: { model?: string; reasoning?: { effort?: string } } = {}): { tool?: Record<string, unknown>; call?: { name: string; args: Record<string, unknown> }; text?: string; delayMs?: number } {
  // The user's request is the last message with its tab context; the runtime's own notices (the
  // budget line after every request, the resume event) are user-role messages too.
  const lastUser = messages.findLastIndex(message => message.role === "user" && textOf(message.content).includes("<browser_context"));
  const user = textOf(messages[lastUser].content);
  const tabId = Number(user.match(/tabId="(\d+)"/)?.[1]);
  const tools = messages.slice(lastUser + 1).filter(message => message.role === "tool").map(message => textOf(message.content));
  const ref = (name: string) => tools.at(-1)?.match(new RegExp(`button "${name}" \\[ref=(e\\d+)\\]`))?.[1];
  const refIn = (text: string | undefined, role: string, name: string) => text?.match(new RegExp(`${role} "${name}" \\[ref=(e\\d+)\\]`))?.[1];
  const opened = Number(tools[0]?.match(/Opened tabId=(\d+)/)?.[1]);
  if (/Also say banana/.test(user)) {
    // A steer merged into the running "Count slowly" turn: the model sees it as the latest request.
    return { text: messages.some(message => message.role === "user" && /Count slowly/.test(textOf(message.content))) ? "Steered: banana." : "Steer without its turn." };
  }
  if (/Count slowly/.test(user)) {
    return tools.length < 3 ? { tool: { action: "snapshot", tabId, filter: "Count" }, delayMs: 1_200 } : { text: "Not steered." };
  }
  if (/Wait for my signal/.test(user)) {
    return released ? { text: "Finished after retry." } : { tool: { action: "snapshot", tabId, filter: "Count" }, delayMs: 1_500 };
  }
  if (/Remember that I sign off/.test(user)) {
    // Long-term memory: the agent saves a standing instruction; it waits for the user's confirmation.
    return tools.length === 0 ? { call: { name: "remember", args: { kind: "instruction", content: "End every answer with: Ciao." } } }
      : { text: /confirms it in Memory/.test(tools[0]) ? "Remembered." : `Not remembered: ${tools[0]}` };
  }
  if (/Routine check/.test(user)) {
    // A Routine run: its first message is the Routine's prompt, about no tab; it opens the page and reads it.
    const url = user.match(/read (http:\/\/\S+\/) and/)![1];
    return [
      { tool: { action: "open", url } },
      { tool: { action: "read_text", tabId: opened } },
    ][tools.length] ?? { text: user.includes("no tab selected") ? `Routine read: ${tools[1]?.match(/Count: \d+/)?.[0] ?? "nothing"}.` : "Routine with a tab." };
  }
  if (/Compute with code/.test(user)) {
    // run_code in the extension's code sandbox: a bash pipeline over a file of the request (its shell
    // Worker downloaded from the local Worker's static assets and checked against the pinned hash),
    // a JS computation that also probes for the network and the extension API, a busy loop stopped
    // at the deadline, and a second bash run after it (the verified shell reused, no download).
    const probe = `${user.match(/(http:\/\/127\.0\.0\.1:\d+\/)/)![1]}sandbox-probe`;
    // Each run's round trip as the model sees it: from sending the call to receiving its result.
    if (tools.length > codeRunMs.length) codeRunMs.push(Date.now() - codeSentAt);
    codeSentAt = Date.now();
    return [
      { call: { name: "run_code", args: { language: "bash", files: { "words.txt": "pear\napple\npear\nfig\napple\npear\n" },
        code: "sort words.txt | uniq -c | sort -rn | awk '{print $2 \"=\" $1}' | paste -sd, -; echo total=$(wc -l < words.txt); command -v curl || echo no-curl" } } },
      { call: { name: "run_code", args: { code: `console.log("summing");
const sum = Array.from({ length: 100 }, (_, i) => i + 1).reduce((a, b) => a + b, 0);
const globals = ["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "indexedDB", "chrome"].filter(name => typeof globalThis[name] !== "undefined");
let network;
try { await fetch(${JSON.stringify(probe)}); network = "open"; } catch (error) { network = error.name; }
let xhr;
try { const request = new XMLHttpRequest(); request.open("GET", ${JSON.stringify(probe)}, false); request.send(); xhr = "open"; } catch (error) { xhr = error.name; }
return { sum, network, xhr, globals, origin: self.origin };` } } },
      { call: { name: "run_code", args: { code: "console.log('spinning'); while (true) {}" } } },
      { call: { name: "run_code", args: { language: "bash", code: "echo $((6 * 7))" } } },
    ][tools.length] ?? { text: `Code result: ${tools.map(result => result.replace(/\s+/g, " ")).join(" ¦ ")}` };
  }
  if (/Which tab is this about/.test(user)) {
    // The tab picker's choice, as the Worker put it in the request's tab context.
    return { text: user.includes("no tab selected") ? "Tab context: none." : `Tab context: ${tabId}.` };
  }
  if (/Describe the attached images/.test(user)) {
    // The images the user pasted and dropped arrive in the same user message as its text, as data URLs.
    const parts = Array.isArray(messages[lastUser].content) ? messages[lastUser].content as { type: string; image_url?: { url: string } }[] : [];
    const images = parts.filter(part => part.type === "image_url").map(part => part.image_url?.url.match(/^data:(image\/[a-z]+);base64,[A-Za-z0-9+/]+=*$/)?.[1] ?? "not a data URL");
    return { text: `Images seen: ${images.length} (${images.join(", ")}) by ${request.model} at ${request.reasoning?.effort ?? "no"} reasoning.` };
  }
  if (/Say hello/.test(user)) {
    // A new chat: the confirmed instruction is in the system prompt.
    const system = textOf(messages.find(message => message.role === "system")?.content);
    return { text: system.includes("End every answer with: Ciao.") ? "Hello. Ciao." : "Hello without the instruction." };
  }
  if (/Fill the frames/.test(user)) {
    // A same-origin iframe, a cross-site (out-of-process) iframe with a closed shadow root, and a
    // same-process iframe nested inside it: snapshot refs reach all three, and actions land there.
    const url = user.match(/(http:\/\/\S+\/frames\.html)/)![1];
    const checks = () => ({
      refs: Boolean(refIn(tools[1], "button", "Shadow click") && refIn(tools[1], "textbox", "Username") && refIn(tools[1], "textbox", "First name")),
      clicked: /^Clicked button "Shadow click"/.test(tools[2]),
      typed: /^Typed 9 characters/.test(tools[3]) && /^Typed 5 characters/.test(tools[4]),
      values: /textbox "Username" \[ref=e\d+\][^\n]*: stagehand/.test(tools[5]) && /textbox "First name" \[ref=e\d+\][^\n]*: nunya/.test(tools[5]),
      text: /Shadow clicked/.test(tools[6]) && /Inner typed nunya/.test(tools[6]) && /--- iframe http:\/\/localhost:\d+\/frame-oopif\.html ---/.test(tools[6]),
      // Elements made clickable only by a script-assigned onclick, in both kinds of iframe.
      scriptClickables: /^Clicked clickable "Script card"/.test(tools[7]) && /^Clicked clickable "Inner card"/.test(tools[8])
        && /Script card clicked/.test(tools[10]) && /Inner card clicked/.test(tools[10]),
      // A covered control is reported, and the click does not land on the overlay.
      occluded: /TARGET_OBSCURED|covered by <div role=dialog>/.test(tools[9]) && !/Covered clicked/.test(tools[10]),
    });
    return [
      { tool: { action: "open", url } },
      { tool: { action: "snapshot", tabId: opened } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "button", "Shadow click") ?? "e999" } },
      { tool: { action: "type", tabId: opened, ref: refIn(tools[1], "textbox", "Username") ?? "e999", text: "stagehand" } },
      { tool: { action: "type", tabId: opened, ref: refIn(tools[1], "textbox", "First name") ?? "e999", text: "nunya" } },
      { tool: { action: "snapshot", tabId: opened } },
      { tool: { action: "read_text", tabId: opened } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "clickable", "Script card") ?? "e999" } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "clickable", "Inner card") ?? "e999" } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "button", "Covered button") ?? "e999" } },
      { tool: { action: "read_text", tabId: opened } },
    ][tools.length] ?? { text: Object.values(checks()).every(Boolean) ? "Frames ok."
      : `Frames failed: ${JSON.stringify(checks())} ${JSON.stringify(tools.map(text => text.slice(0, 1500)))}` };
  }
  if (/Find the missing puzzle/.test(user)) {
    // Guessed addresses that do not exist (the chess test's loop): each failed tab is closed, and
    // after three failed pages the next open is refused before it reaches the browser.
    const base = user.match(/(http:\/\/127\.0\.0\.1:\d+)/)![1];
    const checks = () => ({
      failed: tools.slice(0, 3).every(text => /PAGE_LOAD_FAILED: \S+missing-\w\.png: HTTP 404.*The tab was closed/.test(text)),
      refused: /Not run: 3 pages/.test(tools[3] ?? ""),
      closed: Boolean(tools[4]) && !/missing-/.test(tools[4]),
    });
    return [
      ...["a", "b", "c", "d"].map(name => ({ tool: { action: "open", url: `${base}/missing-${name}.png` } })),
      { tool: { action: "tabs" } },
    ][tools.length] ?? { text: Object.values(checks()).every(Boolean) ? "Guessing stopped ok."
      : `Guessing failed: ${JSON.stringify(checks())} ${JSON.stringify(tools.map(text => text.slice(0, 400)))}` };
  }
  if (/Choose Canada/.test(user)) {
    // A custom dropdown whose trigger is a div with cursor:pointer: it gets a "clickable" ref.
    const url = user.match(/(http:\/\/\S+\/dropdown\.html)/)![1];
    return [
      { tool: { action: "open", url } },
      { tool: { action: "snapshot", tabId: opened } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "clickable", "Select a country") ?? "e999" } },
      { tool: { action: "snapshot", tabId: opened } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[3], "option", "Canada") ?? "e999" } },
      { tool: { action: "select", tabId: opened, ref: refIn(tools[3], "combobox", "Size") ?? "e999", option: "Large" } },
      { tool: { action: "read_text", tabId: opened } },
    ][tools.length] ?? { text: /Chosen: Canada/.test(tools[6]) && /Size l/.test(tools[6]) ? "Dropdown ok." : `Dropdown failed: ${JSON.stringify(tools)}` };
  }
  if (/Scroll the members/.test(user)) {
    // X's List members modal: the document is scroll-locked, so a scroll moves the dialog's list by
    // most of its own height (not the timeline behind it, not past unseen members).
    const url = user.match(/(http:\/\/\S+\/members\.html)/)![1];
    const moved = (text: string | undefined) => text?.match(/^Scrolled div in dialog "List members" down\. scrollY=(\d+) of \d+ \(viewport (\d+)\)/)?.slice(1).map(Number) ?? [-1, 0];
    const [first, height] = moved(tools[1]);
    return [
      { tool: { action: "open", url } },
      { tool: { action: "scroll", tabId: opened, direction: "down" } },
      { tool: { action: "scroll", tabId: opened, direction: "down" } },
    ][tools.length] ?? { text: first > height / 2 && first < height && moved(tools[2])[0] === 2 * first
      ? "Members scroll ok." : `Members scroll failed: ${JSON.stringify(tools)}` };
  }
  if (/Remove members/.test(user)) {
    // X's List members (live 2026-10-10): member 12's button is under the list's sticky header, and
    // member 30 has to be scrolled to while the list's cells take no pointer events. Both land.
    const url = user.match(/(http:\/\/\S+\/members\.html\?under=12)/)![1];
    return [
      { tool: { action: "open", url } },
      { tool: { action: "snapshot", tabId: opened, interactive: true } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "button", "Remove Member 12") ?? "e999" } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "button", "Remove Member 30") ?? "e999" } },
      { tool: { action: "read_text", tabId: opened } },
    ][tools.length] ?? { text: /Removed: 12, 30/.test(tools[4] ?? "") ? "Members removed ok." : `Members removed failed: ${JSON.stringify(tools.slice(2).map(text => text.slice(0, 600)))}` };
  }
  if (/Open the details/.test(user)) {
    // A click in a background tab the agent opened, which opens another tab.
    const url = user.match(/(http:\/\/\S+\/newtab\.html)/)![1];
    if (tools.length === 3 && clickSentAt) { metrics.backgroundClickMs = Date.now() - clickSentAt; clickSentAt = 0; }
    const step = [
      { tool: { action: "open", url } },
      { tool: { action: "snapshot", tabId: opened, interactive: true } },
      { tool: { action: "click", tabId: opened, ref: refIn(tools[1], "button", "Open details") ?? "e999" } },
    ][tools.length];
    if (tools.length === 2) clickSentAt = Date.now();
    return step ?? { text: /new tab tabId=\d+ "Details page" http:\/\/127\.0\.0\.1:\d+\/details\.html/i.test(tools[2] ?? "")
      ? "New tab ok." : `New tab failed: ${tools[2]}` };
  }
  if (/Put the details page here/.test(user)) {
    // With "This window" chosen in Settings, `open` puts the tab in the panel's window.
    const url = user.match(/(http:\/\/\S+\/details\.html)/)![1];
    return tools.length === 0 ? { tool: { action: "open", url } } : { text: `Opened here: ${opened}.` };
  }
  if (/PDF/.test(user)) {
    // Open a PDF at #page=2, read it, try a click (refused), navigate to #page=3 (the viewer
    // detaches the debugger), read again; the answer reports what each step returned.
    const url = user.match(/(http:\/\/\S+\.pdf)/)![1];
    const checks = () => ({
      fromPage2: /--- page 2 ---\nBeta method/.test(tools[1]) && !/Alpha opening/.test(tools[1]),
      clickRefused: /PDF_VIEWER_INPUT|Nothing was sent/.test(tools[2]),
      navigated: tools[3].includes(`Navigated tabId=${opened}`),
      fromPage3: /--- page 3 ---\nGamma results/.test(tools[4]) && !/Beta method/.test(tools[4]),
      reread: tools[5] === tools[4],
    });
    return [
      { tool: { action: "open", url: `${url}#page=2` } },
      { tool: { action: "read_text", tabId: opened } },
      { tool: { action: "click", tabId: opened, ref: "e1" } },
      { tool: { action: "navigate", tabId: opened, url: `${url}?copy=2#page=3` } },
      { tool: { action: "read_text", tabId: opened } },
      { tool: { action: "read_text", tabId: opened } },
    ][tools.length] ?? { text: Object.values(checks()).every(Boolean) ? "PDF ok."
      : `PDF failed: ${JSON.stringify(checks())} ${JSON.stringify(tools.map(text => text.slice(0, 300)))}` };
  }
  if (/increment/i.test(user)) {
    return [
      { tool: { action: "snapshot", tabId } },
      { tool: { action: "click", tabId, ref: ref("Increment") } },
      { tool: { action: "snapshot", tabId, filter: "Count" } },
      { text: `The counter now reads: ${tools.at(-1)?.match(/Count: \d+/)?.[0] ?? "unknown"}` },
    ][tools.length] ?? { text: "done" };
  }
  return [
    { tool: { action: "snapshot", tabId, interactive: true } },
    { tool: { action: "click", tabId, ref: ref("Send message") } },
    { tool: { action: "read_text", tabId } },
    { text: /Message sent/.test(tools.at(-1) ?? "") ? "Message sent." : `Not sent: ${tools.at(-1)}` },
  ][tools.length] ?? { text: "done" };
}

function fakeModel(): Server {
  return createServer(async (request, response) => {
    const body = JSON.parse(await readBody(request) || "{}") as { messages: ChatMessage[]; model?: string; reasoning?: { effort?: string } };
    const step = plan(body.messages ?? [], body);
    if (step.delayMs) await sleep(step.delayMs);
    const chunk = (delta: unknown, finish: string | null, usage?: unknown) =>
      `data: ${JSON.stringify({ id: "smoke", object: "chat.completion.chunk", created: 0, model: "smoke",
        choices: [{ index: 0, delta, finish_reason: finish }], ...(usage ? { usage } : {}) })}\n\n`;
    // `cost` as OpenRouter reports what it billed: the Worker counts it toward the turn's spend ceiling.
    const usage = { prompt_tokens: 100, completion_tokens: 20, total_tokens: 120, cost: 0.0001 };
    response.writeHead(200, { "Content-Type": "text/event-stream" });
    if (step.tool || step.call) {
      response.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${Date.now()}`, type: "function",
        function: { name: step.call?.name ?? "browser", arguments: JSON.stringify(step.call?.args ?? step.tool) } }] }, null));
      response.write(chunk({}, "tool_calls", usage));
    } else {
      response.write(chunk({ role: "assistant", content: step.text }, null));
      response.write(chunk({}, "stop", usage));
    }
    response.end("data: [DONE]\n\n");
  });
}

// Serves the fixtures. Two of these run: the second is reached as http://localhost:<port>, another
// site than 127.0.0.1, so Chrome puts its iframe in another process (an OOPIF).
const PAGES: Record<string, string> = {
  "/frames.html": "frames-page.html", "/frame-inner.html": "frame-inner.html", "/frame-oopif.html": "frame-oopif.html",
  "/frame-nested.html": "frame-nested.html", "/newtab.html": "newtab-page.html", "/details.html": "details-page.html",
  "/dropdown.html": "dropdown-page.html", "/members.html": "scroll-modal-page.html",
};
let sandboxProbes = 0;
function fixtureServer(otherOrigin: () => string): Server {
  const pdf = makePdf(["Alpha opening", "Beta method", "Gamma results"]);
  return createServer((request, response) => {
    const path = new URL(request.url ?? "/", "http://fixture").pathname;
    // A request the code sandbox must never make.
    if (path === "/sandbox-probe") sandboxProbes++;
    if (path === "/paper.pdf") { response.writeHead(200, { "Content-Type": "application/pdf" }); response.end(pdf); return; }
    if (path.startsWith("/missing-")) { response.writeHead(404, { "Content-Type": "text/html" }); response.end("<h1>File not found</h1>"); return; }
    const page = readFileSync(join(root, "test/fixtures", PAGES[path] ?? "smoke-page.html"), "utf8").replaceAll("{{OTHER_ORIGIN}}", otherOrigin());
    response.writeHead(200, { "Content-Type": "text/html" }); response.end(page);
  });
}

// Workers AI toMarkdown stand-in: wrangler dev has no local Workers AI, so the Worker POSTs the PDF
// here (PDF_TEST_CONVERTER_URL). It answers in toMarkdown's PDF layout, one "### Page N" per page,
// from the fixture PDF's text operators.
let conversions = 0;
function fakeConverter(): Server {
  return createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(chunk as Buffer);
    const pdf = Buffer.concat(chunks).toString("latin1");
    conversions++;
    const pages = [...pdf.matchAll(/\((.*?)\) Tj/g)].map((match, index) => `### Page ${index + 1}\n${match[1]}`);
    const data = pdf.startsWith("%PDF-") ? `# document.pdf\n## Metadata\n- PDFFormatVersion=1.4\n\n## Contents\n${pages.join("\n")}` : "";
    response.writeHead(200, { "Content-Type": "application/json" });
    response.end(JSON.stringify([{ name: "document.pdf", format: data ? "markdown" : "error", ...(data ? { data } : { error: "not a PDF" }) }]));
  });
}

async function startWorker(modelPort: number, converterPort: number, workerPort: number): Promise<void> {
  // The generated config without its Workers AI binding: binding it would make wrangler dev reach Cloudflare.
  const config = JSON.parse(readFileSync(join(root, "wrangler.jsonc"), "utf8").replace(/^\/\/.*\n/, ""));
  delete config.ai;
  delete config.$schema;
  // The copy lives in the scratch directory: its paths are made absolute, and Pi is staged from here.
  config.main = join(root, config.main);
  config.base_dir = join(root, config.base_dir);
  config.assets = { ...config.assets, directory: join(root, config.assets.directory) };
  for (const name of Object.keys(config.alias)) config.alias[name] = join(root, config.alias[name]);
  config.build = { ...config.build, cwd: root, watch_dir: config.build.watch_dir.map((dir: string) => join(root, dir)) };
  writeFileSync(join(scratch, "wrangler.smoke.json"), JSON.stringify(config));
  const child = spawn(join(root, "node_modules/.bin/wrangler"), ["dev", "--config", join(scratch, "wrangler.smoke.json"),
    "--port", String(workerPort), "--ip", "127.0.0.1",
    "--persist-to", join(scratch, "state"), "--show-interactive-dev-session=false",
    "--var", `MODEL_BASE_URL:http://127.0.0.1:${modelPort}/v1`, "--var", "OPENROUTER_API_KEY:smoke-fake-key",
    "--var", `BOOTSTRAP_SECRET:${BOOTSTRAP_SECRET}`, "--var", `PDF_TEST_CONVERTER_URL:http://127.0.0.1:${converterPort}/convert`],
  { cwd: root, stdio: ["ignore", "pipe", "pipe"] });
  children.push(child);
  let log = "";
  child.stdout!.on("data", chunk => { log += chunk; });
  child.stderr!.on("data", chunk => { log += chunk; });
  for (let i = 0; i < 120; i++) {
    try { if ((await fetch(`http://127.0.0.1:${workerPort}/api/health`)).ok) return; } catch { /* starting */ }
    await sleep(500);
  }
  throw new Error(`wrangler dev did not start:\n${log.slice(-3000)}`);
}

// ---------------------------------------------------------------- Chrome over CDP

// A complete Chrome for Testing app: its framework binary must be present (partial caches exist).
function completeApp(app: string): string | null {
  const binary = join(app, "Contents/MacOS/Google Chrome for Testing");
  const versions = join(app, "Contents/Frameworks/Google Chrome for Testing Framework.framework/Versions");
  if (!existsSync(binary) || !existsSync(versions)) return null;
  return readdirSync(versions).some(version => existsSync(join(versions, version, "Google Chrome for Testing Framework"))) ? binary : null;
}

function chromeBinary(): string {
  if (process.env.CHROME_BINARY) return process.env.CHROME_BINARY;
  const apps: string[] = [];
  const browsers = join(homedir(), ".agent-browser/browsers");
  if (existsSync(browsers)) for (const dir of readdirSync(browsers)) apps.push(join(browsers, dir, "Google Chrome for Testing.app"));
  const playwright = join(homedir(), "Library/Caches/ms-playwright");
  if (existsSync(playwright)) for (const dir of readdirSync(playwright)) apps.push(join(playwright, dir, "chrome-mac-arm64/Google Chrome for Testing.app"));
  for (const app of apps.sort().reverse()) { const binary = completeApp(app); if (binary) return binary; }
  return "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";
}

async function startChrome() {
  const child = spawn(chromeBinary(), ["--headless=new", "--remote-debugging-port=0", "--enable-unsafe-extension-debugging",
    `--user-data-dir=${join(scratch, "profile")}`, "--no-first-run", "--disable-background-networking", "about:blank"], { stdio: ["ignore", "ignore", "pipe"] });
  children.push(child);
  const endpoint = await new Promise<string>((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`Chrome did not start: ${output.slice(-1000)}`)), 15_000);
    child.stderr!.on("data", chunk => {
      output += chunk;
      const match = output.match(/DevTools listening on (ws:\/\/\S+)/);
      if (match) { clearTimeout(timer); resolve(match[1]); }
    });
  });
  const socket = new WebSocket(endpoint);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  let sequence = 0;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  socket.onmessage = event => {
    const message = JSON.parse(String(event.data));
    const waiter = pending.get(message.id);
    if (!waiter) return;
    pending.delete(message.id);
    if (message.error) waiter.reject(new Error(message.error.message)); else waiter.resolve(message.result);
  };
  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) => new Promise<any>((resolve, reject) => {
    const id = ++sequence;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  return { send, close: () => socket.close() };
}

// ---------------------------------------------------------------- the scenario

async function main(): Promise<void> {
  const extension = join(root, "dist/extension");
  if (!existsSync(join(extension, "manifest.json"))) throw new Error("run `npm run build:extension` first");
  const modelPort = await listen(fakeModel());
  let otherPort = 0;
  const fixturePort = await listen(fixtureServer(() => `http://localhost:${otherPort}`));
  otherPort = await listen(fixtureServer(() => `http://127.0.0.1:${fixturePort}`));
  const converterPort = await listen(fakeConverter());
  const workerPort = 8700 + Math.floor(Math.random() * 200);
  await startWorker(modelPort, converterPort, workerPort);
  console.log(`worker on :${workerPort}, fake model on :${modelPort}, fixture on :${fixturePort}, fake toMarkdown on :${converterPort}`);

  const chrome = await startChrome();
  const { id } = await chrome.send("Extensions.loadUnpacked", { path: extension });
  const fixture = await chrome.send("Target.createTarget", { url: `http://127.0.0.1:${fixturePort}/` });
  const fixtureSession = (await chrome.send("Target.attachToTarget", { targetId: fixture.targetId, flatten: true })).sessionId;
  await sleep(500);
  const panel = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/panel.html`, newWindow: true });
  const panelSession = (await chrome.send("Target.attachToTarget", { targetId: panel.targetId, flatten: true })).sessionId;
  const evaluate = async (session: string, expression: string) => {
    const result = await chrome.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
    return result.result.value;
  };
  const waitFor = async (description: string, expression: string, session = panelSession, timeoutMs = 60_000) => {
    for (const started = Date.now(); Date.now() - started < timeoutMs; await sleep(300)) {
      try { if (await evaluate(session, expression)) return; } catch { /* page loading */ }
    }
    throw new Error(`timed out waiting for ${description}; panel text: ${await evaluate(panelSession, "document.body.innerText").catch(() => "?")}`);
  };

  // React owns the fields: a value is set through the element's native setter and an input event.
  const FILL = "const fill = (element, value) => { Object.getOwnPropertyDescriptor(Object.getPrototypeOf(element), 'value').set.call(element, value); element.dispatchEvent(new Event('input', { bubbles: true })); };";
  // Settings is in the header's "…" menu at the right.
  const OPEN_SETTINGS = "document.querySelector('[data-more-trigger]').click(); document.querySelector('.chat-panel-more [data-view=settings]').click()";
  await waitFor("panel", "!!document.getElementById('connect-form')");
  const header = await evaluate(panelSession, "[...document.querySelector('.chat-panel-header').children].map(child => child.querySelector('#chats') ? 'chat' : child.matches('details') ? 'more:' + [...child.querySelectorAll('[data-view]')].map(item => item.textContent).join(',') : '?')");
  if (JSON.stringify(header) !== JSON.stringify(["chat", "more:Routine,Settings"])) throw new Error(`the header is not [Chat ... More(Routine, Settings)]: ${JSON.stringify(header)}`);
  console.log("PASS header: one header, the Chat control at the top left and Routine and Settings in the … menu at the right");
  await evaluate(panelSession, `(async () => {
    ${FILL}
    fill(document.getElementById('worker-url'), 'http://127.0.0.1:${workerPort}');
    fill(document.getElementById('bootstrap-secret'), ${JSON.stringify(BOOTSTRAP_SECRET)});
    await new Promise(resolve => setTimeout(resolve, 50));
    document.getElementById('connect-form').requestSubmit();
  })()`);
  await waitFor("account", "document.getElementById('account').textContent.includes('acct_')");
  console.log("PASS bootstrap: the panel created an account with the bootstrap secret");

  await waitFor("the chat", "!!document.querySelector('.chat-composer textarea')");
  const sendMessage = (text: string) => evaluate(panelSession, `(async () => {
    ${FILL}
    fill(document.querySelector('.chat-composer textarea'), ${JSON.stringify(text)});
    await new Promise(resolve => setTimeout(resolve, 50));
    document.querySelector('.chat-composer').requestSubmit();
  })()`);
  const transcript = "document.querySelector('.chat-messages').innerText";
  const clickButton = (label: string) => evaluate(panelSession, `(() => {
    const button = [...document.querySelectorAll('button')].find(item => item.textContent === ${JSON.stringify(label)} || item.getAttribute('aria-label') === ${JSON.stringify(label)});
    if (!button) throw new Error('no button ' + ${JSON.stringify(label)});
    button.click();
  })()`);
  await sendMessage("Click the Increment button once and tell me the count.");
  await waitFor("the counter answer", "document.querySelector('.chat-messages').innerText.includes('The counter now reads: Count: 1')");
  if (await evaluate(fixtureSession, "document.getElementById('count').textContent") !== "Count: 1") throw new Error("the fixture page was not clicked");
  console.log("PASS read-act-verify: snapshot -> click by ref -> filtered snapshot, page shows Count: 1");

  await sendMessage("Count slowly to three on this page.");
  await waitFor("the running turn", `/Working|snapshot/.test(${transcript})`);
  await sendMessage("Also say banana.");
  await waitFor("the steered answer", `/Steered: banana\\.|Not steered\\.|Steer without/.test(${transcript})`, panelSession, 60_000);
  const steered = await evaluate(panelSession, transcript);
  if (!/Steered: banana\./.test(steered) || /Not steered/.test(steered)) throw new Error(`the steer did not reach the running turn: ${steered.slice(-600)}`);
  // The panel marks the steer as delivered to the running task and shows the answer after it.
  await waitFor("the steer's delivered note", `/Also say banana\\.[\\s\\S]*Added to the running task[\\s\\S]*Steered: banana\\./.test(${transcript})`, panelSession, 30_000);
  console.log("PASS steer: a message sent while the turn ran was merged into it, marked as added to the running task, and the turn's answer follows it");

  // The panel at a side panel's widths, saved when SMOKE_SCREENSHOT_DIR is set.
  const shoot = async (name: string, width: number) => {
    await chrome.send("Emulation.setDeviceMetricsOverride", { width, height: 760, deviceScaleFactor: 1, mobile: false }, panelSession);
    await sleep(300);
    const shot = await chrome.send("Page.captureScreenshot", { format: "png" }, panelSession);
    writeFileSync(join(process.env.SMOKE_SCREENSHOT_DIR!, `pi-do-after-${width}-${name}.png`), Buffer.from(shot.data, "base64"));
  };
  await sendMessage("Wait for my signal on this page.");
  await waitFor("the Stop button", "[...document.querySelectorAll('button')].some(button => button.getAttribute('aria-label') === 'Stop')");
  await sleep(1_000);
  // Stop joins the composer's row: Send stays beside it at a side panel's narrowest width.
  await chrome.send("Emulation.setDeviceMetricsOverride", { width: 360, height: 760, deviceScaleFactor: 1, mobile: false }, panelSession);
  await sleep(300);
  const composerRows = await evaluate(panelSession, "new Set([...document.querySelectorAll('.chat-composer > *')].map(node => Math.round(node.getBoundingClientRect().top + node.getBoundingClientRect().height / 2))).size");
  if (composerRows !== 1) throw new Error(`the composer wraps with Stop shown: ${composerRows} rows`);
  if (process.env.SMOKE_SCREENSHOT_DIR) for (const width of [400, 380, 360]) await shoot("stop", width);
  await chrome.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
  console.log("PASS composer: with Stop shown, the message box, Stop and Send share one row at 360 px");
  await clickButton("Stop");
  await waitFor("the stopped turn with Retry", "[...document.querySelectorAll('.chat-state.is-error button')].some(button => button.textContent === 'Retry')");
  const stopped = await evaluate(panelSession, "document.querySelector('.chat-state.is-error').innerText");
  if (!/TURN_CANCELLED/.test(stopped)) throw new Error(`the stopped turn does not say it was cancelled: ${stopped}`);
  console.log("PASS cancel: Stop cancelled the running turn and its open browser call; the turn offers Retry");
  released = true;
  await clickButton("Retry");
  await waitFor("the retried answer", `/Finished after retry\\./.test(${transcript})`, panelSession, 60_000);
  console.log("PASS retry: Retry ran the cancelled turn again on a new budget and it answered");

  await sendMessage("Send the message in the form.");
  await waitFor("the confirmation card", "!!document.getElementById('confirm')");
  const reason = await evaluate(panelSession, "document.getElementById('confirm-reason').textContent");
  if (await evaluate(fixtureSession, "document.getElementById('sent').textContent") !== "Not sent") throw new Error("the form was submitted before confirmation");
  console.log(`PASS confirmation seam: the panel asked "${reason}" and nothing was sent yet`);
  await evaluate(panelSession, "document.getElementById('confirm-allow').click()");
  await waitFor("the sent answer", "document.querySelector('.chat-messages').innerText.includes('Message sent.')");
  if (await evaluate(fixtureSession, "document.getElementById('sent').textContent") !== "Message sent") throw new Error("the form was not submitted after approval");
  console.log("PASS approved action: the form was submitted only after Allow once");

  await sendMessage(`Read the PDF at http://127.0.0.1:${fixturePort}/paper.pdf from page 2.`);
  await waitFor("the PDF answer", "/PDF (ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  const pdfAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/PDF (ok|failed).*/s)[0]");
  if (!pdfAnswer.startsWith("PDF ok")) throw new Error(pdfAnswer);
  // Three reads of two URLs: the re-read is served from the account's conversion cache.
  if (conversions !== 2) throw new Error(`expected the Worker to convert the PDF twice (the re-read from its cache), saw ${conversions}`);
  console.log("PASS PDF viewer: open at #page=2 -> read_text (Worker fetch + toMarkdown stand-in) from page 2 with markers -> click refused unsent -> navigate to #page=3 despite the viewer's detach -> read_text from page 3 -> the same read again from the account's conversion cache");

  await sendMessage(`Fill the frames at http://127.0.0.1:${fixturePort}/frames.html`);
  await waitFor("the frames answer", "/Frames (ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 120_000);
  const framesAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Frames (ok|failed).*/s)[0]");
  if (!framesAnswer.startsWith("Frames ok")) throw new Error(framesAnswer);
  const oopif = (await chrome.send("Target.getTargets")).targetInfos.some((target: { type: string; url: string }) => target.type === "iframe" && target.url.includes("/frame-oopif.html"));
  if (!oopif) throw new Error("the cross-site fixture iframe was not out-of-process, so the OOPIF path was not exercised");
  console.log("PASS frames: one snapshot has refs in a same-origin iframe, an out-of-process iframe (button in a closed shadow root) and a frame nested in it; click and type land there; read_text includes each frame's text; elements clickable only through a script-assigned onclick get clickable refs in both iframes; a button under a banner is reported as covered and not clicked");

  await sendMessage(`Choose Canada at http://127.0.0.1:${fixturePort}/dropdown.html`);
  await waitFor("the dropdown answer", "/Dropdown (ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  const dropdownAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Dropdown (ok|failed).*/s)[0]");
  if (!dropdownAnswer.startsWith("Dropdown ok")) throw new Error(dropdownAnswer);
  console.log('PASS custom dropdown: a div trigger with cursor:pointer gets a clickable ref; clicking it and then the option chooses Canada; select chooses a native <select> option');

  await sendMessage(`Find the missing puzzle at http://127.0.0.1:${fixturePort}/`);
  await waitFor("the guessing answer", "/Guessing (stopped ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  const guessingAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Guessing (stopped ok|failed).*/s)[0]");
  if (!guessingAnswer.startsWith("Guessing stopped ok")) throw new Error(guessingAnswer);
  console.log("PASS guessed addresses: three opens of missing files fail with HTTP 404 and close their tabs; the fourth open is refused before it reaches Chrome");

  await sendMessage(`Scroll the members at http://127.0.0.1:${fixturePort}/members.html`);
  await waitFor("the members answer", "/Members scroll (ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  const membersAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Members scroll (ok|failed).*/s)[0]");
  if (!membersAnswer.startsWith("Members scroll ok")) throw new Error(membersAnswer);
  console.log("PASS modal scroll: under a scroll-locked modal (X's List members), scroll moves the dialog's list by most of its height, twice, and says which element moved");

  await sendMessage(`Remove members at http://127.0.0.1:${fixturePort}/members.html?under=12`);
  for (const member of [12, 30]) {
    await waitFor(`the confirmation for member ${member}`, `document.getElementById('confirm-reason')?.textContent.includes('Remove Member ${member}')`, panelSession, 90_000);
    await evaluate(panelSession, "document.getElementById('confirm-allow').click()");
  }
  await waitFor("the removal answer", "/Members removed (ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  const removalAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Members removed (ok|failed).*/s)[0]");
  if (!removalAnswer.startsWith("Members removed ok")) throw new Error(removalAnswer);
  console.log("PASS modal row clicks: in X's List members, a row under the list's sticky header and a row scrolled to while the cells take no pointer events are both clicked");

  const codeStarted = Date.now();
  await sendMessage(`Compute with code the sum of 1..100 (do not touch http://127.0.0.1:${fixturePort}/).`);
  await waitFor("the code answer", "/Code result:/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  const codeResults = (await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Code result: (.*)/)[1]") as string).split(" ¦ ");
  const [bashRun, jsRun, loopRun, afterRun] = codeResults;
  const codeChecks = {
    bash: bashRun === "pear=3,apple=2,fig=1 total=6 no-curl exit status 0",
    js: /"sum":5050/.test(jsRun) && /"network":"ReferenceError"/.test(jsRun) && /"xhr":"ReferenceError"/.test(jsRun) && /"globals":\[\]/.test(jsRun)
      && /"origin":"null"/.test(jsRun) && /console: summing/.test(jsRun),
    timeout: /^run_code failed \(EXEC_TIMEOUT\)/.test(loopRun) && /console: spinning/.test(loopRun),
    after: afterRun === "42 exit status 0",
    noRequest: sandboxProbes === 0,
  };
  if (!Object.values(codeChecks).every(Boolean)) throw new Error(`run_code: ${JSON.stringify(codeChecks)} ${JSON.stringify(codeResults)}`);
  const codeSteps = await evaluate(panelSession, "[...document.querySelectorAll('.chat-turn-progress')].at(-1).textContent");
  if (!/How it worked/.test(codeSteps) || !/run_code/.test(codeSteps)) throw new Error(`run_code is not in How it worked: ${codeSteps}`);
  // The shell Worker came from the Worker's static assets, content-addressed, cacheable for good and
  // readable from the extension; the panel kept it in its Cache API under the pinned hash.
  const shellPath = readFileSync(join(root, "dist/extension/panel.js"), "utf8").match(/\/sandbox\/just-bash-[\d.]+-([0-9a-f]{64})\.js/)!;
  const asset = await fetch(`http://127.0.0.1:${workerPort}${shellPath[0]}`);
  const assetBytes = Buffer.from(await asset.arrayBuffer());
  const served = { status: asset.status, cache: asset.headers.get("cache-control"), cors: asset.headers.get("access-control-allow-origin"),
    hash: createHash("sha256").update(assetBytes).digest("hex") === shellPath[1] };
  const cachedKeys = await evaluate(panelSession, "caches.open('agent-core-code-source').then(cache => cache.keys()).then(keys => keys.map(key => key.url))");
  if (served.status !== 200 || !/immutable/.test(served.cache ?? "") || served.cors !== "*" || !served.hash
    || JSON.stringify(cachedKeys) !== JSON.stringify([`https://code-source.invalid/${shellPath[1]}.js`])) {
    throw new Error(`the shell Worker asset: ${JSON.stringify(served)}, cached ${JSON.stringify(cachedKeys)}`);
  }
  console.log(`PASS run_code: in the extension's code sandbox a bash pipeline over a request file (sort | uniq -c | awk) ran in the shell Worker loaded from the local Worker's static assets (${assetBytes.length} bytes, SHA-256 as pinned, immutable, CORS *; kept in the panel's Cache API under the hash) and a JS sum came back; the code saw no fetch, XHR, WebSocket, importScripts, indexedDB or chrome and an opaque origin; a busy loop was stopped at 10 s as EXEC_TIMEOUT with its console line, and a second bash run reused the verified shell (${Math.round((Date.now() - codeStarted) / 1000)} s)
  round trips ms (bash first run incl. download, js, loop, bash again): ${JSON.stringify(codeRunMs)}
  ${JSON.stringify(codeResults)}`);

  // The sandboxed page's own policy, apart from the runtime's removed globals: opened as a tab, it
  // has an opaque origin and no extension API, and neither it nor a Worker it starts reaches the network.
  const sandboxTab = await chrome.send("Target.createTarget", { url: `chrome-extension://${id}/code-sandbox.html` });
  const sandboxSession = (await chrome.send("Target.attachToTarget", { targetId: sandboxTab.targetId, flatten: true })).sessionId;
  await waitFor("the sandbox page", "document.readyState === 'complete'", sandboxSession);
  const policy = await evaluate(sandboxSession, `(async () => {
    const probe = "http://127.0.0.1:${fixturePort}/sandbox-probe";
    const page = await fetch(probe).then(() => "open", error => error.name);
    const worker = await new Promise(resolve => {
      const source = "fetch(" + JSON.stringify(probe) + ").then(() => postMessage('open'), error => postMessage(error.name))";
      const started = new Worker(URL.createObjectURL(new Blob([source], { type: "text/javascript" })));
      started.onmessage = event => resolve(event.data);
      started.onerror = event => resolve("error: " + event.message);
    });
    return { origin: self.origin, runtime: typeof chrome === "undefined" ? "undefined" : typeof chrome.runtime, page, worker };
  })()`);
  await chrome.send("Target.closeTarget", { targetId: sandboxTab.targetId });
  if (JSON.stringify(policy) !== JSON.stringify({ origin: "null", runtime: "undefined", page: "TypeError", worker: "TypeError" }) || sandboxProbes !== 0) {
    throw new Error(`the code sandbox page's policy: ${JSON.stringify(policy)}, probes reached the fixture: ${sandboxProbes}`);
  }
  console.log("PASS code sandbox policy: the sandboxed page has an opaque origin and no chrome.runtime, and its CSP refuses fetch from the page and from a blob Worker it starts (no request reached the fixture)");

  await sendMessage("Remember that I sign off every answer with Ciao.");
  await waitFor("the memory answer", "/Remembered\\.|Not remembered/.test(document.querySelector('.chat-messages').innerText)");
  const memoryAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/(Remembered\\.|Not remembered).*/s)[0]");
  if (!memoryAnswer.startsWith("Remembered.")) throw new Error(memoryAnswer);
  await evaluate(panelSession, OPEN_SETTINGS);
  await waitFor("Settings", "!document.getElementById('settings').hidden && document.getElementById('chat').hidden");
  await waitFor("the pending instruction in Memory", "[...document.querySelectorAll('#memory-list li.pending button')].some(b => b.textContent === 'Confirm')");
  console.log("PASS memory view: Settings lists the instruction the agent saved, waiting for the user's Confirm");
  await evaluate(panelSession, "[...document.querySelectorAll('#memory-list li.pending button')].find(b => b.textContent === 'Confirm').click()");
  await waitFor("the confirmed instruction", "!!document.querySelector('#memory-list li.confirmed')");
  // The Chat control at the top left shows the chat again and opens its thread list.
  await evaluate(panelSession, "document.getElementById('chats').click()");
  await waitFor("the thread menu", "!!document.querySelector('.chat-thread-new') && !document.getElementById('chat').hidden");
  await evaluate(panelSession, "document.querySelector('.chat-thread-new').click()");
  await sleep(300);
  await sendMessage("Say hello.");
  await waitFor("the hello answer", "/Hello/.test(document.querySelector('.chat-messages').innerText)");
  const hello = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/Hello.*/s)[0]");
  if (!hello.startsWith("Hello. Ciao.")) throw new Error(`the confirmed instruction did not reach the next chat: ${hello}`);
  console.log("PASS memory: the agent saved a standing instruction, the user confirmed it in Memory, and a new chat's prompt carries it");
  await evaluate(panelSession, "document.getElementById('chats').click()");
  await waitFor("both chats in the thread menu", "document.querySelectorAll('.chat-thread-item').length >= 2");
  const titles = await evaluate(panelSession, "[...document.querySelectorAll('.chat-thread-label strong')].map(node => node.textContent)");
  if (titles[0] !== "Say hello." || !titles.includes("Click the Increment button once and tell me the count.")) throw new Error(`thread menu: ${JSON.stringify(titles)}`);
  await evaluate(panelSession, "[...document.querySelectorAll('.chat-thread-item button')].find(button => button.textContent.includes('Click the Increment')).click()");
  await waitFor("the first chat again", `/The counter now reads/.test(${transcript})`);
  console.log("PASS threads: the menu lists both chats, newest first, titled by their first message; selecting one shows its turns");
  await evaluate(panelSession, "document.getElementById('chats').click()");
  await waitFor("the delete control of the hello chat", "!!document.querySelector('.chat-thread-delete[aria-label*=\"Say hello.\"]')");
  await evaluate(panelSession, "window.confirm = () => true; document.querySelector('.chat-thread-delete[aria-label*=\"Say hello.\"]').click()");
  await waitFor("the menu without the deleted chat", "document.querySelectorAll('.chat-thread-item').length === 1");
  const listed = await evaluate(panelSession, "chrome.storage.local.get(['workerUrl', 'token']).then(s => fetch(s.workerUrl + '/api/threads', { headers: { Authorization: 'Bearer ' + s.token } })).then(r => r.json()).then(body => body.threads.map(thread => thread.title))");
  if (listed.length !== 1 || !listed[0].startsWith("Click the Increment")) throw new Error(`the Worker still lists the deleted chat: ${JSON.stringify(listed)}`);
  await evaluate(panelSession, "document.getElementById('chats').click()");
  console.log("PASS delete: deleting a chat from the menu archives it on the Worker; the list no longer shows it");

  // The tab picker: the current tab by default; one of the window's tabs, or no tab, is what the
  // next message is about, as the Worker's request to the model shows.
  const PICKER = "document.querySelector('.tab-picker-trigger').click()";
  const OPTIONS = "[...document.querySelectorAll('.tab-picker-menu [role=menuitemradio]')]";
  const lastTabAnswer = `(${transcript}.match(/Tab context: [^.]+\\./g) || []).at(-1)`;
  await evaluate(panelSession, PICKER);
  await waitFor("the tab picker's menu", `${OPTIONS}.some(option => option.dataset.tabId)`);
  const offered = await evaluate(panelSession, `${OPTIONS}.map(option => option.querySelector('strong').textContent)`);
  if (offered[0] !== "Current tab" || offered.at(-1) !== "No tab") throw new Error(`tab picker options: ${JSON.stringify(offered)}`);
  const chosenTab = await evaluate(panelSession, `(() => { const option = ${OPTIONS}.find(item => item.dataset.tabId); option.click(); return Number(option.dataset.tabId); })()`);
  await waitFor("the chosen tab on the picker", `document.querySelector('.tab-picker-menu') === null && document.querySelector('.tab-picker-trigger').getAttribute('aria-expanded') === 'false'`);
  await sendMessage("Which tab is this about?");
  await waitFor("the chosen tab's answer", `${lastTabAnswer} === 'Tab context: ${chosenTab}.'`);
  await evaluate(panelSession, PICKER);
  await waitFor("the tab picker's menu", `${OPTIONS}.length > 0`);
  await evaluate(panelSession, `${OPTIONS}.find(option => option.querySelector('strong').textContent === 'No tab').click()`);
  await waitFor("No tab on the picker", "document.querySelector('.tab-picker-trigger').textContent === 'No tab'");
  await sendMessage("Which tab is this about?");
  await waitFor("the no-tab answer", `${lastTabAnswer} === 'Tab context: none.'`);
  await evaluate(panelSession, PICKER);
  await waitFor("the tab picker's menu", `${OPTIONS}.length > 0`);
  await evaluate(panelSession, `${OPTIONS}.find(option => option.querySelector('strong').textContent === 'Current tab').click()`);
  await waitFor("the current tab on the picker", "document.querySelector('.tab-picker-trigger').textContent.startsWith('Tab: ')");
  console.log(`PASS tab picker: the menu offers the current tab, the window's web tabs and No tab; a chosen tab (${chosenTab}) and No tab each reached the model with the next message; Current tab is restored`);

  await sendMessage(`Open the details from http://127.0.0.1:${fixturePort}/newtab.html`);
  await waitFor("the new-tab answer", "/New tab (ok|failed)/.test(document.querySelector('.chat-messages').innerText)", panelSession, 90_000);
  console.log(`click in an agent-opened tab: ${metrics.backgroundClickMs} ms from the model's tool call to its result (the claim waits on the Worker for the call; includes the click's 500 ms settle)`);
  const newTabAnswer = await evaluate(panelSession, "document.querySelector('.chat-messages').innerText.match(/New tab (ok|failed).*/s)[0]");
  if (!newTabAnswer.startsWith("New tab ok")) throw new Error(`${newTabAnswer} ${JSON.stringify(await evaluate(panelSession, "chrome.tabs.query({}).then(ts => ts.map(t => [t.id, t.openerTabId, t.url, t.active, t.windowId]))"))}`);
  console.log("PASS new tab: the click's result names the tab it opened (id, title, URL)");

  // "This window" in Settings: the next `open` lands in the panel's window, behind the tab shown
  // there; the agent's own window gets no new tab.
  const agentWindow = await evaluate(panelSession, "chrome.storage.session.get('agentWindowId').then(s => s.agentWindowId ?? null)");
  await evaluate(panelSession, OPEN_SETTINGS);
  await waitFor("Settings", "!document.getElementById('settings').hidden");
  await evaluate(panelSession, "{ const select = document.querySelector('select[name=work-window]'); select.value = 'this'; select.dispatchEvent(new Event('change', { bubbles: true })); }");
  await waitFor("the stored choice", "chrome.storage.local.get('workWindow').then(s => s.workWindow === 'this')");
  await evaluate(panelSession, "document.getElementById('chats').click(); document.getElementById('chats').click()");
  await waitFor("the chat", "!document.getElementById('chat').hidden");
  await sendMessage(`Put the details page here:http://127.0.0.1:${fixturePort}/details.html`);
  await waitFor("the open-here answer", `/Opened here: \\d+\\./.test(${transcript})`, panelSession, 60_000);
  const openedHere = Number((await evaluate(panelSession, transcript)).match(/Opened here: (\d+)\./)[1]);
  const placed = await evaluate(panelSession, `(async () => {
    const tab = await chrome.tabs.get(${openedHere});
    const panelWindow = (await chrome.windows.getCurrent()).id;
    const [shown] = await chrome.tabs.query({ windowId: panelWindow, active: true });
    return { inPanelWindow: tab.windowId === panelWindow, notAgentWindow: tab.windowId !== ${JSON.stringify(agentWindow)}, background: !tab.active,
      afterShown: tab.index === shown.index + 1, opener: tab.openerTabId === shown.id, url: tab.url };
  })()`);
  if (!placed.inPanelWindow || !placed.notAgentWindow || !placed.background || !placed.afterShown || !placed.opener || !/\/details\.html$/.test(placed.url)) {
    throw new Error(`the This-window open did not land behind the panel window's tab: ${JSON.stringify(placed)}`);
  }
  console.log(`PASS this window: with "This window" chosen in Settings, open put tab ${openedHere} in the panel's window right after its shown tab (opener set), in the background, not in the agent's window`);
  // Routines: create one in the Routine view (… menu), Run now; the run opens as a chat, reads the
  // fixture page with no tab given, completes, and is listed in the Chat list under its Routine's name.
  const OPEN_ROUTINES = "document.querySelector('[data-more-trigger]').click(); document.querySelector('.chat-panel-more [data-view=routines]').click()";
  await evaluate(panelSession, OPEN_ROUTINES);
  await waitFor("the Routine view", "!document.getElementById('routines').hidden && !!document.querySelector('#routines [data-routine-create]')");
  await evaluate(panelSession, "document.querySelector('#routines [data-routine-create]').click()");
  await waitFor("the new Routine's form", "!!document.querySelector('#routines [data-routine-form]')");
  const permissionLabels = await evaluate(panelSession, "[...document.querySelectorAll('#routines .chat-routine-allowed .chat-row-label')].map(node => node.textContent)");
  const allowed = await evaluate(panelSession, "[...document.querySelectorAll('#routines .chat-routine-allowed input')].map(input => input.checked)");
  if (JSON.stringify(permissionLabels) !== JSON.stringify(["Act in the browser", "Update memory"]) || allowed.some(Boolean)) throw new Error(`a new Routine is not read-only: ${JSON.stringify({ permissionLabels, allowed })}`);
  await evaluate(panelSession, `(() => {
    document.querySelector('#routines [name=title]').value = 'Fixture check';
    document.querySelector('#routines [name=routinePrompt]').value = 'Routine check: read http://127.0.0.1:${fixturePort}/ and report the count.';
    document.querySelector('#routines [data-routine-form]').requestSubmit();
  })()`);
  await waitFor("the saved Routine", "/Routine saved\\./.test(document.getElementById('routines').innerText)");
  await evaluate(panelSession, "document.querySelector('#routines [data-routine-test-run]').click()");
  await waitFor("the run panel", "!!document.querySelector('#routines [data-routine-run-go]')");
  await evaluate(panelSession, "document.querySelector('#routines [data-routine-run-go]').click()");
  await waitFor("the run in the chat", `!document.getElementById('chat').hidden && /Routine read: Count: \\d+\\./.test(${transcript})`, panelSession, 90_000);
  await evaluate(panelSession, "document.getElementById('chats').click()");
  await waitFor("the run in the Chat list", "[...document.querySelectorAll('.chat-thread-item')].some(item => item.textContent.includes('Fixture check') && item.textContent.includes('Manual run'))");
  const routineRuns = await evaluate(panelSession, "chrome.storage.local.get(['workerUrl', 'token']).then(async s => { const h = { headers: { Authorization: 'Bearer ' + s.token } }; const list = await (await fetch(s.workerUrl + '/api/routines', h)).json(); const detail = await (await fetch(s.workerUrl + '/api/routines/' + list.items[0].thread.threadId, h)).json(); return { permissions: list.items[0].thread.permissions, runs: detail.runs.map(run => [run.trigger, run.latestTurnStatus, run.permissions]) }; })");
  if (JSON.stringify(routineRuns) !== JSON.stringify({ permissions: { update: false, write: false }, runs: [["manual", "completed", { update: false, write: false }]] })) throw new Error(`the Routine's run: ${JSON.stringify(routineRuns)}`);
  await evaluate(panelSession, "document.getElementById('chats').click()");
  console.log("PASS routine: created read-only in the Routine view (… menu); Run now opened the run in the chat, where it read the fixture page with no tab given and completed; the Chat list names it by its Routine and marks it Manual run");

  if (process.env.SMOKE_SCREENSHOT_DIR) {
    // The Routine view: the list, the editor (its runs below), the run panel; the run in the chat
    // and in the Chat list.
    const routineShot = (name: string, width: number) => shoot(`routine-${name}`, width);
    await evaluate(panelSession, OPEN_ROUTINES);
    // The view keeps the sheet it showed last; the list is under it.
    await evaluate(panelSession, "document.querySelector('#routines [data-routine-detail-close]')?.click()");
    await waitFor("the Routine list", "!!document.querySelector('#routines [data-routine-open]') && !document.querySelector('#routines [data-routine-form]')");
    for (const width of [400, 360]) await routineShot("list", width);
    await evaluate(panelSession, "document.querySelector('#routines [data-routine-open]').click()");
    await waitFor("the Routine's runs", "!!document.querySelector('#routines [data-routine-run-item]')");
    await evaluate(panelSession, "document.querySelector('#routines [data-routine-run-item]').open = true");
    for (const width of [400, 360]) await routineShot("editor", width);
    await evaluate(panelSession, "document.querySelector('#routines [data-routine-test-run]').click(); document.querySelector('#routines [data-routine-run-permission=write]').click()");
    await sleep(300);
    for (const width of [400, 360]) await routineShot("run-panel", width);
    await evaluate(panelSession, "document.querySelector('#routines [data-routine-run-cancel]').click(); document.querySelector('#routines [data-routine-run-thread]').click()");
    await waitFor("the run in the chat", `/Routine read/.test(${transcript})`);
    for (const width of [400, 360]) await routineShot("run-in-chat", width);
    await evaluate(panelSession, "document.getElementById('chats').click()");
    for (const width of [400, 360]) await routineShot("chat-list", width);
    await evaluate(panelSession, "document.getElementById('chats').click()");
  }

  // Images: a large JPEG dropped on the composer and a PNG pasted into it (Chrome's own DataTransfer
  // and events), each shown as a thumbnail; sent with the text, both reach the model's request; after
  // a reload the sent bubble loads them again from the Worker.
  await evaluate(panelSession, `(async () => {
    const picture = async (width, height, type, color) => {
      const canvas = new OffscreenCanvas(width, height);
      const context = canvas.getContext('2d');
      context.fillStyle = color; context.fillRect(0, 0, width, height);
      context.fillStyle = '#fff'; context.font = (height / 6) + 'px sans-serif'; context.fillText(type, width / 10, height / 2);
      return new File([await canvas.convertToBlob({ type, quality: 0.95 })], type.replace('/', '.'), { type });
    };
    const transfer = file => { const data = new DataTransfer(); data.items.add(file); return data; };
    const form = document.querySelector('.chat-composer');
    const dropped = transfer(await picture(3000, 2000, 'image/jpeg', '#2e8252'));
    form.dispatchEvent(new DragEvent('dragenter', { dataTransfer: dropped, bubbles: true, cancelable: true }));
    form.dispatchEvent(new DragEvent('drop', { dataTransfer: dropped, bubbles: true, cancelable: true }));
    await new Promise(resolve => setTimeout(resolve, 500));
    document.querySelector('.chat-composer textarea').dispatchEvent(new ClipboardEvent('paste', { clipboardData: transfer(await picture(900, 600, 'image/png', '#1d9bf0')), bubbles: true, cancelable: true }));
  })()`);
  await waitFor("two thumbnails", "[...document.querySelectorAll('.chat-composer-images img')].filter(img => img.complete && img.naturalWidth).length === 2");
  const thumbnails = await evaluate(panelSession, "[...document.querySelectorAll('.chat-composer-images img')].map(img => [img.naturalWidth, img.naturalHeight])");
  if (thumbnails[0][0] !== 1568 || thumbnails[1][0] !== 900) throw new Error(`the attached images were not downscaled to 1568 px (or kept when smaller): ${JSON.stringify(thumbnails)}`);
  if (process.env.SMOKE_SCREENSHOT_DIR) await shoot("image-composer", 400);
  await chrome.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
  await sendMessage("Describe the attached images.");
  await waitFor("the images answer", `/Images seen: /.test(${transcript})`, panelSession, 60_000);
  const imagesAnswer = (await evaluate(panelSession, transcript)).match(/Images seen: .*/)[0];
  // A message with images runs on the vision model, asked to reason.
  if (imagesAnswer !== `Images seen: 2 (image/jpeg, image/png) by ${VISION_MODEL_NAME} at ${modelProfile(VISION_MODEL_NAME).reasoning} reasoning.`) {
    throw new Error(`the vision model did not get both images: ${imagesAnswer}`);
  }
  if (await evaluate(panelSession, "document.querySelectorAll('.chat-composer-images img').length") !== 0) throw new Error("the composer kept the sent images");
  await chrome.send("Page.reload", {}, panelSession);
  await waitFor("the sent images after a reload", "[...document.querySelectorAll('.chat-message.is-user .chat-message-images img')].filter(img => img.src.startsWith('blob:') && img.complete && img.naturalWidth).length === 2");
  if (process.env.SMOKE_SCREENSHOT_DIR) await shoot("image-bubble", 400);
  await chrome.send("Emulation.clearDeviceMetricsOverride", {}, panelSession);
  console.log("PASS images: a dropped JPEG (downscaled to 1568 px) and a pasted PNG showed as thumbnails, reached the vision model (at its profile's reasoning effort) in the message's request as image data URLs, and the sent bubble loaded both again from the Worker after a reload");
  if (process.env.SMOKE_SCREENSHOT_DIR) {
    // The panel at a side panel's widths: the chat, its thread menu, the … menu, Settings with the
    // Memory view, the tab picker.
    await evaluate(panelSession, "[...document.querySelectorAll('.chat-thread-item button')].find(button => button.textContent.includes('Click the Increment'))?.click()");
    await sleep(500);
    for (const width of [400, 360]) await shoot("chat", width);
    await evaluate(panelSession, "document.getElementById('chats').click()");
    for (const width of [400, 360]) await shoot("menu", width);
    await evaluate(panelSession, "document.getElementById('chats').click(); document.querySelector('[data-more-trigger]').click()");
    for (const width of [400, 360]) await shoot("more", width);
    await evaluate(panelSession, "document.querySelector('.chat-panel-more [data-view=settings]').click()");
    await sleep(500);
    for (const width of [400, 360]) await shoot("settings", width);
    await evaluate(panelSession, "document.getElementById('chats').click(); document.getElementById('chats').click(); document.querySelector('.tab-picker-trigger').click()");
    await sleep(300);
    for (const width of [400, 360]) await shoot("tab-picker", width);
    console.log(`panel screenshots: ${process.env.SMOKE_SCREENSHOT_DIR}`);
  }
  chrome.close();
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

try {
  await main();
  console.log("PASS: Chrome smoke (local fixture, local Worker, fake model; no Cloudflare or OpenRouter)");
} catch (error) {
  console.error(`FAIL: ${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  for (const child of children) child.kill("SIGTERM");
  for (const server of servers) server.close();
  await sleep(500);
  rmSync(scratch, { recursive: true, force: true });
}
