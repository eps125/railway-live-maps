import { MapView } from "./map/MapView.js";
import { EditorApp } from "./editor/EditorApp.js";
import { navigate, useRoute } from "./useRoute.js";

const LANCASTER_MAP_SLUG = import.meta.env["VITE_LANCASTER_MAP_SLUG"] ?? "lancaster";

export function App(): JSX.Element {
  const route = useRoute();

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <span className="app-header__mark" aria-hidden="true">
            RLM
          </span>
          <div>
            <h1>Railway Live Maps</h1>
            <p className="app-header__tagline">Nationwide TD/TRUST recorder — not official</p>
          </div>
        </div>
        <nav className="app-nav" aria-label="Primary">
          <a
            className="app-nav__link"
            href="/"
            aria-current={route.name === "public" ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            Live map
          </a>
          <a
            className="app-nav__link"
            href="/editor"
            aria-current={route.name === "editor" ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate("/editor");
            }}
          >
            Editor
          </a>
        </nav>
      </header>

      <main className="app-main">
        {route.name === "editor" ? (
          <EditorApp slug={LANCASTER_MAP_SLUG} />
        ) : (
          <MapView slug={LANCASTER_MAP_SLUG} />
        )}
      </main>

      <footer className="app-footer">
        For information and enthusiast use only. Not official and not suitable for safety-critical
        or operational decisions.
      </footer>
    </div>
  );
}
