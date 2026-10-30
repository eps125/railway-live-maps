import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // apps/web is two projects (logic in Node, dom in jsdom; apps/web/vitest.shared.ts), listed
    // by their own config files because Vitest ignores projects nested in a project's config.
    projects: [
      "apps/api/vitest.config.ts",
      "apps/worker/vitest.config.ts",
      "apps/web/vitest.logic.config.ts",
      "apps/web/vitest.dom.config.ts",
      "packages/*/vitest.config.ts",
    ],
  },
});
