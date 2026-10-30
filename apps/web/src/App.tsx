import { useEffect, useMemo, useState } from "react";
import { MapView } from "./map/MapView.js";
import { EditorApp } from "./editor/EditorApp.js";
import { LandingPage } from "./LandingPage.js";
import { navigate, useNavigationCount, useRoute } from "./useRoute.js";
import { useSession } from "./auth/useSession.js";
import { PermissionsProvider, ROUTE_PERMISSIONS } from "./auth/permissions.js";
import { AdminUserTypesPage } from "./auth/AdminUserTypesPage.js";
import { LoginPage } from "./auth/LoginPage.js";
import { AdminUsersPage } from "./auth/AdminUsersPage.js";
import { TdBoundariesPage } from "./auth/TdBoundariesPage.js";
import { AdminMaintenancePage } from "./auth/AdminMaintenancePage.js";
import { AdminOutagesPage } from "./auth/AdminOutagesPage.js";
import { outagePillClass, outagePillCount, useOutageSummary } from "./auth/useOutageSummary.js";
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
import { applyTheme, readStoredTheme, writeStoredTheme, type Theme } from "./theme.js";
import { NOTICE } from "./notice.js";

const accessUntil = new Intl.DateTimeFormat("en-GB", {
  timeZone: "Europe/London",
  weekday: "short",
  hour: "2-digit",
  minute: "2-digit",
});

/** Every admin-area route — a visit without one of its permissions (auth/permissions.tsx)
 * redirects. */
const ADMIN_ROUTES = new Set(Object.keys(ROUTE_PERMISSIONS));

