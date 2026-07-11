/**
 * Resolve a public asset path against Vite's base URL so it works whether the
 * site is served from the domain root (custom domain) or a project subpath
 * (e.g. GitHub Pages at /avideos-releases/). External URLs pass through.
 */
export function asset(path: string): string {
  if (!path) return path;
  if (/^https?:\/\//.test(path) || path.startsWith('data:')) return path;
  const base = import.meta.env.BASE_URL; // '/' or '/avideos-releases/'
  return base.replace(/\/$/, '') + '/' + path.replace(/^\//, '');
}
