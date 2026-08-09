import { describe, expect, it } from "vitest";
import { parseCommand, UnknownCommandError } from "./dispatch.js";

describe("parseCommand", () => {
  it("returns 'serve' when no argv is given", () => {
    expect(parseCommand([])).toBe("serve");
  });

  it.each([
    "check-connectivity",
    "ensure-archive-bucket",
    "migrate",
    "ensure-partitions",
    "reconcile-archive",
    "replay-fixtures",
    "project-td",
    "publish-map",
    "backfill-map-bindings",
    "project-map-deltas",
    "project-vstp",
    "reparse-vstp-archive",
    "ingest-td",
    "project-trust",
    "project-resolver",
  ])("accepts the known command %s", (name) => {
    expect(parseCommand([name])).toBe(name);
  });

  it("throws UnknownCommandError for an unrecognized command", () => {
    expect(() => parseCommand(["totally-bogus-command"])).toThrow(UnknownCommandError);
  });
});
