import { useEffect, useMemo, useState } from "react";
import type { MapBinding } from "@railway/map-schema";
import { useEditorDispatch, useEditorState } from "./EditorState.js";
import {
  sClassCoverage,
  type BitUse,
  type CoverageDefinition,
  type CoverageSource,
  type DoubleUse,
} from "./sClassCoverage.js";

const KIND_NAME = { signal: "signal", route: "route", crossing: "crossing", trts: "TRTS" } as const;

/**
 * Milestone 91 (owner request 2026-10-14): which defined S-Class signal, route and crossing bits
 * are bound on this map (including its other modules), which aren't, and which are bound twice.
 * A double use can be marked as intended; a signal bit also feeding a crossing never warns.
 */
export function SClassCoveragePanel({ others }: { others: CoverageSource[] }): JSX.Element {
  const { document: doc } = useEditorState();
  const dispatch = useEditorDispatch();
  const [extraArea, setExtraArea] = useState("");
  const [added, setAdded] = useState<string[]>([]);
  const [definitions, setDefinitions] = useState<Record<string, CoverageDefinition[]>>({});
  const [failed, setFailed] = useState<string[]>([]);

  const sources = useMemo<CoverageSource[]>(
    () => [{ moduleSlug: null, name: "This map", doc }, ...others],
    [doc, others],
  );

  // Areas to check: every area an S-Class binding uses, plus any the author adds.
  const areas = useMemo(() => {
    const set = new Set<string>(added);
    for (const source of sources) {
      for (const binding of source.doc.bindings) {
        if (binding.type === "tdSBitBarrierInferred")
          binding.inputs.forEach((i) => set.add(i.tdArea));
        else if (binding.type !== "tdBerth") set.add(binding.tdArea);
      }
    }
    return [...set].sort();
  }, [sources, added]);

  useEffect(() => {
    let cancelled = false;
    const missing = areas.filter((area) => !(area in definitions));
    if (missing.length === 0) return;
    void Promise.all(
      missing.map(async (area) => {
        try {
          const response = await fetch(
            `/api/v1/editor/s-class/areas/${encodeURIComponent(area)}/definitions`,
          );
          if (!response.ok) throw new Error(String(response.status));
          const body = (await response.json()) as { definitions: CoverageDefinition[] };
          return [area, body.definitions] as const;
        } catch {
          return [area, null] as const;
        }
      }),
    ).then((rows) => {
      if (cancelled) return;
      setDefinitions((prev) => {
        const next = { ...prev };
        for (const [area, defs] of rows) next[area] = defs ?? [];
        return next;
      });
      setFailed((prev) => [...prev, ...rows.filter(([, d]) => d === null).map(([a]) => a)]);
    });
    return () => {
      cancelled = true;
    };
  }, [areas, definitions]);

  const coverage = useMemo(
    () =>
      sClassCoverage(
        sources,
        Object.fromEntries(areas.map((area) => [area, definitions[area] ?? []])),
      ),
    [sources, areas, definitions],
  );

  function select(use: BitUse): void {
    if (use.moduleSlug === null) dispatch({ type: "setSelection", ids: [use.elementId] });
  }

  function markIntended(double: DoubleUse, intended: boolean): void {
    for (const use of double.uses) {
      if (use.moduleSlug !== null) continue;
      const binding = doc.bindings.find((b) => b.id === use.bindingId);
      if (!binding || binding.type === "tdBerth" || binding.type === "tdSBitBarrierInferred")
        continue;
      const next: MapBinding = { ...binding };
      if (intended) (next as { allowDuplicate?: boolean }).allowDuplicate = true;
      else delete (next as { allowDuplicate?: boolean }).allowDuplicate;
      dispatch({
        type: "dispatchCommand",
        command: { type: "setBinding", elementId: binding.elementId, binding: next },
      });
    }
  }

  const useLine = (use: BitUse) => (
    <>
      {use.moduleSlug === null ? (
        <button type="button" className="btn--link" onClick={() => select(use)}>
          {use.elementLabel ?? `unlabelled ${KIND_NAME[use.kind]}`}
        </button>
      ) : (
        <span>{use.elementLabel ?? `unlabelled ${KIND_NAME[use.kind]}`}</span>
      )}{" "}
      <span className="field-hint">({use.sourceName})</span>
    </>
  );

  return (
    <section aria-label="S-Class coverage" className="panel-card">
      <h3>S-Class coverage</h3>
      {others.length > 0 ? (
        <p className="field-hint">Includes {others.map((o) => o.name).join(", ")}.</p>
      ) : null}
      {areas.length === 0 ? (
        <p className="field-hint">
          No S-Class bindings yet. Add an area to see what is defined for it.
        </p>
      ) : null}
      {coverage.map((area) => {
        const live = area.doubleUses.filter((d) => !d.intended);
        return (
          <div key={area.tdArea} className="coverage-area">
            <h4>
              {area.tdArea}
              {failed.includes(area.tdArea) ? (
                <span className="field-hint"> — definitions couldn&apos;t be loaded</span>
              ) : null}
            </h4>
            <ul className="info-list">
              <li>
                Signals bound: <strong>{area.signals.bound}</strong> of {area.signals.defined}{" "}
                defined
              </li>
              <li>
                Routes bound: <strong>{area.routes.bound}</strong> of {area.routes.defined} defined
              </li>
              {area.trts.defined > 0 ? (
                <li>
                  TRTS bound: <strong>{area.trts.bound}</strong> of {area.trts.defined} defined
                </li>
              ) : null}
              {area.crossings.defined > 0 ? (
                <li>
                  Crossings bound: <strong>{area.crossings.bound}</strong> of{" "}
                  {area.crossings.defined} defined
                </li>
              ) : null}
            </ul>
            {live.length > 0 ? (
              <p className="badge badge--warning">{live.length} bit(s) used more than once</p>
            ) : null}
            {area.problems.length > 0 ? (
              <p className="badge badge--warning">{area.problems.length} binding(s) to check</p>
            ) : null}

            {area.doubleUses.length > 0 ? (
              <details open={live.length > 0}>
                <summary>Used more than once ({area.doubleUses.length})</summary>
                <ul className="issue-list issue-list--warnings">
                  {area.doubleUses.map((d) => (
                    <li key={`${d.key}-${d.kind}`}>
                      <code>
                        {d.key}
                        {d.definition?.label ? ` ${d.definition.label}` : ""}
                      </code>{" "}
                      — {d.uses.length} {KIND_NAME[d.kind]}s:{" "}
                      {d.uses.map((u, i) => (
                        <span key={u.bindingId}>
                          {i > 0 ? ", " : ""}
                          {useLine(u)}
                        </span>
                      ))}
                      {d.uses.some((u) => u.moduleSlug === null) ? (
                        <div>
                          <button
                            type="button"
                            className="btn"
                            onClick={() => markIntended(d, !d.intended)}
                          >
                            {d.intended ? "Warn about this again" : "Mark as intended"}
                          </button>
                          {d.intended ? <span className="field-hint"> Intended.</span> : null}
                          {!d.intended && d.uses.some((u) => u.moduleSlug !== null) ? (
                            <span className="field-hint">
                              {" "}
                              Also mark it in{" "}
                              {[
                                ...new Set(
                                  d.uses
                                    .filter((u) => u.moduleSlug !== null)
                                    .map((u) => u.sourceName),
                                ),
                              ].join(", ")}
                              .
                            </span>
                          ) : null}
                        </div>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {area.problems.length > 0 ? (
              <details open>
                <summary>Bindings to check ({area.problems.length})</summary>
                <ul className="issue-list issue-list--warnings">
                  {area.problems.map((p) => (
                    <li key={`${p.use.bindingId}-${p.code}`}>
                      {p.message} — {useLine(p.use)}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {area.unbound.length > 0 ? (
              <details>
                <summary>Defined but not bound ({area.unbound.length})</summary>
                <ul className="info-list">
                  {area.unbound.map((d) => (
                    <li key={`${d.address}.${d.bit}`}>
                      <code>
                        {d.address}.{d.bit}
                      </code>{" "}
                      {d.label ?? "(no label)"}{" "}
                      <span className="field-hint">{d.kind.replace("_", " ")}</span>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}

            {area.crossingInputsOnly.length > 0 ? (
              <details>
                <summary>
                  Signals used only by a crossing ({area.crossingInputsOnly.length})
                </summary>
                <p className="field-hint">
                  These feed a crossing&apos;s barriers but aren&apos;t drawn as signals.
                  That&apos;s fine.
                </p>
                <ul className="info-list">
                  {area.crossingInputsOnly.map((d) => (
                    <li key={`${d.address}.${d.bit}`}>
                      <code>
                        {d.address}.{d.bit}
                      </code>{" "}
                      {d.label ?? "(no label)"}
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        );
      })}
      <form
        className="coverage-add"
        onSubmit={(e) => {
          e.preventDefault();
          const area = extraArea.trim().toUpperCase();
          if (/^[A-Z0-9]{2}$/.test(area) && !added.includes(area)) setAdded([...added, area]);
          setExtraArea("");
        }}
      >
        <label className="field">
          Check another area
          <input
            id="coverage-area"
            type="text"
            value={extraArea}
            maxLength={2}
            onChange={(e) => setExtraArea(e.target.value)}
            placeholder="e.g. CE"
          />
        </label>
        <button type="submit" className="btn">
          Add
        </button>
      </form>
    </section>
  );
}
