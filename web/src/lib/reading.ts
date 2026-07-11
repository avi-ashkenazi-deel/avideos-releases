import { writing } from '@/data/writing';
import type { WritingItem } from '@/data/types';

/**
 * Reading order for the continuous feed: strictly newest → oldest. This flows
 * naturally across categories (sections) instead of staying inside one, and
 * the feed does not loop — it simply ends at the oldest post.
 */
export function readingOrder(): WritingItem[] {
  return [...writing].sort((a, b) => b.date.localeCompare(a.date));
}
