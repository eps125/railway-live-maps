import { createHash, randomBytes, randomInt } from "node:crypto";
import type { Queryable } from "./checkpoint.js";

/**
 * Milestone 84 (docs/adr/0018 §6): temporary guest access codes. A code is entered on the access
 * page; each entry creates an `access_grant` lasting a fixed time from entry. The browser keeps
 * only an opaque random token per grant; this module stores and looks up its SHA-256 hash.
 */

export type AccessCodeScope = "site" | "maps";

/** No 0/O, 1/I/L: a generated code is read aloud or copied by hand. */
const CODE_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
const GENERATED_CODE_LENGTH = 8;

/** Codes are matched ignoring case, spaces and dashes. */
export function normalizeAccessCode(raw: string): string {
  return raw.toUpperCase().replace(/[\s-]+/g, "");
}

/** True when a custom code is acceptable: 4-32 letters/digits once spaces and dashes are gone. */
export function isValidCustomAccessCode(raw: string): boolean {
  return /^[A-Za-z0-9\s-]+$/.test(raw) && /^[A-Z0-9]{4,32}$/.test(normalizeAccessCode(raw));
}

/** e.g. `K7QM-3XRP` — 8 characters from a 31-letter alphabet (~40 bits; entry is rate-limited). */
export function generateAccessCode(): string {
  let code = "";
  for (let i = 0; i < GENERATED_CODE_LENGTH; i += 1) {
    code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  }
  return `${code.slice(0, 4)}-${code.slice(4)}`;
}

export function generateGrantToken(): string {
  return randomBytes(32).toString("hex");
}

export function hashGrantToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

/** The network an address belongs to, for spotting a code used from unrelated places: IPv4 /24,
 * IPv6 /48. An IPv4-mapped IPv6 address counts as IPv4. */
export function networkOf(ip: string): string {
  const v4 = ip.replace(/^::ffff:/i, "");
  if (/^\d+\.\d+\.\d+\.\d+$/.test(v4)) return v4.split(".").slice(0, 3).join(".") + ".0/24";
  const groups = ip.toLowerCase().split(":");
  return groups.slice(0, 3).join(":") + "::/48";
}

export class DuplicateAccessCodeError extends Error {
  constructor() {
    super("That code is already in use");
    this.name = "DuplicateAccessCodeError";
  }
}

export class UnknownMapError extends Error {
  constructor(ids: string[]) {
    super(`Unknown map id(s): ${ids.join(", ")}`);
    this.name = "UnknownMapError";
  }
}

export interface AccessCodeInput {
  label: string;
  /** Custom code text; omitted to generate one. */
  code?: string | undefined;
  scope: AccessCodeScope;
  mapIds: string[];
  maxUses: number | null;
  accessSeconds: number;
  validUntil: Date | null;
  notes?: string | null | undefined;
}

export interface AccessCodeSummary {
  id: string;
  label: string;
  code: string;
  scope: AccessCodeScope;
  mapIds: string[];
  maxUses: number | null;
  useCount: number;
  accessSeconds: number;
  validUntil: Date | null;
  notes: string | null;
  createdBy: string | null;
  createdAt: Date;
  revokedAt: Date | null;
  activeGrants: number;
  lastUsedAt: Date | null;
  /** `revoked`, `expired` (past valid-until), `used_up`, or `active`. */
  status: "active" | "revoked" | "expired" | "used_up";
}

interface AccessCodeRow {
  id: string;
  label: string;
  code: string;
  scope: AccessCodeScope;
  map_ids: string[];
  max_uses: number | null;
  use_count: number;
  access_seconds: number;
  valid_until: Date | null;
  notes: string | null;
  created_by: string | null;
  created_at: Date;
  revoked_at: Date | null;
  active_grants: string;
  last_used_at: Date | null;
}

function codeStatus(row: AccessCodeRow, now: Date): AccessCodeSummary["status"] {
  if (row.revoked_at) return "revoked";
  if (row.valid_until && row.valid_until <= now) return "expired";
  if (row.max_uses !== null && row.use_count >= row.max_uses) return "used_up";
  return "active";
}

