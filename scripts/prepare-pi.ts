// Stages the installed pi-coding-agent for the Worker build (wrangler's build command) through
// agent-core's shared Worker build, the same one X Gardener uses: Pi's sources stay untouched in
// node_modules; the staged copy maps each module's `import.meta.url` (undefined in workerd) to its
// own /bundle path, replaces the modules a Worker never runs with throwing stubs, and the Worker
// entry carries the package resources Pi reads at load. Wrangler performs the bundle and Node
// compatibility. Usage: node scripts/prepare-pi.ts
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { stagePi } from "agent-core/worker-bundle";
import { transform } from "esbuild";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const result = await stagePi({ root, transform, entries: { worker: "../../src/worker/index.ts" } });
console.log(`Prepared original Pi: ${result.moduleUrls} module URLs, ${result.resources} resources, ${result.stubs} Worker stubs`);
