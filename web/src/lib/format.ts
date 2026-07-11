/** Format an ISO date as e.g. "Nov 2025". */
export function formatMonthYear(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
}

/** Format an ISO date as e.g. "15 Nov 2025". */
export function formatFullDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
  });
}