function toSummary(row: AccessCodeRow, now: Date): AccessCodeSummary {
  return {
    id: row.id,
    label: row.label,
    code: row.code,
    scope: row.scope,
    mapIds: row.map_ids,
    maxUses: row.max_uses,
    useCount: row.use_count,
    accessSeconds: row.access_seconds,
    validUntil: row.valid_until,
    notes: row.notes,
    createdBy: row.created_by,
    createdAt: row.created_at,
    revokedAt: row.revoked_at,
    activeGrants: Number(row.active_grants),
    lastUsedAt: row.last_used_at,
    status: codeStatus(row, now),
  };
}

const CODE_SELECT = `
  select c.id::text, c.label, c.code, c.scope, c.max_uses, c.use_count, c.access_seconds,
         c.valid_until, c.notes, c.created_by, c.created_at, c.revoked_at,
         coalesce((select array_agg(acm.map_id::text order by acm.map_id)
                     from access_code_map acm where acm.code_id = c.id), '{}') as map_ids,
         (select count(*) from access_grant g
           where g.code_id = c.id and g.revoked_at is null and g.expires_at > now())::text
           as active_grants,
         (select max(g.created_at) from access_grant g where g.code_id = c.id) as last_used_at
    from access_code c`;

export async function listAccessCodes(db: Queryable): Promise<AccessCodeSummary[]> {
  const { rows } = await db.query<AccessCodeRow>(`${CODE_SELECT} order by c.created_at desc`);
  const now = new Date();
  return rows.map((row) => toSummary(row, now));
}

export async function findAccessCode(db: Queryable, id: string): Promise<AccessCodeSummary | null> {
  if (!/^\d+$/.test(id)) return null;
  const { rows } = await db.query<AccessCodeRow>(`${CODE_SELECT} where c.id = $1`, [id]);
  return rows[0] ? toSummary(rows[0], new Date()) : null;
}

async function assertMapsExist(db: Queryable, mapIds: string[]): Promise<void> {
  if (mapIds.length === 0) return;
  if (mapIds.some((id) => !/^\d+$/.test(id))) throw new UnknownMapError(mapIds);
  const { rows } = await db.query<{ id: string }>(
    `select id::text from map where id = any($1::bigint[])`,
    [mapIds],
  );
  const found = new Set(rows.map((row) => row.id));
  const missing = mapIds.filter((id) => !found.has(id));
  if (missing.length > 0) throw new UnknownMapError(missing);
}

async function setCodeMaps(db: Queryable, codeId: string, mapIds: string[]): Promise<void> {
  const unique = [...new Set(mapIds)];
  await assertMapsExist(db, unique);
  await db.query(`delete from access_code_map where code_id = $1`, [codeId]);
  await db.query(`insert into access_code_map (code_id, map_id) select $1, unnest($2::bigint[])`, [
    codeId,
    unique,
  ]);
}

/** Creates a code (generating its text unless `input.code` is given). Run inside a transaction. */
export async function createAccessCode(
  db: Queryable,
  input: AccessCodeInput,
  createdBy: string | null,
): Promise<AccessCodeSummary> {
  const code = input.code?.trim() || generateAccessCode();
  try {
    const { rows } = await db.query<{ id: string }>(
      `insert into access_code (label, code, code_normalized, scope, max_uses, access_seconds,
                                valid_until, notes, created_by)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       returning id::text`,
      [
        input.label.trim(),
        code,
        normalizeAccessCode(code),
        input.scope,
        input.maxUses,
        input.accessSeconds,
        input.validUntil,
        input.notes?.trim() || null,
        createdBy,
      ],
    );
    const id = rows[0]!.id;
    await setCodeMaps(db, id, input.scope === "maps" ? input.mapIds : []);
    return (await findAccessCode(db, id))!;
  } catch (error) {
    if (isUniqueViolation(error)) throw new DuplicateAccessCodeError();
    throw error;
  }
}

export interface AccessCodeUpdate {
  label?: string | undefined;
  scope?: AccessCodeScope | undefined;
  mapIds?: string[] | undefined;
  maxUses?: number | null | undefined;
  accessSeconds?: number | undefined;
  validUntil?: Date | null | undefined;
  notes?: string | null | undefined;
}

export class MaxUsesBelowUseCountError extends Error {
  constructor(useCount: number) {
    super(`This code has already been used ${useCount} times`);
    this.name = "MaxUsesBelowUseCountError";
  }
}

/** Changes a code's settings. A new access period applies to future uses only. Run inside a
 * transaction. */
