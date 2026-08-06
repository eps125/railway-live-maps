# Deployment runbook

This is the practical path from "code in this repo" to "running stack" — see
`docs/ARCHITECTURE.md` §8 for the design intent behind it.

## 1. GitHub repository and image publishing

1. Create a repository on github.com (this pack assumes a new, public
   `railway-live-maps` repo — adjust if you named it differently).
2. Add it as the `origin` remote and push `main`.
3. `.github/workflows/ci.yml` runs on every push/PR: lint, format check, typecheck, unit
   tests, build, a live smoke pass against real Postgres/Redis/MinIO service containers
   (migrations, partitions, archive bucket, connectivity, fixture replay), then builds all
   three Docker images. On push to `main` only, a second `publish` job builds and pushes
   `ghcr.io/<owner>/<repo>-{api,worker,web}` tagged `latest` and the commit SHA, using the
   built-in `GITHUB_TOKEN` — no registry secret setup needed.
4. Confirm the `publish` job succeeded and the three packages appear under the repo's
   GitHub Packages tab before deploying anywhere.

## 2. Local configuration (never committed)

Copy `deploy/.env.example` to `deploy/.env` and fill in real values:

- `*_IMAGE` → `ghcr.io/<owner>/<repo>-{api,worker,web}` from step 1, and pin `APP_TAG` to a
  specific commit SHA for anything beyond local development (never `latest` in production —
  `docs/ARCHITECTURE.md` §8).
- `POSTGRES_PASSWORD`, `RAW_ARCHIVE_ACCESS_KEY`/`RAW_ARCHIVE_SECRET_KEY` — real secrets, not
  the placeholders.
- Leave `TD_LIVE_ENABLED=false` for now (see step 5).

Create `deploy/secrets/nr_username.txt` and `deploy/secrets/nr_password.txt` yourself, per
`deploy/secrets/README.md`. These are gitignored and mounted as Docker secrets on the
`worker` service — never a plain environment variable.

## 3. First bring-up

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env config
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d postgres redis archive
```

Then run the release step (migrations + partition top-up) once, before the app containers
start serving traffic:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm worker node dist/index.js migrate
docker compose -f deploy/docker-compose.yml --env-file deploy/.env run --rm worker node dist/index.js ensure-archive-bucket
```

Now bring up the rest:

```bash
docker compose -f deploy/docker-compose.yml --env-file deploy/.env up -d
```

`worker`'s default command (`serve`) is an idle daemon — it does not connect to Network
Rail until step 5.

## 4. Portainer (remote server)

Use `deploy/docker-compose.portainer.yml`, not `deploy/docker-compose.yml` — it's a
pull-only variant (no `build:` context, so Portainer pulls the published GHCR images
instead of trying to build from source) and has no Docker-secret file-mount requirement,
so it deploys without needing host filesystem/SSH access at all.

1. Portainer → Stacks → Add stack → **Repository**, pointing at this repo and
   `deploy/docker-compose.portainer.yml`.
2. Paste environment values into Portainer's stack environment editor (same values as
   step 2, plus set `NR_USERNAME`/`NR_PASSWORD` there too if/when you have them — see the
   caveat below).
3. Run the `migrate` and `ensure-archive-bucket` one-off commands (Portainer's "Console"
   against the `worker` container, or a scheduled/manual task) before the stack serves
   traffic, same as step 3.
4. Only `web` needs a reverse proxy/public DNS entry for real public use. Postgres, Redis
   and the archive (MinIO) are published straight to the host (`POSTGRES_PORT`/
   `REDIS_PORT`/`MINIO_PORT`/`MINIO_CONSOLE_PORT`, set in Portainer's stack environment —
   `deploy/.env.example` documents this deployment's actual scheme: `6052`/`6053`/`6054`/
   `6055`, chosen to sit right after `WEB_PORT=6050`/`API_PORT=6051`) — a deliberate
   departure from `docs/ARCHITECTURE.md` §12's "only the web entry point should be public"
   for a single-operator testing/staging box, so you can `psql`/`redis-cli`/hit the MinIO
   console directly. Put the host behind a firewall or VPN rather than a raw public IP if
   you rely on this.

