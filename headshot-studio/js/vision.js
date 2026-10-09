// On-device vision models (Google MediaPipe). Everything runs in the browser:
// the photo never leaves the device during capture and retouching.

const VERSION = '0.10.14';
const CDN = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${VERSION}`;
const FACE_MODEL = 'https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task';
const SEGMENT_MODEL = 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_multiclass_256x256/float32/latest/selfie_multiclass_256x256.tflite';

// selfie_multiclass categories
export const SEG = { background: 0, hair: 1, bodySkin: 2, faceSkin: 3, clothes: 4, other: 5 };

let visionLib = null;
let fileset = null;
let liveLandmarker = null;
let stillLandmarker = null;
let segmenter = null;

async function lib() {
  if (!visionLib) {
    visionLib = await import(`${CDN}/vision_bundle.mjs`);
    fileset = await visionLib.FilesetResolver.forVisionTasks(`${CDN}/wasm`);
  }
  return visionLib;
}

async function withDelegate(create) {
  try {
    return await create('GPU');
  } catch (err) {
    console.warn('GPU delegate unavailable, using CPU', err);
    return create('CPU');
  }
}

function landmarkerOptions(delegate, runningMode) {
  return {
    baseOptions: { modelAssetPath: FACE_MODEL, delegate },
    runningMode,
    numFaces: 2,
    outputFaceBlendshapes: true,
    outputFacialTransformationMatrixes: false,
  };
}

export async function getLiveLandmarker() {
  if (liveLandmarker) return liveLandmarker;
  const { FaceLandmarker } = await lib();
  liveLandmarker = await withDelegate((d) => FaceLandmarker.createFromOptions(fileset, landmarkerOptions(d, 'VIDEO')));
  return liveLandmarker;
}

export async function getStillLandmarker() {
  if (stillLandmarker) return stillLandmarker;
  const { FaceLandmarker } = await lib();
  stillLandmarker = await withDelegate((d) => FaceLandmarker.createFromOptions(fileset, landmarkerOptions(d, 'IMAGE')));
  return stillLandmarker;
}

export async function getSegmenter() {
  if (segmenter) return segmenter;
  const { ImageSegmenter } = await lib();
  segmenter = await withDelegate((d) =>
    ImageSegmenter.createFromOptions(fileset, {
      baseOptions: { modelAssetPath: SEGMENT_MODEL, delegate: d },
      runningMode: 'IMAGE',
      outputConfidenceMasks: true,
      outputCategoryMask: false,
    }),
  );
  return segmenter;
}

// Warm everything up in the background so capture and processing feel instant.
export function preload() {
  return Promise.allSettled([getLiveLandmarker(), getStillLandmarker(), getSegmenter()]);
}

export async function detectStill(source) {
  const lm = await getStillLandmarker();
  return lm.detect(source);
}

// Returns { width, height, masks: Float32Array[] } copied out of MediaPipe memory.
export async function segment(source) {
  const seg = await getSegmenter();
  const result = seg.segment(source);
  try {
    const masks = (result.confidenceMasks || []).map((m) => m.getAsFloat32Array().slice());
    const first = result.confidenceMasks?.[0];
    return { width: first?.width ?? 0, height: first?.height ?? 0, masks };
  } finally {
    result.close?.();
  }
}
