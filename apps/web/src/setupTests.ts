import "@testing-library/jest-dom/vitest";
import "vitest-canvas-mock";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// vitest.config.ts doesn't set test.globals, so RTL's automatic-cleanup detection (which
// looks for a global `afterEach`) never fires on its own — without this, rendered components
// (and any interval/effect they started) pile up unmounted across every test in a file.
afterEach(() => {
  cleanup();
});
