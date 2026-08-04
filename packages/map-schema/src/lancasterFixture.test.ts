import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateMapDocument } from "./validate.js";
import { compileMapDocument } from "./compiler.js";
import { MapDocumentSchema } from "./document.js";

function loadFixture(): unknown {
  const here = dirname(fileURLToPath(import.meta.url));
  // Compiled to dist/lancasterFixture.test.js; fixtures/ is at the package root.
  const path = join(here, "..", "fixtures", "lancaster-minimal.json");
  return JSON.parse(readFileSync(path, "utf8"));
}

describe("lancaster-minimal.json (the one hand-authored Milestone 5 test document)", () => {
  it("passes schema + structural validation with no errors", () => {
    const result = validateMapDocument(loadFixture());
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it("compiles to a bundle with every berth bound and both PX and CL areas represented", () => {
    const doc = MapDocumentSchema.parse(loadFixture());
    const bundle = compileMapDocument(doc);

    const areas = new Set(Object.keys(bundle.berthBindingIndex).map((key) => key.split("|")[0]));
    expect(areas).toEqual(new Set(["CL", "PX"]));
    expect(Object.keys(bundle.berthBindingIndex)).toHaveLength(5);
  });

  it("every signal renders blank — Lancaster has no S-Class binding", () => {
    const doc = MapDocumentSchema.parse(loadFixture());
    const signals = doc.elements.filter((element) => element.type === "signal");
    expect(signals.length).toBeGreaterThan(0);
    for (const signal of signals) {
      expect(signal.symbolStyle).toBe("signal-blank");
      expect(signal.bindingId).toBeUndefined();
    }
  });
});
