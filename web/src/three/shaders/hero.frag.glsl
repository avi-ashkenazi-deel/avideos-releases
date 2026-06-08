precision highp float;

varying vec2 vUv;

uniform float uTime;
uniform vec2 uResolution;
uniform vec2 uMouse;

// --- Simplex 2D noise (Ashima / Stefan Gustavson) ---
vec3 mod289(vec3 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec2 mod289(vec2 x) { return x - floor(x * (1.0 / 289.0)) * 289.0; }
vec3 permute(vec3 x) { return mod289(((x * 34.0) + 1.0) * x); }

float snoise(vec2 v) {
  const vec4 C = vec4(0.211324865405187, 0.366025403784439,
                      -0.577350269189626, 0.024390243902439);
  vec2 i = floor(v + dot(v, C.yy));
  vec2 x0 = v - i + dot(i, C.xx);
  vec2 i1 = (x0.x > x0.y) ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
  vec4 x12 = x0.xyxy + C.xxzz;
  x12.xy -= i1;
  i = mod289(i);
  vec3 p = permute(permute(i.y + vec3(0.0, i1.y, 1.0))
                 + i.x + vec3(0.0, i1.x, 1.0));
  vec3 m = max(0.5 - vec3(dot(x0, x0), dot(x12.xy, x12.xy),
                          dot(x12.zw, x12.zw)), 0.0);
  m = m * m;
  m = m * m;
  vec3 x = 2.0 * fract(p * C.www) - 1.0;
  vec3 h = abs(x) - 0.5;
  vec3 ox = floor(x + 0.5);
  vec3 a0 = x - ox;
  m *= 1.79284291400159 - 0.85373472095314 * (a0 * a0 + h * h);
  vec3 g;
  g.x = a0.x * x0.x + h.x * x0.y;
  g.yz = a0.yz * x12.xz + h.yz * x12.yw;
  return 130.0 * dot(m, g);
}

// Fractal Brownian motion
float fbm(vec2 p) {
  float total = 0.0;
  float amp = 0.5;
  for (int i = 0; i < 5; i++) {
    total += snoise(p) * amp;
    p *= 2.0;
    amp *= 0.5;
  }
  return total;
}

// Cheap hash for film grain
float hash(vec2 p) {
  return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
}

void main() {
  // Aspect-correct coordinates
  vec2 uv = vUv;
  float aspect = uResolution.x / uResolution.y;
  vec2 p = uv;
  p.x *= aspect;

  float t = uTime * 0.04;

  // Mouse warps the flow subtly
  vec2 m = (uMouse - 0.5) * vec2(aspect, 1.0);
  p += m * 0.15;

  // Domain warping: noise of noise for soft, morphing fields
  vec2 q = vec2(fbm(p + vec2(0.0, t)), fbm(p + vec2(5.2, 1.3 - t)));
  vec2 r = vec2(fbm(p + 1.5 * q + vec2(1.7, 9.2) + 0.15 * t),
                fbm(p + 1.5 * q + vec2(8.3, 2.8) - 0.12 * t));
  float v = fbm(p + 1.8 * r);

  // Map to greyscale, lift toward light for a paper-like base
  float luma = 0.5 + 0.5 * v;
  luma = pow(luma, 1.4);          // bias toward white
  luma = mix(0.82, 1.0, luma);    // keep it light, airy

  // Soft posterize for a printed feel
  luma = floor(luma * 14.0) / 14.0;

  // Vignette
  vec2 vc = uv - 0.5;
  float vig = smoothstep(0.95, 0.35, length(vc));
  luma *= mix(0.92, 1.0, vig);

  // Fine animated film grain
  float g = hash(uv * uResolution.xy + fract(uTime) * 100.0);
  luma += (g - 0.5) * 0.04;

  luma = clamp(luma, 0.0, 1.0);
  gl_FragColor = vec4(vec3(luma), 1.0);
}
