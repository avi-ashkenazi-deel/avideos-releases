/**
 * Point-compatible masters for variable-font export.
 *
 * A variable font interpolates point-for-point, so every master must have
 * identical contour and point counts. The regular pipeline (ribbon → union)
 * breaks that, so here each glyph gets a FIXED structure derived once from
 * its skeleton, and each master only moves points:
 *   stroke glyphs  : pre-resampled skeleton → ribbon with a fixed fan count
 *   outline glyphs : pre-densified contours → per-vertex normal offset
 * Only point-preserving DNA ops take part (weight, slant, wobble, melt,
 * bounce, jitter); inflate / erode / glitch are static-only.
 */
import type { FontProject, Glyph, Vec, StrokePoint, DnaParams } from '../../core/glyph';
import { resampleStroke, bboxOf, clamp } from '../../core/geometry';
import { glyphRng } from '../../core/prng';
import { glyphName } from '../otf';
import { densifyClosed, ringNormals } from '../../dna/util';
import { WOBBLE_FREQ, WOBBLE_AMP } from '../../dna/wobble';
import { jitterSample } from '../../dna/jitter';
import type { VarAxisSpec, VarMaster, VarPayload } from './index';
import { stackToDna } from '../../fx/stack';

export type VarAxisTag = 'wght' | 'slnt' | 'WOBL' | 'MELT' | 'BNCE';

export const AXIS_DEFS: Record<VarAxisTag, { name: string; min: number; max: number; dna: keyof DnaParams; toUser: (amount: number) => number; toAmount: (user: number) => number }> = {
  wght: { name: 'Weight', min: 100, max: 900, dna: 'weight', toUser: (a) => 500 + 400 * a, toAmount: (u) => (u - 500) / 400 },
  slnt: { name: 'Slant', min: -30, max: 30, dna: 'slant', toUser: (a) => -30 * a, toAmount: (u) => -u / 30 },
  WOBL: { name: 'Wobble', min: 0, max: 100, dna: 'wobble', toUser: (a) => 100 * a, toAmount: (u) => u / 100 },
  MELT: { name: 'Melt', min: 0, max: 100, dna: 'melt', toUser: (a) => 100 * a, toAmount: (u) => u / 100 },
  BNCE: { name: 'Bounce', min: 0, max: 100, dna: 'bounce', toUser: (a) => 100 * a, toAmount: (u) => u / 100 },
};

const FAN = 2;          // arc points per join side (fixed → compatible)
const CAP_PTS = 5;      // points per round cap
const SKELETON_SPACING = 18;

interface StrokeStruct { pts: StrokePoint[]; cap: Glyph['strokes'] extends (infer S)[] | undefined ? (S extends { cap: infer C } ? C : never) : never }
interface GlyphStruct { glyph: Glyph; strokes: StrokeStruct[]; rings: Vec[][] /* outline kind: densified base rings */; normals: Vec[][] }

function structureOf(g: Glyph): GlyphStruct {
  if (g.kind === 'stroke' && g.strokes) {
    const strokes = g.strokes
      .map((s) => ({ pts: resampleStroke(s.points.filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y)), SKELETON_SPACING), cap: s.cap }))
      .filter((s) => s.pts.length >= 1);
    return { glyph: g, strokes, rings: [], normals: [] };
  }
  const rings = (g.contours ?? []).filter((c) => c.points.length >= 3).map((c) => densifyClosed(c.points, 10));
  return { glyph: g, strokes: [], rings, normals: rings.map(ringNormals) };
}

