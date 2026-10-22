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
