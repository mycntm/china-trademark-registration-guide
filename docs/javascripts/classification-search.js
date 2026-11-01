/* ==========================================================================
   China trademark classification search
   --------------------------------------------------------------------------
   Static, client-side search over 32,665 goods and services items.
   Data: data/search-index.json (2.2 MB raw, ~580 KB gzipped), built by
   scripts/build-search-index.py.

   Design decisions that carry the UX:
   * Items are keyed by the two-digit class code as a STRING ("09"), matching
     both the data and the ?class= deep links. A numeric key silently breaks
     every class filter.
   * Two-pass matching: exact/plural word match first, so "app" does not return
     apparatus; only if that yields nothing do we fall back to word-prefix.
   * Results are grouped by class and each group is ranked by hits, because the
     real question is "which class do I file in", not "find one item".
   * The application list shows money: CNIPA includes 10 items per class at
     USD 199, each extra item is USD 10.
   ========================================================================== */

(function () {
  "use strict";

  var root = document.getElementById("tm-search");
  if (!root) return;

  var INDEX_URL = root.getAttribute("data-index") || "../data/search-index.json";
  var STORE_KEY = "cnclass.selection.v2";
  var PAGE_SIZE = 80;

  var CLASS_FEE = 199;
  var CLASS_INCLUDED = 10;
  var EXTRA_FEE = 10;

  var state = {
    items: [],
    classes: [],
    classByCode: {},
    subZh: {},
    query: "",
    tokens: [],
    strict: [],
    loose: [],
    hasAscii: false,
    active: new Set(),
    limit: PAGE_SIZE,
    selection: new Map(),
    ready: false
  };

  var el = {};

  /* ---------------------------------------------------------------- utils */

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }

  function isAscii(value) {
    return /^[\x20-\x7e]+$/.test(value);
  }

  function pad(code) {
    return String(code).padStart(2, "0");
  }

  function keyOf(item) {
    return item.c + "|" + item.s + "|" + item.zh;
  }

  function highlight(text, patterns) {
    var safe = escapeHtml(text);
    if (!patterns || !patterns.length) return safe;
    var union = patterns.map(function (p) { return p.source; }).join("|");
    try {
      return safe.replace(new RegExp("(" + union + ")", "gi"), "<mark>$1</mark>");
    } catch (err) {
      return safe;
    }
  }

  /* ------------------------------------------------------------- data load */

  function normalise(payload) {
    state.classes = payload.classes.map(function (c) {
      var cls = {
        code: c[0],
        zh: c[1],
        en: c[2],
        page: c[3] || "",
        num: parseInt(c[0], 10),
        count: 0
      };
      state.classByCode[cls.code] = cls;
      return cls;
    });

    payload.subclasses.forEach(function (s) {
      state.subZh[s[1]] = s[2];
    });

    state.items = payload.items.map(function (row) {
      var cls = state.classByCode[pad(row[0])];
      var item = {
        /* The class code stays a two-digit STRING: filters, deep links and
           stored selections all use that form. */
        c: pad(row[0]),
        s: row[1],
        zh: row[2],
        en: row[3] || "",
        enl: (row[3] || "").toLowerCase(),
        code: row[4] || "",
        cls: cls
      };
      if (cls) cls.count += 1;
      return item;
    });

    state.itemsByKey = {};
    state.items.forEach(function (item) {
      state.itemsByKey[keyOf(item)] = item;
    });
  }

  function loadSelection() {
    try {
      var raw = window.localStorage.getItem(STORE_KEY);
      if (!raw) return;
      var parsed = JSON.parse(raw);
      if (!parsed || parsed.generated !== INDEX_GENERATION) {
        /* index rebuilt with different wording — old keys would be ghosts */
        window.localStorage.removeItem(STORE_KEY);
        return;
      }
      (parsed.items || []).forEach(function (item) {
        if (item && item.c && item.zh) {
          item.c = pad(item.c);
          state.selection.set(keyOf(item), item);
        }
      });
    } catch (err) {
      /* storage blocked or corrupt: start clean */
    }
  }

  function saveSelection() {
    try {
      window.localStorage.setItem(STORE_KEY, JSON.stringify({
        generated: INDEX_GENERATION,
        items: Array.from(state.selection.values()).map(function (item) {
          return { c: item.c, s: item.s, zh: item.zh, en: item.en, code: item.code };
        })
      }));
    } catch (err) {
      /* private mode: keep it in memory */
    }
  }

  var INDEX_GENERATION = "";

  /* --------------------------------------------------------------- matching */

  function buildPatterns(tokens) {
    state.strict = [];
    state.loose = [];
    state.hasAscii = false;

    tokens.forEach(function (token) {
      if (isAscii(token)) {
        state.hasAscii = true;
        var safe = escapeRegExp(token);
        /* exact word, tolerating the plural forms applicants type */
        state.strict.push(new RegExp("\\b" + safe + "(?:s|es)?\\b", "i"));
        /* word-prefix: only used when the strict pass finds nothing */
        state.loose.push(new RegExp("\\b" + safe, "i"));
      } else {
        state.strict.push(new RegExp(escapeRegExp(token)));
        state.loose.push(new RegExp(escapeRegExp(token)));
      }
    });
  }

  function passes(item, patterns) {
    for (var i = 0; i < patterns.length; i += 1) {
      var re = patterns[i];
      if (!re.test(item.enl) && !re.test(item.zh)) return false;
    }
    return true;
  }

  function scoreItem(item) {
    var q = state.query.toLowerCase();
    var en = item.enl;
    var zh = item.zh;
    var best = 0;

    if (en === q || zh === q) best = 100;
    else if (en.indexOf(q) === 0 || zh.indexOf(q) === 0) best = 60;
    else if (new RegExp("\\b" + escapeRegExp(q)).test(en)) best = 45;
    else if (en.indexOf(q) !== -1 || zh.indexOf(q) !== -1) best = 20;

    /* shorter names are the canonical entries: "clothing" before
       "clothing anti-wrinkle agent" */
    return best - Math.min(item.en.length, 90) / 1000;
  }

  function runQuery() {
    if (!state.tokens.length) return state.items;

    var out = [];
    for (var i = 0; i < state.items.length; i += 1) {
      if (passes(state.items[i], state.strict)) out.push(state.items[i]);
    }
    if (!out.length) {
      for (var j = 0; j < state.items.length; j += 1) {
        if (passes(state.items[j], state.loose)) out.push(state.items[j]);
      }
    }
    return out;
  }

  function filtered() {
    var base = runQuery();
    if (!state.active.size) return base;
    return base.filter(function (item) { return state.active.has(item.c); });
  }

  /* --------------------------------------------------------------- grouping */

  function grouped(list) {
    var map = new Map();
    list.forEach(function (item) {
      if (!map.has(item.c)) map.set(item.c, []);
      map.get(item.c).push(item);
    });

    var groups = Array.from(map.keys()).map(function (code) {
      return { code: code, cls: state.classByCode[code], items: map.get(code) };
    });

    if (state.query) {
      groups.forEach(function (group) {
        group.items.sort(function (a, b) { return scoreItem(b) - scoreItem(a); });
      });
      groups.sort(function (a, b) {
        return b.items.length - a.items.length || a.code.localeCompare(b.code);
      });
    } else {
      groups.sort(function (a, b) { return a.code.localeCompare(b.code); });
    }
    return groups;
  }

  /* ----------------------------------------------------------------- render */

  function buildShell() {
    root.innerHTML =
      '<div class="tm-bar">' +
        '<div class="tm-field">' +
          '<svg class="tm-field__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3a7.5 7.5 0 1 1-4.6 13.4l-3.2 3.2a1 1 0 1 1-1.4-1.4l3.2-3.2A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/></svg>' +
          '<input id="tm-q" class="tm-field__input" type="text" autocomplete="off" spellcheck="false"' +
            ' placeholder="What do you sell? e.g. clothing, software, beer"' +
            ' aria-label="Search goods and services" aria-describedby="tm-status">' +
          '<button id="tm-clear" class="tm-field__clear" type="button" aria-label="Clear search" hidden>&times;</button>' +
        '</div>' +
        '<button id="tm-classbtn" class="tm-cbtn" type="button" aria-haspopup="dialog">' +
          '<span id="tm-classlabel">All 45 classes</span>' +
          '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>' +
        '</button>' +
        '<p id="tm-status" class="tm-status" role="status" aria-live="polite">Loading…</p>' +
      '</div>' +
      '<div id="tm-active" class="tm-activebar" hidden></div>' +
      '<div id="tm-suggest" class="tm-suggest" hidden></div>' +
      '<div class="tm-layout">' +
        '<div class="tm-main">' +
          '<div id="tm-results" class="tm-results"></div>' +
          '<button id="tm-more" class="tm-more" type="button" hidden></button>' +
        '</div>' +
        '<aside id="tm-panel" class="tm-panel" aria-label="Application list">' +
          '<div class="tm-panel__head">' +
            '<h2 class="tm-panel__title">Application list</h2>' +
            '<span id="tm-selcount" class="tm-panel__count">0</span>' +
          '</div>' +
          '<div id="tm-total" class="tm-total"></div>' +
          '<div id="tm-selbody" class="tm-selbody"></div>' +
          '<div class="tm-panel__actions">' +
            '<button id="tm-copy" class="tm-btn tm-btn--primary" type="button">Copy list</button>' +
            '<button id="tm-csv" class="tm-btn" type="button">CSV</button>' +
            '<button id="tm-clearall" class="tm-btn tm-btn--ghost" type="button">Clear</button>' +
          '</div>' +
        '</aside>' +
      '</div>' +
      '<div class="tm-dock" aria-hidden="false">' +
        '<span id="tm-docktext">No items selected</span>' +
        '<button id="tm-dockbtn" class="tm-dock__btn" type="button">View list</button>' +
      '</div>' +
      '<dialog id="tm-dlg" class="tm-dlg" aria-labelledby="tm-dlgtitle">' +
        '<form method="dialog" class="tm-dlg__form">' +
          '<header class="tm-dlg__head">' +
            '<h2 id="tm-dlgtitle">Filter by class</h2>' +
            '<button class="tm-dlg__close" value="close" aria-label="Close">&times;</button>' +
          '</header>' +
          '<div class="tm-dlg__search">' +
            '<input id="tm-dlgq" type="text" placeholder="Filter by name — clothing, software, beer"' +
              ' aria-label="Filter classes by name" autocomplete="off">' +
          '</div>' +
          '<div id="tm-dlglist" class="tm-dlg__list"></div>' +
          '<footer class="tm-dlg__foot">' +
            '<button id="tm-dlgclear" class="tm-btn tm-btn--ghost" type="button">Clear selection</button>' +
            '<button id="tm-dlgdone" class="tm-btn tm-btn--primary" type="submit">Done</button>' +
          '</footer>' +
        '</form>' +
      '</dialog>';

    [
      "q", "clear", "status", "classbtn", "classlabel", "active", "suggest",
      "results", "more", "panel", "selcount", "total", "selbody", "copy", "csv",
      "clearall", "docktext", "dockbtn", "dlg", "dlgq", "dlglist", "dlgclear", "dlgdone"
    ].forEach(function (id) {
      el[id] = document.getElementById("tm-" + id);
    });
  }

  function buildDialog() {
    var groups = [
      { label: "Goods — classes 01–34", from: 1, to: 34 },
      { label: "Services — classes 35–45", from: 35, to: 45 }
    ];

    el.dlglist.innerHTML = groups.map(function (group) {
      var rows = state.classes.filter(function (c) {
        return c.num >= group.from && c.num <= group.to;
      }).map(function (c) {
        return '<label class="tm-crow" data-hay="' +
          escapeHtml((c.code + " " + c.en + " " + c.zh).toLowerCase()) + '">' +
          '<input type="checkbox" value="' + c.code + '"' +
            (state.active.has(c.code) ? " checked" : "") + ">" +
          '<b class="tm-crow__code">' + c.code + "</b>" +
          '<span class="tm-crow__text"><i class="tm-crow__name">' + escapeHtml(c.en) + "</i>" +
            '<i class="tm-crow__zh">' + escapeHtml(c.zh) + "</i></span>" +
          '<span class="tm-crow__n">' + c.count.toLocaleString() + "</span>" +
          "</label>";
      }).join("");
      return '<fieldset class="tm-fieldset"><legend>' + group.label + "</legend>" + rows + "</fieldset>";
    }).join("");
  }

  function renderActive() {
    if (!state.active.size) {
      el.active.hidden = true;
      el.active.innerHTML = "";
      el.classlabel.textContent = "All 45 classes";
      return;
    }
    var codes = Array.from(state.active).sort();
    el.classlabel.textContent = codes.length === 1
      ? "Class " + codes[0]
      : codes.length + " classes";
    el.active.hidden = false;
    el.active.innerHTML = codes.map(function (code) {
      var cls = state.classByCode[code];
      return '<button class="tm-tag" type="button" data-c="' + code + '"' +
        ' aria-label="Remove Class ' + code + " " + escapeHtml(cls ? cls.en : "") + '">' +
        "Class " + code + '<span class="tm-tag__x">&times;</span></button>';
    }).join("") + '<button class="tm-linkbtn" type="button" id="tm-reset">Reset</button>';
  }

  function renderSuggest(list) {
    if (!state.query || !list.length) {
      el.suggest.hidden = true;
      el.suggest.innerHTML = "";
      return;
    }
    var counts = new Map();
    list.forEach(function (item) {
      counts.set(item.c, (counts.get(item.c) || 0) + 1);
    });
    var top = Array.from(counts.entries())
      .sort(function (a, b) { return b[1] - a[1]; })
      .slice(0, 3);

    if (top.length < 2) {
      el.suggest.hidden = true;
      return;
    }

    el.suggest.hidden = false;
    el.suggest.innerHTML = '<span class="tm-suggest__label">Mostly found in</span>' +
      top.map(function (entry) {
        var cls = state.classByCode[entry[0]];
        return '<button type="button" class="tm-suggest__item" data-c="' + entry[0] + '">' +
          "<b>Class " + entry[0] + "</b> " + escapeHtml(cls ? cls.en : "") +
          '<i>' + entry[1] + "</i></button>";
      }).join("");
  }

  function entryState() {
    return '<div class="tm-start">' +
      '<p class="tm-start__title">Where do you want to start?</p>' +
      '<div class="tm-start__grid">' +
        '<button class="tm-start__card" type="button" data-eg="clothing">' +
          '<b>I sell a product</b><span>Search by what the goods are — “clothing”, “cosmetics”, “beer”.</span></button>' +
        '<button class="tm-start__card" type="button" data-open="dlg">' +
          '<b>I know my class number</b><span>Pick classes by name or by the 01–45 number.</span></button>' +
        '<a class="tm-start__card" href="index.html">' +
          '<b>Browse all 45 classes</b><span>Read a whole class, grouped by sub-class.</span></a>' +
      "</div>" +
      '<p class="tm-start__note">Searches the official Chinese wording and its English name at once. ' +
      "No account, nothing leaves your browser.</p>" +
      "</div>";
  }

  function rowHtml(item, patterns) {
    var k = keyOf(item);
    var on = state.selection.has(k);
    return '<div class="tm-row' + (on ? " is-on" : "") + '" data-k="' + escapeHtml(k) + '">' +
      '<span class="tm-row__c">' + item.c + "</span>" +
      '<span class="tm-row__item">' +
        '<span class="tm-row__en">' + highlight(item.en, patterns) + "</span>" +
        '<span class="tm-row__zh">' + highlight(item.zh, patterns) +
          (item.code ? '<code>' + escapeHtml(item.code) + "</code>" : "") +
        "</span>" +
      "</span>" +
      '<span class="tm-row__s" title="' + escapeHtml(state.subZh[item.s] || "sub-class") + '">' + item.s + "</span>" +
      '<button class="tm-add' + (on ? " is-on" : "") + '" type="button" data-k="' + escapeHtml(k) + '"' +
        ' aria-pressed="' + (on ? "true" : "false") + '"' +
        ' aria-label="' + (on ? "Remove " : "Add ") + escapeHtml(item.en || item.zh) + ' to application list">' +
        (on ? "&check;" : "+") + "</button>" +
      "</div>";
  }

  function renderResults() {
    if (!state.query && !state.active.size) {
      el.results.innerHTML = entryState();
      el.more.hidden = true;
      el.status.textContent = "32,665 items · 45 classes · 495 sub-classes";
      return;
    }

    var list = filtered();
    var groups = grouped(list);

    if (!list.length) {
      el.results.innerHTML = '<div class="tm-empty">' +
        '<p class="tm-empty__title">No item matches “' + escapeHtml(state.query) + "”.</p>" +
        "<p>The catalogue uses the official CNIPA wording, which is often more formal than " +
        "the word you have in mind.</p>" +
        '<div class="tm-empty__eg">' +
          ["clothing", "cosmetics", "beer", "medical apparatus", "restaurant"].map(function (eg) {
            return '<button type="button" class="tm-eg" data-eg="' + eg + '">' + eg + "</button>";
          }).join("") +
        "</div></div>";
      el.more.hidden = true;
      el.status.textContent = "No matches";
      renderSuggest([]);
      return;
    }

    var html = "";
    var shown = 0;
    var patterns = state.tokens.map(function (t) { return new RegExp(escapeRegExp(t), "gi"); });

    for (var g = 0; g < groups.length && shown < state.limit; g += 1) {
      var group = groups[g];
      var cls = group.cls;
      html += '<section class="tm-group">' +
        '<header class="tm-ghead">' +
          '<b>Class ' + group.code + "</b>" +
          "<span>" + escapeHtml(cls ? cls.en : "") + "</span>" +
          "<i>" + escapeHtml(cls ? cls.zh : "") + "</i>" +
          '<em>' + group.items.length + "</em>" +
        "</header>";

      for (var i = 0; i < group.items.length && shown < state.limit; i += 1) {
        html += rowHtml(group.items[i], patterns);
        shown += 1;
      }
      html += "</section>";
    }

    el.results.innerHTML = html;
    el.more.hidden = shown >= list.length;
    el.more.textContent = "Show more — " + (list.length - shown).toLocaleString() + " left";

    el.status.textContent = list.length.toLocaleString() + " match" +
      (list.length === 1 ? "" : "es") + (state.active.size ? " in " + state.active.size +
      (state.active.size > 1 ? " classes" : " class") : "");

    renderSuggest(list);
  }

  function totals() {
    var classes = new Set();
    var slots = 0;
    var extras = 0;
    var byClass = new Map();

    state.selection.forEach(function (item) {
      classes.add(item.c);
      slots += 1;
      byClass.set(item.c, (byClass.get(item.c) || 0) + 1);
    });
    byClass.forEach(function (n) {
      if (n > CLASS_INCLUDED) extras += n - CLASS_INCLUDED;
    });

    return {
      classes: classes.size,
      slots: slots,
      extras: extras,
      price: classes.size * CLASS_FEE + extras * EXTRA_FEE
    };
  }

  function renderPanel() {
    var t = totals();
    el.selcount.textContent = String(state.selection.size);

    el.total.innerHTML = state.selection.size
      ? '<span><b>' + t.classes + "</b> class" + (t.classes > 1 ? "es" : "") + "</span>" +
        "<span><b>" + t.slots + "</b> item" + (t.slots > 1 ? "s" : "") + "</span>" +
        "<span class=\"tm-total__price\"><b>USD " + t.price + "</b>" +
        (t.extras ? " incl. " + t.extras + " extra" : "") + "</span>"
      : "";

    el.docktext.textContent = state.selection.size
      ? t.slots + " item" + (t.slots > 1 ? "s" : "") + " · " + t.classes + " class" +
        (t.classes > 1 ? "es" : "") + " · USD " + t.price
      : "No items selected";

    var groups = new Map();
    state.selection.forEach(function (item) {
      if (!groups.has(item.c)) groups.set(item.c, []);
      groups.get(item.c).push(item);
    });

    if (!groups.size) {
      el.selbody.innerHTML = '<p class="tm-selbody__empty">Add items with <b>+</b>. ' +
        "CNIPA includes 10 items per class at USD " + CLASS_FEE +
        "; each extra item is USD " + EXTRA_FEE + ".</p>";
      return;
    }

    var html = "";
    Array.from(groups.keys()).sort().forEach(function (code) {
      var list = groups.get(code);
      var cls = state.classByCode[code];
      var over = list.length > CLASS_INCLUDED;
      html += '<div class="tm-sgroup' + (over ? " is-over" : "") + '">' +
        '<div class="tm-sgroup__head">' +
          "<b>Class " + code + "</b>" +
          '<span class="tm-sgroup__name">' + escapeHtml(cls ? cls.en : "") + "</span>" +
          '<span class="tm-sgroup__count">' + list.length + "/" + CLASS_INCLUDED + "</span>" +
        "</div>" +
        '<ul class="tm-sgroup__list">' +
          list.map(function (item) {
            return "<li>" +
              '<span class="tm-sgroup__item"><b>' + escapeHtml(item.zh) + "</b>" +
              (item.en ? "<i>" + escapeHtml(item.en) + "</i>" : "") + "</span>" +
              '<button type="button" class="tm-remove" data-k="' + escapeHtml(keyOf(item)) +
              '" aria-label="Remove ' + escapeHtml(item.zh) + '">&times;</button></li>';
          }).join("") +
        "</ul>" +
        (over
          ? '<p class="tm-sgroup__warn">' + (list.length - CLASS_INCLUDED) +
            " over the 10 included · +USD " + (list.length - CLASS_INCLUDED) * EXTRA_FEE + "</p>"
          : "") +
        "</div>";
    });
    el.selbody.innerHTML = html;
  }

  function syncAddButtons() {
    var buttons = el.results.querySelectorAll(".tm-add");
    for (var i = 0; i < buttons.length; i += 1) {
      var k = buttons[i].getAttribute("data-k");
      var on = state.selection.has(k);
      buttons[i].classList.toggle("is-on", on);
      buttons[i].setAttribute("aria-pressed", on ? "true" : "false");
      buttons[i].innerHTML = on ? "&check;" : "+";
      var row = buttons[i].parentNode;
      if (row && row.classList.contains("tm-row")) row.classList.toggle("is-on", on);
    }
  }

  function syncUrl() {
    var params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.active.size) params.set("class", Array.from(state.active).sort().join(","));
    var qs = params.toString();
    window.history.replaceState(null, "", window.location.pathname + (qs ? "?" + qs : ""));
  }

  /* --------------------------------------------------------------- actions */

  function toggleItem(k) {
    var item = state.itemsByKey[k];
    if (!item) return;
    if (state.selection.has(k)) state.selection.delete(k);
    else state.selection.set(k, item);
    saveSelection();
    /* Update in place: rebuilding the list on every click drops keyboard focus
       and makes the page jump. */
    syncAddButtons();
    renderPanel();
  }

  function applyQuery(value) {
    state.query = value.trim();
    state.tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    buildPatterns(state.tokens);
    state.limit = PAGE_SIZE;
    el.clear.hidden = state.query === "";
    renderResults();
    syncUrl();
  }

  function applyClass(code) {
    if (state.active.has(code)) state.active.delete(code);
    else state.active.add(code);
    state.limit = PAGE_SIZE;
    renderActive();
    renderResults();
    syncUrl();
  }

  function resetAll() {
    state.active.clear();
    el.q.value = "";
    applyQuery("");
    renderActive();
  }

  function selectionText() {
    var t = totals();
    var byClass = new Map();
    state.selection.forEach(function (item) {
      if (!byClass.has(item.c)) byClass.set(item.c, []);
      byClass.get(item.c).push(item);
    });

    var lines = [
      "China trademark application — goods & services list",
      "Generated " + new Date().toISOString().slice(0, 10) +
        " · " + t.classes + " class(es), " + t.slots + " item(s), USD " + t.price,
      ""
    ];

    Array.from(byClass.keys()).sort().forEach(function (code) {
      var list = byClass.get(code);
      var cls = state.classByCode[code];
      lines.push("Class " + code + " — " + (cls ? cls.zh + " / " + cls.en : "") +
        " (" + list.length + " item" + (list.length === 1 ? "" : "s") +
        (list.length > CLASS_INCLUDED ? ", " + (list.length - CLASS_INCLUDED) + " over the 10 included" : "") + ")");
      list.forEach(function (item, index) {
        lines.push("  " + (index + 1) + ". " + item.zh + " — " + item.en +
          (item.code ? " [" + item.code + "]" : "") + " (sub-class " + item.s + ")");
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  function copyText(text, button) {
    function done(ok) {
      var original = button.textContent;
      button.textContent = ok ? "Copied" : "Copy failed";
      button.disabled = true;
      window.setTimeout(function () {
        button.textContent = original;
        button.disabled = false;
      }, 1500);
    }

    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { done(true); }, function () {
        done(legacyCopy(text));
      });
    } else {
      done(legacyCopy(text));
    }
  }

  function legacyCopy(text) {
    var area = document.createElement("textarea");
    area.value = text;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    var ok = false;
    try { ok = document.execCommand("copy"); } catch (err) { ok = false; }
    document.body.removeChild(area);
    return ok;
  }

  function downloadCsv() {
    var rows = [["class", "class_en", "subclass", "item_zh", "item_en", "code"]];
    Array.from(state.selection.values()).sort(function (a, b) {
      return a.c.localeCompare(b.c) || a.s.localeCompare(b.s);
    }).forEach(function (item) {
      var cls = state.classByCode[item.c];
      rows.push([item.c, cls ? cls.en : "", item.s, item.zh, item.en, item.code]);
    });

    var csv = rows.map(function (row) {
      return row.map(function (cell) { return '"' + String(cell).replace(/"/g, '""') + '"'; }).join(",");
    }).join("\r\n");

    var blob = new Blob(["\ufeff" + csv], { type: "text/csv;charset=utf-8" });
    var url = URL.createObjectURL(blob);
    var link = document.createElement("a");
    link.href = url;
    link.download = "china-trademark-goods-services.csv";
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  /* ------------------------------------------------------------------ boot */

  function bind() {
    var timer = null;
    var composing = false;

    el.q.addEventListener("compositionstart", function () { composing = true; });
    el.q.addEventListener("compositionend", function () {
      composing = false;
      applyQuery(el.q.value);
    });

    el.q.addEventListener("input", function () {
      if (composing) return;
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { applyQuery(el.q.value); }, 150);
    });

    el.q.addEventListener("keydown", function (event) {
      if (event.key === "Escape") {
        el.q.value = "";
        applyQuery("");
      }
    });

    el.clear.addEventListener("click", function () {
      el.q.value = "";
      applyQuery("");
      el.q.focus();
    });

    el.classbtn.addEventListener("click", function () {
      buildDialog();
      if (typeof el.dlg.showModal === "function") el.dlg.showModal();
      else el.dlg.setAttribute("open", "");
    });

    el.dlgq.addEventListener("input", function () {
      var q = el.dlgq.value.trim().toLowerCase();
      var rows = el.dlglist.querySelectorAll(".tm-crow");
      for (var i = 0; i < rows.length; i += 1) {
        rows[i].hidden = q !== "" && rows[i].getAttribute("data-hay").indexOf(q) === -1;
      }
    });

    el.dlglist.addEventListener("change", function (event) {
      var box = event.target;
      if (!box || box.type !== "checkbox") return;
      state.active = new Set(
        Array.prototype.filter.call(
          el.dlglist.querySelectorAll("input:checked"),
          function (input) { return input.checked; }
        ).map(function (input) { return input.value; })
      );
      state.limit = PAGE_SIZE;
      renderActive();
      renderResults();
      syncUrl();
    });

    el.dlgclear.addEventListener("click", function () {
      state.active.clear();
      buildDialog();
      renderActive();
      renderResults();
      syncUrl();
    });

    el.dlgdone.addEventListener("click", function () {
      if (typeof el.dlg.close === "function") el.dlg.close();
    });

    el.active.addEventListener("click", function (event) {
      if (event.target.id === "tm-reset") { resetAll(); return; }
      var tag = event.target.closest(".tm-tag");
      if (tag) applyClass(tag.getAttribute("data-c"));
    });

    el.suggest.addEventListener("click", function (event) {
      var button = event.target.closest(".tm-suggest__item");
      if (button) applyClass(button.getAttribute("data-c"));
    });

    el.results.addEventListener("click", function (event) {
      var add = event.target.closest(".tm-add");
      if (add) { toggleItem(add.getAttribute("data-k")); return; }

      var example = event.target.closest("[data-eg]");
      if (example) {
        el.q.value = example.getAttribute("data-eg");
        applyQuery(el.q.value);
        return;
      }

      var opener = event.target.closest("[data-open]");
      if (opener) {
        buildDialog();
        if (typeof el.dlg.showModal === "function") el.dlg.showModal();
      }
    });

    el.selbody.addEventListener("click", function (event) {
      var button = event.target.closest(".tm-remove");
      if (button) toggleItem(button.getAttribute("data-k"));
    });

    el.more.addEventListener("click", function () {
      state.limit += PAGE_SIZE;
      renderResults();
    });

    el.copy.addEventListener("click", function () {
      copyText(selectionText(), el.copy);
    });

    el.csv.addEventListener("click", downloadCsv);

    /* Clear is destructive, so it becomes Undo for a few seconds. A single
       listener with a backup slot avoids double-handling the undo click. */
    var undoBackup = null;
    var undoTimer = null;

    el.clearall.addEventListener("click", function () {
      if (undoBackup) {
        state.selection = undoBackup;
        undoBackup = null;
        window.clearTimeout(undoTimer);
        el.clearall.textContent = "Clear";
        saveSelection();
        renderPanel();
        syncAddButtons();
        return;
      }
      if (!state.selection.size) return;

      undoBackup = new Map(state.selection);
      state.selection.clear();
      el.clearall.textContent = "Undo";
      saveSelection();
      renderPanel();
      syncAddButtons();

      undoTimer = window.setTimeout(function () {
        if (undoBackup) {
          undoBackup = null;
          el.clearall.textContent = "Clear";
        }
      }, 6000);
    });

    el.dockbtn.addEventListener("click", function () {
      el.panel.scrollIntoView({ behavior: "smooth", block: "start" });
    });

    /* "/" focuses search, but only when this tool owns the viewport region —
       Material's own search binds "/" as well. */
    document.addEventListener("keydown", function (event) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      if (el.dlg.open) return;
      var box = root.getBoundingClientRect();
      if (box.bottom < 0 || box.top > window.innerHeight) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      el.q.focus();
    });
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get("q");
    var cls = params.get("class");

    if (cls) {
      cls.split(",").forEach(function (code) {
        var clean = code.trim();
        if (/^\d{1,2}$/.test(clean)) state.active.add(pad(clean));
      });
    }
    renderActive();

    if (q) {
      el.q.value = q;
      applyQuery(q);
    } else {
      renderResults();
    }
  }

  function init(payload) {
    INDEX_GENERATION = payload.generated || "";
    normalise(payload);
    loadSelection();
    bind();
    readUrl();
    renderPanel();
    state.ready = true;
  }

  buildShell();

  fetch(INDEX_URL, { credentials: "same-origin" })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(init)
    .catch(function (error) {
      el.status.textContent = "Index unavailable";
      el.results.innerHTML = '<div class="tm-empty">' +
        '<p class="tm-empty__title">The search index did not load.</p>' +
        "<p>" + escapeHtml(error.message) + ". Reload the page, or use the " +
        '<a href="index.html">45 class pages</a> and the ' +
        '<a href="../data/search-index.json">raw JSON</a> instead.</p></div>';
    });
})();
