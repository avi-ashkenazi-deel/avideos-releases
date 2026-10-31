import buildVarPy from './build_var.py?raw';

const PYODIDE_VERSION = '0.27.7';
const PYODIDE_URL = `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/`;

export interface VarAxisSpec { tag: string; name: string; min: number; default: number; max: number }
export interface VarMaster { location: Record<string, number>; glyphs: Record<string, { advance: number; contours: [number, number][][] }> }
export interface VarPayload {
  familyName: string; styleName?: string;
  upm: number; ascender: number; descender: number; xHeight: number; capHeight: number;
  axes: VarAxisSpec[];
  glyphOrder: string[];
  unicodes: Record<string, number>;
  masters: VarMaster[];
}

let pyodidePromise: Promise<any> | null = null;

export function pyodideReady(): boolean { return !!pyodidePromise; }

/** Lazy-load Pyodide (~12 MB, cached by the browser) + fontTools. */
export async function getPyodide(onStatus: (s: string) => void = () => {}): Promise<any> {
  if (!pyodidePromise) {
    pyodidePromise = (async () => {
      onStatus('Loading Python runtime (first time only, ~12 MB)…');
      const mod = await import(/* @vite-ignore */ `${PYODIDE_URL}pyodide.mjs`);
      const py = await mod.loadPyodide({ indexURL: PYODIDE_URL });
      onStatus('Loading fontTools…');
      await py.loadPackage('fonttools');
      py.runPython(buildVarPy);
      return py;
    })().catch((e) => { pyodidePromise = null; throw e; });
  }
  return pyodidePromise;
}

/** Build a variable TTF from the payload; returns the font bytes. */
export async function buildVariableFont(payload: VarPayload, onStatus?: (s: string) => void): Promise<Uint8Array> {
  const py = await getPyodide(onStatus);
  onStatus?.('Building variable font…');
  const fn = py.globals.get('build_variable');
  try {
    const result = fn(JSON.stringify(payload));
    const bytes: Uint8Array = result.toJs();
    result.destroy?.();
    return bytes;
  } finally {
    fn.destroy?.();
  }
}

/** Convert the built CFF .otf to a TrueType .ttf (quadratic outlines) with fontTools. */
export async function buildStaticTtf(otf: ArrayBuffer, onStatus?: (s: string) => void): Promise<Uint8Array> {
  const py = await getPyodide(onStatus);
  onStatus?.('Converting to TrueType…');
  const fn = py.globals.get('build_static_ttf');
  const input = py.toPy(new Uint8Array(otf));
  try {
    const result = fn(input);
    const bytes: Uint8Array = result.toJs();
    result.destroy?.();
    return bytes;
  } finally {
    input.destroy?.();
    fn.destroy?.();
  }
}
