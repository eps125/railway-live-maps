# Network Rail credentials

`deploy/docker-compose.yml` mounts these as Docker secrets on the `worker` service
(`NR_USERNAME_FILE=/run/secrets/nr_username`, `NR_PASSWORD_FILE=/run/secrets/nr_password`) —
your Network Rail Open Data account username and password are never a plain environment
variable, never in `deploy/.env`, and never committed to Git (`*.txt` in this directory is
gitignored).

**Do not paste your real NR username/password into a chat with an AI assistant, an issue,
a commit, or anywhere else that isn't this pair of local files.**

## Local / single-server setup

Create these two files yourself (they are not provided by this repo):

```
deploy/secrets/nr_username.txt
deploy/secrets/nr_password.txt
```

Each file contains exactly the credential value, nothing else (a trailing newline is fine —
it's trimmed when read). `docker compose up` will fail to start the `worker` service with a
clear "file not found" error until both exist, by design — there is no working fallback
default.

## Portainer / remote deployment

Prefer Portainer's own secret/file mechanism, or place the same two files on the host at the
paths referenced by `deploy/docker-compose.yml`'s `secrets:` block, with filesystem
permissions restricted to the account running Docker. Do not put the values in the stack's
environment variables field in the Portainer UI — that is visible in `docker inspect` and
Portainer's own UI/logs to anyone with stack access, unlike a mounted secret file.

## Live ingestion is off by default regardless

Even with both files present, the worker does not connect to the live Network Rail feed
unless `TD_LIVE_ENABLED=true` is also set (`deploy/.env`) — see
`docs/IMPLEMENTATION_PLAN.md` Milestone 3: "Live feed enablement only after fixture and
redelivery tests pass." Leave it unset/`false` until you've verified `worker replay-fixtures`
and CI's integration tests pass.
