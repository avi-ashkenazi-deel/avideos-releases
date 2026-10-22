"""
Build a variable TrueType font from point-compatible masters.
Runs inside Pyodide (fontTools is a Pyodide built-in package).

Input (JSON string `payload`):
{
  "familyName": str, "styleName": str,
  "upm": 1000, "ascender": int, "descender": int, "xHeight": int, "capHeight": int,
  "axes": [{"tag": "wght", "name": "Weight", "min": 100, "default": 400, "max": 900}, ...],
  "glyphOrder": [".notdef", "space", "A", ...],
  "unicodes": {"A": 65, ...},
  "masters": [
     {"location": {"wght": 400, "WOBL": 0},
      "glyphs": {"A": {"advance": 600, "contours": [[[x, y], ...], ...]}, ...}},
     ...
  ]
}
Every master must carry the same glyph set with identical contour/point counts.
Returns the font file bytes.
"""
import io
import json

from fontTools.fontBuilder import FontBuilder
from fontTools.pens.ttGlyphPen import TTGlyphPen
from fontTools.designspaceLib import DesignSpaceDocument, AxisDescriptor, SourceDescriptor
from fontTools import varLib


def _glyph_from_contours(contours):
    pen = TTGlyphPen(None)
    for ring in contours:
        if len(ring) < 3:
            continue
        pen.moveTo((round(ring[0][0]), round(ring[0][1])))
        for x, y in ring[1:]:
            pen.lineTo((round(x), round(y)))
        pen.closePath()
    g = pen.glyph()
    # mark overlapping contours as intentional (Apple renderers)
    try:
        if g.numberOfContours > 0:
            g.flags[0] |= 0x40  # OVERLAP_SIMPLE
    except Exception:
        pass
    return g


def _notdef():
    pen = TTGlyphPen(None)
    pen.moveTo((50, 0)); pen.lineTo((450, 0)); pen.lineTo((450, 700)); pen.lineTo((50, 700)); pen.closePath()
    pen.moveTo((100, 50)); pen.lineTo((100, 650)); pen.lineTo((400, 650)); pen.lineTo((400, 50)); pen.closePath()
    return pen.glyph()


def _build_master(spec, master, ps_suffix):
    fb = FontBuilder(spec["upm"], isTTF=True)
    order = spec["glyphOrder"]
    fb.setupGlyphOrder(order)
    cmap = {int(v): k for k, v in spec["unicodes"].items()}
    cmap.setdefault(32, "space")
    fb.setupCharacterMap(cmap)
    glyphs = {}
    advances = {}
    for name in order:
        if name == ".notdef":
            glyphs[name] = _notdef(); advances[name] = 500; continue
        if name == "space":
            glyphs[name] = TTGlyphPen(None).glyph(); advances[name] = int(spec["upm"] * 0.28); continue
        g = master["glyphs"].get(name)
        if g is None:
            glyphs[name] = TTGlyphPen(None).glyph(); advances[name] = 500; continue
        glyphs[name] = _glyph_from_contours(g["contours"])
        advances[name] = max(1, int(round(g["advance"])))
    fb.setupGlyf(glyphs)
    metrics = {}
    glyf = fb.font["glyf"]
    for name in order:
        gl = glyf[name]
        lsb = gl.xMin if hasattr(gl, "xMin") else 0
        metrics[name] = (advances[name], lsb)
    fb.setupHorizontalMetrics(metrics)
    fb.setupHorizontalHeader(ascent=spec["ascender"], descent=spec["descender"])
    fb.setupNameTable({
        "familyName": spec["familyName"],
        "styleName": spec.get("styleName", "Regular"),
        "psName": (spec["familyName"].replace(" ", "") + "-" + ps_suffix)[:60],
    })
    fb.setupOS2(sTypoAscender=spec["ascender"], sTypoDescender=spec["descender"], sTypoLineGap=0,
                usWinAscent=max(spec["ascender"], 0), usWinDescent=max(-spec["descender"], 0),
                sxHeight=spec.get("xHeight", 500), sCapHeight=spec.get("capHeight", 700))
    fb.setupPost()
    return fb.font


def build_variable(payload):
    spec = json.loads(payload) if isinstance(payload, str) else payload
    doc = DesignSpaceDocument()
    tag_to_name = {}
    for ax in spec["axes"]:
        tag_to_name[ax["tag"]] = ax["name"]
        a = AxisDescriptor()
        a.tag = ax["tag"]; a.name = ax["name"]
        a.minimum = ax["min"]; a.default = ax["default"]; a.maximum = ax["max"]
        doc.addAxis(a)
    for i, m in enumerate(spec["masters"]):
        s = SourceDescriptor()
        s.font = _build_master(spec, m, "M%d" % i)
        # designspace locations are keyed by axis NAME, not tag
        s.location = {tag_to_name[t]: v for t, v in m["location"].items()}
        s.name = "master%d" % i
        doc.addSource(s)
    vf, _model, _masters = varLib.build(doc, optimize=True)
    # name the axes nicely in the fvar via STAT-less approach: fvar already carries axis names from designspace
    buf = io.BytesIO()
    vf.save(buf)
    return buf.getvalue()
