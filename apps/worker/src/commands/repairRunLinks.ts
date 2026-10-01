import {
  createPool,
  findOccupancyLink,
  getMappedTdAreas,
  londonMinutesSinceMidnight,
  londonToday,
  resolveFreshRunMatch,
  upsertResolvedLink,
} from "@railway/database";
import { isSameRunIdentity } from "@railway/domain";
import type { Pool } from "pg";
import type { Config } from "../config.js";
import { propagateLinkForward } from "../runLineage/projector.js";

/** The live sweep keeps retrying an unlinked occupancy for this long after it opens (its TRUST
 * activation may land a little after the train is first described) — the repair resolves each
 * occupancy as it would have looked at the end of that window. */
const LIVE_RETRY_WINDOW_MS = 15 * 60 * 1000;

export interface RepairRunLinksSummary {
  examined: number;
  alreadyLinked: number;
  /** Unlinked, and still can't be matched as of its own time. */
  stillUnmatched: number;
  /** Unlinked and now matched: a link was (or, in a dry run, would be) written. */
  linked: number;
  /** Further berths the new links were carried on to. */
  carriedForward: number;
  /** A fresh-resolved link that now resolves to a different run (schedule or traffic day). */
  wrongRun: number;
  wrongRunSamples: string[];
  /** With `--correct`: wrong links replaced, because the run they should be was confirmed by
   * its TRUST activation. */
  corrected: number;
  /** Links carried from a corrected run (the rest of that train's journey) moved with it. */
  repointed: number;
}

interface OccupancyRow {
  id: string;
  entered_at: Date;
  left_at: Date | null;
  td_area: string;
  berth_code: string;
  description: string;
}

/**
 * `repair-run-links --from <iso> [--to <iso>] [--correct] [--dry-run]` — one-shot console command (run it
 * from the `worker` container like `migrate`). Re-runs run matching for every described
 * occupancy in the mapped TD areas over a past window, **as of each occupancy's own time**
 * (`resolveFreshRunMatch`'s `asOf`), and writes the links the live sweep should have written then,
 * carrying each new link forward along the train's next berths exactly as the step chain does.
 * Playback reads these stored links, so this is what puts past identifications right.
 *
 * Written for the 2026-10-01 incident (TRUST ids reused a month later made live trains look
 * "already passed"; see `withinTrustRun`). An occupancy that already has a link is left alone,
 * except: a fresh-resolved link that would now resolve to a different run (schedule or traffic
 * day — overnight trains were stored against the wrong day until 2026-10-01, see
 * `ServiceDateChoice`) is counted (`wrongRun`), and with `--correct` replaced when the new answer
 * is confirmed by its TRUST activation; links carried from the old run move with it. Run with
 * `--dry-run` first to see the counts.
 */
