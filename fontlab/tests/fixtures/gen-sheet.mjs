// Generates tests/fixtures/sheet.png: a dense "type specimen" sheet — 4 rows × 8
// bold blocky letters, every letter wrapped in a 1-px dark halo line that touches
// its neighbours (a mesh), plus a 6-px page frame. No dependencies.
// Usage: node tests/fixtures/gen-sheet.mjs [out.png]
import { deflateSync } from 'node:zlib';
import { writeFileSync } from 'node:fs';

const W = 1000, H = 560, ROWS = 4, COLS = 8;
const out = process.argv[2] ?? 'tests/fixtures/sheet.png';
const dark = process.argv.includes('--dark'); // light letters on black, no frame/mesh (video-frame style)
const ink = new Uint8Array(W * H); // 1 = dark

const rect = (x0, y0, x1, y1) => { for (let y = Math.max(0, y0); y <= Math.min(H - 1, y1); y++) for (let x = Math.max(0, x0); x <= Math.min(W - 1, x1); x++) ink[y * W + x] = 1; };
const hollow = (x0, y0, x1, y1, t) => { rect(x0, y0, x1, y0 + t - 1); rect(x0, y1 - t + 1, x1, y1); rect(x0, y0, x0 + t - 1, y1); rect(x1 - t + 1, y0, x1, y1); };

// frame
if (!dark) hollow(0, 0, W - 1, H - 1, 6);

// grid of cells
const marginX = 40, marginY = 40, cellW = (W - 2 * marginX) / COLS, cellH = (H - 2 * marginY) / ROWS;
const SW = 14; // stroke width of the letters
const shapes = ['stem', 'box', 'bar', 'L', 'T', 'H', 'ring', 'U'];
let k = 0;
for (let r = 0; r < ROWS; r++) for (let c = 0; c < COLS; c++, k++) {
  const x0 = Math.round(marginX + c * cellW), y0 = Math.round(marginY + r * cellH);
  const x1 = Math.round(marginX + (c + 1) * cellW) - 1, y1 = Math.round(marginY + (r + 1) * cellH) - 1;
  // 1-px halo mesh around every cell, touching the neighbours and the frame
  if (!dark) hollow(x0, y0, x1, y1, 1);
  // letter body inside, leaving ≥ 10 px of paper to the halo
  const lx0 = x0 + 14, ly0 = y0 + 14, lx1 = x1 - 14, ly1 = y1 - 14;
  const cx = (lx0 + lx1) >> 1;
  switch (shapes[k % shapes.length]) {
    case 'stem': rect(cx - SW / 2, ly0, cx + SW / 2, ly1); break;
    case 'box': hollow(lx0, ly0, lx1, ly1, SW); break;
    case 'bar': rect(lx0, ((ly0 + ly1) >> 1) - SW / 2, lx1, ((ly0 + ly1) >> 1) + SW / 2); rect(cx - SW / 2, ly0, cx + SW / 2, ly1); break;
    case 'L': rect(lx0, ly0, lx0 + SW, ly1); rect(lx0, ly1 - SW, lx1, ly1); break;
    case 'T': rect(lx0, ly0, lx1, ly0 + SW); rect(cx - SW / 2, ly0, cx + SW / 2, ly1); break;
    case 'H': rect(lx0, ly0, lx0 + SW, ly1); rect(lx1 - SW, ly0, lx1, ly1); rect(lx0, ((ly0 + ly1) >> 1) - SW / 2, lx1, ((ly0 + ly1) >> 1) + SW / 2); break;
    case 'ring': hollow(lx0 + 4, ly0 + 4, lx1 - 4, ly1 - 4, SW); break;
    case 'U': rect(lx0, ly0, lx0 + SW, ly1); rect(lx1 - SW, ly0, lx1, ly1); rect(lx0, ly1 - SW, lx1, ly1); break;
  }
}

const rgba = new Uint8Array(W * H * 4).fill(dark ? 10 : 255);
for (let i = 0; i < W * H; i++) { if (ink[i]) { const v = dark ? 245 : 15; rgba[i * 4] = rgba[i * 4 + 1] = rgba[i * 4 + 2] = v; } rgba[i * 4 + 3] = 255; }

// --- PNG encoder ---
const crcTable = new Int32Array(256);
for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; crcTable[n] = c; }
const crc32 = (buf) => { let c = -1; for (const b of buf) c = crcTable[(c ^ b) & 0xff] ^ (c >>> 8); return (c ^ -1) >>> 0; };
const chunk = (type, data) => {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
};
const ihdr = Buffer.alloc(13);
ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
const raw = Buffer.alloc((W * 4 + 1) * H);
for (let y = 0; y < H; y++) { raw[y * (W * 4 + 1)] = 0; Buffer.from(rgba.buffer, y * W * 4, W * 4).copy(raw, y * (W * 4 + 1) + 1); }
const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
writeFileSync(out, png);
console.log('wrote', out, png.length, 'bytes');
