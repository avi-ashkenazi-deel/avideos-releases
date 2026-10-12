/* Diagrams: flow, cycle, tree (org chart), timeline, mind map, pyramid, staircase and a 2 × 2 matrix. A diagram is a
   small spec ({type, nodes: [{label, text, parent}]}) laid out into ordinary blocks: rounded boxes holding their words,
   connectors drawn as paths with arrowheads. All of them share one group whose frame block (role "diagram") keeps the
   spec and the colors it was drawn with, so the canvas can redraw the diagram when its words or type change, while
   every piece can still be moved, recolored or edited by hand. As text, a diagram is one node per line, indented under
   its parent ("Label — note"), after a "type: …" line. */
const Diagram = (() => {
  const TYPES = ['flow', 'cycle', 'tree', 'timeline', 'mindmap', 'pyramid', 'staircase', 'matrix'];
  const LABEL = { flow: 'Flow', cycle: 'Cycle', tree: 'Tree / org chart', timeline: 'Timeline', mindmap: 'Mind map', pyramid: 'Pyramid', staircase: 'Staircase', matrix: '2 × 2 matrix' };
  const sp = s => String(s == null ? '' : s).replace(/\s+/g, ' ').trim();
  const r1 = v => Math.round(v * 10) / 10;

  // ---- The spec ---------------------------------------------------------------------------------------------------------
  function norm(d) {
    if (!d || typeof d !== 'object') return null;
    const type = TYPES.includes(d.type) ? d.type : 'flow';
    const raw = Array.isArray(d.nodes) ? d.nodes : [];
    const nodes = raw.slice(0, 24).map(x => typeof x === 'string' ? { label: sp(x), text: '', parent: -1 } : { label: sp(x && (x.label || x.title)), text: sp(x && x.text), parent: Number.isInteger(x && x.parent) ? x.parent : -1 }).filter(x => x.label || x.text);
    for (const [i, x] of nodes.entries()) if (x.parent >= i || x.parent < -1) x.parent = -1;
    return nodes.length ? { type, nodes } : null;
  }
  function toText(d) {
    d = norm(d); if (!d) return 'type: flow\n';
    const depth = i => { let k = 0, p = d.nodes[i].parent; while (p >= 0 && k < 6) { k++; p = d.nodes[p].parent; } return k; };
    return `type: ${d.type}\n` + d.nodes.map((x, i) => '  '.repeat(depth(i)) + x.label + (x.text ? ' — ' + x.text : '')).join('\n');
  }
  function fromText(text, fallbackType) {
    let type = TYPES.includes(fallbackType) ? fallbackType : 'flow'; const nodes = []; const stack = [];
    for (const raw of String(text || '').split('\n')) {
      if (!raw.trim()) continue;
      const t = /^\s*type\s*:\s*([a-z ×x2-]+)\s*$/i.exec(raw); if (t) { const k = t[1].toLowerCase().replace(/[^a-z]/g, ''); const hit = TYPES.find(x => k.startsWith(x.slice(0, 4))) || (k.includes('org') ? 'tree' : k.includes('mind') ? 'mindmap' : null); if (hit) type = hit; continue; }
      const ind = (/^(\s*)/.exec(raw.replace(/\t/g, '  '))[1].length / 2) | 0;
      const line = raw.trim().replace(/^[-*•]\s+/, '');
      const m = /^(.{1,60}?)\s+[—–-]\s+(.+)$/.exec(line) || /^(.{1,40}?):\s+(.+)$/.exec(line);
      while (stack.length && stack[stack.length - 1].ind >= ind) stack.pop();
      const parent = stack.length ? stack[stack.length - 1].i : -1;
      nodes.push({ label: sp(m ? m[1] : line), text: sp(m ? m[2] : ''), parent }); stack.push({ ind, i: nodes.length - 1 });
    }
    return { type, nodes };
  }

  // ---- Drawing helpers -----------------------------------------------------------------------------------------------------
  // style: {fg, fg2, line, accent, accentText, card, cardText, cardText2, hi, hiText, font, bodySize, radius, unit, stroke}
  function textStack(H, g, lines, rect, align, valign) { return H.buildStack(lines, rect, align, valign, g); }
  function nodeBox(H, g, st, rect, node, i, opts = {}) {
    const hi = !!opts.hi; const fill = opts.fill || (hi ? st.hi : st.card); const fg = opts.fg || (hi ? st.hiText : st.cardText); const fg2 = opts.fg2 || (hi ? st.hiText : st.cardText2);
    const pad = opts.pad ?? Math.max(6, Math.min(rect.w, rect.h) * 0.1); const size = opts.size || Math.round(st.bodySize * 1.2);
    const items = [{ kind: 'text', role: 'node', path: `diagram.nodes.${i}.label`, text: node.label || ' ', font: { ...st.font, size, weight: st.boldWeight, lineHeight: 1.18 }, fill: fg, maxLines: 4, minSize: Math.max(10, size * 0.55), gap: node.text ? Math.round(size * 0.35) : 0 }];
    if (node.text && !opts.noText) items.push({ kind: 'text', role: 'note', path: `diagram.nodes.${i}.text`, text: node.text, font: { ...st.font, size: Math.round(size * 0.78), weight: st.weight, lineHeight: 1.3 }, fill: fg2, maxLines: opts.noteLines || 6, minSize: Math.max(9, size * 0.45) });
    const inner = { x: rect.x + pad, y: rect.y + pad, w: rect.w - 2 * pad, h: rect.h - 2 * pad };
    let s = textStack(H, g, items, inner, opts.align || 'center', opts.valign || 'center');
    if (!s && items.length > 1) s = textStack(H, g, items.slice(0, 1), inner, opts.align || 'center', opts.valign || 'center'); // the note gives way first
    if (!s) return null;
    const shape = opts.shape === 'circle' ? { kind: 'shape', shape: 'circle', x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill } : { kind: 'field', x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill, radius: opts.radius ?? st.radius, stroke: opts.stroke };
    return [{ ...shape, role: 'diagram-node', decorative: true, label: node.label.slice(0, 40) || 'node' }, ...s.blocks];
  }
  // A connector from (x1,y1) to (x2,y2): straight, elbow (vertical first) or curved; with an arrowhead at the end.
  function connector(st, x1, y1, x2, y2, kind = 'straight', arrow = true) {
    const minX = Math.min(x1, x2), minY = Math.min(y1, y2); const w = Math.max(1, Math.abs(x2 - x1)), h = Math.max(1, Math.abs(y2 - y1));
    const a = [x1 - minX, y1 - minY], b = [x2 - minX, y2 - minY];
    let d, end; // end: direction of the last segment, for the arrowhead
    if (kind === 'elbow') { const my = r1((a[1] + b[1]) / 2); d = `M ${r1(a[0])} ${r1(a[1])} L ${r1(a[0])} ${my} L ${r1(b[0])} ${my} L ${r1(b[0])} ${r1(b[1])}`; end = [0, Math.sign(b[1] - my) || 1]; }
    else if (kind === 'curve') { const mx = r1((a[0] + b[0]) / 2); d = `M ${r1(a[0])} ${r1(a[1])} C ${mx} ${r1(a[1])} ${mx} ${r1(b[1])} ${r1(b[0])} ${r1(b[1])}`; end = [Math.sign(b[0] - mx) || 1, 0]; }
    else { d = `M ${r1(a[0])} ${r1(a[1])} L ${r1(b[0])} ${r1(b[1])}`; const L = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1; end = [(b[0] - a[0]) / L, (b[1] - a[1]) / L]; }
    const out = [{ kind: 'vector', role: 'diagram-link', x: r1(minX), y: r1(minY), w: r1(w), h: r1(h), viewBox: [0, 0, r1(w), r1(h)], d, fill: 'none', stroke: { color: st.line, width: st.stroke }, decorative: true, label: 'connector' }];
    if (arrow) out.push(arrowHead(st, x2, y2, end));
    return out;
  }
  // An arc of the ellipse (cx, cy, R, Ry) from angle t1 to t2 (clockwise on screen), arrowhead at t2.
  function arc(st, cx, cy, R, Ry, t1, t2) {
    if (t2 <= t1) return [];
    const P = t => [cx + R * Math.cos(t), cy + Ry * Math.sin(t)]; const pts = []; for (let k = 0; k <= 16; k++) pts.push(P(t1 + (t2 - t1) * k / 16));
    const mx = Math.min(...pts.map(p => p[0])), my = Math.min(...pts.map(p => p[1])); const w = Math.max(1, Math.max(...pts.map(p => p[0])) - mx), h = Math.max(1, Math.max(...pts.map(p => p[1])) - my);
    const [x1, y1] = P(t1), [x2, y2] = P(t2); const large = t2 - t1 > Math.PI ? 1 : 0;
    const d = `M ${r1(x1 - mx)} ${r1(y1 - my)} A ${r1(R)} ${r1(Ry)} 0 ${large} 1 ${r1(x2 - mx)} ${r1(y2 - my)}`;
    const tx = -R * Math.sin(t2), ty = Ry * Math.cos(t2); const tl = Math.hypot(tx, ty) || 1;
    return [{ kind: 'vector', role: 'diagram-link', x: r1(mx), y: r1(my), w: r1(w), h: r1(h), viewBox: [0, 0, r1(w), r1(h)], d, fill: 'none', stroke: { color: st.line, width: st.stroke }, decorative: true, label: 'connector' }, arrowHead(st, x2, y2, [tx / tl, ty / tl])];
  }
  function arrowHead(st, x, y, dir) {
    const s = st.stroke * 4.2; const [dx, dy] = dir; const px = -dy, py = dx;
    const p1 = [x, y], p2 = [x - dx * s + px * s * 0.55, y - dy * s + py * s * 0.55], p3 = [x - dx * s - px * s * 0.55, y - dy * s - py * s * 0.55];
    const xs = [p1[0], p2[0], p3[0]], ys = [p1[1], p2[1], p3[1]]; const mx = Math.min(...xs), my = Math.min(...ys); const w = Math.max(1, Math.max(...xs) - mx), h = Math.max(1, Math.max(...ys) - my);
    const d = `M ${r1(p1[0] - mx)} ${r1(p1[1] - my)} L ${r1(p2[0] - mx)} ${r1(p2[1] - my)} L ${r1(p3[0] - mx)} ${r1(p3[1] - my)} Z`;
    return { kind: 'vector', role: 'diagram-arrow', x: r1(mx), y: r1(my), w: r1(w), h: r1(h), viewBox: [0, 0, r1(w), r1(h)], d, fill: st.line, decorative: true, label: 'arrowhead' };
  }
  const roots = d => d.nodes.map((x, i) => [x, i]).filter(([x]) => x.parent < 0);
  const kids = (d, i) => d.nodes.map((x, j) => [x, j]).filter(([x]) => x.parent === i);
  // Children folded into their parent's note (for types that draw one level).
  const folded = (d, i) => { const n = d.nodes[i]; const k = kids(d, i).map(([x]) => x.label); return { ...n, text: [n.text, k.join(' · ')].filter(Boolean).join(n.text && k.length ? ' — ' : '') }; };

  // ---- Layouts ---------------------------------------------------------------------------------------------------------------
  const L = {};
  L.flow = (d, r, st, H, g) => {
    const top = roots(d).slice(0, 8); const n = top.length; if (n < 2) return null;
    const rows = n > 5 && r.w < r.h * 2.2 ? 2 : 1; const per = Math.ceil(n / rows); const gap = Math.max(st.unit * 4, r.w * 0.035);
    const w = (r.w - gap * (per - 1)) / per; const h = Math.min(rows === 1 ? r.h * 0.8 : (r.h - gap) / 2, w * 0.66);
    const out = []; const boxes = [];
    for (let k = 0; k < n; k++) {
      const row = Math.floor(k / per), col = row % 2 ? per - 1 - (k % per) : k % per; // snake back on the second row
      const x = r.x + col * (w + gap), y = rows === 1 ? r.y + (r.h - h) / 2 : r.y + row * (h + gap) + (r.h - (h * 2 + gap)) / 2;
      const b = nodeBox(H, g, st, { x, y, w, h }, folded(d, top[k][1]), top[k][1], { hi: k === n - 1 && st.highlightLast }); if (!b) return null;
      out.push(...b); boxes.push({ x, y, w, h, row });
    }
    for (let k = 0; k < n - 1; k++) {
      const a = boxes[k], b = boxes[k + 1];
      if (a.row === b.row) { const ltr = b.x > a.x; out.push(...connector(st, ltr ? a.x + a.w + gap * 0.18 : a.x - gap * 0.18, a.y + a.h / 2, ltr ? b.x - gap * 0.18 : b.x + b.w + gap * 0.18, b.y + b.h / 2)); }
      else out.push(...connector(st, a.x + a.w / 2, a.y + a.h + gap * 0.15, b.x + b.w / 2, b.y - gap * 0.15));
    }
    return out;
  };
  L.cycle = (d, r, st, H, g) => {
    const top = roots(d).slice(0, 8); const n = top.length; if (n < 3) return null;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2;
    const nh = Math.min(r.h * 0.22, r.w * 0.12), nw = Math.min(nh * 2.6, r.w / (n * 0.75));
    const Ry = (r.h - nh) / 2, Rx = Math.min((r.w - nw) / 2, Ry * 2.1);
    const ang = k => -Math.PI / 2 + k * 2 * Math.PI / n; const pts = top.map((_, k) => [cx + Rx * Math.cos(ang(k)), cy + Ry * Math.sin(ang(k))]);
    const out = [];
    for (let k = 0; k < n; k++) { const b = nodeBox(H, g, st, { x: pts[k][0] - nw / 2, y: pts[k][1] - nh / 2, w: nw, h: nh }, folded(d, top[k][1]), top[k][1], { radius: nh / 2, hi: k === 0 }); if (!b) return null; out.push(...b); }
    // arcs along the ring from one step to the next, starting and ending clear of the boxes
    const clear = t => { const c = Math.abs(Math.cos(t)), s2 = Math.abs(Math.sin(t)); return Math.min(Math.PI / n * 0.75, (nw * 0.62 * s2 + nh * 0.9 * c) / Math.max(Rx, Ry) + 0.05); };
    for (let k = 0; k < n; k++) { const a = ang(k), b = ang(k + 1); out.push(...arc(st, cx, cy, Rx, Ry, a + clear(a), b - clear(b))); }
    return out;
  };
  L.tree = (d, r, st, H, g) => {
    // depth and leaves; up to three levels drawn as boxes, deeper ones fold into their parent's note
    const depthOf = i => { let k = 0, p = d.nodes[i].parent; while (p >= 0) { k++; p = d.nodes[p].parent; } return k; };
    const show = d.nodes.map((_, i) => depthOf(i) <= 2); const top = roots(d); if (!top.length) return null;
    const vis = i => kids(d, i).filter(([, j]) => show[j]);
    const leaves = i => { const k = vis(i); return k.length ? k.reduce((t, [, j]) => t + leaves(j), 0) : 1; };
    const total = top.reduce((t, [, i]) => t + leaves(i), 0); const levels = Math.max(...d.nodes.map((_, i) => show[i] ? depthOf(i) : 0)) + 1;
    const slot = r.w / total; const vgap = Math.max(st.unit * 4, r.h * 0.08); const nh = Math.min((r.h - vgap * (levels - 1)) / levels, slot * 0.9); const nw = Math.min(slot * 0.9, nh * 3.2);
    const out = []; const pos = new Map(); let cursor = 0;
    const place = (i, depth) => { const k = vis(i); let x0 = cursor; if (k.length) { for (const [, j] of k) place(j, depth + 1); } else cursor += 1; const span = k.length ? [pos.get(k[0][1]).slot0, pos.get(k[k.length - 1][1]).slot1] : [x0, x0 + 1]; const cxs = r.x + (span[0] + span[1]) / 2 * slot; pos.set(i, { slot0: span[0], slot1: span[1], cx: cxs, y: r.y + depth * (nh + vgap) + (r.h - (levels * nh + (levels - 1) * vgap)) / 2, depth }); };
    for (const [, i] of top) place(i, 0);
    for (const [i, p] of pos) { const node = d.nodes[i]; const deep = kids(d, i).filter(([, j]) => !show[j]).map(([x]) => x.label); const b = nodeBox(H, g, st, { x: p.cx - nw / 2, y: p.y, w: nw, h: nh }, deep.length ? { ...node, text: [node.text, deep.join(' · ')].filter(Boolean).join(' — ') } : node, i, { hi: p.depth === 0 }); if (!b) return null; out.push(...b); }
    for (const [i, p] of pos) for (const [, j] of vis(i)) { const c = pos.get(j); out.push(...connector(st, p.cx, p.y + nh, c.cx, c.y, 'elbow', false)); }
    return out;
  };
  L.timeline = (d, r, st, H, g) => {
    const top = roots(d).slice(0, 8); const n = top.length; if (n < 2) return null;
    if (top.some(([, i]) => (folded(d, i).text || '').length > 60)) {
      // long notes: the track runs along the top and each milestone is a column of text under its dot
      const slot = r.w / n; const dot = Math.max(st.unit * 1.5, Math.min(slot * 0.07, r.h * 0.05)); const y = r.y + dot;
      const out = [...connector(st, r.x, y, r.x + r.w, y, 'straight', true)]; const gap = Math.max(st.unit * 2, slot * 0.08);
      for (let k = 0; k < n; k++) {
        const x0 = r.x + slot * k;
        out.push({ kind: 'shape', shape: 'circle', role: 'diagram-node', x: x0, y: y - dot / 2, w: dot, h: dot, fill: k === 0 ? st.accent : st.line, decorative: true, label: 'milestone' });
        const col = { x: x0, y: y + dot * 1.8, w: slot - gap, h: r.y + r.h - (y + dot * 1.8) };
        const b = nodeBox(H, g, st, col, folded(d, top[k][1]), top[k][1], { fill: 'none', fg: st.fg, fg2: st.fg2, radius: 0, pad: 0, align: 'left', valign: 'top', noteLines: 14 });
        if (!b) return null; b[0].fill = 'none'; out.push(...b.slice(1));
      }
      return out;
    }
    const y = r.y + r.h / 2; const slot = r.w / n; const dot = Math.max(st.unit * 1.5, Math.min(slot * 0.12, r.h * 0.06));
    const out = [...connector(st, r.x, y, r.x + r.w, y, 'straight', true)];
    const bh = (r.h / 2) - dot * 2.2; const bw = slot * 0.92;
    for (let k = 0; k < n; k++) {
      const cx = r.x + slot * (k + 0.5); const up = k % 2 === 0;
      out.push({ kind: 'shape', shape: 'circle', role: 'diagram-node', x: cx - dot / 2, y: y - dot / 2, w: dot, h: dot, fill: k === 0 ? st.accent : st.line, decorative: true, label: 'milestone' });
      const rect = { x: cx - bw / 2, y: up ? y - dot * 1.6 - bh : y + dot * 1.6, w: bw, h: bh };
      const b = nodeBox(H, g, st, rect, folded(d, top[k][1]), top[k][1], { fill: 'none', fg: st.fg, fg2: st.fg2, radius: 0 });
      if (!b) return null; b[0].fill = 'none'; out.push(...b.slice(1));
      const s = b.slice(1); if (s.length) { const hgt = s.reduce((t, x) => Math.max(t, x.y + x.h), 0) - Math.min(...s.map(x => x.y)); const shift = up ? (rect.y + rect.h - (Math.min(...s.map(x => x.y)) + hgt)) : (rect.y - Math.min(...s.map(x => x.y))); for (const x of s) x.y += shift; }
    }
    return out;
  };
  L.mindmap = (d, r, st, H, g) => {
    const top = roots(d); if (!top.length) return null;
    const [, ci] = top[0]; const branches = [...kids(d, ci), ...top.slice(1)].slice(0, 10); if (!branches.length) return null;
    const cx = r.x + r.w / 2, cy = r.y + r.h / 2; const cw = Math.min(r.w * 0.24, r.h * 0.5), ch = cw * 0.5;
    const out = []; const c = nodeBox(H, g, st, { x: cx - cw / 2, y: cy - ch / 2, w: cw, h: ch }, d.nodes[ci], ci, { hi: true, radius: ch / 2, noText: false }); if (!c) return null; out.push(...c);
    const left = branches.filter((_, k) => k % 2 === 1), right = branches.filter((_, k) => k % 2 === 0);
    const bw = Math.min(r.w * 0.26, (r.w - cw) / 2 * 0.82);
    for (const [side, list] of [[1, right], [-1, left]]) {
      const n = list.length; if (!n) continue; const gap = r.h * 0.04; const bh = Math.min(r.h * 0.3, (r.h - gap * (n - 1)) / n);
      const y0 = cy - (n * bh + (n - 1) * gap) / 2;
      list.forEach(([, j], k) => {
        const x = side > 0 ? r.x + r.w - bw : r.x; const y = y0 + k * (bh + gap);
        const b = nodeBox(H, g, st, { x, y, w: bw, h: bh }, folded(d, j), j, { align: side > 0 ? 'left' : 'right' }); if (!b) { out.length = 0; return; }
        out.push(...b); out.push(...connector(st, cx + side * cw / 2, cy, side > 0 ? x : x + bw, y + bh / 2, 'curve', false));
      });
      if (!out.length) return null;
    }
    return out.length ? out : null;
  };
  L.pyramid = (d, r, st, H, g) => {
    const top = roots(d).slice(0, 7); const n = top.length; if (n < 2) return null;
    const pw = Math.min(r.w * (r.w > r.h * 1.6 ? 0.55 : 1), r.h * 1.4); const x0 = r.x + (r.w > r.h * 1.6 ? 0 : (r.w - pw) / 2); const bh = r.h / n; const out = [];
    for (let k = 0; k < n; k++) {
      const wTop = pw * (k / n), wBot = pw * ((k + 1) / n); const y = r.y + k * bh; const cxm = x0 + pw / 2;
      const pts = [[cxm - wTop / 2, y], [cxm + wTop / 2, y], [cxm + wBot / 2, y + bh - 2], [cxm - wBot / 2, y + bh - 2]];
      const mx = Math.min(...pts.map(p => p[0])); const shade = k === 0 ? st.hi : st.card;
      out.push({ kind: 'vector', role: 'diagram-node', x: r1(mx), y: r1(y), w: r1(wBot), h: r1(bh - 2), viewBox: [0, 0, r1(wBot), r1(bh - 2)], d: `M ${pts.map(p => `${r1(p[0] - mx)} ${r1(p[1] - y)}`).join(' L ')} Z`, fill: shade, decorative: true, label: 'level' });
      const node = folded(d, top[k][1]); const wide = r.w > r.h * 1.6;
      const lab = nodeBox(H, g, st, { x: cxm - Math.max(wBot, pw * 0.3) * 0.36, y, w: Math.max(wBot, pw * 0.3) * 0.72, h: bh - 2 }, wide ? { ...node, text: '' } : node, top[k][1], { fill: 'none', fg: k === 0 ? st.hiText : st.cardText, fg2: k === 0 ? st.hiText : st.cardText2, noText: wide });
      if (lab) out.push(...lab.slice(1));
      if (wide && node.text) { const t = nodeBox(H, g, st, { x: x0 + pw + st.unit * 3, y, w: r.x + r.w - (x0 + pw + st.unit * 3), h: bh - 2 }, { label: node.text, text: '' }, top[k][1], { fill: 'none', fg: st.fg2, align: 'left' }); if (t) { const tb = t.slice(1); for (const b of tb) { b.path = `diagram.nodes.${top[k][1]}.text`; b.font = { ...b.font, weight: st.weight }; } out.push(...tb); } }
    }
    return out;
  };
  L.staircase = (d, r, st, H, g) => {
    const top = roots(d).slice(0, 7); const n = top.length; if (n < 2) return null;
    const gap = Math.max(st.unit * 2, r.w * 0.02); const bw = (r.w - gap * (n - 1)) / n; const out = [];
    for (let k = 0; k < n; k++) {
      const h = r.h * (0.38 + 0.62 * (k + 1) / n); const x = r.x + k * (bw + gap), y = r.y + r.h - h;
      const b = nodeBox(H, g, st, { x, y, w: bw, h }, folded(d, top[k][1]), top[k][1], { hi: k === n - 1, radius: st.radius }); if (!b) return null;
      // words at the top of each step, not the middle
      const words = b.slice(1); if (words.length) { const minY = Math.min(...words.map(w => w.y)); for (const w of words) w.y += (y + Math.max(8, bw * 0.08)) - minY; }
      out.push(...b);
    }
    return out;
  };
  L.matrix = (d, r, st, H, g) => {
    const top = roots(d).slice(0, 4); if (top.length < 2) return null; const gap = Math.max(st.unit * 2, r.w * 0.015);
    const s = Math.min(r.w, r.h * 1.8); const x0 = r.x + (r.w - s) / 2; const w = (s - gap) / 2, h = (r.h - gap) / 2; const out = [];
    top.forEach(([, i], k) => { const b = nodeBox(H, g, st, { x: x0 + (k % 2) * (w + gap), y: r.y + Math.floor(k / 2) * (h + gap), w, h }, folded(d, i), i, { hi: k === 1, align: 'left' }); if (b) out.push(...b); });
    return out.length ? out : null;
  };

  // ---- Blocks for a spec in a rectangle --------------------------------------------------------------------------------------
  function blocks(spec, rect, st, H, g) {
    const d = norm(spec); if (!d) return null;
    const fn = L[d.type] || L.flow; let out = null;
    for (const sc of [1, 0.88, 0.76, 0.66]) { out = fn(d, rect, { ...st, bodySize: Math.round(st.bodySize * sc) }, H, g); if (out) break; }
    if (!out) return null;
    const gid = 'dg' + Math.random().toString(36).slice(2, 7);
    const frame = { kind: 'field', role: 'diagram', x: rect.x, y: rect.y, w: rect.w, h: rect.h, fill: 'none', decorative: true, label: `${LABEL[d.type]} diagram`, diagram: d, diagramStyle: { ...st }, group: gid };
    for (const b of out) b.group = gid;
    return [frame, ...out];
  }
  // Colors and type from a slide's palette and type set (the engine's), kept on the diagram for later redraws.
  function styleFrom(pal, ts, kit, g, radius, H) {
    const mix = (a, b, t) => (typeof Color !== 'undefined' && Color.mix) ? Color.mix(a, b, t) : a;
    const card = pal.card || mix(pal.fg, pal.bg, 0.9);
    return {
      fg: pal.fg, fg2: mix(pal.fg, pal.bg, 0.25), line: mix(pal.fg, pal.bg, 0.45), accent: pal.accentText || pal.accent,
      card, cardText: pal.fg, cardText2: mix(pal.fg, card, 0.28), hi: pal.accentCard || pal.accent, hiText: pal.accentCardText || pal.bg,
      font: { family: ts.body.family, weight: ts.body.weight, size: ts.body.size, lineHeight: 1.25, letterSpacing: 0 }, weight: ts.body.weight,
      boldWeight: H && H.nearestWeight && kit ? H.nearestWeight(kit.fonts.body, 600) : 600,
      bodySize: ts.body.size, radius, unit: g.unit, stroke: Math.max(2, Math.round(g.unit / 3)), highlightLast: true,
    };
  }

  // ---- As an engine archetype: headline (and subhead) over the diagram --------------------------------------------------------
  function archetype(ctx, H) {
    const { g, pal, ts, content } = ctx; const spec = norm(content.diagram); if (!spec || !content.headline) return null;
    const C = g.cols, R = ctx.R; const blocksOut = []; const avoid = [];
    const head = [{ kind: 'text', role: 'headline', path: 'headline', text: content.headline, font: { ...ts.headline, size: H.snapFont(ts.headline.size * 0.7, g.unit) }, fill: pal.fg, maxLines: 2, gap: H.snap(ts.body.size * 0.6, g.unit) }];
    if (content.subhead) head.push({ kind: 'text', role: 'subhead', path: 'subhead', text: content.subhead, font: { ...ts.subhead, size: H.snapFont(ts.subhead.size * 0.85, g.unit) }, fill: pal.fg2, maxLines: 2 });
    const hr = H.headlineRegion(ctx, Math.min(3, R - 3), Math.round(C * 0.8));
    const hs = H.buildStack(head, hr, 'left', 'top', g); if (!hs) return null; blocksOut.push(...hs.blocks); avoid.push(H.inkRect(hs, hr, 'left'));
    const area = Grid.rect(g, 0, ctx.r0, C, R); const top = H.snap(hs.y1 + Math.max(g.unit * 4, ts.body.size * 1.6), g.unit);
    const rect = { x: area.x, y: top, w: area.w, h: area.y + area.h - top }; if (rect.h < g.unit * 12) return null;
    const st = styleFrom(pal, ts, ctx.kit, g, ctx.radius(g.unit * 2), H);
    const bl = blocks(spec, rect, st, { buildStack: H.buildStack }, g); if (!bl) return null;
    blocksOut.push(...bl); avoid.push(rect);
    const logo = H.placeLogo(ctx, avoid, ['TR', 'BR']); if (logo) blocksOut.push(logo);
    return { blocks: blocksOut, meta: { diagram: spec.type, nodes: spec.nodes.length } };
  }
  return { TYPES, LABEL, norm, toText, fromText, blocks, styleFrom, archetype };
})();
