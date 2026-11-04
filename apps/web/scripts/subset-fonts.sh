#!/bin/sh
# Latin subsets of Geist / Geist Mono (npm "geist" 1.8.1, SIL OFL 1.1, no Reserved Font Name) for the web build.
# The full files carry Cyrillic, Greek and more (~50 kB each); the app is Italian: the subsets keep Basic Latin,
# Latin-1, typographic punctuation, currency and the arrows/math signs the UI uses, with every OpenType feature (tnum).
# Requires fonttools + brotli:  python3 -m venv v && v/bin/pip install fonttools==4.60.1 brotli==1.1.0
#   PYFTSUBSET=v/bin/pyftsubset sh scripts/subset-fonts.sh
# test/model.test.mjs (U36) fails if the sources use a character outside UNICODES.
set -e
cd "$(dirname "$0")/.."
UNICODES="U+0020-007E,U+00A0-00FF,U+0131,U+0152-0153,U+02C6,U+02DA,U+02DC,U+2009-200B,U+2013-2014,U+2018-201E,U+2022,U+2026,U+202F,U+2030,U+2039-203A,U+20AC,U+2122,U+2190-2193,U+2212,U+2248,U+2260,U+2264-2265"
SRC=node_modules/geist/dist/fonts
for f in geist-mono/GeistMono-Regular geist-mono/GeistMono-Medium geist-mono/GeistMono-SemiBold geist-mono/GeistMono-Bold geist-sans/Geist-Bold; do
  out="src/fonts/$(basename $f)-latin.woff2"
  ${PYFTSUBSET:-pyftsubset} "$SRC/$f.woff2" --unicodes="$UNICODES" --layout-features='*' --flavor=woff2 --output-file="$out"
done
cp node_modules/geist/LICENSE.txt src/fonts/LICENSE.txt
ls -l src/fonts
