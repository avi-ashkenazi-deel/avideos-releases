#!/usr/bin/env python3
"""Turn an existing deck (or a folder of decks) into a brand-kit draft and layout priors.

What it reads (standard library only, no PowerPoint needed):
  - the theme color scheme and theme fonts (ppt/theme/theme1.xml)
  - the colors and typefaces actually used on slides, weighted by how often and how large
  - where real slides put their main text, how big headlines run, how often photos go full-bleed

What it writes:
  --kit kit.json       a brand kit the Layout Engine can load (colors with roles, fonts, content, grid)
  --priors priors.json anchor distribution, archetype shares, headline sizes (to tune engine weights)

Usage:
  python3 tools/pptx_to_kit.py deck.pptx --kit my-brand.json
  python3 tools/pptx_to_kit.py /folder/of/decks --kit kit.json --priors priors.json --name "Acme"
"""
import argparse, collections, glob, json, os, re, sys, zipfile

EMU_PER_INCH = 914400
GENERIC_FONTS = {'calibri', 'arial', 'times new roman', 'helvetica', 'verdana', 'tahoma', 'georgia', 'segoe ui', '+mn-lt', '+mj-lt', '+mn-ea', '+mj-ea', '+mn-cs', '+mj-cs'}
NEUTRAL_HEX = {'000000', 'FFFFFF', '0D0D0D', 'F2F2F2'}


def hex_to_rgb(h):
    return tuple(int(h[i:i + 2], 16) for i in (0, 2, 4))


def luminance(h):
    r, g, b = [v / 255 for v in hex_to_rgb(h)]
    f = lambda v: v / 12.92 if v <= 0.03928 else ((v + 0.055) / 1.055) ** 2.4
    return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)


def saturation(h):
    r, g, b = hex_to_rgb(h)
    mx, mn = max(r, g, b), min(r, g, b)
    return 0 if mx == 0 else (mx - mn) / mx


def contrast(a, b):
    la, lb = luminance(a), luminance(b)
    hi, lo = max(la, lb), min(la, lb)
    return (hi + 0.05) / (lo + 0.05)


def color_distance(a, b):
    return sum((x - y) ** 2 for x, y in zip(hex_to_rgb(a), hex_to_rgb(b))) ** 0.5


def read_deck(path):
    z = zipfile.ZipFile(path)
    names = z.namelist()
    pres = z.read('ppt/presentation.xml').decode('utf8', 'ignore')
    m = re.search(r'<p:sldSz cx="(\d+)" cy="(\d+)"', pres)
    W, H = (int(m.group(1)), int(m.group(2))) if m else (12192000, 6858000)
    theme = {'scheme': {}, 'major': None, 'minor': None}
    for t in [n for n in names if re.match(r'ppt/theme/theme1\.xml$', n)]:
        x = z.read(t).decode('utf8', 'ignore')
        clr = re.search(r'<a:clrScheme name="[^"]*">(.*?)</a:clrScheme>', x, re.S)
        if clr:
            for mm in re.finditer(r'<a:(dk1|lt1|dk2|lt2|accent\d)>(.*?)</a:\1>', clr.group(1), re.S):
                val = re.search(r'(?:srgbClr val|lastClr)="([0-9A-Fa-f]{6})"', mm.group(2))
                if val: theme['scheme'][mm.group(1)] = val.group(1).upper()
        fs = re.search(r'<a:fontScheme name="[^"]*">(.*?)</a:fontScheme>', x, re.S)
        if fs:
            maj = re.search(r'<a:majorFont>.*?<a:latin typeface="([^"]*)"', fs.group(1), re.S)
            mnr = re.search(r'<a:minorFont>.*?<a:latin typeface="([^"]*)"', fs.group(1), re.S)
            theme['major'] = maj.group(1) if maj else None
            theme['minor'] = mnr.group(1) if mnr else None
    slides = sorted([n for n in names if re.match(r'ppt/slides/slide\d+\.xml$', n)], key=lambda s: int(re.search(r'(\d+)\.xml', s).group(1)))
    return z, W, H, theme, slides


def slide_elements(xml, W, H):
    out = []
    for m in re.finditer(r'<p:(sp|pic)>(.*?)</p:\1>', xml, re.S):
        kind, body = m.group(1), m.group(2)
        x = re.search(r'<a:off x="(-?\d+)" y="(-?\d+)"/><a:ext cx="(\d+)" cy="(\d+)"', body)
        if not x: continue
        px, py, cx, cy = map(int, x.groups())
        text = ''.join(re.findall(r'<a:t>([^<]*)</a:t>', body)).strip()
        sizes = [int(s) / 100 for s in re.findall(r'sz="(\d+)"', body)]
        fill = re.search(r'<p:spPr>.*?<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"', body, re.S)
        fonts = re.findall(r'<a:latin typeface="([^"]+)"', body)
        text_colors = re.findall(r'<a:rPr[^>]*>\s*<a:solidFill>\s*<a:srgbClr val="([0-9A-Fa-f]{6})"', body)
        out.append({'kind': 'pic' if kind == 'pic' else ('text' if text else 'shape'), 'x': px / W, 'y': py / H, 'w': cx / W, 'h': cy / H,
                    'area': max(0.0, cx / W) * max(0.0, cy / H), 'text': text, 'size': max(sizes) if sizes else 0,
                    'fill': fill.group(1).upper() if fill else None, 'fonts': fonts, 'text_colors': [c.upper() for c in text_colors]})
    return out


