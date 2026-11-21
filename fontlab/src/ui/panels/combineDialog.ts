import { h, button, toast } from '../dom';
import { parse } from '../../vendor/opentype';
import { decompressWoff2 } from '../../inputs/fontimport';
import { combineWeights } from '../../export/variable';
import { downloadBlob, slug } from '../../project/storage';

interface Entry { file: File; bytes: Uint8Array; weight: number; family: string; style: string; kind: 'TrueType' | 'CFF' | '?'; glyphs: number }

/** Read family / style / weight / outline kind from a font file (woff2 is decompressed first). */
export async function inspectFont(file: File): Promise<Entry> {
  let buf = await file.arrayBuffer();
  const tag = String.fromCharCode(...new Uint8Array(buf.slice(0, 4)));
  if (tag === 'wOF2') buf = await decompressWoff2(buf);
  const bytes = new Uint8Array(buf);
  let weight = 400, family = file.name.replace(/\.[^.]+$/, ''), style = '', kind: Entry['kind'] = '?', glyphs = 0;
  try {
    const f = parse(buf);
    const names = f.names?.unicode ?? f.names?.windows ?? f.names?.macintosh ?? f.names ?? {};
    const pick = (rec: any) => (rec ? rec.en ?? Object.values(rec)[0] : '') as string;
    family = pick(names.preferredFamily) || pick(names.fontFamily) || family;
    style = pick(names.preferredSubfamily) || pick(names.fontSubfamily) || '';
    weight = f.tables?.os2?.usWeightClass ?? weightFromStyle(style);
    kind = f.outlinesFormat === 'cff' ? 'CFF' : f.outlinesFormat === 'truetype' ? 'TrueType' : '?';
    glyphs = f.numGlyphs ?? f.glyphs?.length ?? 0;
  } catch { weight = weightFromStyle(file.name); }
  return { file, bytes, weight, family, style, kind, glyphs };
}

export function weightFromStyle(s: string): number {
  const t = s.toLowerCase().replace(/[\s_-]/g, '');
  const table: [string, number][] = [['hairline', 100], ['thin', 100], ['extralight', 200], ['ultralight', 200], ['light', 300], ['book', 400], ['regular', 400], ['normal', 400], ['medium', 500], ['semibold', 600], ['demibold', 600], ['extrabold', 800], ['ultrabold', 800], ['bold', 700], ['heavy', 900], ['black', 900]];
  for (const [k, v] of table) if (t.includes(k)) return v;
  return 400;
}

