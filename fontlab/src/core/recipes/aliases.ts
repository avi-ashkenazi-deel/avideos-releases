/**
 * Derivation tables: characters that are built from another glyph in the
 * project rather than from a recipe. Resolution order in the generator is
 * composite (NFD base + marks) → addition → alias → small-cap → borrow → recipe.
 */

/** Cyrillic / other letters whose shape IS a Latin glyph: clone it. */
export const ALIASES: Record<string, string> = {
  'А': 'A', 'В': 'B', 'Е': 'E', 'К': 'K', 'М': 'M', 'Н': 'H', 'О': 'O', 'Р': 'P', 'С': 'C', 'Т': 'T', 'Х': 'X',
  'а': 'a', 'е': 'e', 'о': 'o', 'р': 'p', 'с': 'c', 'у': 'y', 'х': 'x',
  'І': 'I', 'і': 'i', 'Ј': 'J', 'ј': 'j', 'Ѕ': 'S', 'ѕ': 's',
  'ı': 'i', // dotless i: alias + dot removal (handled in derive)
};

/** Lowercase letters that are small capitals of their uppercase. */
export const SMALLCAPS: Record<string, string> = {
  'в': 'В', 'г': 'Г', 'ж': 'Ж', 'з': 'З', 'и': 'И', 'к': 'К', 'л': 'Л', 'м': 'М', 'н': 'Н', 'п': 'П', 'т': 'Т',
  'ц': 'Ц', 'ч': 'Ч', 'ш': 'Ш', 'щ': 'Щ', 'ъ': 'Ъ', 'ы': 'Ы', 'ь': 'Ь', 'э': 'Э', 'ю': 'Ю', 'я': 'Я', 'є': 'Є', 'ґ': 'Ґ',
};

export type AdditionKind = 'slash' | 'lbar' | 'hbar' | 'midbar';

/** Base glyph + an extra stroke (Ø = O + slash, Ł = L + bar, Đ = D + bar …). */
export const ADDITIONS: Record<string, { base: string; add: AdditionKind }> = {
  'Ø': { base: 'O', add: 'slash' }, 'ø': { base: 'o', add: 'slash' },
  'Ł': { base: 'L', add: 'lbar' }, 'ł': { base: 'l', add: 'lbar' },
  'Đ': { base: 'D', add: 'hbar' }, 'đ': { base: 'd', add: 'hbar' }, 'Ð': { base: 'D', add: 'hbar' },
  'Ħ': { base: 'H', add: 'midbar' }, 'ħ': { base: 'h', add: 'midbar' },
  'Ŧ': { base: 'T', add: 'midbar' }, 'ŧ': { base: 't', add: 'midbar' },
};

/** bases whose above-marks replace the dot (i, j) */
export const DOTTED_BASES = new Set(['i', 'j', 'і', 'ј']);

/** bases that take the comma-style caron (ď ť ľ Ľ) */
export const COMMA_CARON_BASES = new Set(['d', 't', 'l', 'L']);