export async function repairRunLinks(
  pool: Pool,
  options: { from: Date; to: Date; dryRun: boolean; correct?: boolean },
): Promise<RepairRunLinksSummary> {
  const summary: RepairRunLinksSummary = {
    examined: 0,
    alreadyLinked: 0,
    stillUnmatched: 0,
    linked: 0,
    carriedForward: 0,
    wrongRun: 0,
    wrongRunSamples: [],
    corrected: 0,
    repointed: 0,
  };
  const areas = [...(await getMappedTdAreas(pool))];
  if (areas.length === 0) return summary;

  // `(td_area, entered_at)`-bounded per area, so partitions prune; oldest first, so a link
  // written early is carried forward before later berths of the same train are looked at.
  const { rows } = await pool.query<OccupancyRow>(
    `select id::text as id, entered_at, left_at, td_area, berth_code, description
       from berth_occupancy
      where td_area = any($1::text[])
        and entered_at >= $2 and entered_at < $3
        and description ~ '^[0-9][A-Z][0-9]{2}$'
      order by entered_at, id`,
    [areas, options.from, options.to],
  );

  const now = Date.now();
  for (const row of rows) {
    summary.examined += 1;
    const occupancy = { id: row.id, enteredAt: row.entered_at };
    const existing = await findOccupancyLink(pool, occupancy);
    const asOf = new Date(
      Math.min(
        row.entered_at.getTime() + LIVE_RETRY_WINDOW_MS,
        row.left_at?.getTime() ?? Number.POSITIVE_INFINITY,
        now,
      ),
    );

    // A link carried from an earlier berth is the same train as that berth's link: it is
    // checked (and corrected) there, and moves with it.
    if (existing && existing.linkBasis !== "resolved") {
      summary.alreadyLinked += 1;
      continue;
    }

    const fresh = await resolveFreshRunMatch(pool, {
      tdArea: row.td_area,
      berth: row.berth_code,
      headcode: row.description,
      today: londonToday(asOf),
      nowMinutes: londonMinutesSinceMidnight(asOf),
      asOf,
    });
    const matched =
      fresh.matchStatus === "matched" && fresh.effectiveRow && fresh.matchBasis && fresh.trafficDay;

    if (existing) {
      summary.alreadyLinked += 1;
      if (!matched || existing.cifScheduleId === null) continue;
      const identity = {
        cifScheduleId: fresh.effectiveRow!.id,
        cifTrainUid: fresh.effectiveRow!.cif_train_uid,
        trafficDay: fresh.trafficDay!,
      };
      if (
        isSameRunIdentity(
          {
            cifScheduleId: existing.cifScheduleId,
            cifTrainUid: existing.cifTrainUid,
            trafficDay: existing.trafficDay,
          },
          identity,
        )
      ) {
        continue;
      }
      summary.wrongRun += 1;
      if (summary.wrongRunSamples.length < 20) {
        summary.wrongRunSamples.push(
          `${row.td_area} ${row.berth_code} ${row.description} ${row.entered_at.toISOString()}: ` +
            `linked ${existing.cifScheduleId}/${existing.trafficDay}, now ` +
            `${identity.cifScheduleId}/${identity.trafficDay} (${fresh.matchBasis})`,
        );
      }
      // Only ever overwrite a stored identification with one TRUST itself confirms.
      if (!options.correct || fresh.matchBasis !== "trust_activation") continue;
      summary.corrected += 1;
      if (options.dryRun) continue;
      const oldRunId = existing.trainRunId;
      await upsertResolvedLink(pool, occupancy, {
        ...identity,
        matchBasis: "trust_activation",
        matchConfidence: "solid",
        tdArea: row.td_area,
        berth: row.berth_code,
      });
      const corrected = await findOccupancyLink(pool, occupancy);
      if (corrected && corrected.trainRunId !== oldRunId) {
        // The rest of the journey was carried from the old run: it is the same train, so it
        // moves with the correction rather than being left pointing at a superseded run.
        const moved = await pool.query(
          `update berth_occupancy_run_link set train_run_id = $1, updated_at = now()
            where train_run_id = $2`,
          [corrected.trainRunId, oldRunId],
        );
        summary.repointed += moved.rowCount ?? 0;
      }
      continue;
    }
    if (!matched) {
      summary.stillUnmatched += 1;
      continue;
    }
    summary.linked += 1;
    if (options.dryRun) continue;

    await upsertResolvedLink(pool, occupancy, {
      cifScheduleId: fresh.effectiveRow!.id,
      cifTrainUid: fresh.effectiveRow!.cif_train_uid,
      trafficDay: fresh.trafficDay!,
      matchBasis: fresh.matchBasis as
        "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only",
      matchConfidence: fresh.isSolidMatch ? "solid" : "weak",
      tdArea: row.td_area,
      berth: row.berth_code,
    });
    const link = await findOccupancyLink(pool, occupancy);
    if (!link) continue;
    const client = await pool.connect();
    try {
      await client.query("begin");
      const counter = { stepChainLinks: 0 } as Parameters<typeof propagateLinkForward>[3];
      await propagateLinkForward(
        client,
        { id: row.id, entered_at: row.entered_at },
        link.trainRunId,
        counter,
      );
      await client.query("commit");
      summary.carriedForward += counter.stepChainLinks;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }
  return summary;
}

function readFlag(argv: string[], name: string): string | undefined {
  const index = argv.indexOf(`--${name}`);
  return index >= 0 ? argv[index + 1] : undefined;
}

export async function runRepairRunLinks(config: Config, argv: string[]): Promise<void> {
  const fromRaw = readFlag(argv, "from");
  const from = fromRaw ? new Date(fromRaw) : null;
  if (!from || Number.isNaN(from.getTime())) {
    throw new Error("repair-run-links: --from <ISO timestamp> is required");
  }
  const toRaw = readFlag(argv, "to");
  const to = toRaw ? new Date(toRaw) : new Date();
  if (Number.isNaN(to.getTime()) || to <= from) {
    throw new Error("repair-run-links: --to must be an ISO timestamp after --from");
  }
  const dryRun = argv.includes("--dry-run");
  const correct = argv.includes("--correct");
  const pool = createPool({ connectionString: config.DATABASE_URL, statementTimeoutMs: 120_000 });
  try {
    const summary = await repairRunLinks(pool, { from, to, dryRun, correct });
    console.log(
      `repair-run-links${dryRun ? " (dry run)" : ""}: ${JSON.stringify(summary, null, 2)}`,
    );
  } finally {
    await pool.end();
  }
}
