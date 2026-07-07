import { writing } from '@/data/writing';
import type { WritingItem } from '@/data/types';

/**
 * Reading order for the "pull to next" flow: articles grouped by category
 * (section), each group newest-first, groups in first-seen (newest) order.
 */
export function readingOrder(): WritingItem[] {
  const byDate = [...writing].sort((a, b) => b.date.localeCompare(a.date));
  const groups: string[] = [];
  for (const w of byDate) if (!groups.includes(w.source)) groups.push(w.source);
  return groups.flatMap((g) => byDate.filter((w) => w.source === g));
}
