// Tiny DOM helpers shared by the views.

import { icon } from './icons.js';
import { summarize } from './policy.js';

export function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

export function el(html) {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild;
}

export function rulesHTML(policy) {
  return `<div class="rules">${summarize(policy).map((c) => {
    let lead = icon(c.icon, 16);
    if (c.image) lead = `<span class="rule-swatch" style="background-image:url('${c.image}')"></span>`;
    else if (c.swatch?.length) {
      const bg = c.swatch.length > 1 ? `linear-gradient(135deg, ${c.swatch[0]}, ${c.swatch[1]})` : c.swatch[0];
      lead = `<span class="rule-swatch" style="background:${esc(bg)}"></span>`;
    }
    return `<span class="rule" title="${esc(c.label)}">${lead}${esc(c.label)}</span>`;
  }).join('')}</div>`;
}

let toastTimer;
export function toast(msg) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 2600);
}

export function stepper(current) {
  const steps = ['Get ready', 'Take photo', 'Retouch', 'Done'];
  return `<ol class="stepper" aria-label="Progress">${steps.map((s, i) => {
    const state = i < current ? 'done' : i === current ? 'current' : 'todo';
    const mark = state === 'done' ? icon('check', 12) : i + 1;
    return `<li class="step" data-state="${state}" ${state === 'current' ? 'aria-current="step"' : ''}><span class="step-num">${mark}</span>${s}</li>`;
  }).join('')}</ol>`;
}

export function downloadCanvas(canvas, filename, type = 'image/png', quality) {
  canvas.toBlob((blob) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, type, quality);
}

// Draw `src` into a fixed-size display canvas (for small avatar previews).
export function sizedCopy(src, size) {
  const c = document.createElement('canvas');
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  c.width = c.height = Math.round(size * dpr);
  c.style.width = c.style.height = size + 'px';
  const ctx = c.getContext('2d');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, 0, 0, c.width, c.height);
  return c;
}
