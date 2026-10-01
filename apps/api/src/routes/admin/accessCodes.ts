import type { FastifyInstance } from "fastify";
import type { Pool } from "pg";
import {
  createAccessCode,
  DuplicateAccessCodeError,
  findAccessCode,
  getAccessCodeDetail,
  isValidCustomAccessCode,
  listAccessCodes,
  MaxUsesBelowUseCountError,
  revokeAccessCode,
  revokeGrant,
  UnknownMapError,
  updateAccessCode,
  updateGrantExpiry,
  type AccessCodeDetail,
  type AccessCodeScope,
  type AccessCodeSummary,
  type AccessCodeUpdate,
} from "@railway/database";
import { apiError } from "../../lib/queryRange.js";
import { audit } from "../../lib/audit.js";
import type { SiteAccess } from "../../lib/siteAccess.js";

export interface AccessCodeAdminRoutesDeps {
  pool: Pool;
  siteAccess: SiteAccess;
}

const LABEL_MAX_LENGTH = 80;
const NOTES_MAX_LENGTH = 500;
/** A use lasts between a minute and a year. */
const MIN_ACCESS_SECONDS = 60;
const MAX_ACCESS_SECONDS = 366 * 24 * 60 * 60;
const MAX_USES_LIMIT = 1_000_000;

function iso(date: Date | null): string | null {
  return date ? date.toISOString() : null;
}

function codeResponse(code: AccessCodeSummary) {
  return {
    id: code.id,
    label: code.label,
    code: code.code,
    scope: code.scope,
    mapIds: code.mapIds,
    maxUses: code.maxUses,
    useCount: code.useCount,
    accessSeconds: code.accessSeconds,
    validUntil: iso(code.validUntil),
    notes: code.notes,
    createdBy: code.createdBy,
    createdAt: code.createdAt.toISOString(),
    revokedAt: iso(code.revokedAt),
    activeGrants: code.activeGrants,
    lastUsedAt: iso(code.lastUsedAt),
    status: code.status,
  };
}

function detailResponse(detail: AccessCodeDetail) {
  return {
    ...codeResponse(detail),
    flags: detail.flags,
    grants: detail.grants.map((grant) => ({
      id: grant.id,
      createdAt: grant.createdAt.toISOString(),
      expiresAt: grant.expiresAt.toISOString(),
      revokedAt: iso(grant.revokedAt),
      revokedBy: grant.revokedBy,
      firstIp: grant.firstIp,
      firstUserAgent: grant.firstUserAgent,
      lastSeenAt: iso(grant.lastSeenAt),
      lastIp: grant.lastIp,
      distinctIps: grant.distinctIps,
      requestCount: grant.requestCount,
      flags: grant.flags,
      activity: grant.activity.map((row) => ({
        hour: row.hour.toISOString(),
        ip: row.ip,
        userAgent: row.userAgent,
        requestCount: row.requestCount,
      })),
    })),
  };
}

type Parsed<T> = { ok: true; value: T } | { ok: false; message: string };

