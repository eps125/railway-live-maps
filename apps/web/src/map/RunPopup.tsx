import { useEffect, useState } from "react";

/**
 * The live map's click-a-berth popup (docs/PROJECT_SPEC.md §5).
 *
 * Since ADR 0002 (2026-09-01) RLM has no berth-run resolver: the popup does not claim a single
 * train identity for a berth. It shows the TD headcode plus every openrail-eps ("garner")
 * schedule that shares that headcode and runs today — with the STP-effective one (and its TRUST
 * activation / latest movement) expanded when one can be picked. The `note` from the API is
 * shown verbatim so it is always clear this is garner's data, not an RLM identification.
 */

interface CandidateSchedule {
  scheduleId: string;
  trainUid: string;
  stpIndicator: "C" | "N" | "O" | "P";
  operatorCode: string | null;
  trainStatus: string | null;
  serviceCode: string | null;
  category: string | null;
  signallingId: string | null;
  scheduleStartDate: string;
  scheduleEndDate: string;
  originTiploc: string | null;
  destinationTiploc: string | null;
  activatedToday: boolean;
  trustId: string | null;
  activationDeduced: boolean;
  isEffective: boolean;
}

interface EffectiveLocation {
  seqNo: number;
  locationType: "origin" | "intermediate" | "pass" | "destination";
  tiploc: string;
  locationName: string | null;
  arrivalPublic: string | null;
  arrivalWorking: string | null;
  departurePublic: string | null;
  departureWorking: string | null;
  passWorking: string | null;
  platform: string | null;
  path: string | null;
  line: string | null;
  dayOffset: number;
}

interface EffectiveActivation {
  trustId: string;
  deduced: boolean;
  activatedAt: string;
  trainUid: string | null;
  tocId: string | null;
  scheduleWttId: string | null;
  scheduleType: string | null;
  originDepartureAt: string | null;
}

interface EffectiveMovement {
  trustId: string;
  locStanox: string | null;
  locName: string | null;
  platform: string | null;
  actualTimestamp: string | null;
  plannedTimestamp: string | null;
  gbttTimestamp: string | null;
  eventKind: "departure" | "arrival" | "arrival_destination" | "unknown";
  variationStatus: "early" | "on_time" | "late" | "off_route";
  variationMinutes: number | null;
  terminated: boolean;
  offRoute: boolean;
  manual: boolean;
  correction: boolean;
  nextReportStanox: string | null;
}

interface EffectiveSchedule {
  scheduleId: string;
  trainUid: string;
  stpIndicator: "C" | "N" | "O" | "P";
  operatorCode: string | null;
  trainStatus: string | null;
  serviceCode: string | null;
  category: string | null;
  originTiploc: string | null;
  originName: string | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  activation: EffectiveActivation | null;
  latestMovement: EffectiveMovement | null;
  locations: EffectiveLocation[];
}

/** Owner request (2026-09-13): the anonymous, reduced view of a matched schedule —
 * departure-board-style, none of the resolver-internal or TRUST-operational fields. */
interface PublicEffectiveSchedule {
  originTiploc: string | null;
  originName: string | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  operatorCode: string | null;
  locations: EffectiveLocation[];
}

/** Owner request (2026-09-13): real unit/stock allocation, shown to every visitor regardless of
 * login — mirrored from garner's `train_allocation`. Ordered by formation `position`. */
interface UnitAllocationEntry {
  unitNo: string;
  position: number;
  fleetId: string;
  vehicles: string[];
  reportedAt: string | null;
}

/** Milestone 34 (docs/adr/0006). `positionScoped` says whether `candidateSchedules` was narrowed
 * to schedules calling near this berth (SMART data) — false means no SMART coverage exists for
 * this berth at all, so `matchBasis` (when matched/ambiguous) is always the weakest
 * `headcode_only` tier regardless of which internal rule actually picked among the unscoped set. */
interface FullCurrentRunResponse {
  tdArea: string;
  berth: string;
  description: string | null;
  headcode: string;
  occupancyEnteredAt: string | null;
  matchStatus: "matched" | "ambiguous" | "unmatched";
  matchBasis:
    "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only" | null;
  positionScoped: boolean;
  note: string;
  effective: EffectiveSchedule | null;
  candidateSchedules: CandidateSchedule[];
  unitAllocation: UnitAllocationEntry[];
}

