#!/usr/bin/env python3
"""Generate the Deel Quick extension icons (no Pillow needed).

Draws a rounded dark-navy square with a white lightning-bolt glyph, written
as minimal PNGs. Rerun after tweaking: python3 tools/make-icons.py
"""
import os
import struct
import zlib

INK = (21, 53, 122)     # dark navy
BOLT = (255, 255, 255)  # white


def png_chunk(tag, data):
    chunk = tag + data
    return struct.pack(">I", len(data)) + chunk + struct.pack(">I", zlib.crc32(chunk) & 0xFFFFFFFF)


def write_png(path, size, pixels):
    raw = b"".join(b"\x00" + b"".join(struct.pack("BBBB", *px) for px in row) for row in pixels)
    png = (
        b"\x89PNG\r\n\x1a\n"
        + png_chunk(b"IHDR", struct.pack(">IIBBBBB", size, size, 8, 6, 0, 0, 0))
        + png_chunk(b"IDAT", zlib.compress(raw, 9))
        + png_chunk(b"IEND", b"")
    )
    with open(path, "wb") as f:
        f.write(png)


def in_rounded_square(x, y, size):
    r = size * 0.22
    lo, hi = 0, size - 1
    cx = min(max(x, lo + r), hi - r)
    cy = min(max(y, lo + r), hi - r)
    return (x - cx) ** 2 + (y - cy) ** 2 <= r * r or (lo + r <= x <= hi - r) or (lo + r <= y <= hi - r)


def in_bolt(x, y, size):
    # Lightning bolt in a unit box, then scaled. Two triangles joined at the waist.
    u, v = x / size, y / size
    if 0.30 <= v <= 0.55:  # upper half: from top-right sweeping left
        return 0.58 - (v - 0.30) * 1.5 <= u <= 0.72 - (v - 0.30) * 0.9
    if 0.45 <= v <= 0.72:  # lower half: from the waist sweeping right-down
        return 0.34 + (v - 0.45) * 0.9 <= u <= 0.52 + (v - 0.45) * 0.3
    return False


def make_icon(size, path):
    pixels = []
    for y in range(size):
        row = []
        for x in range(size):
            if not in_rounded_square(x, y, size):
                row.append((0, 0, 0, 0))
            elif in_bolt(x, y, size):
                row.append((*BOLT, 255))
            else:
                row.append((*INK, 255))
        pixels.append(row)
    write_png(path, size, pixels)
    print(f"wrote {path}")


if __name__ == "__main__":
    here = os.path.dirname(os.path.abspath(__file__))
    icons = os.path.join(here, "..", "extension", "icons")
    os.makedirs(icons, exist_ok=True)
    for size in (16, 48, 128):
        make_icon(size, os.path.join(icons, f"icon{size}.png"))
