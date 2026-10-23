/**
 * Character blocks the user can switch on. `latin` is always on. Everything
 * is keyed by literal characters; glyph names and cmap come from code points.
 */
import type { FontProject } from './glyph';
import { CHARSET } from './glyph';

export interface Block {
  id: string;
  name: string;
  chars: string;
  /** one-line sample for the preview */
  sample: string;
  rtl?: boolean;
  always?: boolean;
}

const range = (a: string, b: string) => { let s = ''; for (let c = a.codePointAt(0)!; c <= b.codePointAt(0)!; c++) s += String.fromCodePoint(c); return s; };

/** Latin-1 letters + Latin Extended-A, minus odd ligature/compat forms. */
const ACCENTS = (range('À', 'ö') + range('ø', 'ÿ') + range('Ā', 'ž'))
  .replace(/[×÷ĲĳĿŀŉſĸŊŋ]/g, '');

export const BLOCKS: Block[] = [
  { id: 'latin', name: 'Latin', chars: CHARSET, sample: 'The quick brown fox jumps over the lazy dog 0123456789', always: true },
  { id: 'punct', name: 'Punctuation', chars: `.,;:!?¡¿'"‘’“”«»-–—_()[]{}/\\|@#&*+=<>~^%`, sample: 'Hello, world! (Really?) “Yes” — 100% #1 @home; a+b=c <ok> [x] {y} ~fin~' },
  { id: 'symbols', name: 'Symbols', chars: '$€£¥¢©®™°±×÷•…§¶†‡µ¬', sample: '$9 €8 £7 ¥6 ¢5 ©®™ 20° ±3 ×÷ • … §¶ †‡ µ¬' },
  { id: 'accents', name: 'Latin accents', chars: ACCENTS, sample: 'Zürich café façade naïve crème brûlée Ærø Łódź Ñandú Þór Ştefan Ğül Őrség' },
  { id: 'cyrillic', name: 'Cyrillic', chars: range('А', 'я') + 'ЁёЄєІіЇїҐґЈј', sample: 'Съешь же ещё этих мягких французских булок, да выпей чаю' },
  { id: 'hebrew', name: 'Hebrew', chars: 'אבגדהוזחטיכךלםמןנסעףפץצקרשת', sample: 'דג סקרן שט בים מאוכזב ולפתע מצא חברה', rtl: true },
];

export const BLOCK_BY_ID: Record<string, Block> = Object.fromEntries(BLOCKS.map((b) => [b.id, b]));

export function blockChars(id: string): string[] {
  return [...(BLOCK_BY_ID[id]?.chars ?? '')];
}

/** Which block a character belongs to (first match), or 'custom'. */
export function blockOf(ch: string): string {
  for (const b of BLOCKS) if (b.chars.includes(ch)) return b.id;
  return 'custom';
}

/** Ordered, de-duplicated characters for a project: enabled blocks, then custom. */
export function projectCharset(p: Pick<FontProject, 'blocks' | 'customChars'>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  const enabled = new Set([...(p.blocks ?? []), 'latin']);
  for (const b of BLOCKS) {
    if (!enabled.has(b.id)) continue;
    for (const ch of b.chars) if (!seen.has(ch)) { seen.add(ch); out.push(ch); }
  }
  for (const ch of [...(p.customChars ?? '')]) {
    if (/\s/.test(ch) || seen.has(ch)) continue;
    seen.add(ch); out.push(ch);
  }
  return out;
}

/** Group a charset into [blockId, chars[]] in block order, custom last. */
export function groupCharset(chars: string[]): [string, string[]][] {
  const groups = new Map<string, string[]>();
  for (const ch of chars) { const b = blockOf(ch); if (!groups.has(b)) groups.set(b, []); groups.get(b)!.push(ch); }
  const order = [...BLOCKS.map((b) => b.id), 'custom'];
  return order.filter((id) => groups.has(id)).map((id) => [id, groups.get(id)!]);
}

/** Preview text for the enabled blocks: one sample line per block. */
export function samplePreview(p: Pick<FontProject, 'blocks'>): string {
  const enabled = new Set([...(p.blocks ?? []), 'latin']);
  return BLOCKS.filter((b) => enabled.has(b.id)).map((b) => b.sample).join('\n');
}
