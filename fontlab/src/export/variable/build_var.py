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


def build_static_ttf(otf_bytes):
    """Convert a CFF OpenType font (bytes) to a TrueType font: cubic → quadratic
    with cu2qu, glyf/loca/maxp 1.0, CFF dropped. Returns the .ttf bytes."""
    from fontTools.ttLib import TTFont, newTable
    from fontTools.pens.cu2quPen import Cu2QuPen
    from fontTools.pens.ttGlyphPen import TTGlyphPen

    font = TTFont(io.BytesIO(bytes(otf_bytes)))
    glyph_set = font.getGlyphSet()
    glyf = newTable("glyf")
    glyf.glyphOrder = font.getGlyphOrder()
    glyf.glyphs = {}
    for name in glyf.glyphOrder:
        tt_pen = TTGlyphPen(glyph_set)
        pen = Cu2QuPen(tt_pen, max_err=1.0, reverse_direction=True)
        glyph_set[name].draw(pen)
        glyf.glyphs[name] = tt_pen.glyph()
    font["glyf"] = glyf
    font["loca"] = newTable("loca")
    maxp = newTable("maxp")
    maxp.tableVersion = 0x00010000
    maxp.maxZones = 1
    maxp.maxTwilightPoints = 0
    maxp.maxStorage = 0
    maxp.maxFunctionDefs = 0
    maxp.maxInstructionDefs = 0
    maxp.maxStackElements = 0
    maxp.maxSizeOfInstructions = 0
    maxp.maxComponentElements = 0
    font["maxp"] = maxp
    post = font["post"]
    post.formatType = 2.0
    post.extraNames = []
    post.mapping = {}
    for tag in ("CFF ", "VORG"):
        if tag in font:
            del font[tag]
    font.sfntVersion = "\x00\x01\x00\x00"
    font.recalcBBoxes = True
    out = io.BytesIO()
    font.save(out)
    return out.getvalue()


# ---------------------------------------------------------------------------
# Static weights → one variable font (like blode.co/static-to-variable)

_WEIGHT_NAMES = [(100, "Thin"), (200, "ExtraLight"), (300, "Light"), (400, "Regular"), (500, "Medium"),
                 (600, "SemiBold"), (700, "Bold"), (800, "ExtraBold"), (900, "Black")]


def _weight_name(w):
    return min(_WEIGHT_NAMES, key=lambda p: abs(p[0] - w))[1]


def _outline_signature(glyph_set, name):
    """Structure of a glyph's outline: operators and argument counts (component names kept)."""
    from fontTools.pens.recordingPen import RecordingPen
    pen = RecordingPen()
    try:
        glyph_set[name].draw(pen)
    except Exception:
        return None
    sig = []
    for op, args in pen.value:
        if op == "addComponent":
            sig.append((op, args[0]))
        else:
            sig.append((op, len(args)))
    return tuple(sig)


def _family_name(font):
    name = font["name"]
    for nid in (16, 1):
        rec = name.getDebugName(nid)
        if rec:
            return rec
    return "Combined"


