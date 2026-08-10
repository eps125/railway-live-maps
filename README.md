# Railway Live Maps — Claude Project Pack

This pack is the authoritative planning context for building a self-hosted British railway nationwide data recorder and live signalling-map platform. All subscribed data is captured from the outset; Lancaster is only the first map to be authored and published.

## How to use it

1. Put these files at the root of a new Git repository.
2. Give Claude Code access to the repository.
3. Keep `CLAUDE.md` concise and stable. It points Claude to the detailed documents only when relevant.
4. Work through `docs/IMPLEMENTATION_PLAN.md` one milestone at a time.
5. Use the prompts in `docs/CLAUDE_WORKFLOW.md`; do not paste the entire specification into every chat.
6. Record material architectural changes as ADRs under `docs/adr/`.

## Documents

- `CLAUDE.md` — persistent project rules for Claude.
- `docs/PROJECT_SPEC.md` — product behavior and scope.
- `docs/ARCHITECTURE.md` — services, data flow and Docker/Portainer deployment.
- `docs/DATA_MODEL.md` — events, projections and principal database entities.
- `docs/MAP_EDITOR_SPEC.md` — canonical map format and visual editor requirements.
- `docs/API_CONTRACT.md` — initial REST and WebSocket contract.
- `docs/IMPLEMENTATION_PLAN.md` — bounded milestones and acceptance criteria.
- `docs/CLAUDE_WORKFLOW.md` — low-waste prompting workflow.
- `docs/REFERENCES.md` — primary references and project inspirations.
- `docs/DEPLOYMENT.md` — GitHub/Docker/Portainer bring-up runbook, including how NR credentials are supplied.
- `docs/progress.md` — operational memory: what's built, what was verified and how, next smallest task.
- `docs/adr/0001-nationwide-capture-map-independent.md` — accepted scope decision separating nationwide ingestion from first-map coverage.
- `deploy/docker-compose.yml` — tested Portainer/Docker Compose stack. Pin exact image tags/digests before production use.
- `deploy/docker-compose.portainer.yml` — pull-only variant for Portainer's "Repository" stack deploy method (no build context, images come from GHCR).
- `deploy/.env.example` — non-secret configuration template.
- `deploy/secrets/README.md` — where real Network Rail credentials go (never in Git or chat).

## Important scope distinction

The system must ingest and retain every TD area from the nationwide feed, plus all subscribed TRUST and VSTP events and complete timetable/reference imports. Do not filter ingestion to Preston or to areas with published maps.

The project owner has confirmed the Preston train describer is `PX` (not `PN` — public references may use another TD area identifier). Capture real TD messages and confirm the incoming `area_id` matches before binding the Lancaster map. This is a map-binding question only; nationwide ingestion starts regardless.
