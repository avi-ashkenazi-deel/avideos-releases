// node --test videditor/tests/unit.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { parseProject, clipsAt, detectProject, describeClip, parseAttrs, updateClip, createProject } from '../lib/composition.mjs';
import { buildPrompt, describeDrawing } from '../lib/prompt.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const example = path.join(here, '..', 'examples', 'launch');

test('detects the example composition project', () => {
  const d = detectProject(example);
  assert.equal(d.ok, true); assert.equal(d.isComposition, true);
  assert.equal(detectProject(here).ok, false);
});

test('parses attributes with and without quotes', () => {
  assert.deepEqual(parseAttrs(`id="a" data-start='1.5' muted data-x=7`), { id: 'a', 'data-start': '1.5', muted: '', 'data-x': '7' });
});

test('parses root composition and clips', () => {
  const c = parseProject(example);
  assert.equal(c.id, 'launch'); assert.equal(c.width, 1280); assert.equal(c.duration, 6); assert.equal(c.fps, 30);
  const title = c.clips.find((x) => x.id === 'title');
  assert.equal(title.start, 2.2); assert.equal(title.duration, 3.8); assert.equal(title.track, 2); assert.equal(title.text, 'Launch day');
  const mark = c.clips.find((x) => x.id === 'mark'); assert.equal(mark.start, 0.2); assert.equal(mark.track, 1);
  const music = c.clips.find((x) => x.id === 'music'); assert.equal(music.volume, 0.5); assert.equal(music.hasAudio, true);
});

test('parses nested compositions with time offsets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  fs.mkdirSync(path.join(dir, 'compositions'));
  fs.writeFileSync(path.join(dir, 'index.html'), `<div data-composition-id="root" data-duration="5" data-width="100" data-height="50"><div data-composition-id="sting" data-composition-src="compositions/sting.html" data-start="2" data-duration="2" data-track-index="1"></div></div>`);
  fs.writeFileSync(path.join(dir, 'compositions', 'sting.html'), `<div data-composition-id="sting" data-start="0"><div id="mark" data-start="0.5" data-duration="1"></div></div>`);
  const c = parseProject(dir);
  const mark = c.clips.find((x) => x.id === 'mark');
  assert.equal(mark.depth, 1); assert.equal(mark.start, 2.5); assert.equal(mark.parent, 'sting'); assert.equal(mark.track, 1);
  fs.rmSync(dir, { recursive: true });
});

test('updateClip rewrites timing attributes in place and keeps everything else', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  fs.cpSync(example, dir, { recursive: true });
  const attrs = updateClip(dir, 'title', { start: 1, duration: 4.5 });
  assert.equal(attrs['data-start'], '1'); assert.equal(attrs['data-duration'], '4.5'); assert.equal(attrs.class, 'clip');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /<h1 id="title" class="clip" data-start="1" data-duration="4.5" data-track-index="2">Launch day<\/h1>/);
  assert.equal(updateClip(dir, 'nope', { start: 1 }), null);
  const added = updateClip(dir, 'music', { track: 5 }); assert.equal(added['data-track-index'], '5');
  fs.rmSync(dir, { recursive: true });
});

test('createProject copies the template and fills placeholders', () => {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  const dir = createProject('My First Video!', { base, width: 1080, height: 1920, fps: 25 });
  assert.equal(path.basename(dir), 'my-first-video');
  const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
  assert.match(html, /data-composition-id="my-first-video"/); assert.match(html, /data-width="1080" data-height="1920" data-fps="25"/); assert.match(html, />My First Video!</);
  assert.ok(fs.existsSync(path.join(dir, 'assets'))); assert.ok(fs.existsSync(path.join(dir, 'renders')));
  const dir2 = createProject('My First Video!', { base }); assert.equal(path.basename(dir2), 'my-first-video-2');
  fs.rmSync(base, { recursive: true });
});

