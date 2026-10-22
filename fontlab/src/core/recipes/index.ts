/**
 * Recipe library: one procedural skeleton recipe per character in CHARSET.
 */
import { CHARSET } from '../glyph';
import type { Recipe } from './common';
import { upper } from './upper';
import { lower } from './lower';
import { digits } from './digits';

export type { Recipe, RecipeCtx, RecipeResult, Frame } from './common';
export { frame, finish, param, rec } from './common';
export { upper, lower, digits };

export const recipes: Record<string, Recipe> = { ...upper, ...lower, ...digits };

export function getRecipe(char: string): Recipe | undefined {
  return recipes[char];
}

/** characters in CHARSET without a recipe (should be empty) */
export function missingRecipes(): string[] {
  return [...CHARSET].filter((ch) => !recipes[ch]);
}
