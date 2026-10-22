import GIF from 'gif.js';
import gifWorkerUrl from 'gif.js/dist/gif.worker.js?url';

/** Encode canvas frames into an animated GIF blob. */
export function encodeGif(frames: HTMLCanvasElement[], delayMs = 80, onProgress?: (p: number) => void): Promise<Blob> {
  return new Promise((resolve, reject) => {
    try {
      const gif = new GIF({ workers: 2, quality: 8, workerScript: gifWorkerUrl, width: frames[0].width, height: frames[0].height });
      for (const f of frames) gif.addFrame(f, { delay: delayMs, copy: true });
      gif.on('progress', (p) => onProgress?.(p));
      gif.on('finished', (blob) => resolve(blob));
      gif.render();
    } catch (e) { reject(e); }
  });
}
