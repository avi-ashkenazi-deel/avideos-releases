// node --test videditor/tests/unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseProject, clipsAt, detectProject, describeClip, parseAttrs } from '../lib/hyperframes.mjs';
import { buildPrompt, describeDrawing } from '../lib/prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(here, '..', 'examples', 'launch');

test('detects the example HyperFrames project', () => {
  const d = detectProject(example);
  assert.equal(d.ok, true); assert.equal(d.isComposition, true); assert.equal(d.hasSettings, true);
  assert.equal(detectProject(here).ok, false);
});

test('parses attributes with and without quotes', () => {
  assert.deepEqual(parseAttrs(`id="a" data-start='1.5' muted data-x=7`), { id: 'a', 'data-start': '1.5', muted: '', 'data-x': '7' });
});

test('parses root composition, clips and nested compositions with offsets', () => {
  const c = parseProject(example);
  assert.equal(c.id, 'launch'); assert.equal(c.width, 1280); assert.equal(c.duration, 6); assert.equal(c.fps, 30);
  const title = c.clips.find((x) => x.id === 'title');
  assert.equal(title.start, 2.2); assert.equal(title.duration, 3.8); assert.equal(title.track, 2); assert.equal(title.text, 'Launch day');
  const mark = c.clips.find((x) => x.id === 'mark');
  assert.ok(mark, 'nested clip is included'); assert.equal(mark.depth, 1); assert.equal(mark.start, 0.2); assert.equal(mark.parent, 'logo-sting');
  const music = c.clips.find((x) => x.id === 'music'); assert.equal(music.volume, 0.5);
});

test('clipsAt returns what is on screen, topmost track first', () => {
  const c = parseProject(example);
  const at3 = clipsAt(c, 3.5).map((x) => x.id || x.compositionId);
  assert.deepEqual(at3, ['music', 'title', 'tagline', 'bg']);
  const at1 = clipsAt(c, 1).map((x) => x.id || x.compositionId);
  assert.ok(at1.includes('logo-sting') && at1.includes('mark') && !at1.includes('title'));
  assert.match(describeClip(c.clips.find((x) => x.id === 'title')), /#title \(h1, 0:02.20–0:06.00; “Launch day”, track 2\)/);
});

test('prompt lists open feedback with on-screen clips and the response loop', () => {
  const c = parseProject(example);
  const project = { id: 'prj_1', name: 'Launch', hyperframesDir: example };
  const version = { id: 'ver_1', label: 'v1', number: 1, mediaUrl: '/media/media/ver_1.mp4', duration: 6, width: 1280, height: 720, notes: 'first' };
  const feedback = [
    { id: 'fb_1', author: 'Avi', kind: 'voice', status: 'open', time: 2.4, timeEnd: 4.1, body: 'Title too late', transcript: 'this comes in late', visualReferences: [{ phrase: 'this', time: 2.6 }], drawing: { color: '#ff4d4d', strokes: [{ tool: 'ellipse', points: [[0.3, 0.4, 0], [0.7, 0.6, 0]] }] }, frames: [{ url: '/media/frames/fb_1-0.jpg', time: 2.4, label: 'annotated frame' }], tags: ['timing'] },
    { id: 'fb_2', author: 'Dana', kind: 'text', status: 'done', time: 0.2, body: 'done item' },
    { id: 'fb_3', author: 'Agent', kind: 'text', status: 'open', time: null, body: 'Will do', replyTo: 'fb_1', postedByAgent: true },
  ];
  const text = buildPrompt({ project, version, feedback, composition: c, baseUrl: 'http://localhost:8787' });
  assert.match(text, /## Open feedback \(1\)/);
  assert.match(text, /\[0:02.40–0:04.10\] Title too late/);
  assert.match(text, /On screen at 0:02.40: .*#title/);
  assert.match(text, /Pointing phrases: "this" at 0:02.60/);
  assert.match(text, /Drawing: 1 ellipse in the center of frame/);
  assert.match(text, /Reply from Agent \(agent\): Will do/);
  assert.doesNotMatch(text, /done item/);
  assert.match(text, /renders\/v2.mp4/);
  assert.match(text, /version_add/);
});

test('describeDrawing names the region', () => {
  assert.equal(describeDrawing({ color: 'red', strokes: [{ tool: 'arrow', points: [[0.05, 0.05, 0], [0.2, 0.1, 0]] }] }), '1 arrow in the top-left of frame (red)');
});
