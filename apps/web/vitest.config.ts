import { defineConfig } from "vitest/config";

/** Running `vitest` from apps/web: both web projects (vitest.shared.ts explains the split). */
export default defineConfig({
  test: {
    projects: ["./vitest.logic.config.ts", "./vitest.dom.config.ts"],
  },
});
