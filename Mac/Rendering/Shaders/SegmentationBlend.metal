#include <metal_stdlib>
using namespace metal;

// Virtual-background blend: mix(background, camera, personMask), with mask
// feathering handled upstream (Gaussian on the mask) and an edge-softness
// exponent here. The mask arrives from Vision as OneComponent8, possibly a
// frame late — invisible in practice.

struct SegmentationUniforms {
    float edgeSoftness;   // 0..1 -> gamma shaping of the mask edge
    float hasBackground;  // 0 => use bgColor, 1 => sample bgTex
    float2 _pad;
    float4 bgColor;       // premultiplied-compatible straight color
};

kernel void segmentationBlend(texture2d<float, access::read> cameraTex [[texture(0)]],
                              texture2d<float, access::sample> maskTex [[texture(1)]],
                              texture2d<float, access::sample> bgTex [[texture(2)]],
                              texture2d<float, access::write> outTex [[texture(3)]],
                              constant SegmentationUniforms &u [[buffer(0)]],
                              uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) return;

    constexpr sampler s(address::clamp_to_edge, filter::linear);
    float2 uv = float2((float(gid.x) + 0.5) / float(outTex.get_width()),
                       (float(gid.y) + 0.5) / float(outTex.get_height()));

    float4 cam = cameraTex.read(gid);
    float3 camRGB = cam.a > 1e-5 ? cam.rgb / cam.a : cam.rgb;

    // Mask: 1 = person. Soften the edge by pushing mid-values with a gamma
    // curve derived from edgeSoftness (0 => hard step-ish, 1 => very soft).
    float m = maskTex.sample(s, uv).r;
    float gamma = mix(2.5, 0.75, saturate(u.edgeSoftness));
    m = pow(saturate(m), gamma);

    float3 bgRGB;
    if (u.hasBackground > 0.5) {
        float4 bg = bgTex.sample(s, uv);
        bgRGB = bg.a > 1e-5 ? bg.rgb / bg.a : bg.rgb;
    } else {
        bgRGB = u.bgColor.rgb;
    }

    float3 outRGB = mix(bgRGB, camRGB, m);
    // Output stays opaque (the camera layer's own alpha applies later).
    outTex.write(float4(outRGB * cam.a, cam.a), gid);
}

// Separable Gaussian for feathering the Vision mask before blending.
kernel void maskBlurH(texture2d<float, access::sample> inTex [[texture(0)]],
                      texture2d<float, access::write> outTex [[texture(1)]],
                      uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) return;
    constexpr sampler s(address::clamp_to_edge, filter::linear);
    const float w[5] = {0.227027, 0.194594, 0.121621, 0.054054, 0.016216};
    float2 texel = float2(1.0 / float(outTex.get_width()), 0.0);
    float2 uv = float2((float(gid.x) + 0.5) / float(outTex.get_width()),
                       (float(gid.y) + 0.5) / float(outTex.get_height()));
    float acc = inTex.sample(s, uv).r * w[0];
    for (int i = 1; i < 5; i++) {
        acc += inTex.sample(s, uv + texel * float(i)).r * w[i];
        acc += inTex.sample(s, uv - texel * float(i)).r * w[i];
    }
    outTex.write(float4(acc, 0, 0, 1), gid);
}

kernel void maskBlurV(texture2d<float, access::sample> inTex [[texture(0)]],
                      texture2d<float, access::write> outTex [[texture(1)]],
                      uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) return;
    constexpr sampler s(address::clamp_to_edge, filter::linear);
    const float w[5] = {0.227027, 0.194594, 0.121621, 0.054054, 0.016216};
    float2 texel = float2(0.0, 1.0 / float(outTex.get_height()));
    float2 uv = float2((float(gid.x) + 0.5) / float(outTex.get_width()),
                       (float(gid.y) + 0.5) / float(outTex.get_height()));
    float acc = inTex.sample(s, uv).r * w[0];
    for (int i = 1; i < 5; i++) {
        acc += inTex.sample(s, uv + texel * float(i)).r * w[i];
        acc += inTex.sample(s, uv - texel * float(i)).r * w[i];
    }
    outTex.write(float4(acc, 0, 0, 1), gid);
}
