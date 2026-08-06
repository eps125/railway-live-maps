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
    <section aria-label="Validation">
      <h3>Validation</h3>
      <button type="button" onClick={() => void runValidation()} disabled={loading}>
        {loading ? "Validating…" : "Validate"}
      </button>
      {result ? (
        <div>
          <p>
            {result.valid
              ? "No publication-blocking errors."
              : `${result.errors.length} blocking error(s).`}
          </p>
          {result.errors.length > 0 ? (
            <ul>
              {result.errors.map((issue, index) => (
                <li key={`${issue.code}-${index}`}>
                  [{issue.code}] {issue.message}
                </li>
              ))}
            </ul>
          ) : null}
          {result.warnings.length > 0 ? (
            <>
              <p>{result.warnings.length} warning(s):</p>
              <ul>
                {result.warnings.map((issue, index) => (
                  <li key={`${issue.code}-${index}`}>
                    [{issue.code}] {issue.message}
                  </li>
                ))}
              </ul>
            </>
          ) : null}
          {result.info ? (
            <ul>
              <li>Bound berths: {result.info.boundBerthCount}</li>
              <li>Unbound berths: {result.info.unboundBerthCount}</li>
              <li>Observed binding coverage: {result.info.observedBerthBindingPercentage}%</li>
            </ul>
          ) : null}
        </div>
      ) : null}
    </section>
  );
}
