import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 99 (docs/adr/0022): the permission registry. Every capability a user type or access
 * code can be given is listed here; the `permission` table holds the same keys (the foreign-key
 * target of every stored grant), and the API refuses to start if the two disagree.
 *
 * To add a permission: add an entry here, add a migration inserting its key into `permission`
 * (and granting it to whichever user types should start with it), then check it where it applies.
 * Admin holds every permission automatically.
 */

export type PermissionCategory = "viewing" | "map" | "popup" | "editor" | "tools" | "admin";

export interface PermissionDefinition {
  key: string;
  category: PermissionCategory;
  label: string;
  description: string;
}

export const PERMISSION_CATEGORIES: { key: PermissionCategory; label: string }[] = [
  { key: "viewing", label: "Viewing" },
  { key: "map", label: "Map" },
  { key: "popup", label: "Train popup" },
  { key: "editor", label: "Editor" },
  { key: "tools", label: "Tools" },
  { key: "admin", label: "Admin" },
];

export const PERMISSIONS = [
  {
    key: "site.view",
    category: "viewing",
    label: "Use the site",
    description:
      "The map list, place search, berth and schedule lookups. Without it a visitor is asked to log in or enter a code.",
  },
  {
    key: "site.light_mode",
    category: "viewing",
    label: "Light mode",
    description:
      "Switch the site and maps between dark and light (remembered in the browser). Presentation only.",
  },
  {
    key: "maps.view_public",
    category: "viewing",
    label: "Public maps",
    description: "Maps whose visibility is public.",
  },
  {
    key: "maps.view_all",
    category: "viewing",
    label: "All maps",
    description: "Every map, restricted ones included.",
  },
  {
    key: "map.playback",
    category: "map",
    label: "Playback",
    description: "Replaying a map's history.",
  },
  {
    key: "map.delay_colours",
    category: "map",
    label: "Delay colours",
    description: "Colouring trains by delay.",
  },
  {
    key: "map.signal_numbers",
    category: "map",
    label: "Signal numbers",
    description: "Showing signal numbers on the map.",
  },
  {
    key: "map.feed_gap_details",
    category: "map",
    label: "Feed gap details",
    description: "When and where data feeds dropped out, not just that they did.",
  },
  {
    key: "map.s_class_panel",
    category: "map",
    label: "S-Class panel",
    description: "The S-Class bit panel on the map.",
  },
  {
    key: "popup.headcode",
    category: "popup",
    label: "Headcode",
    description: "The headcode and when the train entered the berth. Without it there is no popup.",
  },
  {
    key: "popup.new_layout",
    category: "popup",
    label: "New popup layout",
    description:
      "The 2026-10-30 train popup: headcode header, journey timeline with live TRUST times, folded details, bottom sheet on phones. Without it, the original layout.",
  },
  {
    key: "popup.berth_codes",
    category: "popup",
    label: "Berth and TD references",
    description:
      "Berth names, TD area and berth codes, and when the train entered the berth. Without them the popup names no berth.",
  },
  { key: "popup.delay", category: "popup", label: "Delay", description: "The delay line." },
  {
    key: "popup.delay_explanation",
    category: "popup",
    label: "Delay explanation",
    description: "How the delay was worked out, and the last TRUST report behind it.",
  },
  {
    key: "popup.origin_destination",
    category: "popup",
    label: "Operator, origin and destination",
    description: "Who runs the train and where it runs from and to.",
  },
  {
    key: "popup.calling_points",
    category: "popup",
    label: "Calling points",
    description: "The full schedule table.",
  },
  {
    key: "popup.formation",
    category: "popup",
    label: "Formation",
    description: "The units allocated to the train.",
  },
  {
    key: "popup.schedule",
    category: "popup",
    label: "Schedule identity",
    description: "Train UID, STP indicator, service code, and origin/destination changes.",
  },
  {
    key: "popup.match_details",
    category: "popup",
    label: "Match details",
    description: "How the schedule was picked, and how confident the match is.",
  },
  {
    key: "popup.weak_matches",
    category: "popup",
    label: "Uncertain matches",
    description:
      "Popups for ambiguous, unmatched and headcode-only matches (otherwise only confident matches show).",
  },
  {
    key: "popup.candidates",
    category: "popup",
    label: "Candidate schedules",
    description: "Every schedule with the same headcode today.",
  },
  {
    key: "popup.trust",
    category: "popup",
    label: "TRUST activation",
    description: "TRUST ID, activation time, TOC and WTT ID.",
  },
  {
    key: "popup.latest_report",
    category: "popup",
    label: "Latest TRUST report",
    description: "The most recent TRUST movement report.",
  },
  {
    key: "editor.view",
    category: "editor",
    label: "Open the editor",
    description: "Open maps in the editor and read drafts and revisions.",
  },
  {
    key: "maps.edit",
    category: "editor",
    label: "Edit maps",
    description: "Save drafts and change bindings.",
  },
  {
    key: "maps.publish",
    category: "editor",
    label: "Publish",
    description: "Publish maps and modules.",
  },
  {
    key: "maps.manage",
    category: "editor",
    label: "Manage maps",
    description:
      "Create, rename and delete maps; map visibility and regions; make modules from a selection.",
  },
  {
    key: "tools.berth_explorer",
    category: "tools",
    label: "Berth explorer",
    description: "Browse berths and their steps by area.",
  },
  {
    key: "tools.berth_query",
    category: "tools",
    label: "Berth query and steps",
    description: "Ad hoc berth event lookups.",
  },
  {
    key: "tools.s_class",
    category: "tools",
    label: "S-Class explorer",
    description: "Explore S-Class bits and edit their definitions.",
  },
  {
    key: "tools.td_boundaries",
    category: "tools",
    label: "TD boundaries",
    description: "Curate TD-area boundary links.",
  },
  {
    key: "tools.maintenance",
    category: "tools",
    label: "Maintenance",
    description: "Queue area maintenance and backfill jobs.",
  },
  {
    key: "admin.users",
    category: "admin",
    label: "Users and groups",
    description: "Create, change and remove users and groups.",
  },
  {
    key: "admin.user_types",
    category: "admin",
    label: "User types",
    description: "Create user types and change the permission matrix.",
  },
  {
    key: "admin.access_codes",
    category: "admin",
    label: "Access codes",
    description: "Create and manage access codes and their uses.",
  },
  {
    key: "admin.site_settings",
    category: "admin",
    label: "Site settings",
    description: "Site-wide settings, including whether the public can view without a code.",
  },
  {
    key: "admin.audit_log",
    category: "admin",
    label: "Audit log",
    description: "Read the log of admin and editor changes.",
  },
] as const satisfies readonly PermissionDefinition[];

