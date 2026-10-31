#!/usr/bin/env python3
"""Generate the bilingual Nice classification reference from the portal catalogue.

Source of truth: portal.mycntm.com/resources/classification/catalogue.json.gz
Outputs:
  classification/README.md            index of the 45 classes + dataset docs
  classification/class-XX-slug.md     one page per class (sub-classes + items)
  data/classes.csv                    45 rows
  data/subclasses.csv                 495 rows
  data/nice-classification-zh-en.csv  one row per item (~32.7k)
  data/nice-classification.json       full catalogue, compact JSON
  data/catalogue.json.gz              byte-identical copy of the source

Usage:
  python scripts/build-classification.py path/to/catalogue.json.gz
"""

from __future__ import annotations

import csv
import gzip
import json
import re
import shutil
import sys
from collections import OrderedDict, defaultdict
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
SITE = "https://china-trademark.net"
REVIEWED = "October 2026"

STOPWORDS = {"and", "or", "of", "for", "the", "to", "by", "in", "with", "not", "other", "than"}
DROP_PREFIX = {"preparations", "services", "products", "apparatus", "machines"}


def slugify(text: str) -> str:
    text = text.lower()
    text = text.replace("&", " and ")
    text = re.sub(r"[^a-z0-9\s-]", " ", text)
    words = [w for w in text.split() if w and w not in STOPWORDS]
    while words and words[-1] in DROP_PREFIX:
        words.pop()
    slug = "-".join(words[:5]) or "class"
    return slug[:48].strip("-")


def md_escape(text: str) -> str:
    return (text or "").replace("|", "\\|").strip()


def load(src: Path) -> dict:
    with gzip.open(src, "rt", encoding="utf-8") as fh:
        return json.load(fh)


def dedupe(items: list[dict]) -> list[dict]:
    seen = set()
    out = []
    for item in items:
        key = (item["class_code"], item["subclass_code"], item["zh"], item["en"])
        if key in seen:
            continue
        seen.add(key)
        out.append(item)
    return out


