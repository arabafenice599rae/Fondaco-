#!/usr/bin/env python3
"""Metric-matched fallback faces for Geist Mono (D-57). Prints the @font-face rules appended to src/fonts.css.

Geist Mono metrics are read from the bundled woff2 (fontTools + brotli: pip install fonttools brotli). The local fallback
fonts are measured where installed (DejaVu Sans Mono, Liberation Mono); Menlo, Consolas and Courier New use their published
hhea/hmtx values. size-adjust matches the advance (monospace: one value); the overrides are Geist Mono's ascent/descent/gap
divided by size-adjust, because size-adjust also scales the overridden metrics.
    python3 apps/web/scripts/font-fallback.py
"""
import os
from fontTools.ttLib import TTFont

HERE = os.path.dirname(os.path.abspath(__file__))
t = TTFont(os.path.join(HERE, '../src/fonts/GeistMono-Regular-latin.woff2'))
upm = t['head'].unitsPerEm
G = dict(adv=t['hmtx'][t.getBestCmap()[ord('0')]][0] / upm, asc=t['hhea'].ascent / upm, desc=-t['hhea'].descent / upm, gap=t['hhea'].lineGap / upm)
F = [  # family, local() names regular, local() names bold, unitsPerEm, advance
    ('Menlo', ['Menlo-Regular', 'Menlo'], ['Menlo-Bold', 'Menlo Bold'], 2048, 1233),
    ('Consolas', ['Consolas'], ['Consolas-Bold', 'Consolas Bold'], 2048, 1126),
    ('DejaVu Sans Mono', ['DejaVuSansMono', 'DejaVu Sans Mono'], ['DejaVuSansMono-Bold', 'DejaVu Sans Mono Bold'], 2048, 1233),
    ('Liberation Mono', ['LiberationMono-Regular', 'Liberation Mono'], ['LiberationMono-Bold', 'Liberation Mono Bold'], 2048, 1229),
    ('Courier New', ['CourierNewPSMT', 'Courier New'], ['CourierNewPS-BoldMT', 'Courier New Bold'], 2048, 1229),
]
for name, reg, bold, fupm, adv in F:
    sa = G['adv'] / (adv / fupm)
    for w, locs in (('100 500', reg), ('600 900', bold)):
        src = ', '.join(f'local("{l}")' for l in locs)
        print(f'@font-face {{ font-family: "Geist Mono Fallback {name}"; font-weight: {w}; src: {src}; size-adjust: {sa*100:.2f}%; '
              f'ascent-override: {G["asc"]/sa*100:.2f}%; descent-override: {G["desc"]/sa*100:.2f}%; line-gap-override: {G["gap"]/sa*100:.0f}% }}')