export async function updateAccessCode(
  db: Queryable,
  id: string,
  update: AccessCodeUpdate,
): Promise<AccessCodeSummary | null> {
  const current = await findAccessCode(db, id);
  if (!current) return null;
  if (
    update.maxUses !== undefined &&
    update.maxUses !== null &&
    update.maxUses < current.useCount
  ) {
    throw new MaxUsesBelowUseCountError(current.useCount);
  }
  await db.query(
    `update access_code
        set label = coalesce($2, label),
            scope = coalesce($3, scope),
            max_uses = case when $4::boolean then $5 else max_uses end,
            access_seconds = coalesce($6, access_seconds),
            valid_until = case when $7::boolean then $8 else valid_until end,
            notes = case when $9::boolean then $10 else notes end
      where id = $1`,
    [
      id,
      update.label?.trim() ?? null,
      update.scope ?? null,
      update.maxUses !== undefined,
      update.maxUses ?? null,
      update.accessSeconds ?? null,
      update.validUntil !== undefined,
      update.validUntil ?? null,
      update.notes !== undefined,
      update.notes?.trim() || null,
    ],
  );
  const scope = update.scope ?? current.scope;
  if (update.mapIds !== undefined || update.scope !== undefined) {
    await setCodeMaps(db, id, scope === "maps" ? (update.mapIds ?? current.mapIds) : []);
  }
  return findAccessCode(db, id);
}

/** Revokes a code and every grant made from it. Returns false for an unknown code. */
export async function revokeAccessCode(
  db: Queryable,
  id: string,
  revokedBy: string | null,
): Promise<boolean> {
  if (!/^\d+$/.test(id)) return false;
  const { rows } = await db.query<{ id: string }>(
    `update access_code set revoked_at = coalesce(revoked_at, now()),
                            revoked_by = coalesce(revoked_by, $2)
      where id = $1 returning id`,
    [id, revokedBy],
  );
  if (rows.length === 0) return false;
  await db.query(
    `update access_grant set revoked_at = now(), revoked_by = $2
      where code_id = $1 and revoked_at is null`,
    [id, revokedBy],
  );
  return true;
}

export type RedeemResult =
  | {
      ok: true;
      token: string;
      grantId: string;
      codeId: string;
      expiresAt: Date;
    }
  | { ok: false; reason: "unknown" | "revoked" | "expired" | "used_up" };

/**
 * Enters a code: checks it can still be used, counts the use and creates the grant, atomically
 * (the row lock means two simultaneous entries of a last remaining use cannot both succeed). Run
 * inside a transaction.
 */
export async function redeemAccessCode(
  db: Queryable,
  input: { code: string; ip: string | null; userAgent: string | null; now?: Date },
): Promise<RedeemResult> {
  const now = input.now ?? new Date();
  const normalized = normalizeAccessCode(input.code);
  if (!/^[A-Z0-9]{4,32}$/.test(normalized)) return { ok: false, reason: "unknown" };
  const { rows } = await db.query<{
    id: string;
    max_uses: number | null;
    use_count: number;
    access_seconds: number;
    valid_until: Date | null;
    revoked_at: Date | null;
  }>(
    `select id::text, max_uses, use_count, access_seconds, valid_until, revoked_at
       from access_code where code_normalized = $1 for update`,
    [normalized],
  );
  const code = rows[0];
  if (!code) return { ok: false, reason: "unknown" };
  if (code.revoked_at) return { ok: false, reason: "revoked" };
  if (code.valid_until && code.valid_until <= now) return { ok: false, reason: "expired" };
  if (code.max_uses !== null && code.use_count >= code.max_uses) {
    return { ok: false, reason: "used_up" };
  }

  await db.query(`update access_code set use_count = use_count + 1 where id = $1`, [code.id]);
  const token = generateGrantToken();
  const expiresAt = new Date(now.getTime() + code.access_seconds * 1000);
  const grant = await db.query<{ id: string }>(
    `insert into access_grant (code_id, token_hash, created_at, expires_at, first_ip,
                               first_user_agent, last_seen_at, last_ip)
     values ($1, $2, $3, $4, $5, $6, $3, $5)
     returning id::text`,
    [
      code.id,
      hashGrantToken(token),
      now,
      expiresAt,
      input.ip,
      input.userAgent?.slice(0, 400) ?? null,
    ],
  );
  return { ok: true, token, grantId: grant.rows[0]!.id, codeId: code.id, expiresAt };
}

