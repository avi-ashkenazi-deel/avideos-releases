// Single source of truth for top-level sections: drives nav, routes and the
// mobile pager order.
export interface SectionDef {
  path: string;
  label: string;
  index: string; // two-digit index shown in the typographic nav
}

export const sections: SectionDef[] = [
  { path: '/', label: 'Index', index: '00' },
  { path: '/writing', label: 'Writing', index: '01' },
  { path: '/talks', label: 'Talks', index: '02' },
  { path: '/projects', label: 'Projects', index: '03' },
  { path: '/tools', label: 'Tools', index: '04' },
  { path: '/gallery', label: 'Gallery', index: '05' },
  { path: '/photography', label: 'Photography', index: '06' },
  { path: '/about', label: 'About', index: '07' },
  { path: '/socials', label: 'Socials', index: '08' },
];

export function sectionIndex(pathname: string): number {
  // Match by first path segment so detail routes still resolve to a section.
  const seg = '/' + (pathname.split('/')[1] ?? '');
  const i = sections.findIndex((s) => s.path === seg);
  return i === -1 ? 0 : i;
}
