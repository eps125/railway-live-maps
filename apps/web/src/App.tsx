import { useEffect } from "react";
import { MapView } from "./map/MapView.js";
import { EditorApp } from "./editor/EditorApp.js";
import { LandingPage } from "./LandingPage.js";
import { navigate, useNavigationCount, useRoute } from "./useRoute.js";
import { useSession, roleAtLeast } from "./auth/useSession.js";
import { LoginPage } from "./auth/LoginPage.js";
import { AdminUsersPage } from "./auth/AdminUsersPage.js";
import { TdBoundariesPage } from "./auth/TdBoundariesPage.js";
import { AdminBerthsPage } from "./auth/AdminBerthsPage.js";
import { BerthQueryPage } from "./auth/BerthQueryPage.js";
import { BerthStepsPage } from "./auth/BerthStepsPage.js";
import { BerthExplorerPage } from "./auth/BerthExplorerPage.js";
import { SClassExplorerPage } from "./auth/SClassExplorerPage.js";
import { AdminHubPage } from "./auth/AdminHubPage.js";
import { AdminMapsPage } from "./auth/AdminMapsPage.js";
import { AdminAuditLogPage } from "./auth/AdminAuditLogPage.js";
import { AdminAccessPage } from "./auth/AdminAccessPage.js";
import { AccessCodePage } from "./auth/AccessCodePage.js";
import { useAccess } from "./auth/useAccess.js";

const accessUntil = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Every admin-only route — a visit without an admin session redirects. */
const ADMIN_ROUTES = new Set([
  "adminHub",
  "adminMaps",
  "adminAuditLog",
  "adminAccess",
  "adminUsers",
  "adminTdBoundaries",
  "adminBerths",
  "adminBerthQuery",
  "adminBerthSteps",
  "adminBerthExplorer",
  "adminSClass",
]);

export function App(): JSX.Element {
  const route = useRoute();
  const navigationCount = useNavigationCount();
  const { session, refresh, logout } = useSession();
  // Milestone 84: whether the site needs an access code, and whether this visitor has one.
  const { access, refresh: refreshAccess } = useAccess();

  const isAuthenticated = session.status === "authenticated";
  const canEdit = isAuthenticated && roleAtLeast(session.user.role, "editor");
  const isAdmin = isAuthenticated && roleAtLeast(session.user.role, "admin");
  const sessionLoading = session.status === "loading";
  const accessStatus = access.status === "ready" ? access.access : null;
  const needsCode =
    accessStatus !== null && !accessStatus.allowed && !isAuthenticated && !sessionLoading;

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
    } else if (ADMIN_ROUTES.has(route.name) && !isAdmin) {
      navigate(isAuthenticated ? "/" : "/rlm-login");
    }
  }, [route.name, sessionLoading, canEdit, isAdmin, isAuthenticated]);

  let main: JSX.Element;
  if (route.name === "login") {
    main = (
      <LoginPage
        onLoggedIn={() => {
          void refresh();
          void refreshAccess();
          navigate("/");
        }}
      />
    );
  } else if (access.status === "loading") {
    main = <p className="app-loading">Loading…</p>;
  } else if (needsCode) {
    // Milestone 84: every address shows the code page; the address itself is kept, so the page
    // asked for appears once a code is accepted.
    main = <AccessCodePage onAccepted={() => void refreshAccess()} />;
  } else if (route.name === "editor") {
    main =
      sessionLoading || !canEdit ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <EditorApp
          // Milestone 85: moving between a map and its modules is a navigation between editors —
          // remount so each starts from its own draft.
          key={`${route.slug}|${navigationCount}`}
          slug={route.slug}
          isAdmin={isAdmin}
          contextSlug={new URLSearchParams(window.location.search).get("in")}
        />
      );
  } else if (route.name === "adminHub") {
    main = sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <AdminHubPage />;
  } else if (route.name === "adminMaps") {
    main = sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <AdminMapsPage />;
  } else if (route.name === "adminAuditLog") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <AdminAuditLogPage />;
  } else if (route.name === "adminAccess") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <AdminAccessPage />;
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
  } else if (route.name === "adminBerthSteps") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <BerthStepsPage />;
  } else if (route.name === "adminBerthExplorer") {
    main =
      sessionLoading || !isAdmin ? <p className="app-loading">Loading…</p> : <BerthExplorerPage />;
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
        // (including its playback position) rather than inheriting the previous map's. Keyed on
        // navigations, not on `?at=`: playback rewrites `at` in place as it runs (2026-09-30), and
        // any re-render of App must not remount the map mid-playback because of that.
        key={`${route.slug}|${navigationCount}`}
        slug={route.slug}
        centerElementId={centerElementId}
        centerBoundaryName={centerBoundaryName}
        initialPlayback={initialPlayback}
        isAdmin={isAdmin}
      />
    );
  } else {
    main = <LandingPage isAdmin={isAdmin} canEdit={canEdit} />;
  }

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="app-header__brand">
          <h1>Matts TD Mapping Project</h1>
        </div>
        <nav className="app-nav" aria-label="Primary">
          {!needsCode && (
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
          )}
          {isAdmin && (
            <a
              className="app-nav__link"
              href="/admin"
              aria-current={ADMIN_ROUTES.has(route.name) ? "page" : undefined}
              onClick={(e) => {
                e.preventDefault();
                navigate("/admin");
              }}
            >
              Admin
            </a>
          )}
          {!isAuthenticated && accessStatus?.access === "code" && accessStatus.expiresAt && (
            <span
              className="app-nav__access"
              title="You are using an access code. Forget it to return to the code page."
            >
              Access until {accessUntil.format(new Date(accessStatus.expiresAt))}
              <button
                type="button"
                className="app-nav__link"
                onClick={() => {
                  void fetch("/api/v1/access/leave", { method: "POST" }).then(() =>
                    refreshAccess(),
                  );
                }}
              >
                Forget code
              </button>
            </span>
          )}
          {isAuthenticated ? (
            <button
              type="button"
              className="app-nav__link"
              onClick={() => {
                void logout().then(() => {
                  void refreshAccess();
                  navigate("/");
                });
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