test('clipsAt returns what is on screen, topmost track first', () => {
  const c = parseProject(example);
  const at3 = clipsAt(c, 3.5).map((x) => x.id || x.compositionId);
  assert.deepEqual(at3, ['music', 'title', 'tagline', 'bg']);
  const at1 = clipsAt(c, 1).map((x) => x.id || x.compositionId);
  assert.ok(at1.includes('mark') && !at1.includes('title'));
  assert.match(describeClip(c.clips.find((x) => x.id === 'title')), /#title \(h1, 0:02.20–0:06.00; “Launch day”, track 2\)/);
});

test('prompt lists open feedback with on-screen clips and the response loop', () => {
  const c = parseProject(example);
  const project = { id: 'prj_1', name: 'Launch', dir: example };
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
  assert.match(text, /render_version/);
  assert.match(text, /index.html/);
});

test('describeDrawing names the region', () => {
  assert.equal(describeDrawing({ color: 'red', strokes: [{ tool: 'arrow', points: [[0.05, 0.05, 0], [0.2, 0.1, 0]] }] }), '1 arrow in the top-left of frame (red)');
});

import { resolveSrc, insertClipHtml, brandCss, writeBrand, readBrand, updateRoot } from '../lib/composition.mjs';
import { scanMedia, probeMedia, detectScenes, analyzeAudio, analyzeFile, writeManifest, analysisDirFor, kindOf } from '../lib/analyze.mjs';
import { spawnSync } from 'node:child_process';

test('resolveSrc maps library/ to the linked folder and relative paths to the composition file', () => {
  assert.equal(resolveSrc('/p', '/lib', 'library/a.mp4'), path.resolve('/lib/a.mp4'));
  assert.equal(resolveSrc('/p', null, 'library/a.mp4'), null);
  assert.equal(resolveSrc('/p', null, 'assets/x.wav'), path.resolve('/p/assets/x.wav'));
  assert.equal(resolveSrc('/p', null, '../assets/x.wav', '/p/compositions/s.html'), path.resolve('/p/assets/x.wav'));
  assert.equal(resolveSrc('/p', null, 'https://cdn/x.mp4'), null);
});

test('insertClipHtml adds a clip after the root opening tag; updateRoot changes the duration', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  fs.cpSync(example, dir, { recursive: true });
  assert.ok(insertClipHtml(dir, '<img id="shot" class="clip" src="library/a.png" data-start="1" data-duration="2" data-track-index="1">'));
  const c = parseProject(dir); const shot = c.clips.find((x) => x.id === 'shot');
  assert.equal(shot.start, 1); assert.equal(shot.src, 'library/a.png');
  updateRoot(dir, { 'data-duration': 9 }); assert.equal(parseProject(dir).duration, 9);
  fs.rmSync(dir, { recursive: true });
});

test('brand.json round-trips to CSS variables', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-'));
  const b = writeBrand(dir, { colors: { primary: '#ff6a00' }, font: { family: 'Georgia' } });
  assert.equal(b.colors.primary, '#ff6a00'); assert.equal(b.colors.background, '#101218');
  const css = fs.readFileSync(path.join(dir, 'brand.css'), 'utf8');
  assert.match(css, /--brand-primary: #ff6a00;/); assert.match(css, /--brand-font: Georgia;/);
  assert.equal(readBrand(dir).font.family, 'Georgia'); assert.match(brandCss({}), /--brand-logo: none;/);
  fs.rmSync(dir, { recursive: true });
});

test('media analysis: scan, cuts, keyframes, tempo and manifest', { timeout: 120000 }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-media-'));
  const clip = path.join(dir, 'clip.mp4'); const music = path.join(dir, 'beat.wav');
  let r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=s=320x180:r=30:d=4', '-filter_complex', '[0:v]split=2[a][b];[a]trim=0:2,setpts=PTS-STARTPTS[a1];[b]trim=2:4,setpts=PTS-STARTPTS,negate[b1];[a1][b1]concat=n=2:v=1:a=0[v]', '-map', '[v]', '-c:v', 'libx264', '-preset', 'veryfast', clip]);
  assert.equal(r.status, 0, 'test clip made');
  r = spawnSync('ffmpeg', ['-y', '-v', 'error', '-f', 'lavfi', '-i', 'anoisesrc=d=12:c=pink:a=0.5', '-af', "aeval='val(0)*gt(mod(t\\,0.5)\\,0.45)',volume=3", '-ar', '22050', music]);
  assert.equal(r.status, 0, 'test music made');
  const items = scanMedia(dir, { prefix: 'library' });
  assert.deepEqual(items.map((i) => [i.rel, i.kind]), [['library/beat.wav', 'audio'], ['library/clip.mp4', 'video']]);
  assert.equal(probeMedia(clip).width, 320);
  const cuts = detectScenes(clip); assert.ok(cuts.some((t) => Math.abs(t - 2) < 0.15), `cut found near 2s (${cuts})`);
  const a = analyzeAudio(music); assert.ok(Math.abs(a.bpm - 120) < 1.5, `120 BPM detected (${a.bpm})`); assert.ok(a.confidence > 0.15);
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vd-proj-'));
  const recs = items.map((it) => analyzeFile(it, analysisDirFor(projectDir, it)));
  const video = recs.find((x) => x.kind === 'video');
  assert.ok(video.frames.length >= 3 && video.sheet && fs.existsSync(path.join(projectDir, video.sheet)), 'keyframes and contact sheet written');
  writeManifest(projectDir, recs, { libraryDir: dir });
  const md = fs.readFileSync(path.join(projectDir, 'MEDIA.md'), 'utf8');
  assert.match(md, /## library\/clip.mp4/); assert.match(md, /Cuts at:/); assert.match(md, /Tempo: 1(19|20|21)/);
  assert.equal(kindOf('x.webp'), 'image');
  fs.rmSync(dir, { recursive: true }); fs.rmSync(projectDir, { recursive: true });
});
