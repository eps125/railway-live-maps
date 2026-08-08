import "@testing-library/jest-dom/vitest";
import "vitest-canvas-mock";
import { afterEach } from "vitest";
import { cleanup } from "@testing-library/react";

// jsdom doesn't implement ResizeObserver (used by EditorCanvas.tsx to size the Konva stage to
// its container) — a no-op stub is enough for components that only need it not to throw;
// layout-dependent behavior itself isn't something jsdom can meaningfully test anyway.
class ResizeObserverStub {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= ResizeObserverStub as unknown as typeof ResizeObserver;

// vitest.config.ts doesn't set test.globals, so RTL's automatic-cleanup detection (which
// looks for a global `afterEach`) never fires on its own — without this, rendered components
// (and any interval/effect they started) pile up unmounted across every test in a file.
afterEach(() => {
  cleanup();
});
