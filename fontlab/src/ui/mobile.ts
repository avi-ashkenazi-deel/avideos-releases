/**
 * Phone layout. On a narrow screen the editor is the whole screen: a slim bar
 * on top, one line of live preview, the canvas, the tools and a row to move
 * between letters. Everything else (letters grid, effects, add letters, the
 * font menus) opens as a sheet from the bottom.
 *
 * Nothing is built twice: the canvas, the tool strip and the panels are the
 * same elements as on desktop, moved here while the screen is narrow and put
 * back when it is not.
 */
import { h, iconButton } from './dom';
import { icon, type IconName } from './icons';
import { store } from './state';
import { PREVIEW_FAMILY } from './preview';
import { featureCss } from './alternates';
import type { DrawUi } from './panels/seeds';

export const PHONE_QUERY = '(max-width: 760px)';
const PREVIEW_KEY = 'fontlab:m-preview';

type SheetId = 'more' | 'letters' | 'letter' | 'add' | 'effects' | 'preview';

export interface MobileParts { header: HTMLElement; seeds: HTMLElement; grid: HTMLElement; effects: HTMLElement; preview: HTMLElement }

/** Move `el` into `target`; the returned function puts it back where it was. */
function dock(el: HTMLElement, target: HTMLElement): () => void {
  const mark = document.createComment('docked');
  el.before(mark);
  target.append(el);
  return () => mark.replaceWith(el);
}

