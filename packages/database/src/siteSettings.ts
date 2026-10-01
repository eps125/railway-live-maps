import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 83 (docs/adr/0018): admin-changeable site settings, stored in `app_setting` as jsonb.
 * Each known key has a type and a default here, so a missing row (or a malformed value) always
 * reads back as the default rather than breaking a page.
 */
export type SiteAccessMode = "open" | "code_required";

export const SITE_SETTING_DEFAULTS = {
  /** Group the public map list by region (with an A–Z toggle) instead of A–Z only. */
  map_list_region_grouping: false as boolean,
  /** Milestone 84: `code_required` asks guests for an access code before anything else. */
  site_access_mode: "open" as SiteAccessMode,
} as const;

/** Settings whose value must be one of a fixed list. */
const SITE_SETTING_CHOICES: Partial<
  Record<keyof typeof SITE_SETTING_DEFAULTS, readonly unknown[]>
> = {
  site_access_mode: ["open", "code_required"],
};

export type SiteSettingKey = keyof typeof SITE_SETTING_DEFAULTS;
export type SiteSettings = { [K in SiteSettingKey]: (typeof SITE_SETTING_DEFAULTS)[K] };

export function isSiteSettingKey(key: string): key is SiteSettingKey {
  return Object.prototype.hasOwnProperty.call(SITE_SETTING_DEFAULTS, key);
}

/** True when `value` has the same JSON type as the key's default (and, for a setting with a fixed
 * list of values, is one of them). */
export function isValidSiteSettingValue(key: SiteSettingKey, value: unknown): boolean {
  if (typeof value !== typeof SITE_SETTING_DEFAULTS[key]) return false;
  const choices = SITE_SETTING_CHOICES[key];
  return !choices || choices.includes(value);
}

export async function getSiteSettings(db: Queryable): Promise<SiteSettings> {
  const { rows } = await db.query<{ key: string; value: unknown }>(
    `select key, value from app_setting where key = any($1::text[])`,
    [Object.keys(SITE_SETTING_DEFAULTS)],
  );
  const settings: Record<string, unknown> = { ...SITE_SETTING_DEFAULTS };
  for (const row of rows) {
    if (isSiteSettingKey(row.key) && isValidSiteSettingValue(row.key, row.value)) {
      settings[row.key] = row.value;
    }
  }
  return settings as SiteSettings;
}

export async function setSiteSetting<K extends SiteSettingKey>(
  db: Queryable,
  key: K,
  value: SiteSettings[K],
  updatedBy: string | null,
): Promise<void> {
  await db.query(
    `insert into app_setting (key, value, updated_at, updated_by)
     values ($1, $2::jsonb, now(), $3)
     on conflict (key) do update
       set value = excluded.value, updated_at = excluded.updated_at, updated_by = excluded.updated_by`,
    [key, JSON.stringify(value), updatedBy],
  );
}
