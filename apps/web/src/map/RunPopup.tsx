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
  selectedBy: "stp_precedence" | "trust_activation";
  activation: EffectiveActivation | null;
  latestMovement: EffectiveMovement | null;
  locations: EffectiveLocation[];
}

interface CurrentRunResponse {
  tdArea: string;
  berth: string;
  description: string | null;
  headcode: string;
  occupancyEnteredAt: string | null;
  note: string;
  effective: EffectiveSchedule | null;
  candidateSchedules: CandidateSchedule[];
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

export function RunPopup({
  elementId,
  displayName,
  tdArea,
  berth,
  onClose,
}: RunPopupProps): JSX.Element {
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
          if (!response.ok) throw new Error(`Failed to load run detail (${response.status})`);
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

  const effective = data?.effective ?? null;

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

      {loading ? <p>Loading…</p> : null}
      {error ? <p className="app-error">{error}</p> : null}

      {!loading && !error && data ? (
        <>
          <dl>
            <dt>Headcode</dt>
            <dd>{data.description ?? "(empty)"}</dd>
            <dt>Entered</dt>
            <dd>{formatIso(data.occupancyEnteredAt)}</dd>
          </dl>

          <p className="map-inspector__note">{data.note}</p>

          {effective ? (
            <>
              <dl>
                <dt>Schedule</dt>
                <dd>
                  {effective.trainUid} ·{" "}
                  {STP_LABELS[effective.stpIndicator] ?? effective.stpIndicator}
                </dd>
                <dt>Picked by</dt>
                <dd>
                  {effective.selectedBy === "stp_precedence"
                    ? "STP precedence"
                    : "TRUST activation today"}
                </dd>
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
                <p className="map-inspector__note">
                  No TRUST activation seen for this schedule today.
                </p>
              )}

              {effective.latestMovement ? (
                <dl>
                  <dt>Latest report</dt>
                  <dd>
                    {effective.latestMovement.eventKind.replace("_", " ")}
                    {effective.latestMovement.locName || effective.latestMovement.locStanox
                      ? ` at ${
                          effective.latestMovement.locName ?? effective.latestMovement.locStanox
                        }`
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

              {effective.locations.length > 0 ? (
                <details className="map-inspector__schedule">
                  <summary>Full schedule ({effective.locations.length} calling points)</summary>
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
                        {effective.locations.map((loc) => {
                          const arrival = loc.arrivalPublic ?? loc.arrivalWorking;
                          const departure = loc.departurePublic ?? loc.departureWorking;
                          const isCall = arrival !== null || departure !== null;
                          const muted = !isCall;
                          const pathLine = [loc.path, loc.line].filter(Boolean).join("/");
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
                                    {formatTime(arrival)}
                                  </td>
                                  <td className="map-inspector__schedule-arrow">→</td>
                                  <td className="map-inspector__schedule-time map-inspector__schedule-time--departure">
                                    {formatTime(departure)}
                                  </td>
                                </>
                              ) : (
                                <td className="map-inspector__schedule-time" colSpan={3}>
                                  {loc.passWorking !== null
                                    ? `pass ${formatTime(loc.passWorking)}`
                                    : "—"}
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
              ) : null}
            </>
          ) : null}

          {data.candidateSchedules.length > 0 ? (
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
          )}
        </>
      ) : null}
    </div>
  );
}
