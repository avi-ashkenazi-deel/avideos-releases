/**
 * Recipe library: one procedural skeleton recipe per character in CHARSET.
 */
import { CHARSET } from '../glyph';
import type { Recipe } from './common';
import { upper } from './upper';
import { lower } from './lower';
import { digits } from './digits';
import { latinExtra } from './latinExtra';
import { cyrillic } from './cyrillic';
import { punct } from './punct';
import { symbols } from './symbols';
import { hebrew } from './hebrew';

export type { Recipe, RecipeCtx, RecipeResult, Frame } from './common';
export { frame, finish, param, rec } from './common';
export { upper, lower, digits, latinExtra, cyrillic, punct, symbols, hebrew };

export const recipes: Record<string, Recipe> = { ...upper, ...lower, ...digits, ...latinExtra, ...cyrillic, ...punct, ...symbols, ...hebrew };

export function getRecipe(char: string): Recipe | undefined {
  return recipes[char];
}

/** characters without a recipe (should be empty for the Latin block) */
export function missingRecipes(chars: string | string[] = CHARSET): string[] {
  return [...chars].filter((ch) => !recipes[ch]);
}