def analyse(paths):
    color_score = collections.Counter(); color_text = collections.Counter(); color_fill_area = collections.Counter()
    font_score = collections.Counter(); font_size = collections.defaultdict(list)
    traits = collections.Counter(); anchors = collections.Counter(); hsizes = []
    n_slides = 0; theme_scheme = {}; theme_fonts = (None, None); first_texts = []
    for path in paths:
        try:
            z, W, H, theme, slides = read_deck(path)
        except Exception as e:
            print(f'skip {path}: {e}', file=sys.stderr); continue
        if theme['scheme'] and not theme_scheme: theme_scheme = theme['scheme']
        if theme['major'] and not theme_fonts[0]: theme_fonts = (theme['major'], theme['minor'])
        for si, s in enumerate(slides):
            els = slide_elements(z.read(s).decode('utf8', 'ignore'), W, H); n_slides += 1
            pics = [e for e in els if e['kind'] == 'pic']; texts = [e for e in els if e['kind'] == 'text']
            if si == 0 and texts: first_texts.extend(sorted(texts, key=lambda e: -e['size'])[:3])
            for e in els:
                if e['fill'] and e['fill'] not in NEUTRAL_HEX:
                    color_score[e['fill']] += 1 + e['area'] * 12; color_fill_area[e['fill']] += e['area']
                for c in e['text_colors']:
                    if c not in NEUTRAL_HEX: color_score[c] += 1.5; color_text[c] += 1
                for f in e['fonts']:
                    if f.lower() in GENERIC_FONTS: continue
                    font_score[f] += 1 + (e['size'] / 40 if e['size'] else 0)
                    if e['size']: font_size[f].append(e['size'])
            if any(e['area'] >= 0.85 for e in pics): traits['full-bleed'] += 1
            elif any(0.3 <= e['area'] < 0.85 for e in pics): traits['poster'] += 1
            elif len(pics) >= 2: traits['mosaic'] += 1
            if any(e['kind'] == 'shape' and e['area'] >= 0.25 for e in els): traits['color-block'] += 1
            if any(len(e['text']) <= 4 and e['size'] >= 100 for e in texts): traits['stat'] += 1
            if not pics and texts: traits['type-led'] += 1
            if texts:
                big = max(texts, key=lambda e: e['size'] * max(1, min(len(e['text']), 40)))
                cx, cy = big['x'] + big['w'] / 2, big['y'] + big['h'] / 2
                ax = 'left' if cx < 0.4 else 'right' if cx > 0.6 else 'center'; ay = 'top' if cy < 0.4 else 'bottom' if cy > 0.6 else 'middle'
                anchors[ax + '-' + ay] += 1
                if 8 <= big['size'] <= 400: hsizes.append(big['size'] / (H / EMU_PER_INCH * 72))
    return dict(color_score=color_score, color_text=color_text, color_fill_area=color_fill_area, font_score=font_score, font_size=font_size,
                traits=traits, anchors=anchors, hsizes=sorted(hsizes), n_slides=n_slides, theme_scheme=theme_scheme, theme_fonts=theme_fonts, first_texts=first_texts)


def cluster(colors, dist=28.0):
    """Merge near-identical hexes, keeping the heavier one."""
    kept = []
    for hexv, score in sorted(colors.items(), key=lambda kv: -kv[1]):
        for k in kept:
            if color_distance(k[0], hexv) < dist: k[1] += score; break
        else:
            kept.append([hexv, score])
    return kept