/** Validates the fields a create or update may carry. `requireAll` for create. */
function parseCodeFields(
  body: Record<string, unknown>,
  requireAll: boolean,
): Parsed<AccessCodeUpdate & { code?: string }> {
  const out: AccessCodeUpdate & { code?: string } = {};
  const { label, code, scope, mapIds, maxUses, accessSeconds, validUntil, notes } = body;

  if (label !== undefined || requireAll) {
    if (typeof label !== "string" || !label.trim() || label.trim().length > LABEL_MAX_LENGTH) {
      return { ok: false, message: `label is required (at most ${LABEL_MAX_LENGTH} characters)` };
    }
    out.label = label;
  }
  if (code !== undefined && code !== null && code !== "") {
    if (!requireAll) return { ok: false, message: "a code's text cannot be changed" };
    if (typeof code !== "string" || !isValidCustomAccessCode(code)) {
      return {
        ok: false,
        message: "a custom code must be 4-32 letters or digits (spaces and dashes are ignored)",
      };
    }
    out.code = code;
  }
  if (scope !== undefined || requireAll) {
    if (scope !== "site" && scope !== "maps") {
      return { ok: false, message: 'scope must be "site" or "maps"' };
    }
    out.scope = scope as AccessCodeScope;
  }
  if (mapIds !== undefined) {
    if (
      !Array.isArray(mapIds) ||
      mapIds.some((id) => typeof id !== "string" || !/^\d+$/.test(id))
    ) {
      return { ok: false, message: "mapIds must be an array of map ids" };
    }
    out.mapIds = mapIds as string[];
  }
  if (maxUses !== undefined || requireAll) {
    if (
      maxUses !== null &&
      (typeof maxUses !== "number" ||
        !Number.isInteger(maxUses) ||
        maxUses < 1 ||
        maxUses > MAX_USES_LIMIT)
    ) {
      return { ok: false, message: "maxUses must be null (unlimited) or a whole number from 1" };
    }
    out.maxUses = (maxUses ?? null) as number | null;
  }
  if (accessSeconds !== undefined || requireAll) {
    if (
      typeof accessSeconds !== "number" ||
      !Number.isInteger(accessSeconds) ||
      accessSeconds < MIN_ACCESS_SECONDS ||
      accessSeconds > MAX_ACCESS_SECONDS
    ) {
      return { ok: false, message: "accessSeconds must be between a minute and a year" };
    }
    out.accessSeconds = accessSeconds;
  }
  if (validUntil !== undefined) {
    if (validUntil === null) {
      out.validUntil = null;
    } else {
      const date = typeof validUntil === "string" ? new Date(validUntil) : null;
      if (!date || Number.isNaN(date.getTime())) {
        return { ok: false, message: "validUntil must be null or an ISO 8601 timestamp" };
      }
      out.validUntil = date;
    }
  }
  if (notes !== undefined) {
    if (notes !== null && (typeof notes !== "string" || notes.length > NOTES_MAX_LENGTH)) {
      return { ok: false, message: `notes must be null or at most ${NOTES_MAX_LENGTH} characters` };
    }
    out.notes = notes as string | null;
  }
  return { ok: true, value: out };
}

/**
 * Milestone 84 (docs/adr/0018 §6): Admin › Access codes. Codes stay viewable after creation
 * (owner decision). Revoking a code ends every use of it immediately; an admin can also change
 * or end a single use. Every change is audited.
 */
