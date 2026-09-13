import { useEffect, useState } from "react";

export type Route =
  { name: "public" } | { name: "editor" } | { name: "login" } | { name: "adminUsers" };

/** Minimal hand-rolled router for the small set of static route shapes this app needs (`/` public
 * map, `/editor` the Milestone 11/12 editor, `/rlm-login` and `/admin/users` added in Milestone
 * 29) — deliberately not `react-router-dom`, matching this repo's established "hand-roll over
 * dependency" style (the STOMP client) for a genuinely tiny routing need. Revisit if the editor
 * ever needs its own sub-navigation. */
export function useRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  if (pathname.startsWith("/rlm-login")) return { name: "login" };
  if (pathname.startsWith("/admin/users")) return { name: "adminUsers" };
  if (pathname.startsWith("/editor")) return { name: "editor" };
  return { name: "public" };
}

/** Client-side navigation without a full page reload — pushes history state and notifies
 * `useRoute` via a synthetic `popstate` event (the real event only fires on browser
 * back/forward, not on `pushState` itself). */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
