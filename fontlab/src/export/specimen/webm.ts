/** Record a sequence of draw calls on a canvas into a WebM blob via MediaRecorder. */
export async function recordWebm(canvas: HTMLCanvasElement, drawFrame: (i: number) => void, frameCount: number, fps = 20): Promise<Blob> {
  if (typeof MediaRecorder === 'undefined') throw new Error('MediaRecorder not supported in this browser');
  const type = ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) => MediaRecorder.isTypeSupported(t));
  if (!type) throw new Error('WebM recording not supported in this browser');
  const stream = canvas.captureStream(fps);
  const rec = new MediaRecorder(stream, { mimeType: type, videoBitsPerSecond: 4_000_000 });
  const chunks: Blob[] = [];
  rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
  const done = new Promise<Blob>((resolve) => { rec.onstop = () => resolve(new Blob(chunks, { type })); });
  rec.start();
  for (let i = 0; i < frameCount; i++) {
    drawFrame(i);
    // tick the stream
    const track = stream.getVideoTracks()[0] as any;
    track.requestFrame?.();
    await new Promise((r) => setTimeout(r, 1000 / fps));
  }
  rec.stop();
  return done;
}
