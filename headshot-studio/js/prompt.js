// Turns the company policy into the instruction for the image model.
// Shared by the browser (admin preview) and the server (the real request),
// so admins see exactly what the model is told. The server builds the prompt
// from the policy itself and never accepts free text from the client.

export const ATTIRE = {
  keep: 'Their own top, cleaned up',
  casual: 'Business casual',
  formal: 'Business formal',
};

export const EXPRESSION = {
  keep: 'Keep their expression',
  smile: 'Relaxed smile',
};

const ATTIRE_TEXT = {
  keep: 'Keep the style and color of their own top, but make it look clean, neat, wrinkle-free and well fitted.',
  casual: 'Dress them in smart business-casual clothing: a plain, well-fitted crew-neck knit or an open-collar shirt in a muted neutral color. No logos or patterns.',
  formal: 'Dress them in business formal clothing: a well-tailored dark navy or charcoal blazer over a plain light shirt. No tie unless they already wear one. No logos.',
};

const EXPRESSION_TEXT = {
  keep: 'Keep their natural expression.',
  smile: 'Give them a relaxed, confident, gentle smile that still looks like their own smile.',
};

function backgroundText(policy) {
  const t = policy.background?.type;
  // For background types we composite ourselves, ask for a plain backdrop so
  // the cut-out is clean and the brand color stays exact.
  if (t === 'blur' || t === 'original') return 'a softly out-of-focus, bright, modern office interior with neutral tones';
  return 'a plain, evenly lit, light grey seamless studio backdrop';
}

export function buildPrompt(policy) {
  const ai = policy.ai || {};
  const closeup = policy.framing === 'closeup';
  return [
    'Turn this photo into a professional corporate headshot of the same person.',
    'Identity comes first: keep their exact face, facial structure, skin tone, eye color, hairline, hair color and texture, facial hair, glasses if they wear them, and age. Do not beautify, slim, de-age, or change their ethnicity or gender presentation. Coworkers must recognize them instantly.',
    'Remove everything that is not the person: drinks, cups, food, phones, other people and other people\'s hands, bags, and anything else in front of or around them.',
    ATTIRE_TEXT[ai.attire] || ATTIRE_TEXT.casual,
    `Pose: ${closeup ? 'close-up of the head and top of the shoulders' : 'head and shoulders, cropped at mid-chest'}, shoulders level and slightly angled, upright posture, face toward the camera, eyes looking straight into the lens. Keep the whole head and hair inside the frame with a little space above.`,
    EXPRESSION_TEXT[ai.expression] || EXPRESSION_TEXT.keep,
    'Lighting: soft, even studio light from the front with gentle fill. No harsh shadows, no color cast, no mixed or colored light.',
    `Background: ${backgroundText(policy)}.`,
    'Style: a realistic photograph with an 85mm portrait-lens look, natural colors, natural skin texture, sharp focus on the eyes. Vertical 4:5 framing, subject centered. No text, watermark, border or frame.',
  ].join('\n');
}
