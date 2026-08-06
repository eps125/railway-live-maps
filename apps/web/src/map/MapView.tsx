import { useMapData } from "./useMapData.js";
import { MapRenderer } from "./MapRenderer.js";
import { LiveStatusBanner } from "./LiveStatusBanner.js";

export interface MapViewProps {
  slug: string;
}

/** docs/PROJECT_SPEC.md §5 "Live map": show a clear connected/stale/data-gap status alongside
 * the map, never silently render as if data were fresh. */
export function MapView({ slug }: MapViewProps): JSX.Element {
  const { definition, state, error, loading, connectionStatus } = useMapData(slug);

  if (loading && !definition) {
    return <p>Loading map…</p>;
  }
  if (!definition) {
    return <p role="alert">{error ?? "Map not available."}</p>;
  }

  return (
    <section>
      <LiveStatusBanner
        connectionStatus={connectionStatus}
        qualityStatus={state?.quality.status ?? "unknown"}
      />
      <MapRenderer
        bundle={definition.definition}
        berths={state?.berths ?? {}}
        signals={state?.signals ?? {}}
      />
    </section>
  );
}
