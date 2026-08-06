import { MapView } from "./map/MapView.js";
import { EditorApp } from "./editor/EditorApp.js";
import { useRoute } from "./useRoute.js";

const LANCASTER_MAP_SLUG = import.meta.env["VITE_LANCASTER_MAP_SLUG"] ?? "lancaster";

export function App(): JSX.Element {
  const route = useRoute();

  return (
    <main>
      <h1>Railway Live Maps</h1>
      {route.name === "editor" ? (
        <EditorApp slug={LANCASTER_MAP_SLUG} />
      ) : (
        <MapView slug={LANCASTER_MAP_SLUG} />
      )}
      <footer>
        For information and enthusiast use only. Not official and not suitable for safety-critical
        or operational decisions.
      </footer>
    </main>
  );
}
