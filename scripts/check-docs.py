#!/usr/bin/env python3
"""Pre-flight check for the documentation site (no third-party dependencies).

    python scripts/check-docs.py

Stages the MkDocs source tree with scripts/build-docs.py, then verifies that

  1. every nav entry in mkdocs.yml points at an existing page;
  2. every relative link resolves to a real file inside the staged tree;
  3. no page exists that is missing from the nav.

Run this before `mkdocs build`; CI runs it on every push.
"""

from __future__ import annotations

import importlib.util
import re
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
CONFIG = REPO / "mkdocs.yml"

LINK_RE = re.compile(r"\]\(\s*([^)\s]+)")
NAV_LINE_RE = re.compile(r"^\s*-\s*(?:\"[^\"]+\"|[^:]+):\s*(\S+\.md)\s*$")


def load_builder():
    spec = importlib.util.spec_from_file_location("build_docs", REPO / "scripts" / "build-docs.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def nav_paths() -> list[str]:
    text = CONFIG.read_text(encoding="utf-8")
    nav_start = text.find("\nnav:")
    if nav_start == -1:
        return []
    return [m.group(1) for line in text[nav_start:].splitlines() if (m := NAV_LINE_RE.match(line))]


def main() -> int:
    build = load_builder().build(quiet=True)
    errors: list[str] = []
    warnings: list[str] = []

    nav = nav_paths()
    if not nav:
        errors.append("mkdocs.yml: no nav entries parsed — check the nav block")

    pages = sorted(build.rglob("*.md"))
    page_rel = {p.relative_to(build).as_posix() for p in pages}

    for rel in nav:
        if not (build / rel).is_file():
            errors.append(f"nav → missing page: {rel}")

    for rel in sorted(page_rel - set(nav)):
        warnings.append(f"page not in nav: {rel}")

    links = 0
    for page in pages:
        for m in LINK_RE.finditer(page.read_text(encoding="utf-8")):
            target = m.group(1)
            if target.startswith(("http://", "https://", "mailto:", "#", "tel:")):
                continue
            clean = target.split("#", 1)[0].split("?", 1)[0]
            if not clean:
                continue
            links += 1
            resolved = (page.parent / clean).resolve()
            if not resolved.exists():
                errors.append(f"broken link in {page.relative_to(build).as_posix()}: {target}")
            elif build not in resolved.parents and resolved != build:
                errors.append(
                    f"target outside the site in {page.relative_to(build).as_posix()}: {target} "
                    "(MkDocs only serves files inside the staging tree)"
                )

    print(f"pages: {len(pages)}   nav entries: {len(nav)}   relative links: {links}")
    for w in warnings:
        print(f"warn  {w}")
    for e in errors:
        print(f"ERROR {e}")

    if errors:
        print(f"\n{len(errors)} error(s)")
        return 1
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
