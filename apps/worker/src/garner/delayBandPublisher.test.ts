import { describe, expect, it } from "vitest";
import type { BerthDelayRow } from "@railway/database";
import { delayMessagesFor, mappedBerths } from "./delayBandPublisher.js";

const row = (tdArea: string, berth: string, band: BerthDelayRow["band"]): BerthDelayRow => ({
  tdArea,
  berth,
  description: "1A01",
  runKey: "7",
  matchConfidence: "weak",
  band,
});

describe("delayMessagesFor (Milestone 82)", () => {
  const at = new Date("2026-09-29T12:00:00Z");

  it("sends one delay.updated per map that binds the berth", () => {
    const messages = delayMessagesFor(
      [row("CL", "0455", "moderate")],
      [
        { slug: "carlisle-psb", berthBindingIndex: { "CL|0455": "el-9" } },
        { slug: "preston-psb", berthBindingIndex: { "PX|0101": "el-1" } },
      ],
      at,
    );
    expect(messages).toEqual([
      {
        slug: "carlisle-psb",
        message: {
          type: "delay.updated",
          eventAt: "2026-09-29T12:00:00.000Z",
          runKey: "7",
          elementId: "el-9",
          description: "1A01",
          band: "moderate",
          matchConfidence: "weak",
        },
      },
    ]);
  });

  it("re-states `none` so a map can take a colour away", () => {
    const messages = delayMessagesFor(
      [row("CL", "0455", "none")],
      [{ slug: "carlisle-psb", berthBindingIndex: { "CL|0455": "el-9" } }],
      at,
    );
    expect(messages.map((m) => m.message.band)).toEqual(["none"]);
  });

  it("sends nothing for a berth no map binds", () => {
    expect(
      delayMessagesFor(
        [row("ZZ", "0001", "severe")],
        [{ slug: "carlisle-psb", berthBindingIndex: { "CL|0455": "el-9" } }],
        at,
      ),
    ).toEqual([]);
  });
});

describe("mappedBerths", () => {
  it("lists each berth bound on any map once", () => {
    expect(
      mappedBerths([
        { slug: "a", berthBindingIndex: { "CL|0455": "x", "PX|0101": "y" } },
        { slug: "b", berthBindingIndex: { "PX|0101": "z" } },
      ]),
    ).toEqual([
      { tdArea: "CL", berth: "0455" },
      { tdArea: "PX", berth: "0101" },
    ]);
  });
});
