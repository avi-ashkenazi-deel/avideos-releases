#include <metal_stdlib>
using namespace metal;

// Shared with Compositor.swift (ItemUniforms) — keep layouts in sync.
struct ItemUniforms {
    float3x3 transform;     // unit-quad -> NDC (already includes rotation/scale/translate)
    float    opacity;
    float    cornerRadius;  // unit terms relative to item's shorter side; <0 => ellipse mask
    float2   itemSizePx;    // item size in canvas pixels (for radius + stroke math)
    float    strokeWidthPx; // >0 when this pass draws a stroke ring instead of content
    float    time;          // seconds, for animated fills
    float4   fillColorA;    // solid fill / shader fill color A
    float4   fillColorB;    // shader fill color B
    float    fillParam0;    // shader fill speed
    float    fillParam1;    // shader fill scale
    int      fillKind;      // 0 solid, 1..4 = ShaderFill.Kind order, 100 = textured
};

struct VSOut {
    float4 position [[position]];
    float2 uv;                     // 0..1 across the item quad, y-down
};

vertex VSOut composite_vertex(uint vid [[vertex_id]],
                              constant ItemUniforms &u [[buffer(0)]]) {
    // Unit quad, y-down to match canvas coords; two triangles as a strip.
    const float2 corners[4] = { float2(0, 0), float2(1, 0), float2(0, 1), float2(1, 1) };
    float2 corner = corners[vid];
    float3 pos = u.transform * float3(corner, 1.0);

    VSOut out;
    out.position = float4(pos.xy, 0.0, 1.0);
    out.uv = corner;
    return out;
}

// Signed distance to a rounded-rectangle edge in pixel space; positive inside.
static float roundedRectMask(float2 uv, float2 sizePx, float radiusPx) {
    float2 p = (uv - 0.5) * sizePx;               // centered pixel coords
    float2 halfSize = sizePx * 0.5;               // ("half" is an MSL type)
    float r = clamp(radiusPx, 0.0, min(halfSize.x, halfSize.y));
    float2 q = abs(p) - (halfSize - r);
    float dist = length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r;
    // 1px anti-aliased edge.
    return saturate(0.5 - dist);
}

static float ellipseMask(float2 uv, float2 sizePx) {
    float2 p = (uv - 0.5) * 2.0;                  // -1..1
    float d = length(p);
    // AA width in uv terms scaled to pixels.
    float aa = 2.0 / min(sizePx.x, sizePx.y);
    return saturate((1.0 - d) / aa + 0.5);
}

static float shapeMask(float2 uv, constant ItemUniforms &u) {
    if (u.cornerRadius < 0.0) {
        return ellipseMask(uv, u.itemSizePx);
    }
    float radiusPx = u.cornerRadius * min(u.itemSizePx.x, u.itemSizePx.y);
    return roundedRectMask(uv, u.itemSizePx, radiusPx);
}

// Ring mask for strokes: inside the outer rounded rect, outside the inner one.
static float strokeMask(float2 uv, constant ItemUniforms &u) {
    float outer = shapeMask(uv, u);
    // Inner shape: shrink by stroke width on each side.
    float2 innerSize = u.itemSizePx - 2.0 * u.strokeWidthPx;
    if (innerSize.x <= 0.0 || innerSize.y <= 0.0) return outer;
    // Re-map uv into the inner rect's own 0..1 space.
    float2 innerUV = ((uv - 0.5) * u.itemSizePx) / innerSize + 0.5;
    float inner;
    if (u.cornerRadius < 0.0) {
        inner = ellipseMask(innerUV, innerSize);
    } else {
        float radiusPx = max(0.0, u.cornerRadius * min(u.itemSizePx.x, u.itemSizePx.y) - u.strokeWidthPx);
        bool inRange = all(innerUV >= float2(0.0)) && all(innerUV <= float2(1.0));
        inner = inRange ? roundedRectMask(innerUV, innerSize, radiusPx) : 0.0;
    }
    return saturate(outer - inner);
}

// ---- procedural fills (ShaderFill.Kind order: 1 gradientSweep, 2 plasma, 3 waves, 4 sparkle)

static float hash21(float2 p) {
    p = fract(p * float2(123.34, 456.21));
    p += dot(p, p + 45.32);
    return fract(p.x * p.y);
}

