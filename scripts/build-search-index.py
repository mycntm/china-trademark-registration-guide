#!/usr/bin/env python3
"""Build the compact search index used by the classification search page.

Input : data/catalogue.json.gz   (source catalogue, byte-identical copy)
Output: data/search-index.json   (~2.1 MB raw / ~0.55 MB gzipped)

The shape is deliberately terse — this file is downloaded by the browser, so
repeated words cost real bandwidth:

    {
      "generated": "2026-10",
      "classes":    [["01", "化学原料", "Chemicals", "class-01-chemicals.md"], ...],
      "subclasses": [["0102", "0101", "工业气体，单质"], ...],        # [class, code, zh]
      "items":      [[1, "0101", "结晶硅", "crystalline silicon", "C010006"], ...]
    }

`items` stores the class as an integer (1–45) and keeps the sub-class code as a
4-digit string, because both are shown to the user and re-parsed in the page.

Usage:
    python scripts/build-search-index.py [path/to/catalogue.json.gz]
"""

from __future__ import annotations

import gzip
import json
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
DEFAULT_SRC = REPO / "data" / "catalogue.json.gz"
OUT = REPO / "data" / "search-index.json"


def main(src: Path) -> int:
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        cat = json.load(fh)

    classes = sorted(cat["classes"], key=lambda c: c["code"])
    class_index = {c["code"]: i + 1 for i, c in enumerate(classes)}

    # Map "09" -> "class-09-electrical-scientific.md" so a result can link to
    # the full page for that class without duplicating the slug table here.
    pages = {}
    for path in (REPO / "classification").glob("class-*.md"):
        code = path.name.split("-")[1]
        pages[code] = path.name

    subclasses = [
        [class_index[s["class_code"]], s["code"], s["zh"]]
        for s in sorted(cat["subclasses"], key=lambda s: (s["class_code"], s["code"]))
        if s["class_code"] in class_index
    ]

    items: list[list] = []
    seen: set[tuple] = set()
    for i in cat["items"]:
        cls = class_index.get(i["class_code"])
        if cls is None:
            continue
        key = (cls, i["subclass_code"], i["zh"], i["en"])
        if key in seen:                      # 3 exact duplicates in the source
            continue
        seen.add(key)
        items.append([cls, i["subclass_code"], i["zh"], i["en"], i["code"]])

    payload = {
        "generated": "2026-10",
        "classes": [[c["code"], c["zh"], c["en"], pages.get(c["code"], "")] for c in classes],
        "subclasses": subclasses,
        "items": items,
    }

    text = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    OUT.write_text(text, encoding="utf-8", newline="\n")

    raw = len(text.encode("utf-8"))
    gz = len(gzip.compress(text.encode("utf-8"), 6))
    print(f"items: {len(items):,}  classes: {len(classes)}  sub-classes: {len(subclasses)}")
    print(f"written: {OUT.relative_to(REPO)}  {raw/1e6:.2f} MB raw  {gz/1e3:.0f} KB gzipped")
    return 0


if __name__ == "__main__":
    sys.exit(main(Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SRC))