export async function registerAccessCodeAdminRoutes(
  app: FastifyInstance,
  deps: AccessCodeAdminRoutesDeps,
): Promise<void> {
  const { pool, siteAccess } = deps;

  async function inTransaction<T>(fn: (client: import("pg").PoolClient) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    try {
      await client.query("begin");
      const result = await fn(client);
      await client.query("commit");
      return result;
    } catch (error) {
      await client.query("rollback");
      throw error;
    } finally {
      client.release();
    }
  }

  app.get("/api/v1/admin/access-codes", async () => ({
    codes: (await listAccessCodes(pool)).map(codeResponse),
  }));

  app.get<{ Params: { id: string } }>("/api/v1/admin/access-codes/:id", async (request, reply) => {
    await siteAccess.flush();
    const detail = await getAccessCodeDetail(pool, request.params.id);
    if (!detail) {
      reply.code(404);
      return apiError("ACCESS_CODE_NOT_FOUND", `No access code with id "${request.params.id}"`);
    }
    return detailResponse(detail);
  });

  app.post<{ Body: Record<string, unknown> }>(
    "/api/v1/admin/access-codes",
    async (request, reply) => {
      const parsed = parseCodeFields(request.body ?? {}, true);
      if (!parsed.ok) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", parsed.message);
      }
      const fields = parsed.value;
      if (fields.scope === "maps" && (fields.mapIds ?? []).length === 0) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "choose at least one map for a maps-only code");
      }
      try {
        const created = await inTransaction(async (client) => {
          const code = await createAccessCode(
            client,
            {
              label: fields.label!,
              code: fields.code,
              scope: fields.scope!,
              mapIds: fields.mapIds ?? [],
              maxUses: fields.maxUses ?? null,
              accessSeconds: fields.accessSeconds!,
              validUntil: fields.validUntil ?? null,
              notes: fields.notes ?? null,
            },
            request.authSession?.username ?? null,
          );
          await audit(
            client,
            request,
            "access.code.create",
            { type: "access_code", id: code.id },
            {
              label: code.label,
              scope: code.scope,
              mapIds: code.mapIds,
              maxUses: code.maxUses,
              accessSeconds: code.accessSeconds,
              validUntil: iso(code.validUntil),
            },
          );
          return code;
        });
        reply.code(201);
        return codeResponse(created);
      } catch (error) {
        if (error instanceof DuplicateAccessCodeError) {
          reply.code(409);
          return apiError("DUPLICATE_CODE", error.message);
        }
        if (error instanceof UnknownMapError) {
          reply.code(400);
          return apiError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
    },
  );

  app.patch<{ Params: { id: string }; Body: Record<string, unknown> }>(
    "/api/v1/admin/access-codes/:id",
    async (request, reply) => {
      const parsed = parseCodeFields(request.body ?? {}, false);
      if (!parsed.ok) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", parsed.message);
      }
      const before = await findAccessCode(pool, request.params.id);
      if (!before) {
        reply.code(404);
        return apiError("ACCESS_CODE_NOT_FOUND", `No access code with id "${request.params.id}"`);
      }
      const fields = parsed.value;
      const scope = fields.scope ?? before.scope;
      const mapIds = fields.mapIds ?? before.mapIds;
      if (scope === "maps" && mapIds.length === 0) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "choose at least one map for a maps-only code");
      }
      try {
        const updated = await inTransaction(async (client) => {
          const code = await updateAccessCode(client, request.params.id, fields);
          await audit(
            client,
            request,
            "access.code.update",
            { type: "access_code", id: before.id },
            {
              label: code!.label,
              before: {
                label: before.label,
                scope: before.scope,
                mapIds: before.mapIds,
                maxUses: before.maxUses,
                accessSeconds: before.accessSeconds,
                validUntil: iso(before.validUntil),
              },
              after: {
                label: code!.label,
                scope: code!.scope,
                mapIds: code!.mapIds,
                maxUses: code!.maxUses,
                accessSeconds: code!.accessSeconds,
                validUntil: iso(code!.validUntil),
              },
            },
          );
          return code!;
        });
        siteAccess.invalidate();
        return codeResponse(updated);
      } catch (error) {
        if (error instanceof MaxUsesBelowUseCountError || error instanceof UnknownMapError) {
          reply.code(400);
          return apiError("VALIDATION_ERROR", error.message);
        }
        throw error;
      }
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/access-codes/:id/revoke",
    async (request, reply) => {
      const before = await findAccessCode(pool, request.params.id);
      if (!before) {
        reply.code(404);
        return apiError("ACCESS_CODE_NOT_FOUND", `No access code with id "${request.params.id}"`);
      }
      await inTransaction(async (client) => {
        await revokeAccessCode(client, before.id, request.authSession?.username ?? null);
        await audit(
          client,
          request,
          "access.code.revoke",
          { type: "access_code", id: before.id },
          {
            label: before.label,
            activeGrants: before.activeGrants,
          },
        );
      });
      siteAccess.invalidate();
      return codeResponse((await findAccessCode(pool, before.id))!);
    },
  );

  app.patch<{ Params: { id: string }; Body: { expiresAt?: unknown } }>(
    "/api/v1/admin/access-grants/:id",
    async (request, reply) => {
      const raw = request.body?.expiresAt;
      const expiresAt = typeof raw === "string" ? new Date(raw) : null;
      if (!expiresAt || Number.isNaN(expiresAt.getTime())) {
        reply.code(400);
        return apiError("VALIDATION_ERROR", "expiresAt must be an ISO 8601 timestamp");
      }
      const result = await inTransaction(async (client) => {
        const updated = await updateGrantExpiry(client, request.params.id, expiresAt);
        if (updated) {
          await audit(
            client,
            request,
            "access.grant.update",
            {
              type: "access_grant",
              id: request.params.id,
            },
            { codeId: updated.codeId, expiresAt: expiresAt.toISOString() },
          );
        }
        return updated;
      });
      if (!result) {
        reply.code(404);
        return apiError("ACCESS_GRANT_NOT_FOUND", `No access grant with id "${request.params.id}"`);
      }
      siteAccess.invalidate();
      return { id: request.params.id, codeId: result.codeId, expiresAt: expiresAt.toISOString() };
    },
  );

  app.post<{ Params: { id: string } }>(
    "/api/v1/admin/access-grants/:id/revoke",
    async (request, reply) => {
      const result = await inTransaction(async (client) => {
        const revoked = await revokeGrant(
          client,
          request.params.id,
          request.authSession?.username ?? null,
        );
        if (revoked) {
          await audit(
            client,
            request,
            "access.grant.revoke",
            {
              type: "access_grant",
              id: request.params.id,
            },
            { codeId: revoked.codeId },
          );
        }
        return revoked;
      });
      if (!result) {
        reply.code(404);
        return apiError("ACCESS_GRANT_NOT_FOUND", `No access grant with id "${request.params.id}"`);
      }
      siteAccess.invalidate();
      return { id: request.params.id, codeId: result.codeId, revoked: true };
    },
  );
}
