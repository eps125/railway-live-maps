import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { listMigrationFiles } from "./migrate.js";

describe("listMigrationFiles", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "railway-migrations-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns only .sql files sorted lexically", async () => {
    await writeFile(join(dir, "0002_second.sql"), "select 1;");
    await writeFile(join(dir, "0001_first.sql"), "select 1;");
    await writeFile(join(dir, "README.md"), "not a migration");

    const files = await listMigrationFiles(dir);

    expect(files.map((f) => f.name)).toEqual(["0001_first.sql", "0002_second.sql"]);
  });

  it("returns an empty array for a directory with no migrations", async () => {
    const files = await listMigrationFiles(dir);
    expect(files).toEqual([]);
  });
});