export function mountMobile(root: HTMLElement, parts: MobileParts, draw: DrawUi): void {
  const ib = (name: IconName, label: string, fn: () => void, testid: string) => iconButton(name, label, fn, { iconOnly: true, testid });

  // ---- top bar
  const undoBtn = ib('undo', 'Undo', () => draw.undo(), 'm-undo');
  const redoBtn = ib('redo', 'Redo', () => draw.redo(), 'm-redo');
  const trashBtn = ib('trash', 'Delete', () => draw.remove(), 'm-delete');
  const previewToggle = ib('type', 'Show or hide the preview line', () => setPreviewShown(!previewShown), 'm-preview-toggle');
  const top = h('div', { class: 'm-top' },
    ib('menu', 'Font: save, export, share', () => openSheet('more'), 'm-more'),
    undoBtn, redoBtn, trashBtn,
    ib('sliders', 'This letter: brush, lock, re-roll', () => openSheet('letter'), 'm-letter'),
    h('span', { class: 'spacer' }),
    previewToggle,
  );

  // ---- one line of live preview (tap to edit the text)
  const previewLine = h('button', { type: 'button', class: 'm-preview', 'data-testid': 'm-preview', 'aria-label': 'Preview. Tap to edit the text', style: { fontFamily: `'${PREVIEW_FAMILY}', monospace` }, onClick: () => openSheet('preview') });
  let previewShown = true;
  try { previewShown = localStorage.getItem(PREVIEW_KEY) !== '0'; } catch { /* private mode */ }
  const setPreviewShown = (on: boolean) => {
    previewShown = on;
    try { localStorage.setItem(PREVIEW_KEY, on ? '1' : '0'); } catch { /* private mode */ }
    previewLine.style.display = on ? '' : 'none';
    previewToggle.classList.toggle('on', on);
    previewToggle.setAttribute('aria-pressed', String(on));
  };
  const syncPreview = () => {
    previewLine.textContent = store.project.previewText.replace(/\s+/g, ' ').trim() || 'Tap to type a preview';
    previewLine.style.fontFeatureSettings = featureCss();
  };

  // ---- the canvas with what floats over it
  const label = h('div', { class: 'm-label', 'aria-hidden': 'true' });
  const snapBtn = ib('magnet', 'Snapping', () => { draw.setSnapping(!draw.snapping()); say(draw.snapping() ? 'Snapping on' : 'Snapping off'); }, 'm-snap');
  const fitBtn = ib('fit', 'Fit the letter to the screen', () => draw.resetZoom(), 'm-fit');
  const penCancel = ib('x', 'Cancel this shape', () => draw.pen.cancel(), 'm-pen-cancel');
  const penClose = ib('check', 'Close the shape', () => draw.pen.close(), 'm-pen-close');
  const ctx = h('div', { class: 'm-ctx' }, snapBtn, fitBtn, penCancel, penClose);
  const said = h('div', { class: 'm-said', role: 'status', 'data-testid': 'm-said' });
  let sayTimer = 0;
  /** a short label over the canvas: which tool was picked, what a toggle did */
  const say = (text: string) => {
    said.textContent = text;
    said.classList.add('show');
    clearTimeout(sayTimer);
    sayTimer = window.setTimeout(() => said.classList.remove('show'), 1300);
  };
  const stage = h('div', { class: 'm-stage' }, label, ctx, said);

  // ---- tools, then moving around
  const tools = h('div', { class: 'm-tools' });
  const navBtn = (name: IconName, text: string, fn: () => void, testid: string) =>
    h('button', { type: 'button', class: 'm-navbtn', 'data-testid': testid, onClick: fn }, icon(name, 22), h('span', {}, text));
  const nav = h('nav', { class: 'm-nav', 'aria-label': 'Font' },
    navBtn('chevronLeft', 'Previous', () => draw.step(-1), 'm-prev'),
    navBtn('chevronRight', 'Next', () => draw.step(1), 'm-next'),
    navBtn('grid', 'Letters', () => openSheet('letters'), 'm-letters'),
    navBtn('plus', 'Add', () => openSheet('add'), 'm-add'),
    navBtn('wand', 'Effects', () => openSheet('effects'), 'm-effects'),
  );
  const shell = h('div', { class: 'm-shell', 'data-testid': 'm-shell' }, top, previewLine, stage, tools, nav);

  // ---- sheets
  const sheetTitle = h('span', { class: 'm-sheettitle' });
  const sheetBody = h('div', { class: 'm-sheetbody' });
  const sheet = h('div', { class: 'm-sheet', role: 'dialog', 'aria-modal': 'true', 'data-testid': 'm-sheet' },
    h('div', { class: 'm-sheethead' }, sheetTitle, h('span', { class: 'spacer' }), ib('x', 'Close', () => closeSheet(), 'm-sheet-close')), sheetBody);
  const backdrop = h('div', { class: 'm-backdrop', onClick: () => closeSheet() });
  const SHEETS: Record<SheetId, { title: () => string; el: HTMLElement }> = {
    more: { title: () => 'Font', el: parts.header },
    letters: { title: () => 'Letters', el: parts.grid },
    letter: { title: () => `Letter “${store.selected}”`, el: parts.seeds },
    add: { title: () => 'Add letters', el: parts.seeds },
    effects: { title: () => 'Effects', el: parts.effects },
    preview: { title: () => 'Preview', el: parts.preview },
  };
  let open: { id: SheetId; undock: () => void } | null = null;
  const closeSheet = () => {
    if (!open) return;
    open.undock();
    open = null;
    sheet.classList.remove('open'); backdrop.classList.remove('open');
    delete sheet.dataset.sheet;
  };
  const openSheet = (id: SheetId) => {
    closeSheet();
    const s = SHEETS[id];
    if (id === 'letter' || id === 'add') parts.seeds.dataset.view = id;
    open = { id, undock: dock(s.el, sheetBody) };
    sheetTitle.textContent = s.title();
    sheet.dataset.sheet = id;
    sheet.classList.add('open'); backdrop.classList.add('open');
    sheetBody.scrollTop = 0;
  };
  // an action in the font sheet opens a dialog or downloads a file: the sheet is done
  sheetBody.addEventListener('click', (e) => {
    if (open?.id !== 'more') return;
    const b = (e.target as HTMLElement).closest('button');
    if (b && !b.classList.contains('menu-trigger')) setTimeout(closeSheet, 0);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && open && !document.querySelector('dialog[open]')) closeSheet(); });

  root.append(shell, backdrop, sheet);

  // ---- keep the bar and the floating buttons in step with the draw tab
  let lastTool = draw.tool();
  const sync = () => {
    const tool = draw.tool();
    const penOpen = draw.pen.open();
    snapBtn.style.display = tool === 'edit' ? '' : 'none';
    snapBtn.classList.toggle('primary', draw.snapping());
    snapBtn.setAttribute('aria-pressed', String(draw.snapping()));
    fitBtn.style.display = draw.zoomed() ? '' : 'none';
    penCancel.style.display = penClose.style.display = penOpen ? '' : 'none';
    penClose.disabled = !draw.pen.canClose();
    const sel = draw.hasSelection();
    trashBtn.title = sel ? 'Delete the selected points' : 'Clear this letter';
    trashBtn.setAttribute('aria-label', trashBtn.title);
    const code = 'U+' + (store.selected.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, '0');
    label.replaceChildren(h('b', {}, store.selected), ` ${code}`, h('br'), store.project.name);
    if (tool !== lastTool) { lastTool = tool; if (active) say(draw.toolLabel()); }
    if (open?.id === 'letter') sheetTitle.textContent = SHEETS.letter.title();
  };
  store.subscribe((ev) => {
    if (ev === 'draw:state' || ev === 'select' || ev === 'glyph' || ev === 'project' || ev === 'project:loaded') sync();
    if (ev === 'preview:typed' || ev === 'preview:text' || ev === 'project:loaded' || ev === 'features' || ev === 'glyph') syncPreview();
    if (!open) return;
    if (ev === 'select' && open.id === 'letters') closeSheet(); // picked a letter: back to the canvas
    else if (ev === 'project' && open.id === 'add') closeSheet(); // generated or imported: look at the result
  });

  // ---- switch between the two layouts
  let active = false;
  let undock: (() => void)[] = [];
  const mq = window.matchMedia(PHONE_QUERY);
  const apply = () => {
    if (mq.matches === active) return;
    active = mq.matches;
    document.documentElement.classList.toggle('phone', active);
    if (active) {
      undock = [dock(draw.canvasWrap, stage), dock(draw.holdBanner, stage), dock(draw.toolStrip, tools)];
      stage.append(ctx, said); // stay above the canvas
    } else {
      closeSheet();
      for (const u of undock.reverse()) u();
      undock = [];
      delete parts.seeds.dataset.view;
    }
  };
  mq.addEventListener('change', apply);
  setPreviewShown(previewShown);
  syncPreview();
  sync();
  apply();
}