/** Evaluate one glyph structure at a DNA location → compatible rings. */
function evaluate(st: GlyphStruct, dna: DnaParams): { rings: Vec[][]; advance: number } {
  const g = st.glyph;
  const noise = glyphRng(dna.seed, g.char, 'wobble').noise2;
  const kW = 1 + dna.weight * 0.9;
  const shear = Math.tan((dna.slant * 30 * Math.PI) / 180);
  let rings: Vec[][] = [];

  if (g.kind === 'stroke') {
    for (const s of st.strokes) {
      const pts = s.pts.map((p, i, arr) => {
        const a = arr[Math.max(0, i - 1)], b = arr[Math.min(arr.length - 1, i + 1)];
        const tx = b.x - a.x, ty = b.y - a.y, l = Math.hypot(tx, ty) || 1;
        const nz = noise(p.x * WOBBLE_FREQ, p.y * WOBBLE_FREQ);
        const wz = noise(p.x * WOBBLE_FREQ + 37.1, p.y * WOBBLE_FREQ - 19.3);
        const d = nz * dna.wobble * WOBBLE_AMP;
        return { x: p.x + (-ty / l) * d, y: p.y + (tx / l) * d, w: Math.max(2, p.w * kW * (1 + wz * dna.wobble * 0.5)) };
      });
      rings.push(compatibleRibbon(pts, s.cap !== 'flat'));
    }
  } else {
    const off = dna.weight * 35;
    rings = st.rings.map((ring, ri) => ring.map((p, i) => {
      const n = st.normals[ri][i];
      const nz = noise(p[0] * WOBBLE_FREQ, p[1] * WOBBLE_FREQ);
      const d = off + nz * dna.wobble * WOBBLE_AMP * 0.6;
      return [p[0] + n[0] * d, p[1] + n[1] * d] as Vec;
    }));
  }

  // melt (point-preserving version of dna/melt.ts)
  if (dna.melt > 0 && rings.length) {
    const b = bboxOf(rings.flat());
    const h = b.maxY - b.minY, cx = (b.minX + b.maxX) / 2;
    const mn = glyphRng(dna.seed, g.char, 'melt').noise2;
    rings = rings.map((r) => r.map(([x, y]) => {
      const t = clamp((y - b.minY) / (h + 1), 0, 1);
      const f = Math.pow(1 - t, 0.75);
      const d0 = clamp((mn(x * 0.018 + 50, 3) - 0.2) / 0.5, 0, 1);
      const drip = d0 * d0 * (3 - 2 * d0);
      return [x + Math.sign(x - cx) * dna.melt * 10 * (1 - t), y - dna.melt * (60 + 80 * mn(x * 0.01, 7) + 220 * drip) * f * f] as Vec;
    }));
  }
  // slant
  if (dna.slant !== 0) rings = rings.map((r) => r.map(([x, y]) => [x + shear * y, y] as Vec));
  // jitter
  let advance = g.advance;
  if (dna.jitter > 0 && rings.length) {
    const js = jitterSample(glyphRng(dna.seed, g.char, 'jitter'), dna.jitter);
    const b = bboxOf(rings.flat());
    const ox = (b.minX + b.maxX) / 2, oy = b.minY;
    rings = rings.map((r) => r.map(([x, y]) => [ox + (x - ox) * js.sx + js.dx, oy + (y - oy) * js.sy] as Vec));
    advance = advance * js.sx;
  }
  // bounce
  if (dna.bounce > 0 && rings.length) {
    const rng = glyphRng(dna.seed, g.char, 'bounce');
    const dy = rng.range(-1, 1) * dna.bounce * 120;
    const rot = (rng.range(-1, 1) * dna.bounce * 8 * Math.PI) / 180;
    const b = bboxOf(rings.flat());
    const cx = (b.minX + b.maxX) / 2, cy = (b.minY + b.maxY) / 2;
    const c = Math.cos(rot), s = Math.sin(rot);
    rings = rings.map((r) => r.map(([x, y]) => { const px = x - cx, py = y - cy; return [cx + px * c - py * s, cy + px * s + py * c + dy] as Vec; }));
  }
  advance += Math.max(0, dna.weight) * 60;
  return { rings, advance };
}

/** Ribbon with a fixed point count: 2 offsets per end + (FAN+1) per interior joint per side + caps. */
function compatibleRibbon(pts: StrokePoint[], roundCaps: boolean): Vec[] {
  if (pts.length === 1) {
    const p = pts[0]; const out: Vec[] = [];
    const n = 2 * (FAN + 1) + 2 * CAP_PTS;
    for (let i = 0; i < n; i++) { const t = (i / n) * Math.PI * 2; out.push([p.x + Math.cos(t) * p.w, p.y + Math.sin(t) * p.w]); }
    return out;
  }
  const n = pts.length;
  const dir: Vec[] = [];
  let last: Vec = [1, 0];
  for (let i = 0; i < n - 1; i++) {
    const dx = pts[i + 1].x - pts[i].x, dy = pts[i + 1].y - pts[i].y, l = Math.hypot(dx, dy);
    last = l > 1e-6 ? [dx / l, dy / l] : last;
    dir.push(last);
  }
  const left: Vec[] = [], right: Vec[] = [];
  const at = (i: number, ang: number, r: number): Vec => [pts[i].x + Math.cos(ang) * r, pts[i].y + Math.sin(ang) * r];
  const a0 = Math.atan2(dir[0][1], dir[0][0]) + Math.PI / 2;
  left.push(at(0, a0, pts[0].w)); right.push(at(0, a0 + Math.PI, pts[0].w));
  for (let i = 1; i < n - 1; i++) {
    const p = Math.atan2(dir[i - 1][1], dir[i - 1][0]) + Math.PI / 2;
    let turn = Math.atan2(dir[i - 1][0] * dir[i][1] - dir[i - 1][1] * dir[i][0], dir[i - 1][0] * dir[i][0] + dir[i - 1][1] * dir[i][1]);
    for (let s = 0; s <= FAN; s++) {
      const t = p + (turn * s) / FAN;
      left.push(at(i, t, pts[i].w));
      right.push(at(i, t + Math.PI, pts[i].w));
    }
  }
  const aN = Math.atan2(dir[n - 2][1], dir[n - 2][0]) + Math.PI / 2;
  left.push(at(n - 1, aN, pts[n - 1].w)); right.push(at(n - 1, aN + Math.PI, pts[n - 1].w));
  const ring: Vec[] = [...left];
  const capR = roundCaps ? 1 : 0.02;
  for (let s = 1; s <= CAP_PTS; s++) ring.push(at(n - 1, aN - (Math.PI * s) / (CAP_PTS + 1), pts[n - 1].w * capR));
  for (let i = right.length - 1; i >= 0; i--) ring.push(right[i]);
  for (let s = 1; s <= CAP_PTS; s++) ring.push(at(0, a0 + Math.PI - (Math.PI * s) / (CAP_PTS + 1), pts[0].w * capR));
  return ring;
}

