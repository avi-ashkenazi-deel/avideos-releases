// Turns the company policy into the instruction for the image model.
// Shared by the browser (admin preview) and the server (the real request),
// so admins see exactly what the model is told. The server builds the prompt
// from the policy itself and never accepts free text from the client.
//
// Rules that never change: keep the person's own clothes and face shape,
// remove what doesn't belong, and light them flatteringly.

export const EXPRESSION = {
  keep: 'Keep their expression',
  smile: 'Relaxed smile',
};

const EXPRESSION_TEXT = {
  keep: 'Keep their natural expression.',
  smile: 'Give them a relaxed, confident, gentle smile that still looks like their own smile.',
};

// Clothing colors the browser may report (measured from the photo). Anything
// else is ignored, so no free text reaches the prompt.
export const CLOTHING_COLORS = ['black', 'charcoal', 'grey', 'white', 'navy', 'blue', 'light blue', 'green', 'olive', 'brown', 'beige', 'red', 'burgundy', 'pink', 'purple', 'yellow', 'orange'];

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
    'Identity comes first: keep their exact face, face shape and width, jawline, cheeks, skin tone, eye color, hairline, hair color and texture, facial hair, glasses if they wear them, and age. Do not slim, reshape, beautify, de-age, or change their ethnicity or gender presentation. Coworkers must recognize them instantly.',
    'Keep the clothes they are wearing: the same garment, color, neckline and fabric. Do not add, swap or restyle clothing. Where something covers their clothes, continue the same garment naturally underneath. You may tidy it: remove lint, smooth small wrinkles, straighten the collar.',
    'Remove everything that is not the person: drinks, cups, food, phones, other people and other people\'s hands, bags, and anything else in front of or around them.',
    `Pose: ${closeup ? 'close-up of the head and top of the shoulders' : 'head and shoulders, cropped at mid-chest'}, face toward the camera, eyes looking into the lens. Keep the whole head and hair inside the frame with a little space above. Do not change their body shape.`,
    EXPRESSION_TEXT[ai.expression] || EXPRESSION_TEXT.keep,
    'Lighting: flattering, soft, even studio light from the front with gentle fill. Lift shadows on the face, soften dark circles and shadows under the eyes, even out blotchy or red patches, and balance the color so there is no warm or green cast. Keep real skin texture: no plastic or airbrushed look.',
    `Background: ${backgroundText(policy)}.`,
    'Style: a realistic photograph with an 85mm portrait-lens look, natural colors, sharp focus on the eyes. Vertical 4:5 framing, subject centered. No text, watermark, border or frame.',
  ].join('\n');
}

// Short keyword prompt for the self-hosted Stable Diffusion inpainting model
// (its text encoder reads only ~75 tokens). That model never touches the
// person: it only fills in what was hidden (behind a drink or a hand) and
// the backdrop. `clothing` is the measured color of their top.
export function buildLocalPrompt(policy, clothing) {
  const t = policy.background?.type;
  const color = CLOTHING_COLORS.includes(clothing) ? clothing : 'dark';
  const backdrop = t === 'blur' || t === 'original' ? 'softly blurred bright modern office background' : 'plain light grey seamless studio backdrop';
  return {
    prompt: `professional headshot photograph, head and shoulders portrait, wearing a plain ${color} top, natural build, ${backdrop}, soft even studio lighting, photorealistic, high detail`,
    negative: 'drink, glass, cocktail, cup, food, fruit, phone, hand, fingers, arm, people, crowd, restaurant, bar, jacket, blazer, tie, collar, necklace, jewelry, text, logo, watermark, frame, border, blurry, lowres, deformed, extra limbs, cartoon, painting, illustration, nsfw',
  };
}
