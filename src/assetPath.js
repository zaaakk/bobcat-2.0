/**
 * Resolve an asset URL against the app's deploy base.
 *
 * Every runtime asset lives under `public/assets/`, which Vite copies verbatim
 * into the build output. Hard-coded `/assets/...` strings only resolve when the
 * site is served from a domain root — on a GitHub Pages project site the app
 * lives under `/<repo>/`, so a leading slash points outside it entirely and
 * every texture, model and sound 404s.
 *
 * `import.meta.env.BASE_URL` is whatever Vite's `base` is set to, always with a
 * trailing slash, and `/` in dev. Going through here keeps the game host-
 * agnostic: domain root, subpath, or file-relative all work from one build.
 */
export const ASSET_BASE = import.meta.env.BASE_URL;

/** `asset('plants/juniper.png')` -> `<base>assets/plants/juniper.png` */
export function asset(rel) {
  return `${ASSET_BASE}assets/${rel}`;
}
