/**
 * Owner request 2026-09-17: a small number of berths represent a physical split-berth group used
 * for permissive working (e.g. a 3- or 4-way platform split, or an approach berth stepping almost
 * immediately through several positions) with no room on the map to draw each member separately.
 * A "combined berth" is up to 4 `tdBerth` bindings (docs/MAP_EDITOR_SPEC.md's berth section)
 * sharing one map element; this joins their current state into the single display that shared
 * element shows.
 *
 * Author-declared only (each member's own `combinedOrder`, never inferred), and purely a
 * rendering/display concern: `berth_current_state`/`berth_occupancy`, history and playback all
 * keep every member's own real, individual data untouched (same "cosmetic only" precedent as the
 * `inhibitedBy` berth-blanking rule).
 */
export interface CombinedBerthMember {
  tdArea: string;
  berth: string;
  /** This member's position in the group (1-4) — join order, not arrival order. */
  order: number;
  /** `null` means this member is currently vacant (DATA_MODEL.md: "treat `description IS NOT
   * NULL` as the occupied signal"). */
  description: string | null;
  enteredAt: string | null;
}

export interface CombinedBerthState {
  description: string | null;
  enteredAt: string | null;
}

/**
 * Joins every currently-occupied member's description, in `order`, separated by a space (e.g.
 * `"A001 B001"`). `enteredAt` is the most-recently-entered occupied member's — the train that
 * most recently joined this combined position — an explicit choice among several reasonable ones
 * since simultaneous occupants make "the" entered time ambiguous.
 *
 * A single-member "group" (the overwhelming, non-combined case) reduces to that member's own
 * state unchanged, so callers can always run every berth through this function rather than
 * special-casing "is this actually combined?".
 */
export function joinCombinedBerthState(members: CombinedBerthMember[]): CombinedBerthState {
  const occupied = members
    .filter((member) => member.description !== null)
    .sort((a, b) => a.order - b.order);
  if (occupied.length === 0) return { description: null, enteredAt: null };

  let enteredAt: string | null = null;
  for (const member of occupied) {
    if (member.enteredAt !== null && (enteredAt === null || member.enteredAt > enteredAt)) {
      enteredAt = member.enteredAt;
    }
  }

  return {
    description: occupied.map((member) => member.description).join(" "),
    enteredAt,
  };
}
