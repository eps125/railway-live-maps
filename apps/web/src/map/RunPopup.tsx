import { useEffect, useState } from "react";

interface ScoredCandidateJson {
  trainRunId: string;
  score: number;
  confidence: number;
  reasons: string[];
  signallingId: string | null;
  trustTrainId: string | null;
  trainUid: string | null;
}

interface CurrentRunResolution {
  status: "matched" | "ambiguous" | "unmatched";
  confidence: number | null;
  resolverVersion: number;
  decidedAt: string;
  candidates: ScoredCandidateJson[];
}

interface CurrentRunRunDetail {
  runId: string;
  trustTrainId: string;
  signallingId: string | null;
  serviceDate: string;
  activatedAt: string | null;
  operatorCode: string | null;
  serviceCode: string | null;
  lifecycleState: string;
  scheduleLink: { matchOutcome: string; scheduleId: string | null } | null;
}

interface CurrentRunScheduleLocation {
  seqNo: number;
  locationType: string;
  tiploc: string;
  locationName: string | null;
  arrivalPublic: string | null;
  departurePublic: string | null;
  passPublic: string | null;
  passWorking: string | null;
  platform: string | null;
}

interface CurrentRunSchedule {
  scheduleId: string;
  trainUid: string;
  stpIndicator: string;
  source: string;
  originTiploc: string | null;
  originName: string | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  locations: CurrentRunScheduleLocation[];
}

interface CurrentRunMovement {
  eventType: string | null;
  locationStanox: string | null;
  platform: string | null;
  variationStatus: "EARLY" | "LATE" | "ON TIME" | "OFF ROUTE" | null;
  timetableVariationMinutes: number | null;
}

interface CurrentRunResponse {
  tdArea: string;
  berth: string;
  description: string | null;
  occupancyEnteredAt: string | null;
  resolution: CurrentRunResolution | null;
  run: CurrentRunRunDetail | null;
  schedule: CurrentRunSchedule | null;
  latestMovement: CurrentRunMovement | null;
}

export interface RunPopupProps {
  elementId: string;
  displayName: string;
  tdArea: string;
  berth: string;
}

const STP_LABELS: Record<string, string> = {
  C: "Cancellation",
  O: "Overlay",
  N: "New",
  P: "Permanent",
};

