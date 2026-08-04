/** docs/DATA_MODEL.md §4-5: TD child events are either C-Class (berth) or S-Class (signalling data). */
export const TD_MESSAGE_CLASSES = ["C", "S"] as const;
export type TdMessageClass = (typeof TD_MESSAGE_CLASSES)[number];

/** docs/PROJECT_SPEC.md §7: the four C-Class message types and their exact semantics. */
export const TD_C_CLASS_MESSAGE_TYPES = ["CA", "CB", "CC", "CT"] as const;
export type TdCClassMessageType = (typeof TD_C_CLASS_MESSAGE_TYPES)[number];
