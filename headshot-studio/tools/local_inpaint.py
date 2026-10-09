"""Self-hosted regeneration for Headshot Studio.

Keeps the person's real head (face, hair, neck) and regenerates everything
else as a studio headshot with an open-source inpainting model. Called by
server.mjs when HEADSHOT_PROVIDER=local.

  python local_inpaint.py JOB_DIR
  JOB_DIR holds photo.png, keep.png (white = keep) and job.json
  ({"prompt", "negative", "n"}); writes out-0.png, out-1.png, ...

Setup: pip install torch diffusers transformers accelerate safetensors pillow
Runs on CPU (about 4 minutes per image) or much faster on a CUDA GPU.
"""
import json, os, random, sys
import torch
from PIL import Image, ImageFilter
from diffusers import StableDiffusionInpaintPipeline, DPMSolverMultistepScheduler

MODEL = os.environ.get('HEADSHOT_LOCAL_MODEL', 'Lykon/dreamshaper-8-inpainting')
W, H = 640, 800


def main(job_dir):
    job = json.load(open(os.path.join(job_dir, 'job.json')))
    device = 'cuda' if torch.cuda.is_available() else 'cpu'
    dtype = torch.float16 if device == 'cuda' else torch.float32
    pipe = StableDiffusionInpaintPipeline.from_pretrained(
        MODEL, variant='fp16', torch_dtype=dtype, safety_checker=None, requires_safety_checker=False).to(device)
    pipe.scheduler = DPMSolverMultistepScheduler.from_config(
        pipe.scheduler.config, algorithm_type='dpmsolver++', solver_order=2,
        final_sigmas_type='sigma_min', use_karras_sigmas=True)
    pipe.set_progress_bar_config(disable=True)

    photo = Image.open(os.path.join(job_dir, 'photo.png')).convert('RGB').resize((W, H), Image.LANCZOS)
    keep = Image.open(os.path.join(job_dir, 'keep.png')).convert('L').resize((W, H), Image.LANCZOS)
    # Repaint everything outside the head, with a slightly widened edge for blending.
    mask = keep.point(lambda v: 255 - min(255, int(v * 1.6)))
    paste = keep.filter(ImageFilter.GaussianBlur(2))

    for i in range(max(1, min(4, int(job.get('n', 1))))):
        img = pipe(prompt=job['prompt'], negative_prompt=job['negative'], image=photo, mask_image=mask,
                   width=W, height=H, num_inference_steps=25, guidance_scale=7.0,
                   generator=torch.Generator(device).manual_seed(random.randrange(1 << 30))).images[0]
        Image.composite(photo, img, paste).save(os.path.join(job_dir, f'out-{i}.png'))
        print(f'done {i}', flush=True)


if __name__ == '__main__':
    main(sys.argv[1])
