import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { readSecret } from "./secrets.js";

describe("readSecret", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railway-secrets-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads and trims a value from the _FILE path when set", async () => {
    const path = join(dir, "nr_username");
    await writeFile(path, "sanitized-example-user\n");

    const value = readSecret({ NR_USERNAME_FILE: path }, "NR_USERNAME", { required: true });

    expect(value).toBe("sanitized-example-user");
  });

  it("prefers the _FILE variant over the plain env var when both are set", async () => {
    const path = join(dir, "nr_username");
    await writeFile(path, "from-file");

    const value = readSecret({ NR_USERNAME_FILE: path, NR_USERNAME: "from-env" }, "NR_USERNAME", {
      required: true,
    });

    expect(value).toBe("from-file");
  });

  it("falls back to the plain env var when no _FILE is set", () => {
    const value = readSecret({ NR_USERNAME: "from-env" }, "NR_USERNAME", { required: true });
    expect(value).toBe("from-env");
  });

  it("returns undefined when unset and not required", () => {
    expect(readSecret({}, "NR_USERNAME", { required: false })).toBeUndefined();
  });

  it("throws when unset and required", () => {
    expect(() => readSecret({}, "NR_USERNAME", { required: true })).toThrow(
      "NR_USERNAME or NR_USERNAME_FILE is required",
    );
  });
});