export interface ActiveGrant {
  id: string;
  codeId: string;
  scope: AccessCodeScope;
  expiresAt: Date;
  codeLabel: string;
}

/** The grant behind a browser's token, if it is still valid (not expired, not revoked, its code
 * not revoked). */
export async function findActiveGrant(
  db: Queryable,
  token: string,
  now: Date = new Date(),
): Promise<ActiveGrant | null> {
  const { rows } = await db.query<{
    id: string;
    code_id: string;
    scope: AccessCodeScope;
    expires_at: Date;
    label: string;
  }>(
    `select g.id::text, g.code_id::text, c.scope, g.expires_at, c.label
       from access_grant g
       join access_code c on c.id = g.code_id
      where g.token_hash = $1 and g.revoked_at is null and c.revoked_at is null
        and g.expires_at > $2`,
    [hashGrantToken(token), now],
  );
  const row = rows[0];
  return row
    ? {
        id: row.id,
        codeId: row.code_id,
        scope: row.scope,
        expiresAt: row.expires_at,
        codeLabel: row.label,
      }
    : null;
}

export async function mapsForAccessCode(
  db: Queryable,
  codeId: string,
): Promise<{ slug: string; name: string }[]> {
  const { rows } = await db.query<{ slug: string; name: string }>(
    `select m.slug, m.name from access_code_map acm join map m on m.id = acm.map_id
      where acm.code_id = $1 order by lower(m.name)`,
    [codeId],
  );
  return rows;
}

export interface GrantActivityEntry {
  grantId: string;
  hour: Date;
  ip: string;
  userAgent: string | null;
  requests: number;
  lastSeenAt: Date;
}

/** Adds request counts (batched by the API) and moves each grant's last-seen forward. */
export async function recordGrantActivity(
  db: Queryable,
  entries: GrantActivityEntry[],
): Promise<void> {
  if (entries.length === 0) return;
  await db.query(
    `insert into access_grant_activity (grant_id, hour, ip, user_agent, request_count)
     select * from unnest($1::bigint[], $2::timestamptz[], $3::text[], $4::text[], $5::int[])
     on conflict (grant_id, hour, ip) do update
       set request_count = access_grant_activity.request_count + excluded.request_count,
           user_agent = coalesce(excluded.user_agent, access_grant_activity.user_agent)`,
    [
      entries.map((e) => e.grantId),
      entries.map((e) => e.hour),
      entries.map((e) => e.ip),
      entries.map((e) => e.userAgent?.slice(0, 400) ?? null),
      entries.map((e) => e.requests),
    ],
  );
  await db.query(
    `update access_grant g set last_seen_at = greatest(g.last_seen_at, v.seen), last_ip = v.ip
       from unnest($1::bigint[], $2::timestamptz[], $3::text[]) as v(id, seen, ip)
      where g.id = v.id and (g.last_seen_at is null or v.seen >= g.last_seen_at)`,
    [entries.map((e) => e.grantId), entries.map((e) => e.lastSeenAt), entries.map((e) => e.ip)],
  );
}

export async function pruneGrantActivity(db: Queryable, before: Date): Promise<number> {
  const { rows } = await db.query<{ count: string }>(
    `with deleted as (delete from access_grant_activity where hour < $1 returning 1)
     select count(*)::text as count from deleted`,
    [before],
  );
  return Number(rows[0]?.count ?? 0);
}

/** A grant used from at least this many addresses is flagged. */
export const MANY_IPS_THRESHOLD = 3;
/** A code whose uses came from at least this many networks is flagged. */
export const MANY_NETWORKS_THRESHOLD = 3;

export type GrantFlag = "many_ips" | "simultaneous_ips";
export type CodeFlag = "many_networks";

export interface GrantDetail {
  id: string;
  createdAt: Date;
  expiresAt: Date;
  revokedAt: Date | null;
  revokedBy: string | null;
  firstIp: string | null;
  firstUserAgent: string | null;
  lastSeenAt: Date | null;
  lastIp: string | null;
  distinctIps: number;
  requestCount: number;
  flags: GrantFlag[];
  activity: { hour: Date; ip: string; userAgent: string | null; requestCount: number }[];
}

export interface AccessCodeDetail extends AccessCodeSummary {
  grants: GrantDetail[];
  flags: CodeFlag[];
}

