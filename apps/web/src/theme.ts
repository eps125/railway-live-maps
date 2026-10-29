/**
 * Light mode (2026-10-29): the visitor's choice of light or dark, remembered in this browser like
 * the map toggles, for users and access-code holders alike. Only shown to — and only applied for
 * — viewers with the `site.light_mode` permission; anyone else always sees dark. It is purely
 * presentation: no data depends on it, so there is nothing for the API to enforce.
 */
export type Theme = "dark" | "light";

const THEME_KEY = "rlm.theme";

export function readStoredTheme(): Theme {
  try {
    return window.localStorage.getItem(THEME_KEY) === "light" ? "light" : "dark";
  } catch {
    return "dark";
  }
}

export function writeStoredTheme(theme: Theme): void {
  try {
    window.localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Storage blocked (private mode): the choice lasts for this page only.
  }
}

/** Sets `data-theme` on <html>; `styles.css` holds the light values. Dark is the default. */
export function applyTheme(theme: Theme): void {
  if (theme === "light") document.documentElement.dataset.theme = "light";
  else delete document.documentElement.dataset.theme;
}
