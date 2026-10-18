import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Milestone 94 (dev-only): production build of the map-scale bench page, with React's profiling
// build so <Profiler> reports commit durations. `pnpm --filter @railway/web bench:build`.
export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  plugins: [react()],
  resolve: {
    // BENCH_NO_PROFILER=1 builds with plain production React (no commit timings, no profiling
    // overhead) for the main-thread numbers.
    alias: process.env.BENCH_NO_PROFILER
      ? []
      : [{ find: /^react-dom\/client$/, replacement: "react-dom/profiling" }],
  },
  define: {
    "import.meta.env.VITE_BENCH_PROFILING": JSON.stringify(
      process.env.BENCH_NO_PROFILER ? "0" : "1",
    ),
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    minify: process.env.BENCH_NO_MINIFY ? false : "esbuild",
  },
});