function formatTime(publicTime: string | null): string {
  // Raw CIF-style HHMM(H) text, exactly as supplied (docs/DATA_MODEL.md: never derive a
  // normalized time from a missing one) — just insert a colon for readability, nothing more.
  if (!publicTime) return "—";
  const digits = publicTime.replace(/H$/, "");
  if (digits.length < 4) return publicTime;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}${publicTime.endsWith("H") ? "½" : ""}`;
}

/** CORPUS's location_reference has no entry for every TIPLOC (import coverage gaps, or CORPUS
 * simply not imported yet) — always fall back to the raw TIPLOC rather than showing nothing. */
function formatLocation(tiploc: string | null, name: string | null): string {
  if (!tiploc) return "—";
  return name ? `${name} (${tiploc})` : tiploc;
}

/** How often the popup re-fetches while open. Resolution isn't necessarily settled the instant a
 * berth is clicked — project-resolver runs its own decoupled loop (deploy/docker-compose.
 * portainer.yml's `projector-resolver` service), so a berth clicked right as a train arrives can
 * genuinely still be `unmatched` for a few seconds. A one-shot fetch would then never update even
 * after the backend resolves it moments later — confirmed 2026-08-10 against a real occupancy
 * that matched 15s after entering while the popup, opened at entry, kept showing "no match". */
const POLL_INTERVAL_MS = 2000;

/**
 * The live map's click-a-berth popup (docs/PROJECT_SPEC.md §5 "Train/run popup", Milestone 9).
 * Polls `GET /api/v1/td/areas/{tdArea}/berths/{berth}/current-run` every POLL_INTERVAL_MS while
 * open, so a resolution decided after the popup was opened still reaches it. Renders the full
 * spec'd field list, and — critically — never silently picks a run when the resolver reports
 * `ambiguous`, and never fabricates schedule/operator data when `unmatched`.
 */
export function RunPopup({ elementId, displayName, tdArea, berth }: RunPopupProps): JSX.Element {
  const [data, setData] = useState<CurrentRunResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    setData(null);

    function fetchOnce(): void {
      fetch(
        `/api/v1/td/areas/${encodeURIComponent(tdArea)}/berths/${encodeURIComponent(berth)}/current-run`,
      )
        .then(async (response) => {
          if (!response.ok) {
            throw new Error(`Failed to load run detail (${response.status})`);
          }
          return (await response.json()) as CurrentRunResponse;
        })
        .then((body) => {
          if (!cancelled) {
            setData(body);
            setError(null);
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setError(err instanceof Error ? err.message : "Failed to load run detail");
          }
        })
        .finally(() => {
          if (!cancelled) setLoading(false);
        });
    }

    fetchOnce();
    const intervalId = setInterval(fetchOnce, POLL_INTERVAL_MS);

    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
  }, [tdArea, berth]);

  return (
    <div role="status" className="map-inspector map-inspector--run">
      <div className="map-inspector__title">
        {displayName || elementId}
        <span className="map-inspector__subtitle">
          {" "}
          · {tdArea} {berth}
        </span>
      </div>

      {loading ? <p>Loading…</p> : null}
      {error ? <p className="app-error">{error}</p> : null}

      {!loading && !error && data ? (
        <>
          <dl>
            <dt>Description</dt>
            <dd>{data.description ?? "(empty)"}</dd>
            <dt>Entered</dt>
            <dd>{data.occupancyEnteredAt ?? "—"}</dd>
          </dl>

          {data.resolution?.status === "matched" && data.run ? (
            <>
              <dl>
                <dt>Match status</dt>
                <dd>
                  Matched
                  {data.resolution.confidence !== null
                    ? ` (${Math.round(data.resolution.confidence * 100)}% confidence)`
                    : ""}
                </dd>
                <dt>TRUST train ID</dt>
                <dd>{data.run.trustTrainId}</dd>
                <dt>Activated</dt>
                <dd>{data.run.activatedAt ?? "—"}</dd>
                <dt>Operator</dt>
                <dd>{data.run.operatorCode ?? "—"}</dd>
                <dt>Service code</dt>
                <dd>{data.run.serviceCode ?? "—"}</dd>
                <dt>Lifecycle</dt>
                <dd>{data.run.lifecycleState}</dd>
              </dl>

              {data.schedule ? (
                <dl>
                  <dt>Schedule UID</dt>
                  <dd>{data.schedule.trainUid}</dd>
                  <dt>Schedule type</dt>
                  <dd>
                    {STP_LABELS[data.schedule.stpIndicator] ?? data.schedule.stpIndicator} (
                    {data.schedule.source})
                  </dd>
                  <dt>Origin</dt>
                  <dd>{formatLocation(data.schedule.originTiploc, data.schedule.originName)}</dd>
                  <dt>Destination</dt>
                  <dd>
                    {formatLocation(data.schedule.destinationTiploc, data.schedule.destinationName)}
                  </dd>
                </dl>
              ) : (
                <p className="map-inspector__note">
                  Run matched, but its activation has no linked schedule.
                </p>
              )}

              {data.schedule && data.schedule.locations.length > 0 ? (
                <details className="map-inspector__schedule">
                  <summary>Full schedule ({data.schedule.locations.length} calling points)</summary>
                  <table>
                    <tbody>
                      {data.schedule.locations.map((loc) => {
                        // A "call" (real stop) has a booked arrival and/or departure; a location
                        // with only a pass time is never actually visited long enough to board —
                        // greyed out and shown as a single time, no arrow, same distinction other
                        // public train-time sites draw between calling and passing points. A
                        // location with neither (a structural/junction TIPLOC CIF includes for
                        // route continuity, not a timed point at all) gets the same muted
                        // treatment since there's nothing booked there either.
                        const isCall = loc.arrivalPublic !== null || loc.departurePublic !== null;
                        const muted = !isCall;
                        // CIF has no real concept of a *public* pass time — junctions and other
                        // non-stop points are essentially never customer-facing, so passPublic is
                        // null for nearly every real passing point; the actually-booked time lives
                        // in passWorking (confirmed 2026-08-13 against realtimetrains.co.uk, which
                        // shows exactly these working times for non-stop locations). Preferring
                        // passPublic when it IS present costs nothing and covers the rare case
                        // where a public pass time genuinely is published.
                        const passTime = loc.passPublic ?? loc.passWorking;
                        return (
                          <tr
                            key={loc.seqNo}
                            className={muted ? "map-inspector__schedule-row--muted" : ""}
                          >
                            <td>{formatLocation(loc.tiploc, loc.locationName)}</td>
                            <td>{loc.platform ?? ""}</td>
                            {isCall ? (
                              <>
                                <td className="map-inspector__schedule-time map-inspector__schedule-time--arrival">
                                  {formatTime(loc.arrivalPublic)}
                                </td>
                                <td className="map-inspector__schedule-arrow">→</td>
                                <td className="map-inspector__schedule-time map-inspector__schedule-time--departure">
                                  {formatTime(loc.departurePublic)}
                                </td>
                              </>
                            ) : (
                              <td className="map-inspector__schedule-time" colSpan={3}>
                                {passTime !== null ? `pass ${formatTime(passTime)}` : "—"}
                              </td>
                            )}
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </details>
              ) : null}

              {data.latestMovement ? (
                <dl>
                  <dt>Latest report</dt>
                  <dd>
                    {data.latestMovement.eventType ?? "—"}
                    {data.latestMovement.platform
                      ? ` (platform ${data.latestMovement.platform})`
                      : ""}
                  </dd>
                  <dt>Variation</dt>
                  <dd>
                    {data.latestMovement.variationStatus
                      ? `${data.latestMovement.variationStatus}${
                          data.latestMovement.timetableVariationMinutes !== null
                            ? ` (${data.latestMovement.timetableVariationMinutes} min)`
                            : ""
                        }`
                      : "—"}
                  </dd>
                </dl>
              ) : null}
            </>
          ) : null}

          {data.resolution?.status === "ambiguous" ? (
            <>
              <p className="map-inspector__note">
                Ambiguous — {data.resolution.candidates.length} plausible candidates, none clearly
                strongest:
              </p>
              <ul className="map-inspector__candidates">
                {data.resolution.candidates.map((candidate) => (
                  <li key={candidate.trainRunId}>
                    {[candidate.trainUid, candidate.signallingId, candidate.trustTrainId]
                      .filter((part): part is string => Boolean(part))
                      .join(" · ") || candidate.trainRunId}{" "}
                    — {Math.round(candidate.confidence * 100)}%
                    {candidate.reasons.length > 0 ? ` (${candidate.reasons.join(", ")})` : ""}
                  </li>
                ))}
              </ul>
            </>
          ) : null}

          {!data.resolution || data.resolution.status === "unmatched" ? (
            <p className="map-inspector__note">No matching activated schedule found.</p>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
