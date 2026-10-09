// A drawn sample person, so admins can preview the policy before anyone has
// taken a photo. It goes through the same renderer as real photos.

import { OUT_W, OUT_H, makeCanvas, blurChannel, Renderer, composeAvatar } from './pipeline.js';

function makeSamplePrep() {
  const W = OUT_W, H = OUT_H, N = W * H;

  // The "room" behind the sample, used by the blur / keep-my-room options.
  const room = makeCanvas(W, H);
  const rc = room.getContext('2d', { willReadFrequently: true });
  const wall = rc.createLinearGradient(0, 0, 0, H);
  wall.addColorStop(0, '#d9c8b4');
  wall.addColorStop(1, '#a88f78');
  rc.fillStyle = wall;
  rc.fillRect(0, 0, W, H);
  rc.fillStyle = '#eef3f7';
  rc.fillRect(40, 90, 230, 360);
  rc.fillStyle = '#6b5644';
  rc.fillRect(600, 160, 200, 840);
  const roomPx = rc.getImageData(0, 0, W, H).data;

  // The person silhouette, drawn on its own layer to get a clean mask.
  const fig = makeCanvas(W, H);
  const fc = fig.getContext('2d', { willReadFrequently: true });
  fc.fillStyle = '#294c6a';
  fc.beginPath();
  fc.moveTo(90, H);
  fc.bezierCurveTo(110, 780, 230, 700, 330, 690);
  fc.lineTo(470, 690);
  fc.bezierCurveTo(570, 700, 690, 780, 710, H);
  fc.closePath();
  fc.fill();
  fc.fillStyle = '#7f949f';
  fc.fillRect(345, 520, 110, 190);
  fc.fillStyle = '#90a4ae';
  fc.beginPath();
  fc.ellipse(400, 400, 125, 160, 0, 0, Math.PI * 2);
  fc.fill();
  fc.fillStyle = '#e8ebf2';
  fc.beginPath();
  fc.moveTo(350, 690); fc.lineTo(400, 790); fc.lineTo(450, 690); fc.closePath();
  fc.fill();

  rc.drawImage(fig, 0, 0);
  const base = rc.getImageData(0, 0, W, H).data;
  const figData = fc.getImageData(0, 0, W, H).data;

  const person = new Float32Array(N);
  const skin = new Float32Array(N);
  const r = new Float32Array(N), g = new Float32Array(N), b = new Float32Array(N);
  const rr = new Float32Array(N), rg = new Float32Array(N), rb = new Float32Array(N);
  for (let i = 0, j = 0; i < N; i++, j += 4) {
    person[i] = figData[j + 3] / 255;
    r[i] = base[j]; g[i] = base[j + 1]; b[i] = base[j + 2];
    rr[i] = roomPx[j]; rg[i] = roomPx[j + 1]; rb[i] = roomPx[j + 2];
    skin[i] = person[i] > 0 && j / 4 < W * 700 && figData[j + 2] > 150 ? 1 : 0;
  }
  const zeros = new Float32Array(N);

  return {
    W, H, base, smooth: [r, g, b], detail: [r, g, b],
    roomBlur: [blurChannel(rr, W, H, 14), blurChannel(rg, W, H, 14), blurChannel(rb, W, H, 14)],
    masks: { person, skin, eyes: zeros, lips: zeros },
    geometry: { faceH: 320, faceW: 250, cx: 400, eyeY: 390 },
    original: room,
    sample: true,
  };
}

let renderer = null;

// Renders the sample with a policy. Returns { portrait, avatar } canvases.
export async function renderSample(policy, avatarSize = 480) {
  if (!renderer) renderer = new Renderer(makeSamplePrep());
  await renderer.setPolicy(policy);
  const portrait = renderer.render({});
  const avatar = composeAvatar(portrait, renderer.prep, policy, {}, avatarSize);
  return { portrait, avatar };
}