/** Export → "Combine weights into a variable font…" (like blode.co/static-to-variable). */
export function openCombineDialog(): void {
  const dlg = h('dialog', { class: 'modal combine', 'data-testid': 'combine-dialog' });
  const entries: Entry[] = [];
  const list = h('div', { class: 'combine-list' });
  const status = h('div', { class: 'status' });
  const demoWrap = h('div', { class: 'combine-demo', style: { display: 'none' } });
  const picker = h('input', { type: 'file', accept: '.ttf,.otf,.woff,.woff2', multiple: true, style: { display: 'none' }, 'data-testid': 'combine-files' }) as HTMLInputElement;
  picker.addEventListener('change', async () => {
    const files = [...(picker.files ?? [])];
    picker.value = '';
    status.textContent = files.length ? 'Reading files…' : '';
    for (const f of files) {
      try { entries.push(await inspectFont(f)); } catch (e) { toast(`Could not read ${f.name}: ${(e as Error).message}`); }
    }
    entries.sort((a, b) => a.weight - b.weight);
    status.textContent = '';
    render();
  });
  const render = () => {
    list.replaceChildren(...entries.map((e, i) => {
      const w = h('input', { type: 'number', min: 1, max: 1000, step: 1, value: e.weight, 'aria-label': `Weight of ${e.file.name}`, class: 'cw-weight' }) as HTMLInputElement;
      w.addEventListener('change', () => { e.weight = Math.max(1, Math.min(1000, Math.round(Number(w.value) || 400))); render(); });
      const dup = entries.filter((x) => x.weight === e.weight).length > 1;
      return h('div', { class: 'combine-row' + (dup ? ' dup' : ''), 'data-testid': 'combine-row' },
        h('div', { class: 'cw-name' }, h('strong', {}, e.family), ' ', h('span', { class: 'muted' }, e.style || ''), h('div', { class: 'muted small' }, `${e.file.name} · ${e.kind} · ${e.glyphs} glyphs`)),
        h('label', {}, 'Weight ', w),
        button('Remove', () => { entries.splice(i, 1); render(); }));
    }));
    const families = new Set(entries.map((e) => e.family));
    const kinds = new Set(entries.map((e) => e.kind));
    const dupes = new Set(entries.map((e) => e.weight)).size !== entries.length;
    const problems: string[] = [];
    if (entries.length && entries.length < 2) problems.push('Add at least one more weight.');
    if (dupes) problems.push('Two files have the same weight: change one.');
    if (kinds.size > 1) problems.push('Mix of TrueType and CFF files: use files of one kind.');
    if (families.size > 1) problems.push(`These look like different families (${[...families].join(', ')}). It only works for weights of one family.`);
    hint.textContent = entries.length ? problems.join(' ') : 'Add two or more weights of one family, e.g. Thin, Regular and Bold (.ttf, .otf, .woff or .woff2).';
    hint.classList.toggle('warn', problems.length > 0 && entries.length > 0);
    build.disabled = entries.length < 2 || dupes || kinds.size > 1;
  };
  const hint = h('p', { class: 'muted' });
  const build = button('Build variable font', async () => {
    build.disabled = true;
    demoWrap.style.display = 'none';
    try {
      const { bytes, report } = await combineWeights(entries.map((e) => e.bytes), entries.map((e) => e.weight), (s) => (status.textContent = s));
      const ext = report.format === 'otf' ? 'otf' : 'ttf';
      const name = `${slug(report.family.replace(/ Variable$/, ''))}-Variable.${ext}`;
      downloadBlob(bytes.buffer as ArrayBuffer, name, ext === 'otf' ? 'font/otf' : 'font/ttf');
      // live preview with a weight slider
      const fam = `FLCombined${Date.now()}`;
      const face = new FontFace(fam, bytes.buffer as ArrayBuffer);
      await face.load(); document.fonts.add(face);
      const word = h('div', { class: 'combine-word', contenteditable: 'true', spellcheck: false, style: { fontFamily: `'${fam}'` } }, 'Hamburgefonstiv');
      const val = h('span', { class: 'val' }, String(report.axis.default));
      const slide = h('input', { type: 'range', min: report.axis.min, max: report.axis.max, step: 1, value: report.axis.default, 'aria-label': 'Weight' }) as HTMLInputElement;
      const apply = () => { word.style.fontVariationSettings = `'wght' ${slide.value}`; val.textContent = slide.value; };
      slide.addEventListener('input', apply); apply();
      demoWrap.replaceChildren(word, h('label', { class: 'slider' }, h('span', { class: 'name' }, 'Weight'), slide, val));
      demoWrap.style.display = '';
      const dropped = report.dropped.filter((n) => n !== '.notdef');
      status.textContent = `Done: ${name} (${(bytes.length / 1024).toFixed(0)} KB, ${report.glyphs} glyphs, weight ${report.axis.min}–${report.axis.max}). Downloaded.`
        + (dropped.length ? ` Left out ${dropped.length} glyph${dropped.length > 1 ? 's' : ''} whose outlines differ between the files: ${dropped.slice(0, 12).join(' ')}${dropped.length > 12 ? ' …' : ''}.` : '')
        + (report.notes.length ? ' ' + report.notes.join(' ') : '');
    } catch (e) {
      status.textContent = 'Could not combine: ' + (e as Error).message + ((e as Error).message.includes('fetch') ? ' (the converter downloads 12 MB the first time and needs internet)' : '');
    }
    build.disabled = false;
  }, 'primary');
  dlg.append(
    h('h2', {}, 'Combine weights into a variable font'),
    h('p', {}, 'Pick static files of one family, for example Thin, Regular and Bold. You get one variable font with every weight in between. Everything happens in your browser; the first build downloads a 12 MB converter.'),
    h('div', { class: 'row' }, button('Add font files…', () => picker.click(), 'primary'), picker),
    list, hint,
    h('div', { class: 'row' }, build, button('Close', () => dlg.close())),
    status, demoWrap,
  );
  render();
  document.body.append(dlg); dlg.showModal(); dlg.addEventListener('close', () => dlg.remove());
}
