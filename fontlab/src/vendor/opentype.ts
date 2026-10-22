// opentype.js 2.0 ships an ESM build with named exports but no `exports` map,
// so Node (vitest) resolves the CJS build and only sees `default`. Normalise.
import * as m from 'opentype.js';
const ot: any = (m as any).default?.Font ? (m as any).default : m;
export const Font: any = ot.Font;
export const Glyph: any = ot.Glyph;
export const Path: any = ot.Path;
export const parse: (buf: ArrayBuffer) => any = ot.parse;