/** Owner request (2026-09-13): what an anonymous (no session cookie) visitor gets on a "solid"
 * match — the API never sends this shape unless `matchStatus` is `matched` and position-scoped
 * (not the weakest `headcode_only` tier); anything else 404s and the popup closes itself rather
 * than showing a reduced view of an ambiguous/unmatched/unreliable result. No `note` either
 * (owner request, 2026-09-14) — the resolver-internal "matched by TRUST activation/STP
 * precedence/verify this" language has no `matchBasis` to interpret it against out here, so it
 * stays backend-only, on the full response. */
interface PublicCurrentRunResponse {
  tdArea: string;
  berth: string;
  headcode: string;
  occupancyEnteredAt: string | null;
  matchStatus: "matched";
  effective: PublicEffectiveSchedule | null;
  unitAllocation: UnitAllocationEntry[];
}

type CurrentRunResponse = FullCurrentRunResponse | PublicCurrentRunResponse;

/** The two response shapes are distinguished by a field only the full one ever carries. */
function isFullResponse(data: CurrentRunResponse): data is FullCurrentRunResponse {
  return "candidateSchedules" in data;
}

export interface RunPopupProps {
  elementId: string;
  displayName: string;
  tdArea: string;
  berth: string;
  onClose: () => void;
}

const STP_LABELS: Record<string, string> = {
  C: "STP cancellation",
  O: "STP overlay",
  N: "STP new",
  P: "Permanent (WTT)",
};

const VARIATION_LABELS: Record<EffectiveMovement["variationStatus"], string> = {
  early: "early",
  on_time: "on time",
  late: "late",
  off_route: "off route",
};

const MATCH_BASIS_LABELS: Record<NonNullable<FullCurrentRunResponse["matchBasis"]>, string> = {
  trust_activation: "TRUST activation today",
  stp_precedence: "STP precedence",
  station_berth_timetable: "closest scheduled call at this station to now",
  headcode_only: "headcode match only — no position data, unscoped, verify",
};

/** How often the popup re-fetches while open — garner's mirror advances every ~20s, and a berth
 * clicked right as a train arrives can genuinely have no activation yet. */
const POLL_INTERVAL_MS = 5000;

function formatTime(raw: string | null): string {
  if (!raw) return "—";
  const digits = raw.replace(/H$/, "");
  if (digits.length < 4) return raw;
  return `${digits.slice(0, 2)}:${digits.slice(2, 4)}${raw.endsWith("H") ? "½" : ""}`;
}

function formatIso(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toISOString().replace("T", " ").slice(0, 16);
}

function formatLocation(tiploc: string | null, name: string | null): string {
  if (!tiploc) return "—";
  return name ? `${name} (${tiploc})` : tiploc;
}

function variationText(m: EffectiveMovement): string {
  const status = VARIATION_LABELS[m.variationStatus];
  if (m.variationMinutes === null || m.variationMinutes === 0) return status;
  return `${status} (${Math.abs(m.variationMinutes)} min)`;
}

/** Shared by both the full and reduced (anonymous) views — the API sends identical location
 * objects either way, so there's nothing to withhold here beyond the section already not
 * appearing for a non-matched/anonymous request at all. */
