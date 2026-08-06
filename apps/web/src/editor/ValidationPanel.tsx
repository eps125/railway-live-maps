import { useState } from "react";
import { useEditorState } from "./EditorState.js";

interface ValidationIssue {
  code: string;
  message: string;
  elementId?: string;
  bindingId?: string;
}

interface ValidationResult {
  valid: boolean;
  errors: ValidationIssue[];
  warnings: ValidationIssue[];
  info: {
    elementCounts: Record<string, number>;
    boundBerthCount: number;
    unboundBerthCount: number;
    observedBerthBindingPercentage: number;
  } | null;
}

/** docs/MAP_EDITOR_SPEC.md §9: three validation tiers (publication-blocking errors, warnings,
 * informational diagnostics), backed by `POST /api/v1/editor/maps/{slug}/validate`
 * (`apps/api/src/editor/validateWithContext.ts`) — the same gate `/publish` itself enforces
 * server-side, surfaced here so the author sees it before attempting to publish. */
export function ValidationPanel({ slug }: { slug: string }): JSX.Element {
  const { document: doc } = useEditorState();
  const [result, setResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);

  async function runValidation(): Promise<void> {
    setLoading(true);
    try {
      const response = await fetch(`/api/v1/editor/maps/${encodeURIComponent(slug)}/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ canonicalDocument: doc }),
      });
      const body = (await response.json()) as ValidationResult;
      setResult(body);
    } finally {
      setLoading(false);
    }
  }

  return (
    <section aria-label="Validation" className="panel-card">
      <h3>Validation</h3>
      <button type="button" className="btn" onClick={() => void runValidation()} disabled={loading}>
        {loading ? "Validating…" : "Validate"}
      </button>
      {result ? (
        <div>
          <p style={{ marginTop: "0.6rem" }}>
            {result.valid ? (
              <span className="badge badge--success">No blocking errors</span>
            ) : (
              <span className="badge badge--danger">{result.errors.length} blocking error(s)</span>
            )}
          </p>
          {result.errors.length > 0 ? (
            <ul className="issue-list issue-list--errors">
              {result.errors.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  <code>{issue.code}</code> {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          {result.warnings.length > 0 ? (
            <>
              <p className="badge badge--warning">{result.warnings.length} warning(s)</p>
              <ul className="issue-list issue-list--warnings">
                {result.warnings.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    <code>{issue.code}</code> {issue.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {result.info ? (
            <ul className="info-list">
              <li>
                Bound berths: <strong>{result.info.boundBerthCount}</strong>
              </li>
              <li>
                Unbound berths: <strong>{result.info.unboundBerthCount}</strong>
              </li>
              <li>
                Observed binding coverage:{" "}
                <strong>{result.info.observedBerthBindingPercentage}%</strong>
              </li>
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
