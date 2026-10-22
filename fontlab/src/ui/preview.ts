/** Manage the live FontFace used by the preview area. */
const FAMILY = 'FunkyPreview';
let current: FontFace | null = null;
let gen = 0;

export const PREVIEW_FAMILY = FAMILY;

export async function installPreviewFont(otf: ArrayBuffer): Promise<void> {
  const myGen = ++gen;
  const face = new FontFace(FAMILY, otf);
  try {
    await face.load();
  } catch (e) {
    console.warn('FontFace load failed', e);
    return;
  }
  if (myGen !== gen) return; // a newer font superseded this one while loading
  if (current) document.fonts.delete(current);
  document.fonts.add(face);
  current = face;
  document.documentElement.classList.add('has-preview-font');
}