export type Permission = (typeof PERMISSIONS)[number]["key"];

export const PERMISSION_KEYS: readonly Permission[] = PERMISSIONS.map((p) => p.key);

const PERMISSION_KEY_SET = new Set<string>(PERMISSION_KEYS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === "string" && PERMISSION_KEY_SET.has(value);
}

/** An access code may grant editor permissions (owner, 2026-10-28) but never an admin one. */
export function isCodeGrantable(permission: Permission): boolean {
  return !permission.startsWith("admin.");
}

/** The editor permissions, which the access-code form warns about. */
export const EDITOR_PERMISSIONS: readonly Permission[] = PERMISSIONS.filter(
  (p) => p.category === "editor",
).map((p) => p.key);

/** Returns the keys present in only one of the registry and the `permission` table. */
export async function checkPermissionTable(
  db: Queryable,
): Promise<{ missingFromTable: string[]; unknownInTable: string[] }> {
  const { rows } = await db.query<{ key: string }>(`select key from permission`);
  const inTable = new Set(rows.map((row) => row.key));
  return {
    missingFromTable: PERMISSION_KEYS.filter((key) => !inTable.has(key)),
    unknownInTable: [...inTable].filter((key) => !PERMISSION_KEY_SET.has(key)).sort(),
  };
}
