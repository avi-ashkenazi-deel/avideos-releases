import * as THREE from 'three';
import type { GalleryImage } from '@/data/types';

function hashHue(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}

/**
 * Builds a colorful placeholder texture for a gallery item. Used until a real
 * image `src` is provided. Full-color gradient + the item's title, so the field
 * looks alive immediately.
 */
export function makePlaceholderTexture(item: GalleryImage): THREE.Texture {
  const w = 512;
  const h = Math.round((512 * item.height) / item.width);
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d')!;

  const hue = hashHue(item.id);
  const grad = ctx.createLinearGradient(0, 0, w, h);
  grad.addColorStop(0, `hsl(${hue}, 62%, 58%)`);
  grad.addColorStop(1, `hsl(${(hue + 48) % 360}, 60%, 38%)`);
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, w, h);

  if (item.title) {
    ctx.fillStyle = 'rgba(255,255,255,0.92)';
    ctx.font = `500 ${Math.round(w * 0.07)}px "Helvetica Neue", Helvetica, Arial, sans-serif`;
    ctx.textBaseline = 'bottom';
    ctx.fillText(item.title, w * 0.06, h - h * 0.06);
  }

  const tex = new THREE.CanvasTexture(canvas);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}