/** A code with every use and its hourly activity, and flags that may mean sharing:
 * `many_ips` — one use seen from 3+ addresses; `simultaneous_ips` — one use seen from 2+
 * addresses in the same hour; `many_networks` — the code's uses came from 3+ networks. */
export async function getAccessCodeDetail(
  db: Queryable,
  id: string,
): Promise<AccessCodeDetail | null> {
  const summary = await findAccessCode(db, id);
  if (!summary) return null;
  const grants = await db.query<{
    id: string;
    created_at: Date;
    expires_at: Date;
    revoked_at: Date | null;
    revoked_by: string | null;
    first_ip: string | null;
    first_user_agent: string | null;
    last_seen_at: Date | null;
    last_ip: string | null;
  }>(
    `select id::text, created_at, expires_at, revoked_at, revoked_by, first_ip, first_user_agent,
            last_seen_at, last_ip
       from access_grant where code_id = $1 order by created_at desc`,
    [id],
  );
  const activity = await db.query<{
    grant_id: string;
    hour: Date;
    ip: string;
    user_agent: string | null;
    request_count: number;
  }>(
    `select a.grant_id::text, a.hour, a.ip, a.user_agent, a.request_count
       from access_grant_activity a join access_grant g on g.id = a.grant_id
      where g.code_id = $1
      order by a.hour desc, a.ip`,
    [id],
  );
  const byGrant = new Map<string, GrantDetail["activity"]>();
  for (const row of activity.rows) {
    const list = byGrant.get(row.grant_id) ?? [];
    list.push({
      hour: row.hour,
      ip: row.ip,
      userAgent: row.user_agent,
      requestCount: row.request_count,
    });
    byGrant.set(row.grant_id, list);
  }

  const networks = new Set<string>();
  const details: GrantDetail[] = grants.rows.map((grant) => {
    const rows = byGrant.get(grant.id) ?? [];
    const ips = new Set(rows.map((row) => row.ip));
    if (grant.first_ip) ips.add(grant.first_ip);
    for (const ip of ips) networks.add(networkOf(ip));
    const ipsPerHour = new Map<number, Set<string>>();
    for (const row of rows) {
      const set = ipsPerHour.get(row.hour.getTime()) ?? new Set<string>();
      set.add(row.ip);
      ipsPerHour.set(row.hour.getTime(), set);
    }
    const flags: GrantFlag[] = [];
    if (ips.size >= MANY_IPS_THRESHOLD) flags.push("many_ips");
    if ([...ipsPerHour.values()].some((set) => set.size >= 2)) flags.push("simultaneous_ips");
    return {
      id: grant.id,
      createdAt: grant.created_at,
      expiresAt: grant.expires_at,
      revokedAt: grant.revoked_at,
      revokedBy: grant.revoked_by,
      firstIp: grant.first_ip,
      firstUserAgent: grant.first_user_agent,
      lastSeenAt: grant.last_seen_at,
      lastIp: grant.last_ip,
      distinctIps: ips.size,
      requestCount: rows.reduce((sum, row) => sum + row.requestCount, 0),
      flags,
      activity: rows,
    };
  });

  return {
    ...summary,
    grants: details,
    flags: networks.size >= MANY_NETWORKS_THRESHOLD ? ["many_networks"] : [],
  };
}

/** Changes one grant's expiry (an admin extending or shortening a use after entry). */
export async function updateGrantExpiry(
  db: Queryable,
  grantId: string,
  expiresAt: Date,
): Promise<{ codeId: string } | null> {
  if (!/^\d+$/.test(grantId)) return null;
  const { rows } = await db.query<{ code_id: string }>(
    `update access_grant set expires_at = $2 where id = $1 returning code_id::text`,
    [grantId, expiresAt],
  );
  return rows[0] ? { codeId: rows[0].code_id } : null;
}

export async function revokeGrant(
  db: Queryable,
  grantId: string,
  revokedBy: string | null,
): Promise<{ codeId: string } | null> {
  if (!/^\d+$/.test(grantId)) return null;
  const { rows } = await db.query<{ code_id: string }>(
    `update access_grant set revoked_at = coalesce(revoked_at, now()),
                             revoked_by = coalesce(revoked_by, $2)
      where id = $1 returning code_id::text`,
    [grantId, revokedBy],
  );
  return rows[0] ? { codeId: rows[0].code_id } : null;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "23505"
  );
}
