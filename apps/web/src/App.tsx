import { MapView } from "./map/MapView.js";

const LANCASTER_MAP_SLUG = import.meta.env["VITE_LANCASTER_MAP_SLUG"] ?? "lancaster";

export function App(): JSX.Element {
  return (
    <main>
      <h1>Railway Live Maps</h1>
      <MapView slug={LANCASTER_MAP_SLUG} />
      <footer>
        For information and enthusiast use only. Not official and not suitable for safety-critical
        or operational decisions.
      </footer>
    </main>
  );
}