export interface MasterPlan { axes: VarAxisSpec[]; locations: Record<string, number>[]; dnaFor: (loc: Record<string, number>) => DnaParams }

/** Star designspace: default = current DNA; one master per axis extreme that differs from default. */
export function planMasters(dna: DnaParams, tags: VarAxisTag[]): MasterPlan {
  const axes: VarAxisSpec[] = tags.map((tag) => {
    const d = AXIS_DEFS[tag];
    const def = clamp(d.toUser(dna[d.dna] as number), d.min, d.max);
    return { tag, name: d.name, min: d.min, default: Math.round(def), max: d.max };
  });
  const base: Record<string, number> = Object.fromEntries(axes.map((a) => [a.tag, a.default]));
  const locations: Record<string, number>[] = [base];
  for (const a of axes) {
    if (a.min !== a.default) locations.push({ ...base, [a.tag]: a.min });
    if (a.max !== a.default) locations.push({ ...base, [a.tag]: a.max });
  }
  const dnaFor = (loc: Record<string, number>): DnaParams => {
    const out: DnaParams = { ...dna, inflate: 0, erode: 0, glitch: 0 };
    for (const tag of tags) { const d = AXIS_DEFS[tag]; (out as any)[d.dna] = d.toAmount(loc[tag]); }
    for (const tag of Object.keys(AXIS_DEFS) as VarAxisTag[]) if (!tags.includes(tag)) { /* keep current value frozen */ }
    return out;
  };
  return { axes, locations, dnaFor };
}

export function buildVarPayload(project: FontProject, tags: VarAxisTag[]): VarPayload {
  const plan = planMasters(stackToDna(project.fx), tags);
  const glyphs = Object.values(project.glyphs).filter((g) => (g.kind === 'stroke' ? (g.strokes?.length ?? 0) : (g.contours?.length ?? 0)) > 0);
  const structs = glyphs.map(structureOf);
  const names = glyphs.map((g) => glyphName(g.char, g.unicode));
  const unicodes: Record<string, number> = {};
  glyphs.forEach((g, i) => { unicodes[names[i]] = g.unicode; });
  const masters: VarMaster[] = plan.locations.map((loc) => {
    const dna = plan.dnaFor(loc);
    const out: VarMaster = { location: loc, glyphs: {} };
    structs.forEach((st, i) => {
      const ev = evaluate(st, dna);
      out.glyphs[names[i]] = { advance: Math.max(1, Math.round(ev.advance)), contours: ev.rings.map((r) => r.map(([x, y]) => [Math.round(x), Math.round(y)] as [number, number])) };
    });
    return out;
  });
  // sanity: compatibility
  for (const name of names) {
    const ref = masters[0].glyphs[name].contours.map((c) => c.length).join(',');
    for (const m of masters) if (m.glyphs[name].contours.map((c) => c.length).join(',') !== ref) throw new Error(`master incompatibility in glyph ${name}`);
  }
  const m = project.metrics;
  return {
    familyName: project.name || 'FontLab Var', styleName: 'Regular',
    upm: 1000, ascender: m.ascender, descender: m.descender, xHeight: m.xHeight, capHeight: m.capHeight,
    axes: plan.axes, glyphOrder: ['.notdef', 'space', ...names], unicodes, masters,
  };
}
