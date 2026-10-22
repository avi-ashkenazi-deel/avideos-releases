/// <reference types="node" />
/**
 * Tiny dependency-free PNG decoder for test fixtures: 8-bit gray / gray+alpha /
 * RGB / RGBA, non-interlaced, filters 0-4. Always returns RGBA.
 */
import { inflateSync } from 'node:zlib';
import { readFileSync } from 'node:fs';

export interface DecodedPng { width: number; height: number; data: Uint8ClampedArray }

export function decodePng(buf: Uint8Array): DecodedPng {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < 8; i++) if (buf[i] !== sig[i]) throw new Error('not a PNG');
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Uint8Array[] = [];
  while (pos < buf.length) {
    const len = dv.getUint32(pos);
    const type = String.fromCharCode(buf[pos + 4], buf[pos + 5], buf[pos + 6], buf[pos + 7]);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = dv.getUint32(pos + 8); height = dv.getUint32(pos + 12);
      bitDepth = buf[pos + 16]; colorType = buf[pos + 17]; interlace = buf[pos + 20];
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bitDepth !== 8) throw new Error(`unsupported bit depth ${bitDepth}`);
  if (interlace) throw new Error('interlaced PNG not supported');
  const channels = { 0: 1, 2: 3, 4: 2, 6: 4 }[colorType as 0 | 2 | 4 | 6];
  if (!channels) throw new Error(`unsupported color type ${colorType}`);
  const total = idat.reduce((s, c) => s + c.length, 0);
  const z = new Uint8Array(total);
  let off = 0;
  for (const c of idat) { z.set(c, off); off += c.length; }
  const raw = inflateSync(z);
  const stride = width * channels;
  const px = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const line = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? cur[i - channels] : 0;
      const b = prev[i];
      const c = i >= channels ? prev[i - channels] : 0;
      let v = line[i];
      switch (f) {
        case 0: break;
        case 1: v += a; break;
        case 2: v += b; break;
        case 3: v += (a + b) >> 1; break;
        case 4: { const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; break; }
        default: throw new Error(`bad filter ${f}`);
      }
      cur[i] = v & 0xff;
    }
    px.set(cur, y * stride);
    prev = cur;
  }
  const data = new Uint8ClampedArray(width * height * 4);
  for (let i = 0, j = 0; i < width * height; i++, j += 4) {
    const s = i * channels;
    if (channels === 1) { data[j] = data[j + 1] = data[j + 2] = px[s]; data[j + 3] = 255; }
    else if (channels === 2) { data[j] = data[j + 1] = data[j + 2] = px[s]; data[j + 3] = px[s + 1]; }
    else if (channels === 3) { data[j] = px[s]; data[j + 1] = px[s + 1]; data[j + 2] = px[s + 2]; data[j + 3] = 255; }
    else { data[j] = px[s]; data[j + 1] = px[s + 1]; data[j + 2] = px[s + 2]; data[j + 3] = px[s + 3]; }
  }
  return { width, height, data };
}

export function readPng(path: string): DecodedPng {
  return decodePng(new Uint8Array(readFileSync(path)));
}