static float4 proceduralFill(float2 uv, constant ItemUniforms &u) {
    float t = u.time * u.fillParam0;
    float scale = max(u.fillParam1, 0.05);
    switch (u.fillKind) {
        case 1: { // linearGradientSweep: gradient whose axis rotates over time
            float angle = t * 0.6;
            float2 dir = float2(cos(angle), sin(angle));
            float g = dot(uv - 0.5, dir) / (0.7071 * scale) + 0.5;
            return mix(u.fillColorA, u.fillColorB, saturate(g));
        }
        case 2: { // plasma
            float2 p = uv * 6.0 * scale;
            float v = sin(p.x + t) + sin(p.y + t * 1.3)
                    + sin((p.x + p.y) * 0.7 + t * 0.7)
                    + sin(length(p - 3.0 * scale) + t * 1.7);
            return mix(u.fillColorA, u.fillColorB, saturate(v * 0.25 + 0.5));
        }
        case 3: { // waves: drifting horizontal sine bands
            float bands = 8.0 * scale;
            float v = sin((uv.y + sin(uv.x * 3.0 + t * 0.8) * 0.06) * bands * 3.14159 + t * 2.0);
            return mix(u.fillColorA, u.fillColorB, saturate(v * 0.5 + 0.5));
        }
        case 4: { // sparkle: twinkling points over colorA
            float2 cell = floor(uv * 40.0 * scale);
            float rnd = hash21(cell);
            float tw = pow(saturate(sin(t * 3.0 + rnd * 6.28318) * 0.5 + 0.5), 12.0);
            float star = step(0.92, rnd) * tw;
            return mix(u.fillColorA, u.fillColorB, saturate(star));
        }
        default:
            return u.fillColorA;
    }
}

// Content pass: one fragment for every item kind. `contentTex` carries the
// (already effect-chained) source frame, the video paint, or nothing;
// `glyphTex` carries the text raster's alpha (a 1×1 white texture when the
// item isn't text). Paint selection by fillKind:
//   0        solid fillColorA
//   1..4     procedural fills (ShaderFill.Kind order)
//   100      contentTex IS the content (camera/screen/movie/web/image/guest)
//   200      contentTex is video *paint* (masked by glyph/shape like a fill)
// Output is premultiplied alpha; BlendMode.normal composites with
// fixed-function blending, other modes go through the ping-pong pass.
fragment float4 composite_fragment(VSOut in [[stage_in]],
                                   constant ItemUniforms &u [[buffer(0)]],
                                   texture2d<float> contentTex [[texture(0)]],
                                   texture2d<float> glyphTex [[texture(1)]],
                                   sampler s [[sampler(0)]]) {
    float mask = (u.strokeWidthPx > 0.0) ? strokeMask(in.uv, u) : shapeMask(in.uv, u);
    if (mask <= 0.0) discard_fragment();

    float4 color;
    switch (u.fillKind) {
        case 100:
        case 200:
            color = contentTex.sample(s, in.uv);
            color.rgb *= u.fillColorA.rgb;   // white unless deliberately tinted
            color.a *= u.fillColorA.a;
            break;
        case 0:
            color = u.fillColorA;
            break;
        default:
            color = proceduralFill(in.uv, u);
            break;
    }

    float glyphAlpha = glyphTex.sample(s, in.uv).a;
    float alpha = color.a * glyphAlpha * u.opacity * mask;
    return float4(color.rgb * alpha, alpha);   // premultiply
}

// ---- preview blit -----------------------------------------------------------

// Aspect-fit display of the program texture in the preview MTKView.
// Reuses blend_vertex's fullscreen triangle from Blend.metal.
struct PreviewUniforms {
    float2 scale;    // uv scale for letterboxing (>=1 on the padded axis)
    float2 _pad;
};

struct PreviewVSOut {
    float4 position [[position]];
    float2 uv;
};

vertex PreviewVSOut preview_vertex(uint vid [[vertex_id]]) {
    const float2 pos[3] = { float2(-1, -1), float2(3, -1), float2(-1, 3) };
    PreviewVSOut out;
    out.position = float4(pos[vid], 0, 1);
    out.uv = float2((pos[vid].x + 1.0) * 0.5, 1.0 - (pos[vid].y + 1.0) * 0.5);
    return out;
}

fragment float4 preview_fragment(PreviewVSOut in [[stage_in]],
                                 constant PreviewUniforms &u [[buffer(0)]],
                                 texture2d<float> programTex [[texture(0)]],
                                 sampler s [[sampler(0)]]) {
    float2 uv = (in.uv - 0.5) * u.scale + 0.5;
    if (any(uv < float2(0.0)) || any(uv > float2(1.0))) {
        return float4(0.06, 0.06, 0.07, 1.0);   // letterbox bars
    }
    float4 c = programTex.sample(s, uv);
    return float4(c.rgb, 1.0);
}