**NR credential caveat**: `deploy/docker-compose.portainer.yml` sets `NR_USERNAME`/
`NR_PASSWORD` as plain environment variables (Portainer's stack environment editor),
not mounted secret files — deliberately, since creating files on the host isn't always
practical from Portainer alone. This is weaker than a mounted secret (the values are
visible via `docker inspect`/the Portainer UI to anyone with stack access) but is fine
while every `*_LIVE_ENABLED` flag stays `false`, since nothing reads them. If you later
want the stronger file-based secret isolation, `deploy/docker-compose.yml`'s `secrets:`
block is the template — it needs the two files placed on the host at the stack's
checkout path.

**Live feed services**: `deploy/docker-compose.portainer.yml` runs four always-on services
beyond the idle `worker`:

- `ingest-td` / `ingest-vstp` / `ingest-trust` — each connects to its own live Network Rail
  STOMP feed only when its own `TD_LIVE_ENABLED`/`VSTP_LIVE_ENABLED`/`TRUST_LIVE_ENABLED` flag
  is `true`; otherwise it idles (`sleep infinity`) rather than crash-looping, so leaving the
  defaults alone is a safe no-op. Flip one flag and redeploy — the other two feeds are
  unaffected.
- `projector` — re-runs the one-shot `project-td`/`project-vstp`/`project-trust` commands
  every 30 seconds, since there's no built-in scheduler yet. Without this, raw captured events
  would sit in `raw_feed_event` and never become queryable current-state/history. Safe to
  leave running even with every feed disabled (each command just finds an empty backlog).

None of these four report healthy/unhealthy the way `api`/`web`/`worker` do — their
Docker `HEALTHCHECK` is disabled in the compose file, since the image's baked-in check
only makes sense for the idle `serve` role. Use their logs to confirm they're behaving.

## 4a. Testing Milestone 4/5 against the Portainer stack

Once the stack is up and `migrate`/`ensure-archive-bucket` have run, drive the pipeline via
Portainer's "Console" on the `worker` container (or `docker exec` if you have host access):

```bash
node dist/index.js replay-fixtures multi-area-smoke
node dist/index.js project-td
node dist/index.js publish-map lancaster packages/map-schema/fixtures/lancaster-minimal.json
```

Then, from your own machine, using the host running the stack and the ports above:

- `curl http://<host>:${API_PORT}/api/v1/td/areas` / `.../api/v1/maps` / `.../api/v1/maps/lancaster/state`
- `psql postgresql://<POSTGRES_USER>:<POSTGRES_PASSWORD>@<host>:${POSTGRES_PORT}/railway_live_maps`
  to inspect `berth_current_state`/`berth_occupancy` directly.
- Open `http://<host>:${MINIO_CONSOLE_PORT}` to browse archived raw frames in MinIO's console.
- Open `http://<host>:${WEB_PORT}` in a browser for the Lancaster map itself.

## 5. Enabling live ingestion (TD / VSTP / TRUST)

Do **not** set `TD_LIVE_ENABLED`/`VSTP_LIVE_ENABLED`/`TRUST_LIVE_ENABLED` to `true` for a
feed until:

1. `pnpm run test:integration` passes (CI runs this against real Postgres + MinIO) — it
   covers all three feeds' recorder/projector fixture-replay behavior.
2. `worker replay-fixtures multi-area-smoke` and `worker replay-fixtures redelivery-smoke`
   have passed for TD specifically (CI runs both on every build).
3. Real NR credentials are in place — either `deploy/secrets/nr_username.txt`/
   `nr_password.txt` on the host (`deploy/docker-compose.yml`), or `NR_USERNAME`/
   `NR_PASSWORD` set in the Portainer stack environment (`deploy/docker-compose.portainer.yml`).
   One username/password pair covers all three feeds — Network Rail doesn't separate
   credentials per feed.

Then, on the Portainer stack, set the relevant flag(s) — `TD_LIVE_ENABLED`, `VSTP_LIVE_ENABLED`,
`TRUST_LIVE_ENABLED` — to `true` in the stack environment and redeploy. Each flag
independently controls its own `ingest-{td,vstp,trust}` service (§4 above); you don't have
to enable all three at once. Watch that service's own logs for the initial
`<feed> session started` line and `feed_connection_session`/`feed_frame` row growth in
Postgres to confirm it's working. It will durably record every subscribed area/message
nationwide, not filtered to Preston/Lancaster (`docs/PROJECT_SPEC.md` §4).

Every VSTP/TRUST wire-format field name in this codebase is constructed from public
documentation, not verified against a captured real message (`docs/IMPLEMENTATION_PLAN.md`'s
M7/M8 status notes) — if real traffic shows up with `parse_status = 'unsupported'` or
`'malformed'` in bulk (`select event_type, parse_status, count(*) from raw_feed_event where
feed_name = '...' group by 1, 2`), that's the signal to compare a sample against the parser
and adjust it. Nothing is ever silently dropped, so this is always diagnosable from the DB.

## 6. Ongoing operations

- `worker ensure-partitions` should run on a schedule (e.g. monthly) independently of
  deploys, so partitions stay ahead of live data even between releases — `migrate` already
  runs it once per deploy, which is not sufficient on its own for a long-lived deployment.
- `worker reconcile-archive --mode=quick` (routine) / `--mode=deep` (periodic, more
  expensive) audits the Postgres archive index against real S3 objects — see
  `docs/ARCHITECTURE.md` §5 for why this two-sided check exists.
- Backups, alerting and the public status page are explicitly out of scope until Milestone
  13 (`docs/IMPLEMENTATION_PLAN.md`) — do not treat this deployment as production-hardened
  before that milestone lands.