function LocationsTable({ locations }: { locations: EffectiveLocation[] }): JSX.Element | null {
  if (locations.length === 0) return null;
  return (
    <details className="map-inspector__schedule">
      <summary>Full schedule ({locations.length} calling points)</summary>
      <div className="map-inspector__schedule-scroll">
        <table>
          <thead>
            <tr>
              <th>Location</th>
              <th>Pl</th>
              <th colSpan={3}>Time</th>
              <th>Path/Line</th>
            </tr>
          </thead>
          <tbody>
            {locations.map((loc) => {
              const arrival = loc.arrivalPublic ?? loc.arrivalWorking;
              const departure = loc.departurePublic ?? loc.departureWorking;
              const isCall = arrival !== null || departure !== null;
              const muted = !isCall;
              const pathLine = [loc.path, loc.line].filter(Boolean).join("/");
              return (
                <tr key={loc.seqNo} className={muted ? "map-inspector__schedule-row--muted" : ""}>
                  <td>{formatLocation(loc.tiploc, loc.locationName)}</td>
                  <td>{loc.platform ?? ""}</td>
                  {isCall ? (
                    <>
                      <td className="map-inspector__schedule-time map-inspector__schedule-time--arrival">
                        {formatTime(arrival)}
                      </td>
                      <td className="map-inspector__schedule-arrow">→</td>
                      <td className="map-inspector__schedule-time map-inspector__schedule-time--departure">
                        {formatTime(departure)}
                      </td>
                    </>
                  ) : (
                    <td className="map-inspector__schedule-time" colSpan={3}>
                      {loc.passWorking !== null ? `pass ${formatTime(loc.passWorking)}` : "—"}
                    </td>
                  )}
                  <td className="map-inspector__schedule-pathline">{pathLine}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </details>
  );
}

/** Owner request (2026-09-13): real unit/stock allocation, shown to every visitor regardless of
 * login whenever garner has reported one for this train today. */
function UnitAllocationSection({
  unitAllocation,
}: {
  unitAllocation: UnitAllocationEntry[] | null;
}): JSX.Element | null {
  // Defensive: the API contract (docs/API_CONTRACT.md) always sends an array, but this popup
  // has no error boundary anywhere above it — a bug that ever regresses this to `null`/`undefined`
  // again should not blank the whole page (see currentRun.ts's own fix for the same 2026-09-14 bug).
  if (!unitAllocation || unitAllocation.length === 0) return null;
  return (
    <dl>
      <dt>Formation</dt>
      <dd>{unitAllocation.map((unit) => `${unit.unitNo} (${unit.fleetId})`).join(" + ")}</dd>
    </dl>
  );
}

function FullEffectiveDetail({ data }: { data: FullCurrentRunResponse }): JSX.Element | null {
  const effective = data.effective;
  if (!effective) return null;
  return (
    <>
      <dl>
        <dt>Schedule</dt>
        <dd>
          {effective.trainUid} · {STP_LABELS[effective.stpIndicator] ?? effective.stpIndicator}
        </dd>
        <dt>Picked by</dt>
        <dd>{data.matchBasis ? MATCH_BASIS_LABELS[data.matchBasis] : "—"}</dd>
        <dt>Operator</dt>
        <dd>{effective.operatorCode ?? "—"}</dd>
        <dt>Service code</dt>
        <dd>{effective.serviceCode ?? "—"}</dd>
        <dt>Origin</dt>
        <dd>{formatLocation(effective.originTiploc, effective.originName)}</dd>
        <dt>Destination</dt>
        <dd>{formatLocation(effective.destinationTiploc, effective.destinationName)}</dd>
      </dl>

      {effective.activation ? (
        <dl>
          <dt>TRUST ID</dt>
          <dd>
            {effective.activation.trustId}
            {effective.activation.deduced ? " (deduced)" : ""}
          </dd>
          <dt>Activated</dt>
          <dd>{formatIso(effective.activation.activatedAt)}</dd>
          <dt>TOC</dt>
          <dd>{effective.activation.tocId ?? "—"}</dd>
          <dt>WTT ID</dt>
          <dd>{effective.activation.scheduleWttId ?? "—"}</dd>
        </dl>
      ) : (
        <p className="map-inspector__note">No TRUST activation seen for this schedule today.</p>
      )}

      {effective.latestMovement ? (
        <dl>
          <dt>Latest report</dt>
          <dd>
            {effective.latestMovement.eventKind.replace("_", " ")}
            {effective.latestMovement.locName || effective.latestMovement.locStanox
              ? ` at ${effective.latestMovement.locName ?? effective.latestMovement.locStanox}`
              : ""}
            {effective.latestMovement.platform
              ? ` (platform ${effective.latestMovement.platform})`
              : ""}
          </dd>
          <dt>When</dt>
          <dd>{formatIso(effective.latestMovement.actualTimestamp)}</dd>
          <dt>Variation</dt>
          <dd>
            {variationText(effective.latestMovement)}
            {effective.latestMovement.terminated ? " · terminated" : ""}
          </dd>
        </dl>
      ) : null}

      <LocationsTable locations={effective.locations} />
    </>
  );
}

/** Owner request (2026-09-13): anonymous, reduced departure-board-style view — the API only ever
 * sends this shape on a solid match, so there's no "picked by"/ambiguity detail to show. */
function PublicEffectiveDetail({ data }: { data: PublicCurrentRunResponse }): JSX.Element | null {
  const effective = data.effective;
  if (!effective) return null;
  return (
    <>
      <dl>
        <dt>Operator</dt>
        <dd>{effective.operatorCode ?? "—"}</dd>
        <dt>Origin</dt>
        <dd>{formatLocation(effective.originTiploc, effective.originName)}</dd>
        <dt>Destination</dt>
        <dd>{formatLocation(effective.destinationTiploc, effective.destinationName)}</dd>
      </dl>
      <LocationsTable locations={effective.locations} />
    </>
  );
}

export function RunPopup({
  elementId,
  displayName,
  tdArea,
  berth,
  onClose,
}: RunPopupProps): JSX.Element | null {
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
          if (response.status === 404) {
            // Owner request (2026-09-13): a 404 here always means "nothing to show this
            // visitor" — either the berth genuinely isn't occupied any more, or (anonymous,
            // `NO_PUBLIC_DETAIL`) the match isn't solid enough to show publicly. Either way the
            // honest behaviour is to close quietly, not display an error.
            if (!cancelled) onClose();
            return null;
          }
          if (!response.ok) throw new Error(`Failed to load run detail (${response.status})`);
          return (await response.json()) as CurrentRunResponse;
        })
        .then((body) => {
          if (!cancelled && body) {
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

  // While the very first fetch is still in flight, render nothing at all rather than a
  // popup shell that might immediately vanish again. A non-solid public match 404s (see this
  // component's own 2026-09-13 "close quietly" handling above) — usually within well under a
  // second — and a title bar + "Loading…" that flashes open then closes reads as the popup
  // being broken, not as "nothing to show" (reported against PX 0218/0214, 2026-09-14). Once
  // the first fetch has resolved (`data` or a real `error`), subsequent poll ticks never flip
  // `loading` back to true, so this only ever hides the opening frame, not a refresh.
  if (loading) return null;

  return (
    <div role="status" className="map-inspector map-inspector--run">
      <div className="map-inspector__title">
        <span>
          {displayName || elementId}
          <span className="map-inspector__subtitle">
            {" "}
            · {tdArea} {berth}
          </span>
        </span>
        <button type="button" className="map-inspector__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>

      {error ? <p className="app-error">{error}</p> : null}

      {!error && data ? (
        <>
          <dl>
            <dt>Headcode</dt>
            <dd>{data.headcode}</dd>
            <dt>Entered</dt>
            <dd>{formatIso(data.occupancyEnteredAt)}</dd>
          </dl>

          {isFullResponse(data) ? (
            <>
              <p className="map-inspector__note">{data.note}</p>
              <FullEffectiveDetail data={data} />
            </>
          ) : (
            <PublicEffectiveDetail data={data} />
          )}

          <UnitAllocationSection unitAllocation={data.unitAllocation} />

          {isFullResponse(data) ? (
            data.candidateSchedules.length > 0 ? (
              <>
                <p className="map-inspector__note">
                  {data.candidateSchedules.length} schedule
                  {data.candidateSchedules.length === 1 ? "" : "s"} match headcode {data.headcode}{" "}
                  today:
                </p>
                <ul className="map-inspector__candidates">
                  {data.candidateSchedules.map((candidate) => (
                    <li key={candidate.scheduleId}>
                      {candidate.trainUid} ·{" "}
                      {STP_LABELS[candidate.stpIndicator] ?? candidate.stpIndicator}
                      {candidate.isEffective ? " — effective" : ""}
                      {candidate.activatedToday
                        ? ` — activated${candidate.activationDeduced ? " (deduced)" : ""} as ${
                            candidate.trustId
                          }`
                        : ""}
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <p className="map-inspector__note">
                No garner schedule matches headcode {data.headcode} today.
              </p>
            )
          ) : null}
        </>
      ) : null}
    </div>
  );
}
