#include <metal_stdlib>
using namespace metal;

// Parametric chroma key: distance from the key color in the CbCr plane maps
// to alpha through smoothstep(similarity, similarity + smoothness), plus
// luma-preserving spill suppression. Tuned live from the Effects panel.

struct ChromaKeyUniforms {
    float3 keyColor;         // sRGB 0..1
    float  similarity;       // 0..1 CbCr distance fully keyed below this
    float  smoothness;       // softness band above similarity
    float  spillSuppression; // 0..1
    float2 _pad;
};

static float2 rgbToCbCr(float3 rgb) {
    // BT.709
    float cb = -0.114572 * rgb.r - 0.385428 * rgb.g + 0.5 * rgb.b;
    float cr =  0.5 * rgb.r - 0.454153 * rgb.g - 0.045847 * rgb.b;
    return float2(cb, cr);
}

static float luma709(float3 rgb) {
    return dot(rgb, float3(0.2126, 0.7152, 0.0722));
}

kernel void chromaKey(texture2d<float, access::read> inTex [[texture(0)]],
                      texture2d<float, access::write> outTex [[texture(1)]],
                      constant ChromaKeyUniforms &u [[buffer(0)]],
                      uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) return;

    float4 color = inTex.read(gid);
    float3 rgb = color.a > 1e-5 ? color.rgb / color.a : color.rgb;

    float2 pixCbCr = rgbToCbCr(rgb);
    float2 keyCbCr = rgbToCbCr(u.keyColor);
    float dist = distance(pixCbCr, keyCbCr) * 2.0;    // normalize to ~0..1

    // 0 at/below similarity (keyed out) -> 1 above similarity+smoothness.
    float alpha = smoothstep(u.similarity, u.similarity + max(u.smoothness, 1e-4), dist);

    // Spill suppression: desaturate toward luma proportionally to how close
    // the pixel is to the key color (only in the partially-kept band).
    float spill = (1.0 - alpha) * u.spillSuppression;
    float l = luma709(rgb);
    rgb = mix(rgb, float3(l), saturate(spill));

    float outA = color.a * alpha;
    outTex.write(float4(rgb * outA, outA), gid);
}
