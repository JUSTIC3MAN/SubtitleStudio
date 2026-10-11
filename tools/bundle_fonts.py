"""
bundle_fonts.py - developer tool: copies every caption font into web/fonts so
the app (and its exports) never depend on an internet connection.

Fonts come from the Fontsource packages on npm (the same files Google Fonts
serves, all SIL OFL / Apache 2.0). Needs `npm` on PATH. The user never has to
run this - the fonts ship with the app.

    python tools/bundle_fonts.py
"""

import json
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "web" / "fonts"
SUBSETS = ("latin", "latin-ext")

# family -> (weights, italic weights). Mirrors SS.FONTS in web/presets.js,
# plus the interface font.
FAMILIES = {
    "Montserrat": ([400, 600, 700, 800, 900], [700, 800, 900]),
    "Poppins": ([400, 500, 600, 700, 800, 900], [700, 800]),
    "Inter": ([400, 500, 600, 700, 800, 900], [700, 800]),
    "TikTok Sans": ([400, 700, 900], []),
    "Figtree": ([400, 700, 900], [700]),
    "Plus Jakarta Sans": ([400, 700, 800], [700]),
    "Outfit": ([400, 600, 800, 900], []),
    "Rubik": ([400, 700, 900], [700]),
    "Space Grotesk": ([400, 500, 700], []),
    "Syne": ([400, 600, 700, 800], []),
    "Unbounded": ([400, 700, 900], []),
    "Archivo Black": ([400], []),
    "Anton": ([400], []),
    "Bebas Neue": ([400], []),
    "Oswald": ([400, 500, 600, 700], []),
    "Barlow Condensed": ([500, 700, 800, 900], [700, 800]),
    "Teko": ([400, 500, 600, 700], []),
    "Instrument Serif": ([400], [400]),
    "Playfair Display": ([400, 700, 900], [400, 700]),
    "DM Serif Display": ([400], [400]),
    "Cormorant Garamond": ([400, 600, 700], [400, 600]),
    "Luckiest Guy": ([400], []),
    "Bangers": ([400], []),
    "Lilita One": ([400], []),
    "Titan One": ([400], []),
    "Bungee": ([400], []),
    "Righteous": ([400], []),
    "Russo One": ([400], []),
    "Permanent Marker": ([400], []),
    "Caveat": ([400, 700], []),
    "Kalam": ([400, 700], []),
    "Special Elite": ([400], []),
    "Monoton": ([400], []),
    # interface
    "Instrument Sans": ([400, 500, 600, 700], []),
}

BLOCK = re.compile(r"/\* (?P<name>[^*]+?) \*/\s*@font-face\s*{(?P<body>[^}]*)}", re.S)


def main():
    npm = shutil.which("npm")
    if not npm:
        sys.exit("npm not found")
    files = OUT / "files"
    if OUT.exists():
        shutil.rmtree(OUT)
    files.mkdir(parents=True)
    css_out = ["/* Bundled caption fonts - SIL Open Font License / Apache 2.0 (via Fontsource) */"]
    licences = {}
    with tempfile.TemporaryDirectory() as tmp:
        tmp = Path(tmp)
        for fam, (weights, italics) in FAMILIES.items():
            slug = fam.lower().replace(" ", "-")
            r = subprocess.run([npm, "pack", f"@fontsource/{slug}", "--silent"], cwd=tmp,
                               capture_output=True, text=True)
            tgz = tmp / r.stdout.strip().splitlines()[-1] if r.returncode == 0 and r.stdout.strip() else None
            if not tgz or not tgz.exists():
                print("  !! could not fetch", fam, r.stderr[-300:])
                continue
            d = tmp / slug
            d.mkdir()
            with tarfile.open(tgz) as tf:
                tf.extractall(d, filter="data")
            pkg = d / "package"
            lic = pkg / "LICENSE"
            if lic.exists():
                licences[fam] = lic.read_text("utf-8", "replace")[:200].splitlines()[0]
            want = [(w, "normal") for w in weights] + [(w, "italic") for w in italics]
            n = 0
            for w, style in want:
                css_file = pkg / (f"{w}.css" if style == "normal" else f"{w}-italic.css")
                if not css_file.exists():
                    print(f"  .. {fam} {w} {style} not in package")
                    continue
                for m in BLOCK.finditer(css_file.read_text("utf-8")):
                    name = m.group("name").strip()
                    if not any(name == f"{slug}-{sub}-{w}-{style}" for sub in SUBSETS):
                        continue
                    body = m.group("body")
                    src = re.search(r"url\(\./files/([^)]+?\.woff2)\)", body)
                    if not src:
                        continue
                    fn = src.group(1)
                    shutil.copy(pkg / "files" / fn, files / fn)
                    rng = re.search(r"unicode-range:\s*([^;]+);", body)
                    css_out.append(
                        "@font-face{font-family:'%s';font-style:%s;font-weight:%d;font-display:block;"
                        "src:url(files/%s) format('woff2');%s}"
                        % (fam, style, w, fn, f"unicode-range:{rng.group(1).strip()};" if rng else ""))
                    n += 1
            print(f"  {fam}: {n} files")
    (OUT / "fonts.css").write_text("\n".join(css_out) + "\n", "utf-8")
    (OUT / "LICENSES.json").write_text(json.dumps(licences, indent=1), "utf-8")
    total = sum(f.stat().st_size for f in files.iterdir())
    print(f"done: {len(list(files.iterdir()))} files, {total / 1e6:.1f} MB")


if __name__ == "__main__":
    main()
