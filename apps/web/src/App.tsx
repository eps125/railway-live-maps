import { useEffect } from "react";
import { MapView } from "./map/MapView.js";
import { EditorApp } from "./editor/EditorApp.js";
import { LandingPage } from "./LandingPage.js";
import { navigate, useRoute } from "./useRoute.js";
import { useSession, roleAtLeast } from "./auth/useSession.js";
import { LoginPage } from "./auth/LoginPage.js";
import { AdminUsersPage } from "./auth/AdminUsersPage.js";
import { TdBoundariesPage } from "./auth/TdBoundariesPage.js";
import { AdminBerthsPage } from "./auth/AdminBerthsPage.js";
import { BerthQueryPage } from "./auth/BerthQueryPage.js";
import { SClassExplorerPage } from "./auth/SClassExplorerPage.js";

export function App(): JSX.Element {
  const route = useRoute();
  const { session, refresh, logout } = useSession();

  const isAuthenticated = session.status === "authenticated";
  const canEdit = isAuthenticated && roleAtLeast(session.user.role, "editor");
  const isAdmin = isAuthenticated && roleAtLeast(session.user.role, "admin");
  const sessionLoading = session.status === "loading";

  // Milestone 29: a logged-out (or under-privileged) visit to a gated route redirects to the
  // login page instead of showing whatever the API's 401/403 looks like — the route itself is
  // never revealed to render. Redirecting is a side effect, so it belongs in an effect, not the
  // render body itself (which must stay pure). Milestone 30: `/editor` with no slug has nothing
  // to load — send it to the landing page, where every map's own "Edit" link carries the slug.
  useEffect(() => {
    if (sessionLoading) return;
    if (route.name === "editor" && !canEdit) {
      navigate("/rlm-login");
    } else if (route.name === "editorPicker") {
      navigate("/");
    } else if (
      (route.name === "adminUsers" ||
        route.name === "adminTdBoundaries" ||
        route.name === "adminBerths" ||
        route.name === "adminBerthQuery" ||
        route.name === "adminSClass") &&
      !isAdmin
    ) {
      navigate(isAuthenticated ? "/" : "/rlm-login");
    }
  }, [route.name, sessionLoading, canEdit, isAdmin, isAuthenticated]);

  let main: JSX.Element;
  if (route.name === "login") {
    main = (
      <LoginPage
        onLoggedIn={() => {
          void refresh();
          navigate("/");
        }}
      />
    );
  } else if (route.name === "editor") {
    main =
      sessionLoading || !canEdit ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <EditorApp slug={route.slug} />
      );
  } else if (route.name === "adminUsers") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <AdminUsersPage />;
  } else if (route.name === "adminTdBoundaries") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <TdBoundariesPage />;
  } else if (route.name === "adminBerths") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <AdminBerthsPage />;
  } else if (route.name === "adminBerthQuery") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <BerthQueryPage />;
  } else if (route.name === "adminSClass") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <SClassExplorerPage />;
  } else if (route.name === "map") {
    // Milestone 31: a places-search click-through carries `?center=<elementId>` — read directly
    // from the URL rather than teaching useRoute about query strings, since only this one route
    // cares about it. Re-evaluated on every render, so it stays in sync with `navigate()`-driven
    // route changes (which re-render App via useRoute's own state) without needing its own effect.
    // Milestone 32 adds `?boundary=<name>`, the same click-through pattern from a boundary
    // element on the adjacent map instead of a places search.
    const searchParams = new URLSearchParams(window.location.search);
    const centerElementId = searchParams.get("center");
    const centerBoundaryName = searchParams.get("boundary");
    // Milestone 65: a boundary link followed in playback carries the clock, so the adjacent map
    // opens in playback at the same moment. An unparseable `at` is ignored (opens live).
    const atMs = Date.parse(searchParams.get("at") ?? "");
    const initialPlayback = Number.isNaN(atMs)
      ? null
      : {
          atMs,
          speed: Number(searchParams.get("speed") ?? "1") || 1,
          playing: searchParams.get("play") === "1",
        };
    main = (
      <MapView
        // Remount per map and per arrival, so a boundary link starts the new map's own state
        // (including its playback position) rather than inheriting the previous map's.
        key={`${route.slug}|${searchParams.get("at") ?? ""}`}
        slug={route.slug}
        centerElementId={centerElementId}
        centerBoundaryName={centerBoundaryName}
        initialPlayback={initialPlayback}
        isAdmin={isAdmin}
      />
    );
  } else {
    main = <LandingPage canCreateMap={isAdmin} canEdit={canEdit} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <h1>Matts TD Mapping Project</h1>
        </div>
        <nav className="app-nav" aria-label="Primary">
          <a
            className="app-nav__link"
            href="/"
            aria-current={route.name === "landing" ? "page" : undefined}
            onClick={(e) => {
              e.preventDefault();
              navigate("/");
            }}
          >
            Maps
          </a>
          {isAdmin && (
            <a
              className="app-nav__link"
              href="/admin/users"
              aria-current={route.name === "adminUsers" ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate("/admin/users");
              }}
            >
              Users
            </a>
          )}
          {isAdmin && (
            <a
              className="app-nav__link"
              href="/admin/td-boundaries"
              aria-current={route.name === "adminTdBoundaries" ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate("/admin/td-boundaries");
              }}
            >
              TD boundaries
            </a>
          )}
          {isAdmin && (
            <a
              className="app-nav__link"
              href="/admin/berths"
              aria-current={
                route.name === "adminBerths" ||
                route.name === "adminBerthQuery" ||
                route.name === "adminSClass"
                  ? "page"
                  : undefined
              }
              onClick={(e) => {
                e.preventDefault();
                navigate("/admin/berths");
              }}
            >
              Berths
            </a>
          )}
          {isAuthenticated ? (
            <button
              type="button"
              className="app-nav__link"
              onClick={() => {
                void logout().then(() => navigate("/"));
              }}
            >
              Log out ({session.user.username})
            </button>
          ) : null}
        </nav>
      </header>

      <main className="app-main">{main}</main>

      <footer className="app-footer">
        For information and enthusiast use only. Not official and not suitable for safety-critical
        or operational decisions.
      </footer>
    </div>
  );
}
