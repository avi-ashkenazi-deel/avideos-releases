#include <metal_stdlib>
using namespace metal;

// Ping-pong blend pass for After-Effects-style modes: samples the current
// accumulator (dst) and the already-effected item layer (src, rendered to its
// own full-canvas texture), applies the separable blend formula per the W3C
// compositing spec, and writes the new accumulator.
//
// Mode indices match BlendMode.rawValue in Mac/Model/BlendMode.swift.

struct BlendUniforms {
    int   mode;
    float _pad0;
    float _pad1;
    float _pad2;
};

struct BlendVSOut {
    float4 position [[position]];
    float2 uv;
};

vertex BlendVSOut blend_vertex(uint vid [[vertex_id]]) {
    // Full-screen triangle.
    const float2 pos[3] = { float2(-1, -1), float2(3, -1), float2(-1, 3) };
    BlendVSOut out;
    out.position = float4(pos[vid], 0, 1);
    out.uv = float2((pos[vid].x + 1.0) * 0.5, 1.0 - (pos[vid].y + 1.0) * 0.5);
    return out;
}

static float3 blendChannel(int mode, float3 cb, float3 cs) {
    switch (mode) {
        case 1:  return cb * cs;                                        // multiply
        case 2:  return cb + cs - cb * cs;                              // screen
        case 3: {                                                       // overlay = hardLight(swapped)
            float3 lo = 2.0 * cb * cs;
            float3 hi = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
            return select(hi, lo, cb <= 0.5);
        }
        case 4:  return min(cb, cs);                                    // darken
        case 5:  return max(cb, cs);                                    // lighten
        case 6: {                                                       // colorDodge
            float3 r = select(min(float3(1.0), cb / max(1.0 - cs, 1e-5)),
                              float3(1.0), cs >= 1.0);
            return select(r, float3(0.0), cb <= 0.0);
        }
        case 7: {                                                       // colorBurn
            float3 r = select(1.0 - min(float3(1.0), (1.0 - cb) / max(cs, 1e-5)),
                              float3(0.0), cs <= 0.0);
            return select(r, float3(1.0), cb >= 1.0);
        }
        case 8: {                                                       // hardLight
            float3 lo = 2.0 * cb * cs;
            float3 hi = 1.0 - 2.0 * (1.0 - cb) * (1.0 - cs);
            return select(hi, lo, cs <= 0.5);
        }
        case 9: {                                                       // softLight (W3C)
            float3 d = select(sqrt(cb),
                              ((16.0 * cb - 12.0) * cb + 4.0) * cb,
                              cb <= 0.25);
            float3 lo = cb - (1.0 - 2.0 * cs) * cb * (1.0 - cb);
            float3 hi = cb + (2.0 * cs - 1.0) * (d - cb);
            return select(hi, lo, cs <= 0.5);
        }
        case 10: return abs(cb - cs);                                   // difference
        case 11: return cb + cs - 2.0 * cb * cs;                        // exclusion
        default: return cs;                                             // normal
    }
}

fragment float4 blend_fragment(BlendVSOut in [[stage_in]],
                               constant BlendUniforms &u [[buffer(0)]],
                               texture2d<float> dstTex [[texture(0)]],
                               texture2d<float> srcTex [[texture(1)]],
                               sampler s [[sampler(0)]]) {
    float4 dst = dstTex.sample(s, in.uv);   // premultiplied accumulator
    float4 src = srcTex.sample(s, in.uv);   // premultiplied item layer

    // Un-premultiply for the blend math.
    float3 cb = dst.a > 1e-5 ? dst.rgb / dst.a : float3(0.0);
    float3 cs = src.a > 1e-5 ? src.rgb / src.a : float3(0.0);

    float3 blended = blendChannel(u.mode, cb, cs);

    // Composite with source-over alpha, using the blended color where both
    // layers exist (per spec: cs' = (1-ab)*cs + ab*B(cb,cs)).
    float3 csPrime = (1.0 - dst.a) * cs + dst.a * blended;
    float  ao = src.a + dst.a * (1.0 - src.a);
    float3 co = csPrime * src.a + cb * dst.a * (1.0 - src.a);

    return float4(co, ao);   // premultiplied out
}