export function App(): JSX.Element {
  const route = useRoute();
  const navigationCount = useNavigationCount();
  const { session, refresh, logout } = useSession();
  // Milestone 84: whether the site needs an access code, and whether this visitor has one.
  const { access, refresh: refreshAccess } = useAccess();

  const isAuthenticated = session.status === "authenticated";
  const sessionLoading = session.status === "loading";
  const accessStatus = access.status === "ready" ? access.access : null;
  // Milestone 99 (docs/adr/0022): what this visitor may do — their user type's permissions when
  // logged in, else the public type's plus any access code's. UI only; the API enforces each.
  const permissionList =
    session.status === "authenticated"
      ? session.user.permissions
      : (accessStatus?.permissions ?? []);
  const permissions = useMemo(() => new Set(permissionList), [permissionList.join(",")]);
  const canOpen = (routeName: string): boolean =>
    (ROUTE_PERMISSIONS[routeName] ?? []).some((p) => permissions.has(p));
  const canEdit = permissions.has("editor.view");
  // 2026-10-30: the unseen-outage pill on the Admin link (logged-in users with outage details).
  const outageSummary = useOutageSummary(isAuthenticated && canOpen("adminOutages"));
  const outageCount = outagePillCount(outageSummary);

  // 2026-10-29: light mode, for viewers with `site.light_mode`; remembered in this browser.
  const canChooseTheme = permissions.has("site.light_mode");
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  const permissionsKnown = !sessionLoading && access.status !== "loading";
  useEffect(() => {
    // Until the permissions are known, keep what main.tsx painted from the remembered choice.
    if (!permissionsKnown) return;
    applyTheme(canChooseTheme ? theme : "dark");
  }, [permissionsKnown, canChooseTheme, theme]);
  function toggleTheme(): void {
    const next: Theme = theme === "light" ? "dark" : "light";
    writeStoredTheme(next);
    setTheme(next);
  }
  // 2026-10-30: on a phone the links fold into a menu; it closes whenever the page changes.
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => setMenuOpen(false), [route.name, navigationCount]);
  const canOpenRoute = !ADMIN_ROUTES.has(route.name) || canOpen(route.name);
  const needsCode =
    accessStatus !== null && !accessStatus.allowed && !isAuthenticated && !sessionLoading;

  // Milestone 29: a logged-out (or under-privileged) visit to a gated route redirects to the
  // login page instead of showing whatever the API's 401/403 looks like — the route itself is
  // never revealed to render. Redirecting is a side effect, so it belongs in an effect, not the
  // render body itself (which must stay pure). Milestone 30: `/editor` with no slug has nothing
  // to load — send it to the landing page, where every map's own "Edit" link carries the slug.
  useEffect(() => {
    if (sessionLoading) return;
    // An access code may give editor permissions (Milestone 99), so wait for the code check too.
    if (access.status === "loading") return;
    if (route.name === "editor" && !canEdit) {
      navigate(isAuthenticated ? "/" : "/rlm-login");
    } else if (route.name === "editorPicker") {
      navigate("/");
    } else if (!canOpenRoute) {
      navigate(isAuthenticated ? "/" : "/rlm-login");
    }
  }, [route.name, sessionLoading, access.status, canEdit, canOpenRoute, isAuthenticated]);

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
          contextSlug={new URLSearchParams(window.location.search).get("in")}
        />
      );
  } else if (route.name === "adminHub") {
    main =
      sessionLoading || !canOpenRoute ? <p className="app-loading">Loading…</p> : <AdminHubPage />;
  } else if (route.name === "adminMaps") {
    main =
      sessionLoading || !canOpenRoute ? <p className="app-loading">Loading…</p> : <AdminMapsPage />;
  } else if (route.name === "adminAuditLog") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminAuditLogPage />
      );
  } else if (route.name === "adminAccess") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminAccessPage />
      );
  } else if (route.name === "adminUserTypes") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminUserTypesPage />
      );
  } else if (route.name === "adminUsers") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminUsersPage />
      );
  } else if (route.name === "adminTdBoundaries") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <TdBoundariesPage />
      );
  } else if (route.name === "adminBerths") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminBerthsPage />
      );
  } else if (route.name === "adminBerthQuery") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <BerthQueryPage />
      );
  } else if (route.name === "adminBerthSteps") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <BerthStepsPage />
      );
  } else if (route.name === "adminBerthExplorer") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <BerthExplorerPage />
      );
  } else if (route.name === "adminMaintenance") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminMaintenancePage />
      );
  } else if (route.name === "adminOutages") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <AdminOutagesPage />
      );
  } else if (route.name === "adminSClass") {
    main =
      sessionLoading || !canOpenRoute ? (
        <p className="app-loading">Loading…</p>
      ) : (
        <SClassExplorerPage />
      );
  } else if (route.name === "map") {
    // Milestone 31: a places-search click-through carries `?center=<elementId>` — read directly
    // from the URL rather than teaching useRoute about query strings, since only this one route
    // cares about it. Re-evaluated on every render, so it stays in sync with `navigate()`-driven
    // route changes (which re-render App via useRoute's own state) without needing its own effect.
    // Milestone 32 adds `?boundary=<name>`, the same click-through pattern from a boundary
    // element on the adjacent map instead of a places search. Milestone 98: both are arrival-only —
    // once the map opens, MapRenderer replaces them with the view (`?x=&y=&z=`), which wins.
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
      />
    );
  } else {
    main = <LandingPage />;
  }

  return (
    <PermissionsProvider permissions={permissions}>
      <div className="app-shell">
        <header className="app-header">
          <div className="app-header__brand">
            <h1>BetterMap</h1>
          </div>
          {/* The theme switch stays in the bar; on a phone everything else is in the menu. */}
          {canChooseTheme && (
            <button
              type="button"
              className="app-nav__link app-nav__theme"
              aria-label={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              title={theme === "light" ? "Switch to dark mode" : "Switch to light mode"}
              onClick={toggleTheme}
            >
              <span aria-hidden="true">{theme === "light" ? "☾" : "☀"}</span>
            </button>
          )}
          <button
            type="button"
            className="app-header__menu-btn"
            aria-label="Menu"
            aria-expanded={menuOpen}
            aria-controls="app-nav"
            onClick={() => setMenuOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
            {outageCount > 0 && (
              <span
                className={`${outagePillClass(outageSummary)} outage-pill--dot`}
                aria-hidden="true"
              />
            )}
          </button>
          {menuOpen ? (
            <div
              className="app-header__menu-backdrop"
              aria-hidden="true"
              onClick={() => setMenuOpen(false)}
            />
          ) : null}
          <nav
            id="app-nav"
            className={`app-nav${menuOpen ? " app-nav--open" : ""}`}
            aria-label="Primary"
          >
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
            {canOpen("adminHub") && (
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
                {outageCount > 0 && (
                  <span
                    className={outagePillClass(outageSummary)}
                    title={`${outageCount} data outage${outageCount === 1 ? "" : "s"} not yet seen`}
                    aria-label={`${outageCount} data outage${outageCount === 1 ? "" : "s"} not yet seen`}
                  >
                    {outageCount}
                  </span>
                )}
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
            {/* CLAUDE.md rule 16: the notice is always in the menu, whatever the map shows. */}
            <p className="app-nav__notice">{NOTICE}</p>
          </nav>
        </header>

        <main className="app-main">{main}</main>

        {/* 2026-10-30: a map page gives the footer's height to the map, which carries its own short
            notice (MapView); the full sentence is in the menu there. */}
        {route.name !== "map" ? <footer className="app-footer">{NOTICE}</footer> : null}
      </div>
    </PermissionsProvider>
  );
}
