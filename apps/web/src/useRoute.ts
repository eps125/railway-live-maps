import { useEffect, useState } from "react";

export type Route =
  | { name: "landing" }
  | { name: "map"; slug: string }
  | { name: "editor"; slug: string }
  // A bare `/editor` with no slug — nothing to load; App.tsx redirects this to the landing page.
  | { name: "editorPicker" }
  | { name: "login" }
  | { name: "adminUsers" }
  | { name: "adminTdBoundaries" };

/** Minimal hand-rolled router for the small set of route shapes this app needs (`/` the Milestone
 * 30 map-list landing page, `/map/:slug` the public map, `/editor/:slug` the Milestone 11/12
 * editor for a given map, `/rlm-login` and `/admin/users` added in Milestone 29, `/admin/
 * td-boundaries` added in Milestone 39) — deliberately not `react-router-dom`, matching this
 * repo's established "hand-roll over dependency" style (the STOMP client) for a genuinely tiny
 * routing need. Revisit if the editor ever needs its own sub-navigation. */
export function useRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (pathname.startsWith("/rlm-login")) return { name: "login" };
  if (pathname.startsWith("/admin/users")) return { name: "adminUsers" };
  if (pathname.startsWith("/admin/td-boundaries")) return { name: "adminTdBoundaries" };

  const editorMatch = /^\/editor\/([^/]+)\/?$/.exec(pathname);
  if (editorMatch) return { name: "editor", slug: decodeURIComponent(editorMatch[1]!) };
  if (pathname === "/editor" || pathname === "/editor/") return { name: "editorPicker" };

  const mapMatch = /^\/map\/([^/]+)\/?$/.exec(pathname);
  if (mapMatch) return { name: "map", slug: decodeURIComponent(mapMatch[1]!) };

  return { name: "landing" };
}

/** Client-side navigation without a full page reload — pushes history state and notifies
 * `useRoute` via a synthetic `popstate` event (the real event only fires on browser
 * back/forward, not on `pushState` itself). */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