def combine_weights(font_bytes_list, weights_json):
    """Combine static fonts of one family (e.g. Thin, Regular, Bold) into one
    variable font with a `wght` axis.

    font_bytes_list: list of .ttf / .otf / .woff file bytes (woff2 must be
    decompressed beforehand). weights_json: JSON list of weights (one per font).
    Returns (font_bytes, report_json). All masters must be TrueType or all CFF.
    Glyphs missing from any master, or whose outlines differ in structure, are
    dropped; kerning/features that cannot be merged are dropped with a note.
    """
    from fontTools.ttLib import TTFont
    from fontTools import subset as ftsubset
    from fontTools.designspaceLib import InstanceDescriptor

    weights = json.loads(weights_json) if isinstance(weights_json, str) else list(weights_json)
    fonts = []
    for b in font_bytes_list:
        f = TTFont(io.BytesIO(bytes(b)))
        f.flavor = None
        fonts.append(f)
    if len(fonts) < 2:
        raise ValueError("Pick at least two weights of the same family.")
    if len(set(weights)) != len(weights):
        raise ValueError("Two files have the same weight. Give each file its own weight.")
    kinds = {("glyf" in f) for f in fonts}
    if len(kinds) != 1:
        raise ValueError("Mix of TrueType (.ttf) and CFF (.otf) files. Use files of one kind.")
    is_ttf = kinds.pop()
    notes = []

    # sort by weight; default master = closest to 400
    order = sorted(range(len(fonts)), key=lambda i: weights[i])
    fonts = [fonts[i] for i in order]
    weights = [float(weights[i]) for i in order]
    default_i = min(range(len(weights)), key=lambda i: abs(weights[i] - 400))

    # glyphs present in every master
    common = set(fonts[0].getGlyphOrder())
    for f in fonts[1:]:
        common &= set(f.getGlyphOrder())
    missing = sorted(set().union(*[set(f.getGlyphOrder()) for f in fonts]) - common)

    # structurally compatible glyphs only
    sets = [f.getGlyphSet() for f in fonts]
    incompatible = []
    keep = []
    for name in fonts[default_i].getGlyphOrder():
        if name not in common:
            continue
        sigs = {_outline_signature(gs, name) for gs in sets}
        if len(sigs) == 1 and None not in sigs:
            keep.append(name)
        elif name == ".notdef":
            keep.append(name)  # fixed below
        else:
            incompatible.append(name)
    # composites whose components were dropped must go too
    dropped = set(incompatible) | set(missing)
    changed = True
    while changed:
        changed = False
        for name in list(keep):
            sig = _outline_signature(sets[default_i], name) or ()
            if any(op == "addComponent" and comp in dropped for op, comp in sig):
                keep.remove(name); incompatible.append(name); dropped.add(name); changed = True
    if len([n for n in keep if n != ".notdef"]) == 0:
        raise ValueError("These files do not share compatible outlines, so they cannot be interpolated. "
                         "Use weights exported from the same family and version.")

    def make_compatible_notdef():
        # replace .notdef in every master with the default master's so it always interpolates
        if _outline_signature(sets[0], ".notdef") is None:
            return
        sigs = {_outline_signature(gs, ".notdef") for gs in sets}
        if len(sigs) == 1:
            return
        if is_ttf:
            import copy
            src = fonts[default_i]
            for f in fonts:
                if f is src:
                    continue
                f["glyf"][".notdef"] = copy.deepcopy(src["glyf"][".notdef"])
                f["hmtx"][".notdef"] = src["hmtx"][".notdef"]
        else:
            notes.append(".notdef shapes differ between files; used as is.")
    make_compatible_notdef()

    def subset_all(layout):
        out = []
        for f in fonts:
            buf = io.BytesIO(); f.save(buf); buf.seek(0)
            g = TTFont(buf)
            opts = ftsubset.Options()
            opts.glyph_names = True
            opts.name_IDs = ["*"]
            opts.name_languages = ["*"]
            opts.notdef_outline = True
            opts.recalc_bounds = True
            opts.drop_tables = [] if layout else ["GSUB", "GPOS", "GDEF", "kern"]
            opts.layout_features = ["*"]
            opts.hinting = False
            opts.desubroutinize = True
            opts.legacy_kern = True
            sub = ftsubset.Subsetter(options=opts)
            sub.populate(glyphs=keep)
            sub.subset(g)
            if not layout:
                for t in ("GSUB", "GPOS", "GDEF", "kern"):
                    if t in g:
                        del g[t]
            for t in ("fpgm", "prep", "cvt ", "hdmx", "VDMX", "LTSH", "DSIG"):
                if t in g:
                    del g[t]
            out.append(g)
        return out

    def build(masters):
        doc = DesignSpaceDocument()
        a = AxisDescriptor()
        a.tag = "wght"; a.name = "Weight"
        a.minimum = weights[0]; a.maximum = weights[-1]; a.default = weights[default_i]
        doc.addAxis(a)
        for i, m in enumerate(masters):
            s = SourceDescriptor()
            s.font = m
            s.location = {"Weight": weights[i]}
            s.name = "master%d" % i
            doc.addSource(s)
            inst = InstanceDescriptor()
            inst.familyName = family
            inst.styleName = _weight_name(weights[i])
            inst.location = {"Weight": weights[i]}
            doc.addInstance(inst)
        vf, _model, _m = varLib.build(doc, optimize=True)
        return vf

    family = _family_name(fonts[default_i])
    try:
        vf = build(subset_all(True))
    except Exception as e:  # kerning/feature tables that do not merge
        notes.append("Kerning and OpenType features could not be merged across the files and were left out (%s)." % type(e).__name__)
        vf = build(subset_all(False))

    # names: "<Family> Variable"
    name = vf["name"]
    vf_family = family + " Variable"
    for nid in (1, 16):
        name.removeNames(nameID=nid)
    name.setName(vf_family, 1, 3, 1, 0x409)
    name.setName(vf_family, 1, 1, 0, 0)
    name.setName(vf_family, 16, 3, 1, 0x409)
    ps = "".join(ch for ch in vf_family if ch.isalnum()) + "-VF"
    name.setName(ps, 6, 3, 1, 0x409)
    name.setName(ps, 6, 1, 0, 0)
    try:
        from fontTools.otlLib.builder import buildStatTable
        buildStatTable(vf, [{"tag": "wght", "name": "Weight",
                             "values": [{"value": w, "name": _weight_name(w), **({"flags": 0x2} if i == default_i else {})}
                                        for i, w in enumerate(weights)]}])
    except Exception:
        pass
    vf["OS/2"].usWeightClass = int(round(weights[default_i]))

    buf = io.BytesIO()
    vf.save(buf)
    report = {
        "format": "ttf" if is_ttf else "otf",
        "family": vf_family,
        "axis": {"tag": "wght", "min": weights[0], "default": weights[default_i], "max": weights[-1]},
        "masters": [{"weight": w, "style": _weight_name(w)} for w in weights],
        "glyphs": len(vf.getGlyphOrder()),
        "dropped": sorted(set(incompatible) | set(missing)),
        "notes": notes,
    }
    return buf.getvalue(), json.dumps(report)
