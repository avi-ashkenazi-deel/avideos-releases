// The company photo policy: what the admin decides, what every photo follows.
// Prototype storage is localStorage; in Deel this would be an org-level setting.

import { ATTIRE } from './prompt.js';

const KEY = 'hs.policy.v1';
const SUBMISSIONS_KEY = 'hs.submissions.v1';

export const BACKGROUND_PRESETS = [
  { id: 'studio', label: 'Studio grey', type: 'studio', colors: ['#e9ebee', '#b9bec6'] },
  { id: 'deel-blue', label: 'Deel blue', type: 'color', colors: ['#2c71f0'] },
  { id: 'ink', label: 'Ink', type: 'color', colors: ['#011423'] },
  { id: 'warm', label: 'Warm white', type: 'color', colors: ['#f4efe8'] },
  { id: 'sky', label: 'Sky gradient', type: 'gradient', colors: ['#cadbfb', '#2c71f0'] },
  { id: 'blur', label: 'Blur my room', type: 'blur', colors: [] },
  { id: 'original', label: 'Keep my room', type: 'original', colors: [] },
];

export const TREATMENTS = {
  natural: 'Natural color',
  bw: 'Black & white',
  warm: 'Warm',
  cool: 'Cool',
  duotone: 'Brand duotone',
};

export const RETOUCH_LIMITS = {
  light: { label: 'Light', max: 0.4, help: 'Small fixes only. People still look exactly like themselves.' },
  medium: { label: 'Medium', max: 0.7, help: 'Visible polish. Good for most teams.' },
  full: { label: 'Full', max: 1, help: 'Every slider at full range.' },
};

export const STRICTNESS = {
  // minFace / maxFace: face height as a share of the frame height.
  relaxed: { label: 'Relaxed', minFace: 0.2, maxFace: 0.5, center: 0.16, roll: 10, yaw: 0.17, minLight: 70 },
  standard: { label: 'Standard', minFace: 0.25, maxFace: 0.44, center: 0.11, roll: 7, yaw: 0.12, minLight: 85 },
  strict: { label: 'Strict', minFace: 0.28, maxFace: 0.4, center: 0.08, roll: 5, yaw: 0.09, minLight: 100 },
};

export const EDIT_GROUPS = {
  light: 'Light & color',
  skin: 'Skin',
  eyes: 'Eyes',
  lips: 'Lips',
  framing: 'Framing',
};

export const DEFAULT_POLICY = {
  name: 'Team profile photos',
  background: { preset: 'studio', type: 'studio', colors: ['#e9ebee', '#b9bec6'], image: null },
  treatment: 'natural',
  framing: 'headshoulders',
  shape: 'circle',
  brandColor: '#2c71f0',
  ring: { enabled: false },
  retouchLimit: 'medium',
  edits: { light: true, skin: true, eyes: true, lips: true, framing: true },
  capture: { autoCapture: true, strictness: 'standard', eyesOpen: true },
  // AI regeneration: rebuild the photo as a studio headshot with an image
  // model, then apply the style above. 'off' keeps the real photo.
  ai: { mode: 'regenerate', attire: 'casual', expression: 'keep', variations: 2 },
  requireApproval: true,
};

function clone(v) {
  return JSON.parse(JSON.stringify(v));
}

export function loadPolicy() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return clone(DEFAULT_POLICY);
    const saved = JSON.parse(raw);
    return {
      ...clone(DEFAULT_POLICY),
      ...saved,
      background: { ...DEFAULT_POLICY.background, ...saved.background },
      ring: { ...DEFAULT_POLICY.ring, ...saved.ring },
      edits: { ...DEFAULT_POLICY.edits, ...saved.edits },
      capture: { ...DEFAULT_POLICY.capture, ...saved.capture },
      ai: { ...DEFAULT_POLICY.ai, ...saved.ai },
    };
  } catch {
    return clone(DEFAULT_POLICY);
  }
}

export function savePolicy(policy) {
  try {
    localStorage.setItem(KEY, JSON.stringify(policy));
    return true;
  } catch {
    // Usually a background image that is too large for localStorage.
    return false;
  }
}

export function resetPolicy() {
  try { localStorage.removeItem(KEY); } catch { /* ignore */ }
  return clone(DEFAULT_POLICY);
}

export function backgroundLabel(bg) {
  if (bg.type === 'image') return 'Company image';
  const preset = BACKGROUND_PRESETS.find((p) => p.id === bg.preset);
  if (preset && preset.type === bg.type) return preset.label;
  return bg.type === 'gradient' ? 'Custom gradient' : 'Custom color';
}

// The compact rule summary shown as small icon chips to admins and to the
// person being photographed.
export function summarize(policy) {
  const bg = policy.background;
  const swatch = bg.type === 'color' || bg.type === 'studio' || bg.type === 'gradient' ? bg.colors : null;
  const chips = [
    ...(policy.ai?.mode === 'regenerate' ? [{ icon: 'sparkle', label: 'AI studio photo · ' + ATTIRE[policy.ai.attire] }] : []),
    { icon: 'background', label: backgroundLabel(bg), swatch, image: bg.type === 'image' ? bg.image : null },
    { icon: policy.treatment === 'bw' ? 'contrast' : 'palette', label: TREATMENTS[policy.treatment] },
    { icon: 'shape-' + policy.shape, label: { circle: 'Circle avatar', rounded: 'Rounded avatar', square: 'Square avatar' }[policy.shape] },
    { icon: 'frame', label: policy.framing === 'closeup' ? 'Close-up' : 'Head & shoulders' },
    { icon: 'face', label: RETOUCH_LIMITS[policy.retouchLimit].label + ' retouch' },
  ];
  if (policy.ring.enabled) chips.push({ icon: 'ring', label: 'Brand ring', swatch: [policy.brandColor] });
  if (policy.capture.autoCapture) chips.push({ icon: 'timer', label: 'Auto capture' });
  return chips;
}

export function loadSubmissions() {
  try {
    return JSON.parse(localStorage.getItem(SUBMISSIONS_KEY) || '[]');
  } catch {
    return [];
  }
}

export function saveSubmissions(list) {
  try {
    localStorage.setItem(SUBMISSIONS_KEY, JSON.stringify(list));
    return true;
  } catch {
    return false;
  }
}
