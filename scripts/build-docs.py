#!/usr/bin/env python3
"""Assemble the MkDocs source tree without touching the original files.

The repository keeps its content where it has always been:

    guides/          01..05.md          published guides
    classification/  README.md + 45 pages
    data/            CSV / JSON / the gzipped catalogue
    docs/            site shell only (home page, license page, robots.txt)

MkDocs can only serve files inside its `docs_dir`, and the source files must
stay where they are, so this script builds a staging tree that mirrors them:

    .build/docs/
    ├── index.md              <- docs/index.md        (site home)
    ├── license.md            <- docs/license.md
    ├── robots.txt            <- docs/robots.txt
    ├── guides/               <- guides/
    ├── classification/       <- classification/  (README.md renamed to index.md)
    └── data/                 <- data/

Two link rewrites are applied to the *copies* so that GitHub and the site both
work: the repo links back to ../README.md and ../LICENSE, which on the site are
the home page and the license page.

Usage:
    python scripts/build-docs.py      # refresh .build/docs
    mkdocs serve                      # preview at http://127.0.0.1:8000
"""

from __future__ import annotations

import shutil
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
BUILD = REPO / ".build" / "docs"

SHELL_FILES = ["index.md", "license.md", "robots.txt"]
CONTENT_DIRS = ["guides", "classification", "data"]
# Static assets that belong to the site shell (stylesheets, images, ...)
ASSET_DIRS = ["assets", "javascripts"]

# (pattern, replacement) — applied to every copied Markdown file
REWRITES = [
    ("](../README.md)", "](../index.md)"),
    ("](../LICENSE)", "](../license.md)"),
    ("](README.md)", "](index.md)"),
]


def build(quiet: bool = False) -> Path:
    if BUILD.exists():
        shutil.rmtree(BUILD)
    BUILD.mkdir(parents=True)

    for name in SHELL_FILES:
        src = REPO / "docs" / name
        if src.exists():
            shutil.copyfile(src, BUILD / name)

    for name in ASSET_DIRS:
        src = REPO / "docs" / name
        if src.is_dir():
            shutil.copytree(src, BUILD / name)

    for name in CONTENT_DIRS:
        src = REPO / name
        if src.is_dir():
            shutil.copytree(src, BUILD / name)

    # classification/README.md becomes the index page of its section
    cls = BUILD / "classification"
    if (cls / "README.md").exists():
        (cls / "README.md").replace(cls / "index.md")

    touched = 0
    for md in BUILD.rglob("*.md"):
        text = md.read_text(encoding="utf-8")
        new = text
        for old, repl in REWRITES:
            new = new.replace(old, repl)
        if new != text:
            md.write_text(new, encoding="utf-8", newline="\n")
            touched += 1

    pages = len(list(BUILD.rglob("*.md")))
    if not quiet:
        print(f"staged {pages} pages into {BUILD.relative_to(REPO)} ({touched} with rewritten links)")
    return BUILD


if __name__ == "__main__":
    build()
