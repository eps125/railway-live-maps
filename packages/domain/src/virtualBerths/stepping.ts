/**
 * docs/adr/0012: the pure decision core of `project-virtual-berths`
 * (`apps/worker/src/virtualBerths/projector.ts`). A GPS-sourced TRUST movement report for a given
 * `trust_id` either opens a fresh virtual-berth occupancy, steps an existing one from wherever it
 * was to the new STANOX, or (when the report says the train has terminated) opens then
 * immediately closes it. Unlike ADR 0007's TD-area boundary crossings, no owner-curated chain
 * ordering is needed here at all — the report's own `trust_id` is direct identity evidence, not
 * inferred, so "the previous virtual berth to close" is simply "wherever this exact trust_id
 * currently holds an open virtual occupancy," found by a plain lookup, not a authored sequence.
 */

export interface VirtualBerthStepInput {
  /** The STANOX this occupancy is currently open at for this `trust_id`, if any — found by a
   * plain `trust_id` lookup against `virtual_berth_occupancy`, nationwide (not scoped to "the
   * same chain," since there is no chain to scope to). */
  existingStanox: string | null;
  /** The STANOX this report was made at. */
  newStanox: string;
  /** `train_terminated` decoded from this report's own flags. */
  terminated: boolean;
}

export interface VirtualBerthStepDecision {
  /** Close the existing occupancy at `existingStanox` (only meaningful when `existingStanox` is
   * non-null and differs from `newStanox`) — the "step" motion, mirroring TD's `CA` closing
   * `from` and opening `to` in one physical event. */
  closeExisting: boolean;
  /** Open (or, for a same-STANOX repeat report, re-affirm) an occupancy at `newStanox`. Always
   * true — every report that reaches this decision names a real STANOX to be present at. */
  openNew: boolean;
  /** Close the just-opened occupancy immediately — TRUST's own evidence that the journey ended
   * here, never inferred from the absence of a later report. */
  terminateNew: boolean;
}

export function decideVirtualBerthStep(input: VirtualBerthStepInput): VirtualBerthStepDecision {
  const closeExisting = input.existingStanox !== null && input.existingStanox !== input.newStanox;
  return {
    closeExisting,
    openNew: true,
    terminateNew: input.terminated,
  };
}