def build_kit(a, name, max_colors=9):
    scheme = a['theme_scheme']
    candidates = collections.Counter()
    for k, v in a['color_score'].items(): candidates[k] += v
    # theme accents count a little even when unused, backgrounds count when they are not plain white/black
    for role, v in scheme.items():
        if role.startswith('accent'): candidates[v] += 0.5
        if role in ('dk2', 'lt2') and v not in NEUTRAL_HEX: candidates[v] += 1
    merged = cluster(candidates)[:max_colors]
    colors = []
    for hexv, score in merged:
        lum, sat = luminance(hexv), saturation(hexv)
        area = a['color_fill_area'].get(hexv, 0)
        if (lum > 0.8 and (sat < 0.35 or area >= 0.5)) or (lum < 0.08 and sat < 0.3): role = 'background'
        elif lum > 0.8: role = 'accent'
        elif area >= 0.5 and sat >= 0.25: role = 'core'
        elif sat < 0.18: role = 'background' if lum > 0.5 else 'neutral'
        elif score >= merged[0][1] * 0.35: role = 'core'
        else: role = 'accent'
        label = next((r for r, v in scheme.items() if v == hexv), None)
        colors.append({'name': (label or f'Color {len(colors) + 1}').replace('accent', 'Accent ').replace('dk', 'Dark ').replace('lt', 'Light ').title(), 'hex': '#' + hexv, 'role': role})
    if not any(c['role'] == 'background' for c in colors): colors.append({'name': 'White', 'hex': '#FFFFFF', 'role': 'background'})
    if not any(c['role'] in ('core',) for c in colors) and colors:
        for c in colors:
            if c['role'] == 'accent': c['role'] = 'core'; break
    if not any(c['hex'] in ('#000000', '#111111') for c in colors): colors.append({'name': 'Black', 'hex': '#000000', 'role': 'neutral'})
    fonts = [f for f, _ in a['font_score'].most_common(4)]
    major, minor = a['theme_fonts']
    display = fonts[0] if fonts else (major or 'Inter')
    body = minor if minor and minor.lower() not in GENERIC_FONTS else (fonts[1] if len(fonts) > 1 else 'Inter')
    headline = ''
    if a['first_texts']:
        big = max(a['first_texts'], key=lambda e: e['size'] * min(len(e['text']), 60))
        headline = big['text'][:120]
    allowed = [c['hex'] for c in colors if c['role'] in ('core', 'neutral')][:2] + ['#FFFFFF']
    return {
        'name': name, 'note': 'Draft kit mined from existing decks. Review roles, fonts, and the logo before use.',
        'colors': colors,
        'logo': {'kind': 'wordmark', 'text': name.lower(), 'allowedColors': allowed, 'monochrome': True, 'clearZone': 1.0, 'minPx': 20},
        'fonts': {'display': display, 'body': body, 'displayWeight': 700, 'bodyWeight': 400, 'headlineCase': 'sentence', 'tracking': -0.02,
                  'observed': {f: {'uses': round(a['font_score'][f], 1), 'medianPt': sorted(a['font_size'][f])[len(a['font_size'][f]) // 2] if a['font_size'][f] else None} for f in fonts},
                  'theme': {'major': major, 'minor': minor}},
        'grid': {'unit': 8, 'marginRatio': 0.06, 'gutterUnits': 3, 'radius': 1},
        'shapes': ['circle', 'pill', 'quarter'],
        'content': {'eyebrow': '', 'headline': headline or 'Headline goes here', 'subhead': '', 'body': '', 'cta': 'Learn more', 'stat': '', 'footer': ''},
    }


def build_priors(a):
    n = max(1, a['n_slides']); hs = a['hsizes']
    pct = lambda q: round(100 * hs[int(len(hs) * q)], 1) if hs else None
    arch = {k: round(v / n, 3) for k, v in a['traits'].items()}
    return {'slides': a['n_slides'], 'archetypeShare': arch,
            'anchorShare': {k: round(v / n, 3) for k, v in a['anchors'].most_common()},
            'headlineSizePctOfHeight': {'p25': pct(0.25), 'median': pct(0.5), 'p75': pct(0.75), 'p90': pct(0.9)},
            'suggestedWeights': {k: round(0.3 + 4 * v, 2) for k, v in arch.items()},
            'suggestedLoud': round(min(1.0, max(0.0, ((pct(0.5) or 7) - 4) / 14)), 2)}


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('source', help='a .pptx file or a folder containing .pptx files (searched recursively)')
    ap.add_argument('--kit', help='write the brand-kit draft JSON here')
    ap.add_argument('--priors', help='write layout priors JSON here')
    ap.add_argument('--name', default=None, help='brand name for the kit')
    args = ap.parse_args()
    paths = [args.source] if args.source.lower().endswith('.pptx') else sorted(glob.glob(os.path.join(args.source, '**', '*.pptx'), recursive=True))
    if not paths: sys.exit('no .pptx files found')
    a = analyse(paths)
    name = args.name or os.path.splitext(os.path.basename(paths[0]))[0][:40]
    kit = build_kit(a, name); priors = build_priors(a)
    print(f'read {len(paths)} deck(s), {a["n_slides"]} slides')
    print('colors:', ', '.join(f"{c['name']} {c['hex']} ({c['role']})" for c in kit['colors']))
    print('fonts:', kit['fonts']['display'], '/', kit['fonts']['body'], '| theme:', kit['fonts']['theme'])
    print('archetype share:', priors['archetypeShare'])
    print('anchors:', dict(list(priors['anchorShare'].items())[:4]))
    print('headline size % of height:', priors['headlineSizePctOfHeight'])
    if args.kit: json.dump(kit, open(args.kit, 'w'), indent=2); print('wrote', args.kit)
    if args.priors: json.dump(priors, open(args.priors, 'w'), indent=2); print('wrote', args.priors)


if __name__ == '__main__':
    main()
