import { defineConfig } from "vitest/config";

export default defineConfig({
  // The panel's components render with pi-do's React (agent-core's chat UI resolves React too).
  resolve: { dedupe: ["react", "react-dom"] },
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