def build(src: Path) -> None:
    catalogue = load(src)
    classes = catalogue["classes"]
    subclasses = catalogue["subclasses"]
    items = dedupe(catalogue["items"])

    sub_by_code = {s["code"]: s for s in subclasses}
    subs_by_class = defaultdict(list)
    for sub in subclasses:
        subs_by_class[sub["class_code"]].append(sub)
    items_by_class = defaultdict(list)
    for item in items:
        items_by_class[item["class_code"]].append(item)

    (REPO / "classification").mkdir(exist_ok=True)
    (REPO / "data").mkdir(exist_ok=True)

    # ---- CSV / JSON exports -------------------------------------------------
    def write_csv(path: Path, header: list[str], rows: list[list[str]]) -> None:
        with open(path, "w", encoding="utf-8-sig", newline="") as fh:
            writer = csv.writer(fh, lineterminator="\n")
            writer.writerow(header)
            writer.writerows(rows)

    write_csv(
        REPO / "data/classes.csv",
        ["class_code", "class_zh", "class_en", "zh_description", "en_description", "subclass_count", "item_count"],
        [
            [
                c["code"],
                c["zh"],
                c["en"],
                c["zh_desc"],
                c["en_desc"],
                str(len(subs_by_class[c["code"]])),
                str(len(items_by_class[c["code"]])),
            ]
            for c in classes
        ],
    )

    write_csv(
        REPO / "data/subclasses.csv",
        ["subclass_code", "class_code", "subclass_zh"],
        [[s["code"], s["class_code"], s["zh"]] for s in subclasses],
    )

    class_by_code = {c["code"]: c for c in classes}
    write_csv(
        REPO / "data/nice-classification-zh-en.csv",
        ["class_code", "class_zh", "class_en", "subclass_code", "subclass_zh", "item_code", "item_zh", "item_en", "item_type"],
        [
            [
                i["class_code"],
                class_by_code[i["class_code"]]["zh"],
                class_by_code[i["class_code"]]["en"],
                i["subclass_code"],
                sub_by_code.get(i["subclass_code"], {}).get("zh", ""),
                i["code"],
                i["zh"],
                i["en"],
                i["type"],
            ]
            for i in items
        ],
    )

    with open(REPO / "data/nice-classification.json", "w", encoding="utf-8") as fh:
        json.dump(
            {"source": catalogue.get("source", SITE + "/class-finder.php"), "reviewed": REVIEWED,
             "classes": classes, "subclasses": subclasses, "items": items},
            fh, ensure_ascii=False, separators=(",", ":"),
        )
        fh.write("\n")
    shutil.copyfile(src, REPO / "data/catalogue.json.gz")

    # ---- one page per class -------------------------------------------------
    page_names: dict[str, str] = {}
    for c in classes:
        page_names[c["code"]] = f"class-{c['code']}-{slugify(c['en'])}.md"

    for idx, c in enumerate(classes):
        code = c["code"]
        subs = subs_by_class[code]
        its = items_by_class[code]
        by_sub = OrderedDict()
        for sub in subs:
            by_sub[sub["code"]] = [i for i in its if i["subclass_code"] == sub["code"]]
        orphan = [i for i in its if i["subclass_code"] not in by_sub]

        prev_c = classes[idx - 1] if idx > 0 else None
        next_c = classes[idx + 1] if idx + 1 < len(classes) else None
        nav = []
        if prev_c:
            nav.append(f"[← Class {prev_c['code']}]({page_names[prev_c['code']]})")
        nav.append("[All 45 classes](README.md)")
        if next_c:
            nav.append(f"[Class {next_c['code']} →]({page_names[next_c['code']]})")

        lines = [
            f"# Class {code} — {c['zh']} / {c['en']}",
            "",
            " · ".join(nav),
            "",
            f"> **Nice Classification, Class {code}** — {len(subs)} sub-classes (类似群) and **{len(its):,} goods/services items**, "
            "Chinese–English, as used by CNIPA (China). Part of the "
            f"[45-class bilingual classification dataset](README.md) from [china-trademark.net]({SITE}/).",
            "",
            "| 中文名称 | English heading |",
            "|---|---|",
            f"| **{md_escape(c['zh'])}** | **{md_escape(c['en'])}** |",
            "",
            "**Class heading (中文)**",
            "",
            f"{c['zh_desc']}",
            "",
            "**Class heading (English)**",
            "",
            f"{c['en_desc']}",
            "",
            "> A China application covers **10 items per class** (extra items are charged individually), and protection "
            "generally runs per sub-class rather than across the whole class — see "
            "[the class selection guide](../guides/05-nice-classification-guide-china.md).",
            "",
            "## Sub-classes in this class",
            "",
            "| 群组 | 类似群名称 | 商品项数 |",
            "|---|---|---|",
        ]
        for sub in subs:
            lines.append(f"| {sub['code']} | {md_escape(sub['zh'])} | {len(by_sub[sub['code']])} |")

        lines += ["", "## Goods and services (中英对照)", ""]
        for sub in subs:
            group = by_sub[sub["code"]]
            if not group:
                continue
            lines += [
                f"### {sub['code']} — {sub['zh']}",
                "",
                "| # | 中文 | English | 编码 |",
                "|---:|---|---|---|",
            ]
            for n, item in enumerate(group, 1):
                lines.append(
                    f"| {n} | {md_escape(item['zh'])} | {md_escape(item['en'])} | {item['code'] or ''} |"
                )
            lines.append("")
        if orphan:
            lines += ["### Items without a listed sub-class", "", "| # | 中文 | English | 编码 |", "|---:|---|---|---|"]
            for n, item in enumerate(orphan, 1):
                lines.append(f"| {n} | {md_escape(item['zh'])} | {md_escape(item['en'])} | {item['code'] or ''} |")
            lines.append("")

        lines += [
            "---",
            "",
            f"**Filing in Class {code}?** [Free availability check and fixed quote]({SITE}/quote.php) — "
            "USD 199 per class, CNIPA official fee included, English service.",
            "",
            "[All 45 classes](README.md) · [Class selection guide](../guides/05-nice-classification-guide-china.md) · "
            f"[Cost and fees](../guides/02-china-trademark-cost-and-official-fees.md) · [Home]({SITE}/)",
            "",
            f"*Data reviewed {REVIEWED}. Official classification is published by CNIPA / WIPO; this copy is provided for "
            "reference and may lag the latest edition.*",
            "",
        ]
        (REPO / "classification" / page_names[code]).write_text("\n".join(lines), encoding="utf-8", newline="\n")

    # ---- index page ---------------------------------------------------------
    total_items = sum(len(items_by_class[c["code"]]) for c in classes)
    type_counts = defaultdict(int)
    for item in items:
        type_counts[item["type"]] += 1
    no_code = sum(1 for item in items if not item["code"])
    code_collisions = sum(
        1 for k, v in __import__("collections").Counter(i["code"] for i in items if i["code"]).items() if v > 1
    )
    idx = [
        "# 45 类商标分类中英文对照 · Nice Classification (Chinese–English)",
        "",
        "> **完整的中文商标分类对照表** — 45 个类别的中英文类名、类别说明、495 个类似群（sub-classes）与 "
        f"**{total_items:,} 条商品/服务项目中英对照**，与中国国家知识产权局（CNIPA）使用的分类体系一致。"
        "由 [china-trademark.net](%s/) 维护，可自由转载（CC BY 4.0）。" % SITE,
        "",
        "A complete, machine-readable Chinese–English version of the Nice Classification used by CNIPA: "
        "45 classes, 495 sub-classes and every listed goods/services item in both languages — "
        "as **Markdown pages**, **CSV** and **JSON**.",
        "",
        "**[← Back to the main guide](../README.md)** · **[Free availability check](%s/search.php)** · "
        "**[Class selection guide](../guides/05-nice-classification-guide-china.md)**" % SITE,
        "",
        "---",
        "",
        "## 为什么必须看「类似群」",
        "",
        "中国把每个类别再划分为若干**类似群**（sub-classes）。同类别但不同类似群的两个商品，通常**不构成类似商品**，"
        "因此一标一类只选 10 个项目时，如果全部集中在一个类似群，其余类似群等于没有保护。本表把每个商品项按类似群归组，"
        "就是为了让你一眼看出「我的 10 项到底覆盖了哪几个类似群」。",
        "",
        "In China, protection generally extends across a **sub-class**, not across the whole class. Two items in the same "
        "class but different sub-classes are not automatically similar — which is why a flat 10-item selection can leave "
        "gaps. Items below are grouped by sub-class for exactly that reason.",
        "",
        "## 45 个类别 / The 45 classes",
        "",
        "| 类号 | 中文 | English | 类似群 | 商品项 |",
        "|---:|---|---|---:|---:|",
    ]
    for c in classes:
        idx.append(
            f"| [{c['code']}]({page_names[c['code']]}) | {md_escape(c['zh'])} | {md_escape(c['en'])} | "
            f"{len(subs_by_class[c['code']])} | {len(items_by_class[c['code']]):,} |"
        )

    idx += [
        "",
        "## 下载 / Data files",
        "",
        "| 文件 | 内容 | 行数 |",
        "|---|---|---|",
        f"| [`data/nice-classification-zh-en.csv`](../data/nice-classification-zh-en.csv) | 全部商品项，一行一项，含类号/类似群/编码/中英文 | {total_items:,} |",
        "| [`data/classes.csv`](../data/classes.csv) | 45 个类别的中英文类名与类别说明 | 45 |",
        "| [`data/subclasses.csv`](../data/subclasses.csv) | 495 个类似群代码与中文名称 | 495 |",
        "| [`data/nice-classification.json`](../data/nice-classification.json) | 同一份数据的 JSON 版（classes / subclasses / items） | — |",
        "| [`data/catalogue.json.gz`](../data/catalogue.json.gz) | 源文件（gzip JSON，与 portal.mycntm.com 完全一致） | — |",
        "",
        "### CSV 字段 / Schema",
        "",
        "`data/nice-classification-zh-en.csv`（UTF-8 with BOM，Excel 可直接打开）",
        "",
        "| 字段 | 含义 | 示例 |",
        "|---|---|---|",
        "| `class_code` | 类号 01–45 | `09` |",
        "| `class_zh` / `class_en` | 类别中英文名称 | `电子科学仪器` / `Scientific, electrical and optical apparatus` |",
        "| `subclass_code` | 类似群代码 | `0901` |",
        "| `subclass_zh` | 类似群中文名称 | `计算机及其外部设备` |",
        "| `item_code` | 官方商品编码；**可为空**，且并不唯一 | `C090142` 或空 |",
        "| `item_zh` / `item_en` | 商品/服务项目中英对照 | `可下载的手机应用软件` / `downloadable mobile phone applications` |",
        "| `item_type` | 项目类型（见下） | `china_specific` |",
        "",
        "`item_type` 取值：",
        "",
        "| 值 | 含义 | 条目数 |",
        "|---|---|---:|",
        f"| `standard` | 国际标准项目（WIPO 基础清单） | {type_counts['standard']:,} |",
        f"| `china_specific` | 中国特有项目（如「可下载的手机应用软件」） | {type_counts['china_specific']:,} |",
        f"| `acceptable_name` | 可接受的规范名称，通常无官方编码 | {type_counts['acceptable_name']:,} |",
        "",
        f"> **注意**：`item_code` 不能作为唯一键——{code_collisions} 个编码在源数据中被用于不同商品，"
        f"另有 {no_code:,} 条可接受名称没有编码。唯一标识请使用 `class_code + subclass_code + item_zh`。",
        "",
        "### 用法示例 / Quick start",
        "",
        "```python",
        "import pandas as pd",
        "",
        "df = pd.read_csv('data/nice-classification-zh-en.csv', encoding='utf-8-sig', dtype=str)",
        "",
        "# 中→英：查某个中文商品属于哪一类",
        "df[df.item_zh.str.contains('手机应用软件', na=False)][['class_code', 'subclass_zh', 'item_en']]",
        "",
        "# 英→中：海外客户用英文查中文规范名称",
        "df[df.item_en.str.contains('cosmetics', case=False, na=False)][['class_code', 'item_zh']].head(20)",
        "",
        "# 某一类的所有类似群",
        "df[df.class_code == '09'].groupby('subclass_code').size().sort_values(ascending=False)",
        "```",
        "",
        "```javascript",
        "const data = require('./data/nice-classification.json');",
        "const class9 = data.items.filter(i => i.class_code === '09');",
        "const bySub = Object.groupBy(class9, i => i.subclass_code);",
        "```",
        "",
        "## 数据来源与免责 / Source and disclaimer",
        "",
        f"- 分类数据与 [china-trademark.net 商标分类查询工具]({SITE}/class-finder.php) 同源，"
        "原始文件为 `data/catalogue.json.gz`（逐字节复制，未作改写）。",
        f"- 数据核对时间：{REVIEWED}。官方分类表由 CNIPA / WIPO 发布并会随版本更新，本仓库为便于检索的副本，"
        "可能滞后于最新版；正式申请前请以官方公布版本为准。",
        "- 本仓库提供的是分类信息，不构成法律意见。",
        "",
        "## 授权 / License",
        "",
        "文本与数据以 **CC BY 4.0** 授权，可商用、可再分发，**请保留署名并链接回 "
        f"[china-trademark.net]({SITE}/)**（详见 [LICENSE](../LICENSE)）。欢迎转载这份对照表——它本来就该是公开的。",
        "",
        "---",
        "",
        f"由 [MY CNTM]({SITE}/about.php) 维护 · CNIPA 注册代理 · 商标注册 USD 199/类（含官费）· "
        f"[免费查询]({SITE}/search.php) · [报价]({SITE}/quote.php)",
        "",
    ]
    (REPO / "classification/README.md").write_text("\n".join(idx), encoding="utf-8", newline="\n")

    print(f"classes: {len(classes)}  subclasses: {len(subclasses)}  items: {total_items}")
    print("pages:", ", ".join(f"{c['code']}:{page_names[c['code']]}" for c in classes[:3]), "...")


if __name__ == "__main__":
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    build(Path(sys.argv[1]))
