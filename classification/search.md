---
hide:
  - navigation
  - toc
---

# China trademark classification search

Search all **32,665 goods and services items** of the Chinese Nice Classification — in English or in Chinese — and see exactly where each item sits in the class structure CNIPA examines against.

Most Chinese classification tools are built for Chinese applicants: Chinese interface, Chinese-only search, no explanation of why an item is filed where it is. This one is built for the foreign applicant, agent or in-house counsel who has to choose ten items per class and defend that choice later. Nothing to install, no account, and no query ever leaves your browser.

<div id="tm-search" data-index="../data/search-index.json"></div>

## How to read a result

| Column | What it is | Why it matters |
|---|---|---|
| **Class** | One of the 45 Nice classes, using the Chinese numbering (01–45) | CNIPA fees, examination and protection all run per class |
| **Sub-class** | The 类似群 — China splits every class into numbered sub-classes (e.g. `4209`) | Items in the same class but different sub-classes are generally **not** similar goods |
| **中文** | The official Chinese wording | This is the text that appears on your Chinese application — the English is a reference, not the filing |
| **English** | A working English name for the same item | Use it to search, not to file |
| **Code** | The catalogue code, where CNIPA assigns one | Quote it when corresponding with an agent or an examiner |

## Why the sub-class column decides your filing

Foreign applicants usually treat a class as a single bucket and pick ten familiar-sounding items. In China that can leave most of the class unprotected: two items sitting in different sub-classes of the same class are, in general, **not** considered similar goods. Ten items spread across ten sub-classes block far more than ten items crowded into one.

Select a class in the filter row and the results collapse to that class, still grouped by sub-class — which is exactly the shape of the decision you are making.

## Build the filing list here, not in a spreadsheet

Press **+** on any result to add it to the application list on the right. The list groups items by class, counts them against the **10 items included** in the per-class fee, and warns when a class goes over — each extra item is charged separately by CNIPA.

When the list looks right, **Copy list** gives you a plain-text working list (Chinese wording, English, code and sub-class) and **Download CSV** gives the same as a spreadsheet. The list is kept in this browser only, so you can come back to it later; **Clear** removes it.

## What is behind this page

The search runs entirely client-side against a 2.2 MB index (about 580 KB compressed) built from the same catalogue as the [45 class pages](index.md) and the [CSV / JSON dataset](index.md). It is reviewed periodically against the CNIPA classification; the current review date is shown on the [classification overview](index.md).

Licensed **CC BY 4.0** — the index, the code that renders this page and the underlying data can all be reused.

---

*General information for brand owners, not legal advice on a specific matter. Class and sub-class practice can change; confirm the current position before filing.*
