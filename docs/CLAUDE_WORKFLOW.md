# Low-Waste Claude Code Workflow

## 1. Keep persistent context layered

`CLAUDE.md` contains only stable constraints and pointers. Detailed specifications remain under `docs/`. Ask Claude to read only the documents relevant to the current milestone.

Do not paste this entire pack into every prompt. Claude Code reads project `CLAUDE.md`; keep a single session focused on one milestone so prompt caching and repository context remain useful.

## 2. Start every milestone in plan mode

Use a prompt of this form:

```text
Read CLAUDE.md, docs/IMPLEMENTATION_PLAN.md and the documents relevant to Milestone N only.
Do not edit files yet. Inspect the repository and produce a bounded implementation plan for Milestone N.
List the files you expect to create/change, database migrations, tests and acceptance criteria.
Call out any conflict with the specification. Do not design later milestones.
```

Review the plan, then use:

```text
Implement the approved Milestone N plan only.
Keep changes within the agreed files unless a necessary change is explained first.
Use fixtures; do not require production Network Rail credentials for tests.
Run formatting, type-checking and the relevant tests.
Update the milestone checklist and report actual commands/results.
```

## 3. Use small repair prompts

For a failed test:

```text
Investigate only this failing test/error. Explain the root cause briefly, make the smallest correct fix, add or update a regression test, and run the narrow test first followed by the affected suite. Do not refactor unrelated code.
```

For review:

```text
Review the current Milestone N diff against its acceptance criteria. Do not edit files. Identify correctness, data-loss, ordering, timestamp, idempotency, security and test gaps, ranked by severity with file references.
```

Then ask Claude to fix selected findings, not all speculative improvements.

## 4. End sessions cleanly

Before ending a milestone session:

```text
Update docs/progress.md with completed work, exact test commands/results, unresolved decisions and the next smallest task. Keep it factual and under 100 lines. Do not duplicate the full specification.
```

Create `docs/progress.md` once implementation begins. It is operational memory, not architecture.

## 5. Avoid expensive prompt patterns

Do not ask:

- `Build the whole app.`
- `Improve everything.`
- `Refactor this project to best practices.`
- `Read every file and tell me what to do.`

Prefer explicit milestone, files, invariants and acceptance tests.

Do not let Claude repeatedly rewrite large generated files. For map documents and fixtures, request targeted transformations or scripts.

## 6. Preserve decisions

Material decisions go in small ADR files:

```text
docs/adr/0001-use-postgresql-event-store.md
docs/adr/0002-svg-public-renderer-konva-editor.md
```

A decision prompt:

```text
Write an ADR for the approved decision only. Include context, decision, consequences and rejected alternatives in under 700 words. Do not change implementation files.
```

## 7. Recommended first prompts

### Prompt A — repository skeleton

```text
Read CLAUDE.md, docs/ARCHITECTURE.md and Milestone 1 in docs/IMPLEMENTATION_PLAN.md. Plan Milestone 1 only. Use pnpm workspaces, strict TypeScript, Fastify API, React/Vite web and a worker app. Include Docker Compose suitable for a Portainer stack, but do not add railway feed logic. List all files and tests before editing.
```

### Prompt B — event store

```text
Read CLAUDE.md, docs/DATA_MODEL.md and Milestone 2. Plan an append-only PostgreSQL event store with feed lineage, monotonic ingestion sequence, explicit redelivery/idempotency behavior and projection checkpoints. Prefer transparent SQL migrations. Do not implement TD semantics yet.
```

### Prompt C — TD fixtures before live feed

```text
Read CLAUDE.md, the C-Class section of docs/PROJECT_SPEC.md, docs/DATA_MODEL.md and Milestone 3. Implement pure parsers and a fixture replay harness for sanitized CA, CB, CC, CT and representative S-Class/unknown TD messages from multiple areas. The recorder must retain every child event and must not filter to Preston or mapped areas. Do not connect to the live Network Rail broker until fixture tests, nationwide retention and durable-before-ack boundaries are demonstrable.
```

### Prompt D — map schema

```text
Read CLAUDE.md, docs/MAP_EDITOR_SPEC.md, docs/API_CONTRACT.md and Milestone 5. Design the version-1 canonical map schema and validator first. It must support Lancaster track paths, berths, static blank signals, platforms, labels and boundaries. Do not build the visual editor in this milestone.
```
