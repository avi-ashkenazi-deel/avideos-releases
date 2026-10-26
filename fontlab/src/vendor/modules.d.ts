declare module 'opentype.js';
declare module 'gif.js' {
  export default class GIF {
    constructor(opts: Record<string, unknown>);
    addFrame(el: CanvasImageSource | CanvasRenderingContext2D, opts?: Record<string, unknown>): void;
    on(ev: 'finished', cb: (blob: Blob) => void): void;
    on(ev: 'progress', cb: (p: number) => void): void;
    render(): void;
  }
}
declare module 'skeleton-tracing-js';
declare module 'wawoff2/decompress.js' {
  const decompress: (buf: Uint8Array) => Promise<Uint8Array>;
  export default decompress;
}
declare module 'wawoff2/compress.js' {
  const compress: (buf: Uint8Array) => Promise<Uint8Array>;
  export default compress;
}
