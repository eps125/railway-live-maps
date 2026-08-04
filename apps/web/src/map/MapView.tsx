import { useMapData } from "./useMapData.js";
import { MapRenderer } from "./MapRenderer.js";

export interface MapViewProps {
  slug: string;
}

/** docs/PROJECT_SPEC.md §5 "Live map": show a clear connected/stale/data-gap status alongside
 * the map, never silently render as if data were fresh. */
export function MapView({ slug }: MapViewProps): JSX.Element {
  const { definition, state, error, loading } = useMapData(slug);

  if (loading && !definition) {
    return <p>Loading map…</p>;
  }
  if (!definition) {
    return <p role="alert">{error ?? "Map not available."}</p>;
  }

  const qualityStatus = state?.quality.status ?? "unknown";
  const bannerText =
    qualityStatus === "ok"
      ? "Live"
      : qualityStatus === "stale"
        ? "Data may be stale"
        : "Live data status unknown";

  return (
    <section>
      <div role="status" aria-live="polite">
        {bannerText}
      </div>
      <MapRenderer
        bundle={definition.definition}
        berths={state?.berths ?? {}}
        signals={state?.signals ?? {}}
      />
    </section>
  );
}
