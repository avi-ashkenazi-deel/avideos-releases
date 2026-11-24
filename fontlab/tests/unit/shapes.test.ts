import { describe, it, expect } from 'vitest';
import { rectContour, ellipseContour, dragCorners, KAPPA } from '../../src/inputs/draw/shapes';
import { notesFor, openNoteCount, addNote, updateNote, removeNote, hitNote, NOTE_MAX_TEXT, NOTE_MAX_COUNT } from '../../src/inputs/draw/notes';
import { applyPenContour } from '../../src/inputs/draw/pen';
import { flattenCurves } from '../../src/inputs/draw/curves';
import { bboxOf, signedArea } from '../../src/core/geometry';
import { isLine } from '../../src/outline/fitCurves';
import { glyphToContours } from '../../src/outline';
import { newProject } from '../../src/core/glyph';
import { isNote } from '../../src/project/schema';
import type { CurveContour, Glyph, Vec } from '../../src/core/glyph';

const flat = (c: CurveContour, steps = 64) => flattenCurves([c], steps)[0].points;
const area = (c: CurveContour, steps = 64) => signedArea(flat(c, steps));
const chained = (c: CurveContour) => {
  expect(c.segments[0][0]).toEqual(c.start);
  for (let i = 1; i < c.segments.length; i++) expect(c.segments[i][0]).toEqual(c.segments[i - 1][3]);
  expect(c.segments[c.segments.length - 1][3]).toEqual(c.start);
};
/** the four ways to drag the same box */
const drags = (x0: number, y0: number, x1: number, y1: number): [Vec, Vec][] => [
  [[x0, y0], [x1, y1]], [[x1, y1], [x0, y0]], [[x0, y1], [x1, y0]], [[x1, y0], [x0, y1]],
];

describe('rectContour', () => {
  it('is a closed, counter-clockwise loop of 4 straight segments with the right box', () => {
    const c = rectContour([100, 50], [400, 650]);
    expect(c.segments).toHaveLength(4);
    expect(c.segments.every((s) => isLine(s))).toBe(true);
    chained(c);
    expect(area(c)).toBeCloseTo(300 * 600, 6);
    expect(bboxOf(flat(c))).toEqual({ minX: 100, minY: 50, maxX: 400, maxY: 650 });
  });

  it('gives the same shape whichever way the corners are dragged', () => {
    const ref = rectContour([100, 50], [400, 650]);
    for (const [a, b] of drags(100, 50, 400, 650)) expect(rectContour(a, b)).toEqual(ref);
  });
});

describe('ellipseContour', () => {
  it('is a closed, counter-clockwise loop of 4 cubics inside the dragged box', () => {
    const c = ellipseContour([100, 0], [500, 600]);
    expect(c.segments).toHaveLength(4);
    expect(c.segments.some((s) => isLine(s))).toBe(false);
    chained(c);
    expect(area(c)).toBeGreaterThan(0);
    const b = bboxOf(flat(c));
    expect(b.minX).toBeCloseTo(100, 6); expect(b.maxX).toBeCloseTo(500, 6);
    expect(b.minY).toBeCloseTo(0, 6); expect(b.maxY).toBeCloseTo(600, 6);
    // handles sit kappa × radius away from the on-curve points
    expect(c.segments[0][1]).toEqual([500, 300 + 300 * KAPPA]);
    expect(c.segments[0][2]).toEqual([300 + 200 * KAPPA, 600]);
  });

  it('has the area of the ellipse, π·a·b, within 1 %', () => {
    for (const [a, b] of [[[0, 0], [400, 400]], [[100, 0], [500, 600]], [[-50, 20], [750, 120]]] as [Vec, Vec][]) {
      const rx = Math.abs(b[0] - a[0]) / 2, ry = Math.abs(b[1] - a[1]) / 2;
      const want = Math.PI * rx * ry;
      expect(Math.abs(area(ellipseContour(a, b)) - want) / want).toBeLessThan(0.01);
    }
  });

  it('stays within 0.1 % of the true radius everywhere (circle)', () => {
    for (const [x, y] of flat(ellipseContour([0, 0], [400, 400]))) expect(Math.abs(Math.hypot(x - 200, y - 200) - 200)).toBeLessThan(0.2);
  });

  it('gives the same shape whichever way the corners are dragged', () => {
    const ref = ellipseContour([100, 0], [500, 600]);
    for (const [a, b] of drags(100, 0, 500, 600)) expect(ellipseContour(a, b)).toEqual(ref);
  });
});

describe('dragCorners', () => {
  it('uses the drag as given, as a square, or from the centre', () => {
    expect(dragCorners([100, 100], [300, 150])).toEqual([[100, 100], [300, 150]]);
    expect(dragCorners([100, 100], [300, 150], { square: true })).toEqual([[100, 100], [300, 300]]);
    expect(dragCorners([100, 100], [300, 50], { square: true })).toEqual([[100, 100], [300, -100]]);
    expect(dragCorners([100, 100], [0, 150], { square: true })).toEqual([[100, 100], [0, 200]]);
    expect(dragCorners([100, 100], [300, 150], { centre: true })).toEqual([[-100, 50], [300, 150]]);
    expect(dragCorners([100, 100], [300, 150], { centre: true, square: true })).toEqual([[-100, -100], [300, 300]]);
  });

  it('a Shift-drag makes a true circle', () => {
    const [a, b] = dragCorners([50, 50], [250, 120], { square: true });
    const bb = bboxOf(flat(ellipseContour(a, b)));
    expect(bb.maxX - bb.minX).toBeCloseTo(bb.maxY - bb.minY, 6);
  });
});

