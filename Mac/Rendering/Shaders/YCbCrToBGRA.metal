#include <metal_stdlib>
using namespace metal;

// NV12 (biplanar 4:2:0, video-range or full-range) -> BGRA conversion for
// LiveKit guest frames, normalizing every source to the compositor's uniform
// BGRA domain at ingest.

struct YCbCrUniforms {
    float fullRange;   // 1 = full-range (JPEG), 0 = video-range (BT.709 video)
    float3 _pad;
};

kernel void nv12ToBGRA(texture2d<float, access::sample> yTex [[texture(0)]],
                       texture2d<float, access::sample> cbcrTex [[texture(1)]],
                       texture2d<float, access::write> outTex [[texture(2)]],
                       constant YCbCrUniforms &u [[buffer(0)]],
                       uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) return;
    constexpr sampler s(address::clamp_to_edge, filter::linear);
    float2 uv = float2((float(gid.x) + 0.5) / float(outTex.get_width()),
                       (float(gid.y) + 0.5) / float(outTex.get_height()));

    float y = yTex.sample(s, uv).r;
    float2 cbcr = cbcrTex.sample(s, uv).rg - 0.5;

    if (u.fullRange < 0.5) {
        // Expand video range: Y 16..235, C 16..240 (in 0..1 units).
        y = (y - 16.0 / 255.0) * (255.0 / 219.0);
        cbcr = cbcr * (255.0 / 224.0);
    }

    // BT.709
    float3 rgb;
    rgb.r = y + 1.5748 * cbcr.y;
    rgb.g = y - 0.1873 * cbcr.x - 0.4681 * cbcr.y;
    rgb.b = y + 1.8556 * cbcr.x;
    rgb = saturate(rgb);

    outTex.write(float4(rgb, 1.0), gid);
}

// I420 (triplanar) variant: separate Cb and Cr planes.
kernel void i420ToBGRA(texture2d<float, access::sample> yTex [[texture(0)]],
                       texture2d<float, access::sample> cbTex [[texture(1)]],
                       texture2d<float, access::sample> crTex [[texture(2)]],
                       texture2d<float, access::write> outTex [[texture(3)]],
                       constant YCbCrUniforms &u [[buffer(0)]],
                       uint2 gid [[thread_position_in_grid]]) {
    if (gid.x >= outTex.get_width() || gid.y >= outTex.get_height()) return;
    constexpr sampler s(address::clamp_to_edge, filter::linear);
    float2 uv = float2((float(gid.x) + 0.5) / float(outTex.get_width()),
                       (float(gid.y) + 0.5) / float(outTex.get_height()));

    float y = yTex.sample(s, uv).r;
    float cb = cbTex.sample(s, uv).r - 0.5;
    float cr = crTex.sample(s, uv).r - 0.5;

    if (u.fullRange < 0.5) {
        y = (y - 16.0 / 255.0) * (255.0 / 219.0);
        cb = cb * (255.0 / 224.0);
        cr = cr * (255.0 / 224.0);
    }

    float3 rgb;
    rgb.r = y + 1.5748 * cr;
    rgb.g = y - 0.1873 * cb - 0.4681 * cr;
    rgb.b = y + 1.8556 * cb;
    rgb = saturate(rgb);

    outTex.write(float4(rgb, 1.0), gid);
}
