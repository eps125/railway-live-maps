import { useState } from "react";
import type { ModuleIssue, ModuleUse } from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import {
  placementForNewModule,
  placementSummary,
  type BackdropItem,
  type EditorModule,
} from "./modulesSupport.js";

export interface AvailableModule {
  slug: string;
  name: string;
  publishedVersion: number | null;
}

/**
 * Milestone 85 (docs/adr/0019): the modules an assembled map is made from. Add a module (it lands
 * to the right of everything, placed freely so it can be dragged), attach it by choosing one of
 * its joins and a join of a module already placed (the position is then worked out from the
 * joins), go back to free placement, remove it, or open it to edit in place. Changes are ordinary
 * undoable edits of the draft.
 */
export function ModulesPanel({
  slug,
  modules,
  available,
  backdrop,
  offsets,
  issues,
  onOpen,
}: {
  slug: string;
  /** Leave for another editor page (after saving). */
  onOpen: (path: string) => void;
  modules: EditorModule[];
  available: AvailableModule[];
  backdrop: BackdropItem[];
  offsets: Map<string, { dx: number; dy: number }>;
  issues: ModuleIssue[];
}): JSX.Element {
  const { document: doc } = useEditorState();
  const dispatch = useEditorDispatch();
  const [adding, setAdding] = useState("");
  const uses = doc.modules ?? [];
  const byslug = new Map(modules.map((module) => [module.slug, module]));
  const moduleDoc = (moduleSlug: string) =>
    byslug.get(moduleSlug)?.draft ?? byslug.get(moduleSlug)?.published ?? null;
  const joinsOf = (moduleSlug: string) => moduleDoc(moduleSlug)?.joins ?? [];
  const nameOf = (moduleSlug: string) =>
    byslug.get(moduleSlug)?.name ??
    available.find((m) => m.slug === moduleSlug)?.name ??
    moduleSlug;

  function setModules(next: ModuleUse[]): void {
    dispatch({ type: "dispatchCommand", command: { type: "setModules", modules: next } });
  }

  function updateUse(moduleSlug: string, placement: ModuleUse["placement"]): void {
    setModules(uses.map((use) => (use.slug === moduleSlug ? { ...use, placement } : use)));
  }

  function attachDefaults(moduleSlug: string): ModuleUse["placement"] | null {
    const own = joinsOf(moduleSlug)[0];
    const target = uses.find((use) => use.slug !== moduleSlug && joinsOf(use.slug).length > 0);
    const targetJoin = target ? joinsOf(target.slug)[0] : undefined;
    if (!own || !target || !targetJoin) return null;
    return { kind: "attached", join: own.id, to: target.slug, toJoin: targetJoin.id };
  }

  const unused = available.filter((m) => !uses.some((use) => use.slug === m.slug));

  return (
    <section aria-label="Modules" className="panel-card modules-panel">
      <h3>Modules</h3>
      {uses.length === 0 ? (
        <p className="field-hint">
          Build this map from modules: each is drawn once and can appear on several maps. A module
          attaches to another where their joins meet.
        </p>
      ) : null}

      {issues.length > 0 ? (
        <ul className="issue-list issue-list--errors" aria-label="Module problems">
          {issues.map((issue, index) => (
            <li key={index}>{issue.message}</li>
          ))}
        </ul>
      ) : null}

      <ul className="modules-panel__list">
        {uses.map((use) => {
          const module = byslug.get(use.slug);
          const ownJoins = joinsOf(use.slug);
          const others = uses.filter((other) => other.slug !== use.slug);
          const defaults = attachDefaults(use.slug);
          const status =
            module?.publishedVersion == null
              ? "Not published yet"
              : module.draft && JSON.stringify(module.draft) !== JSON.stringify(module.published)
                ? `v${module.publishedVersion} published · unpublished changes`
                : `v${module.publishedVersion} published`;
          return (
            <li key={use.slug} className="modules-panel__item">
              <div className="modules-panel__head">
                <strong>{nameOf(use.slug)}</strong>
                <span className="field-hint">{status}</span>
              </div>
              <p className="field-hint">
                {placementSummary(
                  use,
                  (s, id) => joinsOf(s).find((j) => j.id === id)?.name,
                  nameOf,
                )}
              </p>
              <fieldset className="modules-panel__placement">
                <legend className="visually-hidden">Placement of {nameOf(use.slug)}</legend>
                <label className="field field--checkbox">
                  <input
                    type="radio"
                    checked={use.placement.kind === "at"}
                    onChange={() => {
                      const at = offsets.get(use.slug) ?? { dx: 0, dy: 0 };
                      updateUse(use.slug, { kind: "at", x: at.dx, y: at.dy });
                    }}
                  />
                  Place freely
                </label>
                <label className="field field--checkbox">
                  <input
                    type="radio"
                    checked={use.placement.kind === "attached"}
                    disabled={!defaults && use.placement.kind !== "attached"}
                    onChange={() => defaults && updateUse(use.slug, defaults)}
                  />
                  Attach by a join
                </label>
                {!defaults && use.placement.kind !== "attached" ? (
                  <p className="field-hint">
                    To attach, this module and another one here both need a join.
                  </p>
                ) : null}
                {use.placement.kind === "attached" ? (
                  <div className="modules-panel__attach">
                    <label className="field">
                      Its join
                      <select
                        value={use.placement.join}
                        onChange={(e) =>
                          use.placement.kind === "attached" &&
                          updateUse(use.slug, { ...use.placement, join: e.target.value })
                        }
                      >
                        {ownJoins.map((join) => (
                          <option key={join.id} value={join.id}>
                            {join.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      meets module
                      <select
                        value={use.placement.to}
                        onChange={(e) => {
                          const firstJoin = joinsOf(e.target.value)[0];
                          if (use.placement.kind === "attached" && firstJoin) {
                            updateUse(use.slug, {
                              ...use.placement,
                              to: e.target.value,
                              toJoin: firstJoin.id,
                            });
                          }
                        }}
                      >
                        {others.map((other) => (
                          <option key={other.slug} value={other.slug}>
                            {nameOf(other.slug)}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label className="field">
                      at its join
                      <select
                        value={use.placement.toJoin}
                        onChange={(e) =>
                          use.placement.kind === "attached" &&
                          updateUse(use.slug, { ...use.placement, toJoin: e.target.value })
                        }
                      >
                        {joinsOf(use.placement.to).map((join) => (
                          <option key={join.id} value={join.id}>
                            {join.name}
                          </option>
                        ))}
                      </select>
                    </label>
                  </div>
                ) : null}
              </fieldset>
              <div className="modules-panel__buttons">
                <button
                  type="button"
                  className="btn"
                  onClick={() =>
                    onOpen(`/editor/${encodeURIComponent(use.slug)}?in=${encodeURIComponent(slug)}`)
                  }
                >
                  Edit module here
                </button>
                <button
                  type="button"
                  className="btn"
                  onClick={() => {
                    const attachedToThis = uses.filter(
                      (other) =>
                        other.placement.kind === "attached" && other.placement.to === use.slug,
                    );
                    const warning =
                      attachedToThis.length > 0
                        ? ` ${attachedToThis.map((o) => nameOf(o.slug)).join(", ")} attach to it and will need placing again.`
                        : "";
                    if (window.confirm(`Remove ${nameOf(use.slug)} from this map?${warning}`)) {
                      setModules(uses.filter((other) => other.slug !== use.slug));
                    }
                  }}
                >
                  Remove
                </button>
              </div>
            </li>
          );
        })}
      </ul>

      <div className="modules-panel__add">
        <label className="field">
          Add a module
          <select value={adding} onChange={(e) => setAdding(e.target.value)}>
            <option value="">Choose…</option>
            {unused.map((module) => (
              <option key={module.slug} value={module.slug}>
                {module.name}
                {module.publishedVersion === null ? " (not published yet)" : ""}
              </option>
            ))}
          </select>
        </label>
        <button
          type="button"
          className="btn btn--primary"
          disabled={!adding}
          onClick={() => {
            setModules([
              ...uses,
              {
                slug: adding,
                placement: placementForNewModule(doc, backdrop, doc.map.canvas.gridSize),
              },
            ]);
            setAdding("");
          }}
        >
          Add
        </button>
        {unused.length === 0 ? (
          <p className="field-hint">No other modules yet — create one in Admin › Maps.</p>
        ) : null}
      </div>
    </section>
  );
}

/**
 * Milestone 85: a module's joins. Draw one with the Join tool across the track ends at an edge;
 * name it after where it leads ("To Carlisle"). Other modules attach where joins meet.
 */
export function JoinsPanel({
  usedBy,
  moduleSlug,
  onOpen,
}: {
  usedBy: string[];
  moduleSlug: string;
  onOpen: (path: string) => void;
}): JSX.Element {
  const { document: doc, selectedJoinId } = useEditorState();
  const dispatch = useEditorDispatch();
  const joins = doc.joins ?? [];

  function setJoins(next: typeof joins): void {
    dispatch({ type: "dispatchCommand", command: { type: "setJoins", joins: next } });
  }

  return (
    <section aria-label="Joins" className="panel-card modules-panel">
      <h3>Joins</h3>
      <p className="field-hint">
        Use the Join tool to draw a join across the track ends where another module will meet this
        one. The rings show the track ends it catches.
      </p>
      {joins.length === 0 ? <p className="field-hint">No joins yet.</p> : null}
      <ul className="modules-panel__list">
        {joins.map((join) => (
          <li
            key={join.id}
            className={`modules-panel__item${join.id === selectedJoinId ? " modules-panel__item--selected" : ""}`}
          >
            <label className="field">
              Join name
              <input
                type="text"
                defaultValue={join.name}
                key={join.name}
                onFocus={() => dispatch({ type: "selectJoin", joinId: join.id })}
                onBlur={(e) => {
                  const name = e.target.value.trim();
                  if (name && name !== join.name) {
                    setJoins(joins.map((j) => (j.id === join.id ? { ...j, name } : j)));
                  }
                }}
              />
            </label>
            <div className="modules-panel__buttons">
              <button
                type="button"
                className="btn"
                onClick={() => dispatch({ type: "selectJoin", joinId: join.id })}
              >
                Select
              </button>
              <button
                type="button"
                className="btn"
                onClick={() => {
                  setJoins(joins.filter((j) => j.id !== join.id));
                  dispatch({ type: "selectJoin", joinId: null });
                }}
              >
                Delete
              </button>
            </div>
          </li>
        ))}
      </ul>
      {usedBy.length > 0 ? (
        <div className="modules-panel__used-by">
          <p className="field-hint">
            Used by — edit it in place, with the rest of the map around it:
          </p>
          <ul>
            {usedBy.map((mapSlug) => (
              <li key={mapSlug}>
                <a
                  href={`/editor/${encodeURIComponent(moduleSlug)}?in=${encodeURIComponent(mapSlug)}`}
                  onClick={(e) => {
                    e.preventDefault();
                    onOpen(
                      `/editor/${encodeURIComponent(moduleSlug)}?in=${encodeURIComponent(mapSlug)}`,
                    );
                  }}
                >
                  {mapSlug}
                </a>
              </li>
            ))}
          </ul>
        </div>
      ) : (
        <p className="field-hint">Not used by any map yet.</p>
      )}
    </section>
  );
}
