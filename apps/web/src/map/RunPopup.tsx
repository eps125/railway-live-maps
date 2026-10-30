import { useEffect, useState, type ReactNode } from "react";
import { DELAY_BAND_COLORS } from "./delayBands.js";
import type { FollowResult } from "./followTrain.js";
import { useCan } from "../auth/permissions.js";

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
  /** 2026-10-30: TRUST's reports here (`popup.delay`); absent when the API doesn't send them,
   * `null` when nothing has been reported here yet. */
  running?: {
    arrival: LocationRunningReport | null;
    departure: LocationRunningReport | null;
  } | null;
}

interface LocationRunningReport {
  actual: string;
  minutesLate: number | null;
  platform: string | null;
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

/** docs/adr/0009: a change currently in effect for this run's origin/destination — full/
 * shown with `popup.schedule` (Milestone 99). `originTiploc`/
 * `destinationTiploc` on `EffectiveSchedule` are already the *current* values; this is only the
 * "what it used to be, and when" detail. */
interface EffectiveChangeDetail {
  previousTiploc: string | null;
  previousName: string | null;
  changedAt: string;
  reason: string | null;
}

interface EffectiveIdentityChange {
  previousTrustId: string;
  newTrustId: string;
  changedAt: string;
  previousHeadcode: string | null;
  newHeadcode: string | null;
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
  originChange: EffectiveChangeDetail | null;
  destinationTiploc: string | null;
  destinationName: string | null;
  destinationChange: EffectiveChangeDetail | null;
  identityChange: EffectiveIdentityChange | null;
  activation: EffectiveActivation | null;
  latestMovement: EffectiveMovement | null;
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

/**
 * Milestone 99 (docs/adr/0022): one response shape, carrying only the rows this viewer's
 * `popup.*` permissions allow — a missing field is a row not to show. (Before Milestone 99 there
 * were two fixed shapes, anonymous and logged-in.)
 *
 * Milestone 34 (docs/adr/0006). `positionScoped` says whether `candidateSchedules` was narrowed
 * to schedules calling near this berth (SMART data) — false means no SMART coverage exists for
 * this berth at all, so `matchBasis` (when matched/ambiguous) is always the weakest
 * `headcode_only` tier regardless of which internal rule actually picked among the unscoped set.
 */
interface CurrentRunResponse {
  /** `popup.berth_codes` (2026-10-30), with `occupancyEnteredAt`. */
  tdArea?: string;
  berth?: string;
  description?: string | null;
  headcode: string;
  occupancyEnteredAt?: string | null;
  matchStatus: "matched" | "ambiguous" | "unmatched";
  /** `popup.match_details`. */
  matchBasis?:
    "trust_activation" | "stp_precedence" | "station_berth_timetable" | "headcode_only" | null;
  positionScoped?: boolean;
  note?: string;
  effective: Partial<EffectiveSchedule> | null;
  /** `popup.candidates`. */
  candidateSchedules?: CandidateSchedule[];
  /** Milestone 97c (`popup.delay`). Optional so an older API without it still renders. */
  delay?: PopupDelay | null;
  /** `popup.formation` (empty without it). */
  unitAllocation: UnitAllocationEntry[];
}

/** Milestone 97c (docs/adr/0021): the delay line, in both views. `estimated` is the held-train
 * estimate, which can only be later than TRUST says. */
export interface PopupDelay {
  minutesLate: number | null;
  band: "none" | "on_time" | "minor" | "moderate" | "severe";
  estimated: boolean;
  estimate: {
    basis: "timing_point" | "held_in_berth";
    carried: boolean;
    standingSince: string | null;
  } | null;
  lastReport: {
    minutesLate: number | null;
    eventKind: "departure" | "arrival" | "arrival_destination" | "unknown";
    locationName: string | null;
    at: string | null;
  } | null;
}

export interface RunPopupMember {
  tdArea: string;
  berth: string;
}

export interface RunPopupProps {
  elementId: string;
  displayName: string;
  tdArea: string;
  berth: string;
  /** Combined berth (Milestone 50, owner request 2026-09-17, docs/MAP_EDITOR_SPEC.md's berth
   * section): every physical berth sharing this map element, in `combinedOrder`. Omitted (or a
   * single-entry array) for a plain berth — every existing caller passing only `tdArea`/`berth`
   * is unaffected. When there's more than one, each occupied member's detail is shown in its own
   * section, successively, separated by a divider — rather than a picker that only shows one
   * member at a time (owner offered both, 2026-09-17; this shows everything with no extra click). */
  members?: RunPopupMember[];
  /** Milestone 57: in playback, the instant being displayed — sent to the API as `?at=`, so the
   * answer is about who was in this berth *then*. Omitted/`null` is live.
   *
   * Captured once when the popup opens and deliberately not followed afterwards: the playback
   * clock ticks several times a second, and re-fetching on every tick would hammer the API and
   * make the popup's content flicker between trains as the berth changes hands underneath it. A
   * click means "tell me about this train, at this moment"; the shown time stays put until the
   * visitor closes it and clicks again — or until the train steps (2026-10-30): the popup then
   * moves to the berth it stepped into, asking about that berth at the instant shown then. */
  atIso?: string | null;
  /** 2026-10-30 (sticky popup): set while the map can't tell which berth the train is in
   * (`followTrain`). The popup keeps showing what it last knew, says so, and stops polling. */
  lost?: FollowResult["lost"];
  /** 2026-10-30: TIPLOCs of the stations and labelled places drawn near the train's berth on the
   * map, nearest first — what the journey's position line names, instead of a berth. */
  nearbyTiplocs?: readonly string[];
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

const MATCH_BASIS_LABELS: Record<NonNullable<CurrentRunResponse["matchBasis"]>, string> = {
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

/** Milestone 57: the playback instant a frozen popup describes. CLAUDE.md rule 4 — canonical
 * timestamps are UTC, user-facing times render in `Europe/London`, which `formatIso` above
 * deliberately doesn't do (it shows raw UTC for the operational/diagnostic fields). */
function formatLondonClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: "Europe/London",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).format(d);
}

/** "12 min late", "On time", "3 min early" — or null when nothing says how late. */
export function lateness(minutes: number | null): string | null {
  if (minutes === null) return null;
  if (minutes === 0) return "On time";
  return minutes > 0 ? `${minutes} min late` : `${-minutes} min early`;
}

function hhmm(iso: string | null): string | null {
  if (!iso) return null;
  return formatLondonClock(iso).slice(0, 5);
}

const REPORT_KIND: Record<NonNullable<PopupDelay["lastReport"]>["eventKind"], string> = {
  departure: "departed",
  arrival: "arrived",
  arrival_destination: "arrived",
  unknown: "reported",
};

/** The last TRUST report, in words: "departed Preston 17:30, 5 min late". */
export function lastReportText(report: NonNullable<PopupDelay["lastReport"]>): string {
  const where = report.locationName ? ` ${report.locationName}` : "";
  const when = hhmm(report.at);
  const how = lateness(report.minutesLate);
  return `${REPORT_KIND[report.eventKind]}${where}${when ? ` ${when}` : ""}${how ? `, ${how.toLowerCase()}` : ""}`;
}

/** 2026-10-30 (popup redesign): the last TRUST report as a short sentence for under the status
 * pill — "Departed Bridge Street Junction 17:00". The lateness is the pill's, so it isn't repeated. */
function reportSentence(report: NonNullable<PopupDelay["lastReport"]>): string {
  const kind = REPORT_KIND[report.eventKind];
  const where = report.locationName ? ` ${placeCase(report.locationName)}` : "";
  const when = hhmm(report.at);
  return `${kind.charAt(0).toUpperCase()}${kind.slice(1)}${where}${when ? ` ${when}` : ""}`;
}

/** What the line under the status pill says: an estimate's working (Milestone 97c), or TRUST's
 * last report. `null` when there's nothing to add. */
function statusDetail(delay: PopupDelay): string | null {
  if (delay.estimated && delay.estimate) {
    const since = hhmm(delay.estimate.standingSince);
    let detail = delay.estimate.carried
      ? "Held earlier and not reported since"
      : delay.estimate.basis === "timing_point"
        ? `Still here after its booked departure${since ? `; standing since ${since}` : ""}`
        : `Standing${since ? ` since ${since}` : ""}, longer than trains normally take here`;
    if (delay.lastReport) detail += `. Last report: ${lastReportText(delay.lastReport)}`;
    return detail;
  }
  return delay.lastReport ? reportSentence(delay.lastReport) : null;
}

/** Milestone 97c (docs/adr/0021): how late the train is, marked when estimated — redesigned
 * 2026-10-30 as a pill in its band's colour. */
function StatusPill({ delay }: { delay: PopupDelay }): JSX.Element {
  const headline = lateness(delay.minutesLate) ?? "No delay information";
  const colours = delay.band === "none" ? null : DELAY_BAND_COLORS[delay.band];
  return (
    <span
      className="run-popup__status-pill"
      aria-label="Delay"
      style={colours ? { background: colours.fill, borderColor: colours.stroke } : undefined}
    >
      {delay.estimated ? <strong>Estimated </strong> : null}
      {delay.estimated ? headline.toLowerCase() : headline}
    </span>
  );
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

/** docs/adr/0009: the "was X, changed at HH:MM" suffix for a revised origin/destination — never
 * struck through here (owner request 2026-09-17, unlike openrail's own detail page); this is the
 * live map's `originTiploc`/`destinationTiploc` already being the *current* value, with this just
 * naming what it used to be. */
function changeSuffix(change: EffectiveChangeDetail): string {
  const was = change.previousTiploc
    ? formatLocation(change.previousTiploc, change.previousName)
    : "no scheduled value";
  return ` (was ${was}, changed ${formatIso(change.changedAt)})`;
}

function variationText(m: EffectiveMovement): string {
  const status = VARIATION_LABELS[m.variationStatus];
  if (m.variationMinutes === null || m.variationMinutes === 0) return status;
  return `${status} (${Math.abs(m.variationMinutes)} min)`;
}

/** 2026-10-30 (popup redesign): operators by their ATOC code, for the header. A code not listed
 * shows as itself; the code is always in the details. */
const OPERATOR_NAMES: Record<string, string> = {
  AW: "Transport for Wales",
  CC: "c2c",
  CH: "Chiltern Railways",
  CS: "Caledonian Sleeper",
  EM: "East Midlands Railway",
  GC: "Grand Central",
  GN: "Great Northern",
  GR: "LNER",
  GW: "Great Western Railway",
  GX: "Gatwick Express",
  HT: "Hull Trains",
  HX: "Heathrow Express",
  IL: "Island Line",
  LD: "Lumo",
  LE: "Greater Anglia",
  LM: "West Midlands Railway",
  LO: "London Overground",
  ME: "Merseyrail",
  NT: "Northern",
  SE: "Southeastern",
  SN: "Southern",
  SR: "ScotRail",
  SW: "South Western Railway",
  TL: "Thameslink",
  TP: "TransPennine Express",
  VT: "Avanti West Coast",
  XC: "CrossCountry",
  XR: "Elizabeth line",
};

/** Words CORPUS abbreviates, as they're usually written. */
const PLACE_WORDS: Record<string, string> = {
  JN: "Jn",
  JCN: "Jcn",
  ST: "St",
  RD: "Rd",
  SDG: "Sdg",
  SDGS: "Sdgs",
  NO: "No",
};
const PLACE_SMALL_WORDS = new Set(["AND", "OF", "THE", "ON", "UPON", "IN", "AT"]);

/**
 * 2026-10-30 (owner: the header looked shouty): a CORPUS name, which is all capitals, in normal
 * capitalisation — "SHIELDS TMD(E)" → "Shields TMD(E)", "GLASGOW CENTRAL LOW LEVEL" → "Glasgow
 * Central Low Level". A word without a vowel stays an abbreviation (TMD, CSD, WC); a name already
 * in mixed case is left alone.
 */
export function placeCase(name: string): string {
  if (name !== name.toUpperCase()) return name;
  let first = true;
  return name.replace(/[A-Z]+/g, (word) => {
    const wasFirst = first;
    first = false;
    const known = PLACE_WORDS[word];
    if (known) return known;
    if (word.length === 1 || !/[AEIOUY]/.test(word)) return word;
    if (!wasFirst && PLACE_SMALL_WORDS.has(word)) return word.toLowerCase();
    return word.charAt(0) + word.slice(1).toLowerCase();
  });
}

/** A location's name for the new layout: the CORPUS name in normal capitalisation, else its
 * TIPLOC. */
function placeName(tiploc: string | null | undefined, name: string | null | undefined): string {
  return name ? placeCase(name) : (tiploc ?? "—");
}

/** `HHMM` / `HHMMH` → minutes after midnight, or null. */
function bookedMinutes(raw: string | null): number | null {
  if (!raw) return null;
  const digits = raw.replace(/H$/, "");
  if (!/^\d{4}$/.test(digits)) return null;
  return Number(digits.slice(0, 2)) * 60 + Number(digits.slice(2, 4));
}

function minutesToClock(total: number): string {
  const m = ((total % 1440) + 1440) % 1440;
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

interface JourneyRow {
  loc: EffectiveLocation;
  index: number;
  isCall: boolean;
  /** The booked time shown: departure, or arrival at the destination, or the pass. */
  booked: string | null;
  report: LocationRunningReport | null;
}

function journeyRows(locations: EffectiveLocation[]): JourneyRow[] {
  return locations.map((loc, index) => {
    const arrival = loc.arrivalPublic ?? loc.arrivalWorking;
    const departure = loc.departurePublic ?? loc.departureWorking;
    const isCall = arrival !== null || departure !== null;
    const isDestination = loc.locationType === "destination";
    const booked = !isCall
      ? loc.passWorking
      : isDestination
        ? (arrival ?? departure)
        : (departure ?? arrival);
    const running = loc.running ?? null;
    const report = !running
      ? null
      : isDestination
        ? (running.arrival ?? running.departure)
        : (running.departure ?? running.arrival);
    return { loc, index, isCall, booked, report };
  });
}

/**
 * 2026-10-30 (owner request, popup redesign): the schedule as a journey — one row per stop with
 * its platform, booked time and, when the API sends TRUST's reports (`running`), the actual time;
 * stops still to come show an expected time carried forward from the current delay, marked as an
 * estimate. Passing points and stops already well behind the train fold away. The train's
 * position (the berth this popup is following) sits after the last reported stop. Replaces the
 * old six-column table, which didn't fit a phone.
 */
function JourneyTimeline({
  locations,
  currentLate,
  estimated,
  nearbyTiplocs,
}: {
  locations: EffectiveLocation[];
  currentLate: number | null;
  /** The delay carried forward is Milestone 97's held-train estimate, not TRUST's own figure. */
  estimated: boolean;
  /** Stations and labelled places on the map near the train's berth, nearest first. */
  nearbyTiplocs: readonly string[];
}): JSX.Element | null {
  const [showPasses, setShowPasses] = useState(false);
  const [showEarlier, setShowEarlier] = useState(false);
  if (locations.length === 0) return null;

  const rows = journeyRows(locations);
  const hasRunning = locations.some((loc) => loc.running !== undefined);
  let lastReported = -1;
  for (const row of rows) if (row.report) lastReported = row.index;
  const passCount = rows.filter((row) => !row.isCall).length;

  // Stops behind the train fold to the last one it called at or passed.
  const passedCalls = rows.filter((row) => row.isCall && row.index <= lastReported);
  const keepFrom = passedCalls.length > 0 ? passedCalls[passedCalls.length - 1]!.index : -1;
  const earlierCount = passedCalls.length - 1;
  const visible = rows.filter(
    (row) => (row.isCall || showPasses) && (showEarlier || row.index >= keepFrom),
  );
  const expectedLate = currentLate !== null && currentLate > 0 ? currentLate : null;
  let showedExpected = false;
  const position = trainPosition(rows, lastReported, nearbyTiplocs);

  const items: JSX.Element[] = [];
  visible.forEach((row) => {
    const passed = row.index <= lastReported;
    const late = row.report?.minutesLate ?? null;
    let actual: JSX.Element | null = null;
    if (row.report) {
      actual = (
        <span className={late !== null && late > 0 ? "run-popup__late" : "run-popup__ontime"}>
          {hhmm(row.report.actual)}
        </span>
      );
    } else if (!passed && hasRunning && expectedLate !== null) {
      const booked = bookedMinutes(row.booked);
      if (booked !== null) {
        showedExpected = true;
        actual = (
          <span className="run-popup__expected" title="Expected, if the current delay holds">
            {minutesToClock(booked + expectedLate)}
          </span>
        );
      }
    }
    const platform = row.report?.platform ?? row.loc.platform;
    items.push(
      <li
        key={row.loc.seqNo}
        className={[
          "run-popup__stop",
          passed ? "run-popup__stop--passed" : "",
          row.isCall ? "" : "run-popup__stop--pass",
          row.loc.locationType === "origin" || row.loc.locationType === "destination"
            ? "run-popup__stop--end"
            : "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        <span className="run-popup__stop-dot" aria-hidden="true" />
        <span className="run-popup__stop-name">
          {placeName(row.loc.tiploc, row.loc.locationName)}
          {row.isCall ? null : <span className="run-popup__stop-tag"> passes</span>}
        </span>
        <span className="run-popup__stop-platform">
          {platform ? <span className="run-popup__platform">{platform}</span> : null}
        </span>
        <span className="run-popup__stop-time">{formatTime(row.booked)}</span>
        {hasRunning ? <span className="run-popup__stop-time">{actual}</span> : null}
      </li>,
    );
  });
  if (position) {
    // After the last visible row the position follows; folded rows don't move it.
    const at = visible.filter((row) => row.index <= position.after).length;
    items.splice(
      at,
      0,
      <li key="now" className="run-popup__now">
        <span className="run-popup__now-mark" aria-hidden="true" />
        {position.text}
      </li>,
    );
  }

  return (
    <section className="run-popup__journey" aria-label="Journey">
      <div
        className={`run-popup__journey-head${hasRunning ? "" : " run-popup__journey-head--booked"}`}
      >
        <span />
        <span>Calling at</span>
        <span>Plat</span>
        <span>Booked</span>
        {hasRunning ? <span>Actual</span> : null}
      </div>
      {earlierCount > 0 ? (
        <button type="button" className="run-popup__fold" onClick={() => setShowEarlier((v) => !v)}>
          {showEarlier
            ? "Hide earlier stops"
            : `${earlierCount} earlier stop${earlierCount === 1 ? "" : "s"}`}
        </button>
      ) : null}
      <ol className={`run-popup__stops${hasRunning ? "" : " run-popup__stops--booked"}`}>
        {items}
      </ol>
      <div className="run-popup__journey-foot">
        {passCount > 0 ? (
          <button
            type="button"
            className="run-popup__fold"
            onClick={() => setShowPasses((v) => !v)}
          >
            {showPasses
              ? "Hide passing points"
              : `Show ${passCount} passing point${passCount === 1 ? "" : "s"}`}
          </button>
        ) : (
          <span />
        )}
        {showedExpected ? (
          <span>
            {estimated
              ? "Expected times assume the estimated delay holds"
              : "Expected times assume the delay holds"}
          </span>
        ) : null}
      </div>
    </section>
  );
}

/**
 * 2026-10-30 (owner): where the train is, in place names only — never a berth or TD code. "Near
 * X" when a station or labelled place on the map close to the train's berth is on its schedule
 * (calling or passing, matched by TIPLOC); otherwise "Between A and B" from its last TRUST report
 * and the next point of the schedule, passing points included. `after` is the schedule index the
 * marker follows.
 */
export function trainPosition(
  rows: ReadonlyArray<{ index: number; loc: { tiploc: string; locationName: string | null } }>,
  lastReported: number,
  nearbyTiplocs: readonly string[],
): { text: string; after: number } | null {
  for (const tiploc of nearbyTiplocs) {
    const row = rows.find((r) => r.loc.tiploc === tiploc);
    if (row) {
      const name = placeName(row.loc.tiploc, row.loc.locationName);
      // Beside the last report when there is one; otherwise just before the place itself.
      return { text: `Near ${name}`, after: lastReported >= 0 ? lastReported : row.index - 1 };
    }
  }
  if (lastReported < 0) return null;
  const from = rows[lastReported]!;
  const to = rows[lastReported + 1];
  const fromName = placeName(from.loc.tiploc, from.loc.locationName);
  return {
    text: to
      ? `Between ${fromName} and ${placeName(to.loc.tiploc, to.loc.locationName)}`
      : `At ${fromName}`,
    after: lastReported,
  };
}

/** One row of the details list. */
function DetailRow({ term, children }: { term: string; children: ReactNode }): JSX.Element {
  return (
    <>
      <dt>{term}</dt>
      <dd>{children}</dd>
    </>
  );
}

/**
 * 2026-10-30 (popup redesign): everything technical — schedule, match, TRUST, the latest raw
 * report, revisions, candidates, garner's note — folded into one "Train details" section, each
 * row still sent only with its own `popup.*` permission (Milestone 99). Unidentified trains open
 * it, since the candidates are then the main content.
 */
function TrainDetails({ data }: { data: CurrentRunResponse }): JSX.Element | null {
  const effective = data.effective;
  const hasRoute = effective ? "originTiploc" in effective : false;
  const rows: JSX.Element[] = [];
  // `popup.berth_codes` only (absent without it).
  if (data.occupancyEnteredAt !== undefined) {
    rows.push(
      <DetailRow key="entered" term="Entered berth">
        {formatIso(data.occupancyEnteredAt)}
      </DetailRow>,
    );
  }
  if (effective?.trainUid !== undefined && effective.stpIndicator !== undefined) {
    rows.push(
      <DetailRow key="schedule" term="Schedule">
        {effective.trainUid} · {STP_LABELS[effective.stpIndicator] ?? effective.stpIndicator}
      </DetailRow>,
    );
  }
  if (effective && data.matchBasis !== undefined) {
    rows.push(
      <DetailRow key="basis" term="Picked by">
        {data.matchBasis ? MATCH_BASIS_LABELS[data.matchBasis] : "—"}
      </DetailRow>,
    );
  }
  if (effective && hasRoute) {
    rows.push(
      <DetailRow key="operator" term="Operator">
        {effective.operatorCode ?? "—"}
      </DetailRow>,
      <DetailRow key="origin" term="Origin">
        {formatLocation(effective.originTiploc ?? null, effective.originName ?? null)}
        {effective.originChange ? changeSuffix(effective.originChange) : ""}
      </DetailRow>,
      <DetailRow key="destination" term="Destination">
        {formatLocation(effective.destinationTiploc ?? null, effective.destinationName ?? null)}
        {effective.destinationChange ? changeSuffix(effective.destinationChange) : ""}
      </DetailRow>,
    );
  }
  if (effective?.serviceCode !== undefined) {
    rows.push(
      <DetailRow key="service" term="Service code">
        {effective.serviceCode ?? "—"}
      </DetailRow>,
    );
  }
  if (effective?.activation) {
    const a = effective.activation;
    const change = effective.identityChange;
    rows.push(
      <DetailRow key="trust" term="TRUST ID">
        {a.trustId}
        {a.deduced ? " (deduced)" : ""}
        {change
          ? ` — now ${change.newTrustId} (changed ${formatIso(change.changedAt)})` +
            (change.previousHeadcode && change.newHeadcode
              ? ` — headcode ${change.previousHeadcode} → ${change.newHeadcode}`
              : "")
          : ""}
      </DetailRow>,
      <DetailRow key="activated" term="Activated">
        {formatIso(a.activatedAt)}
      </DetailRow>,
      <DetailRow key="toc" term="TOC">
        {a.tocId ?? "—"}
      </DetailRow>,
      <DetailRow key="wtt" term="WTT ID">
        {a.scheduleWttId ?? "—"}
      </DetailRow>,
    );
  }
  const m = effective?.latestMovement;
  if (m) {
    rows.push(
      <DetailRow key="report" term="Latest report">
        {m.eventKind.replace("_", " ")}
        {m.locName || m.locStanox ? ` at ${m.locName ?? m.locStanox}` : ""}
        {m.platform ? ` (platform ${m.platform})` : ""}
      </DetailRow>,
      <DetailRow key="when" term="When">
        {formatIso(m.actualTimestamp)}
      </DetailRow>,
      <DetailRow key="variation" term="Variation">
        {variationText(m)}
        {m.terminated ? " · terminated" : ""}
      </DetailRow>,
    );
  }
  if (data.unitAllocation && data.unitAllocation.length > 0) {
    rows.push(
      <DetailRow key="formation" term="Units">
        {data.unitAllocation
          .map((unit) => `${unit.unitNo} (${unit.fleetId}): ${unit.vehicles.join(" ")}`)
          .join("; ")}
      </DetailRow>,
    );
  }

  const candidates = data.candidateSchedules;
  const unidentified = !effective && candidates !== undefined;
  return (
    <details className="run-popup__details" open={unidentified}>
      <summary>Train details</summary>
      <dl>{rows}</dl>
      {effective?.activation === null ? (
        <p className="map-inspector__note">No TRUST activation seen for this schedule today.</p>
      ) : null}
      {candidates ? (
        candidates.length > 0 ? (
          <>
            <p className="map-inspector__note">
              {candidates.length} schedule{candidates.length === 1 ? "" : "s"} match headcode{" "}
              {data.headcode} today:
            </p>
            <ul className="map-inspector__candidates">
              {candidates.map((candidate) => (
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
      {data.note ? <p className="map-inspector__note">{data.note}</p> : null}
    </details>
  );
}

/**
 * 2026-10-30 (popup redesign; layout "A", owner's choice): a departure-board header — the headcode
 * in its map colour beside where the train is going, "from" where it started underneath; then one
 * row of how late it is, who runs it and its units; then the last report. Then the journey and
 * the details.
 */
function TrainCard({
  data,
  nearbyTiplocs,
}: {
  data: CurrentRunResponse;
  nearbyTiplocs: readonly string[];
}): JSX.Element {
  const effective = data.effective;
  const band = data.delay?.band;
  const chip = band && band !== "none" ? DELAY_BAND_COLORS[band] : null;
  const hasRoute = effective ? "originTiploc" in effective : false;
  const destination = hasRoute
    ? placeName(effective?.destinationTiploc, effective?.destinationName)
    : data.matchStatus === "ambiguous"
      ? "More than one possible train"
      : data.matchStatus === "unmatched"
        ? "Train not identified"
        : null;
  const origin = hasRoute ? placeName(effective?.originTiploc, effective?.originName) : null;
  const operator = effective?.operatorCode
    ? (OPERATOR_NAMES[effective.operatorCode] ?? effective.operatorCode)
    : null;
  // Sent only with `popup.formation` (empty without it), so the chips follow that permission.
  const units = data.unitAllocation ?? [];
  const currentLate =
    data.delay?.minutesLate ?? effective?.latestMovement?.variationMinutes ?? null;
  const detail = data.delay ? statusDetail(data.delay) : null;

  return (
    <>
      <header className="run-popup__header">
        <span
          className="run-popup__headcode"
          style={chip ? { background: chip.fill, borderColor: chip.stroke } : undefined}
        >
          {data.headcode}
        </span>
        <div className="run-popup__heading">
          {destination ? <div className="run-popup__route">{destination}</div> : null}
          {origin ? <div className="run-popup__from">from {origin}</div> : null}
        </div>
      </header>

      {data.delay || operator || units.length > 0 ? (
        <div className="run-popup__meta">
          {data.delay ? <StatusPill delay={data.delay} /> : null}
          {operator ? <span className="run-popup__operator">{operator}</span> : null}
          {units.length > 0 ? (
            <span className="run-popup__units" aria-label="Units">
              {units.map((unit) => (
                <span key={`${unit.position}-${unit.unitNo}`} className="run-popup__unit">
                  {unit.unitNo}
                  <span className="run-popup__unit-fleet">{unit.fleetId}</span>
                </span>
              ))}
            </span>
          ) : null}
        </div>
      ) : null}
      {detail ? <p className="run-popup__report">{detail}</p> : null}

      {effective?.locations ? (
        <JourneyTimeline
          locations={effective.locations}
          currentLate={currentLate}
          estimated={data.delay?.estimated ?? false}
          nearbyTiplocs={nearbyTiplocs}
        />
      ) : null}

      <TrainDetails data={data} />
    </>
  );
}

// ---- Original layout (viewers without `popup.new_layout`) ----

/** Milestone 97c (docs/adr/0021): the delay line every visitor sees, marked when estimated —
 * the original popup layout (viewers without `popup.new_layout`). */
function ClassicDelayLine({ delay }: { delay: PopupDelay | null | undefined }): JSX.Element | null {
  if (!delay) return null;
  const headline = lateness(delay.minutesLate) ?? "No delay information";
  const colours = delay.band === "none" ? null : DELAY_BAND_COLORS[delay.band];
  let detail: string | null = null;
  if (delay.estimated && delay.estimate) {
    const since = hhmm(delay.estimate.standingSince);
    detail = delay.estimate.carried
      ? "Held earlier and not reported since"
      : delay.estimate.basis === "timing_point"
        ? `Still here after its booked departure${since ? `; standing since ${since}` : ""}`
        : `Standing${since ? ` since ${since}` : ""}, longer than trains normally take here`;
    if (delay.lastReport) detail += `. Last report: ${lastReportText(delay.lastReport)}`;
  } else if (delay.lastReport) {
    detail = `Last report: ${lastReportText(delay.lastReport)}`;
  }
  return (
    <dl className="run-popup__delay">
      <dt>Delay</dt>
      <dd>
        {colours ? (
          <span
            className="map-page__delay-swatch"
            style={{ background: colours.fill, borderColor: colours.stroke }}
            aria-hidden="true"
          />
        ) : null}
        {delay.estimated ? <strong>Estimated </strong> : null}
        {delay.estimated ? headline.toLowerCase() : headline}
        {detail ? <span className="run-popup__delay-detail">{detail}</span> : null}
      </dd>
    </dl>
  );
}

/** Shared by both the full and reduced (anonymous) views — the API sends identical location
 * objects either way, so there's nothing to withhold here beyond the section already not
 * appearing for a non-matched/anonymous request at all. */
function ClassicLocationsTable({
  locations,
}: {
  locations: EffectiveLocation[];
}): JSX.Element | null {
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

/** The schedule rows the API sent (Milestone 99: each is a permission of its own). */
function ClassicEffectiveDetail({ data }: { data: CurrentRunResponse }): JSX.Element | null {
  const effective = data.effective;
  if (!effective) return null;
  const hasRoute = "originTiploc" in effective;
  return (
    <>
      <dl>
        {effective.trainUid !== undefined && effective.stpIndicator !== undefined ? (
          <>
            <dt>Schedule</dt>
            <dd>
              {effective.trainUid} · {STP_LABELS[effective.stpIndicator] ?? effective.stpIndicator}
            </dd>
          </>
        ) : null}
        {data.matchBasis !== undefined ? (
          <>
            <dt>Picked by</dt>
            <dd>{data.matchBasis ? MATCH_BASIS_LABELS[data.matchBasis] : "—"}</dd>
          </>
        ) : null}
        {hasRoute ? (
          <>
            <dt>Operator</dt>
            <dd>{effective.operatorCode ?? "—"}</dd>
          </>
        ) : null}
        {effective.serviceCode !== undefined ? (
          <>
            <dt>Service code</dt>
            <dd>{effective.serviceCode ?? "—"}</dd>
          </>
        ) : null}
        {hasRoute ? (
          <>
            <dt>Origin</dt>
            <dd>
              {formatLocation(effective.originTiploc ?? null, effective.originName ?? null)}
              {effective.originChange ? changeSuffix(effective.originChange) : ""}
            </dd>
            <dt>Destination</dt>
            <dd>
              {formatLocation(
                effective.destinationTiploc ?? null,
                effective.destinationName ?? null,
              )}
              {effective.destinationChange ? changeSuffix(effective.destinationChange) : ""}
            </dd>
          </>
        ) : null}
      </dl>

      {effective.activation ? (
        <dl>
          <dt>TRUST ID</dt>
          <dd>
            {effective.activation.trustId}
            {effective.activation.deduced ? " (deduced)" : ""}
            {effective.identityChange
              ? ` — now ${effective.identityChange.newTrustId} (changed ${formatIso(effective.identityChange.changedAt)})` +
                (effective.identityChange.previousHeadcode && effective.identityChange.newHeadcode
                  ? ` — headcode ${effective.identityChange.previousHeadcode} → ${effective.identityChange.newHeadcode}`
                  : "")
              : ""}
          </dd>
          <dt>Activated</dt>
          <dd>{formatIso(effective.activation.activatedAt)}</dd>
          <dt>TOC</dt>
          <dd>{effective.activation.tocId ?? "—"}</dd>
          <dt>WTT ID</dt>
          <dd>{effective.activation.scheduleWttId ?? "—"}</dd>
        </dl>
      ) : effective.activation === null ? (
        <p className="map-inspector__note">No TRUST activation seen for this schedule today.</p>
      ) : null}

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

      {effective.locations ? <ClassicLocationsTable locations={effective.locations} /> : null}
    </>
  );
}

/** The original popup body (before 2026-10-30), kept for viewers without `popup.new_layout`. */
function ClassicTrainCard({ data }: { data: CurrentRunResponse }): JSX.Element {
  return (
    <>
      <dl>
        <dt>Headcode</dt>
        <dd>{data.headcode}</dd>
        {data.occupancyEnteredAt !== undefined ? (
          <>
            <dt>Entered</dt>
            <dd>{formatIso(data.occupancyEnteredAt)}</dd>
          </>
        ) : null}
      </dl>

      <ClassicDelayLine delay={data.delay} />

      {data.note ? <p className="map-inspector__note">{data.note}</p> : null}
      <ClassicEffectiveDetail data={data} />

      <UnitAllocationSection unitAllocation={data.unitAllocation} />

      {data.candidateSchedules ? (
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
  );
}

function memberKey(member: RunPopupMember): string {
  return `${member.tdArea}|${member.berth}`;
}

interface MemberState {
  data: CurrentRunResponse | null;
  error: string | null;
  /** `null` = first fetch still in flight. */
  occupied: boolean | null;
}

const LOST_TEXT: Record<NonNullable<FollowResult["lost"]>, string> = {
  gone: "This train has gone out of view of the map. Showing what was last known; the popup picks it up again if it reappears.",
  ambiguous:
    "More than one train on the map shows this headcode, so the popup can't tell which is this one. Showing what was last known.",
};

/** One member's fetched-and-settled detail, pure display — no fetching of its own. Split out from
 * the fetch loop (now owned by `RunPopup` itself, one effect for every member) so a combined
 * berth's members never double-fetch and the "don't show the shell until everything has settled"
 * gate can live in one place. */
function RunPopupMemberSection({
  tdArea,
  berth,
  showHeading,
  nearbyTiplocs,
  newLayout,
  state,
}: {
  tdArea: string;
  berth: string;
  showHeading: boolean;
  nearbyTiplocs: readonly string[];
  newLayout: boolean;
  state: MemberState;
}): JSX.Element | null {
  if (!state.occupied) return null;
  const { data, error } = state;
  return (
    <div className="map-inspector__member">
      {showHeading ? (
        <p className="map-inspector__member-heading">
          {tdArea} {berth}
        </p>
      ) : null}
      {error ? <p className="app-error">{error}</p> : null}
      {!error && data ? (
        newLayout ? (
          <TrainCard data={data} nearbyTiplocs={nearbyTiplocs} />
        ) : (
          <ClassicTrainCard data={data} />
        )
      ) : null}
    </div>
  );
}

export function RunPopup({
  elementId,
  displayName,
  tdArea,
  berth,
  members,
  atIso = null,
  lost = null,
  nearbyTiplocs = [],
  onClose,
}: RunPopupProps): JSX.Element | null {
  const resolvedMembers = members && members.length > 0 ? members : [{ tdArea, berth }];
  const membersKey = resolvedMembers.map(memberKey).join(",");
  const [statesByKey, setStatesByKey] = useState<Record<string, MemberState>>({});
  // Frozen per berth — see `atIso`'s own doc comment for why this doesn't follow the clock. When
  // the train steps to another berth the instant is taken afresh, during that render.
  const [frozen, setFrozen] = useState({ key: membersKey, atIso });
  if (frozen.key !== membersKey) setFrozen({ key: membersKey, atIso });
  const frozenAtIso = frozen.key === membersKey ? frozen.atIso : atIso;
  const isHistorical = frozenAtIso !== null;
  // The members last shown in full. Kept on screen while a step's new berth is first fetched, so
  // a step changes the popup's contents in place instead of blanking it.
  const [shownMembers, setShownMembers] = useState<RunPopupMember[] | null>(null);
  const paused = lost !== null;
  const [expanded, setExpanded] = useState(false);
  // 2026-10-30 (owner): the redesigned popup is its own permission; without it, the original.
  const can = useCan();
  const newLayout = can("popup.new_layout");
  // 2026-10-30 (owner): berth names and TD/berth codes only with `popup.berth_codes`.
  const showBerths = can("popup.berth_codes");

  useEffect(() => {
    let cancelled = false;

    function fetchMember(member: RunPopupMember): void {
      const key = memberKey(member);
      const query = frozenAtIso === null ? "" : `?at=${encodeURIComponent(frozenAtIso)}`;
      fetch(
        `/api/v1/td/areas/${encodeURIComponent(member.tdArea)}/berths/${encodeURIComponent(member.berth)}/current-run${query}`,
      )
        .then(async (response) => {
          if (response.status === 404) {
            // Owner request (2026-09-13): a 404 here always means "nothing to show for this
            // member" — either it genuinely isn't occupied any more, or (anonymous,
            // `NO_PUBLIC_DETAIL`) the match isn't solid enough to show publicly. This member's
            // own section just omits itself; the whole popup closes only once every member does.
            // 2026-10-30: once shown, a member keeps its last answer — the train has usually just
            // stepped, and the map moves the popup after it (`followTrain`).
            if (!cancelled) {
              setStatesByKey((prev) =>
                prev[key]?.data
                  ? prev
                  : { ...prev, [key]: { data: null, error: null, occupied: false } },
              );
            }
            return null;
          }
          if (!response.ok) throw new Error(`Failed to load run detail (${response.status})`);
          return (await response.json()) as CurrentRunResponse;
        })
        .then((body) => {
          if (!cancelled && body) {
            setStatesByKey((prev) => ({
              ...prev,
              [key]: { data: body, error: null, occupied: true },
            }));
          }
        })
        .catch((err: unknown) => {
          if (!cancelled) {
            setStatesByKey((prev) => ({
              ...prev,
              [key]: {
                data: null,
                error: err instanceof Error ? err.message : "Failed to load run detail",
                occupied: true, // shown, not silently dropped — a genuine fetch failure is worth surfacing
              },
            }));
          }
        });
    }

    // A lost popup keeps what it has: asking about its last berth now would describe whichever
    // train has since entered it.
    if (paused) {
      return () => {
        cancelled = true;
      };
    }
    for (const member of resolvedMembers) fetchMember(member);
    // Milestone 57: a historical answer can't change — the occupancy and its run link are
    // settled facts about a past instant, so polling would re-fetch identical rows forever. The
    // poll exists only because garner's mirror advances every ~20s underneath a *live* berth.
    if (isHistorical) {
      return () => {
        cancelled = true;
      };
    }
    const intervalId = setInterval(() => {
      for (const member of resolvedMembers) fetchMember(member);
    }, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      clearInterval(intervalId);
    };
    // resolvedMembers/fetchMember are recreated every render — membersKey is the stable,
    // content-based dependency that actually decides when to restart polling (this project has
    // no react-hooks/exhaustive-deps lint rule configured to flag the omission). frozenAtIso and
    // isHistorical change only with membersKey, so they add nothing to restart on.
  }, [membersKey, paused]);

  const allSettled = resolvedMembers.every((m) => statesByKey[memberKey(m)] !== undefined);
  const anyOccupied = resolvedMembers.some((m) => statesByKey[memberKey(m)]?.occupied);
  const ready = allSettled && anyOccupied;

  useEffect(() => {
    if (ready) setShownMembers(resolvedMembers);
    // Only on reaching a fully answered member set, not for each render's fresh array.
  }, [ready, membersKey]);

  useEffect(() => {
    // Nothing to show where it was opened. After a step, the new berth not answering (a public
    // viewer's match there not being solid enough) leaves the previous berth's detail up instead.
    if (allSettled && !anyOccupied && shownMembers === null) onClose();
  }, [allSettled, anyOccupied, shownMembers, onClose]);

  // While every member's very first fetch is still in flight, render nothing at all rather than
  // a popup shell that might immediately vanish again. A non-solid public match 404s — usually
  // within well under a second — and a title bar + "Loading…" that flashes open then closes reads
  // as the popup being broken, not as "nothing to show" (reported against PX 0218/0214,
  // 2026-09-14). Once every member has settled, later poll ticks never make this go back to
  // false, so this only ever hides the opening frame, not a refresh.
  const displayMembers = ready ? resolvedMembers : shownMembers;
  if (!displayMembers) return null;

  return (
    <div
      role="status"
      className={[
        "map-inspector",
        "map-inspector--run",
        newLayout ? "map-inspector--new" : "map-inspector--classic",
        expanded ? "map-inspector--expanded" : "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      <div className="map-inspector__title">
        {/* 2026-10-30: on a phone the popup is a sheet along the bottom of the map, showing the
            train's header until this handle opens it to the full height. Hidden on wider screens. */}
        {newLayout ? (
          <button
            type="button"
            className="map-inspector__handle"
            aria-label={expanded ? "Show less" : "Show more"}
            aria-expanded={expanded}
            onClick={() => setExpanded((v) => !v)}
          />
        ) : null}
        <span className="map-inspector__berth">
          {showBerths
            ? displayName || elementId
            : newLayout
              ? null
              : displayMembers
                  .map((m) => statesByKey[memberKey(m)]?.data?.headcode)
                  .filter(Boolean)
                  .join(" / ")}
          {showBerths && displayMembers.length === 1 ? (
            <span className="map-inspector__subtitle">
              {" "}
              · {displayMembers[0]!.tdArea} {displayMembers[0]!.berth}
            </span>
          ) : null}
          {/* Milestone 57: name the instant this describes. Without it a frozen popup is
              indistinguishable from a live one that has stopped updating. */}
          {frozenAtIso !== null ? (
            <span className="map-inspector__subtitle"> · at {formatLondonClock(frozenAtIso)}</span>
          ) : null}
        </span>
        {newLayout && !lost ? (
          <span className="map-inspector__following" title="The popup moves with the train">
            Following
          </span>
        ) : null}
        <button type="button" className="map-inspector__close" aria-label="Close" onClick={onClose}>
          ×
        </button>
      </div>
      <div className="map-inspector__body">
        {lost ? <p className="map-inspector__lost">{LOST_TEXT[lost]}</p> : null}
        {displayMembers.map((member) => {
          const state = statesByKey[memberKey(member)];
          if (!state) return null;
          return (
            <RunPopupMemberSection
              key={memberKey(member)}
              tdArea={member.tdArea}
              berth={member.berth}
              showHeading={showBerths && displayMembers.length > 1}
              nearbyTiplocs={nearbyTiplocs}
              newLayout={newLayout}
              state={state}
            />
          );
        })}
      </div>
    </div>
  );
}