describe('shapes on a letter', () => {
  const blank = (ch: string): Glyph => ({ char: ch, unicode: ch.codePointAt(0)!, advance: 520, source: 'drawn', kind: 'stroke', strokes: [] });

  it('a rectangle on an empty letter makes an outline glyph that builds', () => {
    const g = applyPenContour(undefined, 'x', rectContour([400, 300], [100, 0]), blank('x'));
    expect(g.kind).toBe('outline');
    expect(g.curves).toHaveLength(1);
    const built = glyphToContours(g);
    expect(built).toHaveLength(1);
    expect(signedArea(built[0].points)).toBeCloseTo(90000, 0);
  });

  it('an ellipse inside a rectangle cuts a counter', () => {
    let g = applyPenContour(undefined, 'o', rectContour([0, 0], [400, 400]), blank('o'));
    g = applyPenContour(g, 'o', ellipseContour([100, 100], [300, 300]), blank('o'));
    const built = glyphToContours(g);
    expect(built).toHaveLength(2);
    const total = built.reduce((s, c) => s + signedArea(c.points), 0);
    expect(Math.abs(total - (160000 - Math.PI * 100 * 100)) / total).toBeLessThan(0.01);
  });
});

describe('review notes', () => {
  const project = () => newProject('t');

  it('adds notes per letter, numbered in the order they were pinned', () => {
    const p = project();
    const a = addNote(p, { ch: 'a', x: 100.04, y: 200.06, text: '  too heavy  ' }, 1000)!;
    addNote(p, { ch: 'b', x: 0, y: 0, text: 'other letter' }, 1001);
    const c = addNote(p, { ch: 'a', x: 300, y: 50, text: 'second', author: 'Avi' }, 1002)!;
    expect(a).toMatchObject({ ch: 'a', x: 100, y: 200.1, text: 'too heavy', createdAt: 1000 });
    expect(a.id).not.toBe(c.id);
    expect(c.author).toBe('Avi');
    expect(notesFor(p, 'a').map((n) => n.text)).toEqual(['too heavy', 'second']);
    expect(notesFor(p, 'z')).toEqual([]);
    expect(p.notes.every(isNote)).toBe(true); // survives the project schema
  });

  it('ignores empty notes, caps the text and the number of notes', () => {
    const p = project();
    expect(addNote(p, { ch: 'a', x: 0, y: 0, text: '   \n ' })).toBeNull();
    expect(p.notes).toHaveLength(0);
    expect(addNote(p, { ch: 'a', x: 0, y: 0, text: 'x'.repeat(NOTE_MAX_TEXT + 50) })!.text).toHaveLength(NOTE_MAX_TEXT);
    for (let i = 1; i < NOTE_MAX_COUNT; i++) addNote(p, { ch: 'a', x: i, y: 0, text: 'n' });
    expect(p.notes).toHaveLength(NOTE_MAX_COUNT);
    expect(addNote(p, { ch: 'a', x: 0, y: 0, text: 'one too many' })).toBeNull();
    expect(p.notes).toHaveLength(NOTE_MAX_COUNT);
  });

  it('updates text and resolved state, and counts open notes', () => {
    const p = project();
    const a = addNote(p, { ch: 'a', x: 0, y: 0, text: 'one' })!;
    const b = addNote(p, { ch: 'a', x: 50, y: 0, text: 'two' })!;
    expect(openNoteCount(p, 'a')).toBe(2);
    expect(updateNote(p, a.id, { done: true })!.done).toBe(true);
    expect(openNoteCount(p, 'a')).toBe(1);
    expect(updateNote(p, a.id, { done: false })!.done).toBeUndefined();
    expect(openNoteCount(p, 'a')).toBe(2);
    expect(updateNote(p, b.id, { text: ' thinner here ' })!.text).toBe('thinner here');
    expect(updateNote(p, b.id, { text: '  ' })).toBeNull(); // an empty text is not a change
    expect(notesFor(p, 'a')[1].text).toBe('thinner here');
    expect(updateNote(p, 'nope', { text: 'x' })).toBeNull();
  });

  it('removes a note by id', () => {
    const p = project();
    const a = addNote(p, { ch: 'a', x: 0, y: 0, text: 'one' })!;
    addNote(p, { ch: 'a', x: 50, y: 0, text: 'two' });
    expect(removeNote(p, a.id)).toBe(true);
    expect(removeNote(p, a.id)).toBe(false);
    expect(notesFor(p, 'a').map((n) => n.text)).toEqual(['two']);
  });

  it('hit-tests the nearest pin within the tolerance; the newer pin wins a tie', () => {
    const p = project();
    const a = addNote(p, { ch: 'a', x: 100, y: 100, text: 'one' })!;
    const b = addNote(p, { ch: 'a', x: 140, y: 100, text: 'two' })!;
    const c = addNote(p, { ch: 'a', x: 100, y: 100, text: 'on top of one' })!;
    const list = notesFor(p, 'a');
    expect(hitNote(list, 135, 100, 20)).toBe(b);
    expect(hitNote(list, 100, 104, 20)).toBe(c);
    expect(hitNote(list, 100, 130, 20)).toBeNull();
    expect(hitNote(list, 119, 100, 20)!.id).toBe(c.id); // 19 from one/c, 21 from two
    expect(hitNote([a], 100, 120, 20)).toBe(a); // exactly on the tolerance counts
    expect(hitNote([], 0, 0, 20)).toBeNull();
  });
});
