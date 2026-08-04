# Deployment runbook

Milestone 1's Docker foundation plus Milestone 2/3's event store and TD recorder are in
place. This is the practical path from "code in this repo" to "running stack" — see
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

1. Create a Portainer stack from this Git repository, pointing at
   `deploy/docker-compose.yml`.
2. Set the same environment values from step 2 in Portainer's stack environment editor
   (or point Portainer at an uploaded `.env` file). Put `deploy/secrets/*.txt` on the host
   at the paths the Compose file's `secrets:` block references, with restricted file
   permissions — not in the Portainer environment-variables UI (those are visible via
   `docker inspect` and the Portainer UI to anyone with stack access; a mounted secret file
   is not).
3. Run the `migrate` and `ensure-archive-bucket` one-off commands (Portainer's "Console"
   against the `worker` container, or a scheduled/manual task) before the stack serves
   traffic, same as step 3.
4. Only the `web` service needs a public-facing port/reverse proxy. Postgres, Redis and the
   archive stay on the internal `backend` network (already enforced by
   `deploy/docker-compose.yml`).

## 5. Enabling live TD ingestion

Do **not** set `TD_LIVE_ENABLED=true` until:

1. `worker replay-fixtures multi-area-smoke` and `worker replay-fixtures redelivery-smoke`
   have passed (CI runs both on every build; you can also run them manually against your
   deployed Postgres/archive).
2. `pnpm run test:integration` passes (CI runs this against real Postgres + MinIO).
3. `deploy/secrets/nr_username.txt` / `nr_password.txt` exist on the target host.

Then set `TD_LIVE_ENABLED=true` in `deploy/.env` (or the Portainer stack environment) and
redeploy the `worker` service. It will connect to the real Network Rail TD feed and start
durably recording every subscribed TD area — not just Preston/Lancaster
(`docs/PROJECT_SPEC.md` §4). Watch the worker logs for the initial `TD session started`
line and `feed_connection_session`/`feed_frame` row growth in Postgres to confirm it's
working.

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
