// Runs media analysis (ffmpeg scene detection, keyframes, contact sheets, tempo) on a worker thread.
// analyzeFile is synchronous and can take seconds per clip; on the main thread it froze the whole server.
import { parentPort } from 'node:worker_threads';
import { analyzeFile } from './analyze.mjs';

parentPort.on('message', ({ id, entry, outDir }) => {
  try {
    const rec = analyzeFile(entry, outDir, { onLog: (text) => parentPort.postMessage({ id, log: text }) });
    parentPort.postMessage({ id, rec });
  } catch (e) { parentPort.postMessage({ id, error: e.message }); }
});
