import { useEffect, useState } from "react";

export type Route = { name: "public" } | { name: "editor" };

/** Minimal hand-rolled router for the two static route shapes this app needs (`/` public map,
 * `/editor` the Milestone 11/12 editor) — deliberately not `react-router-dom`, matching this
 * repo's established "hand-roll over dependency" style (the STOMP client) for a genuinely tiny
 * routing need. Revisit if the editor ever needs its own sub-navigation. */
export function useRoute(): Route {
  const [pathname, setPathname] = useState(() => window.location.pathname);

  useEffect(() => {
    const onPopState = (): void => setPathname(window.location.pathname);
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  return pathname.startsWith("/editor") ? { name: "editor" } : { name: "public" };
}

/** Client-side navigation without a full page reload — pushes history state and notifies
 * `useRoute` via a synthetic `popstate` event (the real event only fires on browser
 * back/forward, not on `pushState` itself). */
export function navigate(path: string): void {
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}
