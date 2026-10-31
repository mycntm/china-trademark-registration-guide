/* ==========================================================================
   China trademark classification search
   --------------------------------------------------------------------------
   Client-side search over all 32,665 goods and services items. The page is
   static: data/search-index.json is fetched once (2.2 MB raw, ~580 KB
   gzipped) and filtered in memory, so results are instant and nothing leaves
   the browser.

   The widget only initialises when #tm-search exists, so this file can be
   loaded site-wide without affecting other pages.
   ========================================================================== */

(function () {
  "use strict";

  var root = document.getElementById("tm-search");
  if (!root) return;

  var INDEX_URL = root.getAttribute("data-index") || "../data/search-index.json";
  var STORE_KEY = "cnclass.selection.v1";
  var PAGE_SIZE = 60;

  var state = {
    items: [],
    classes: [],
    subNames: {},
    query: "",
    tokens: [],
    activeClasses: new Set(),
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

  function highlight(text, tokens) {
    var safe = escapeHtml(text);
    if (!tokens.length) return safe;
    var pattern = new RegExp("(" + tokens.map(escapeRegExp).join("|") + ")", "gi");
    return safe.replace(pattern, "<mark>$1</mark>");
  }

  function keyOf(item) {
    return item.c + "|" + item.s + "|" + item.zh;
  }

  /* ------------------------------------------------------------- data load */

  function normalise(payload) {
    state.classes = payload.classes.map(function (c) {
      return { code: c[0], zh: c[1], en: c[2], page: c[3], num: parseInt(c[0], 10), count: 0 };
    });

    var byNum = {};
    state.classes.forEach(function (c) { byNum[c.num] = c; });

    payload.subclasses.forEach(function (s) {
      state.subNames[s[1]] = s[2];
    });

    state.items = payload.items.map(function (row) {
      var cls = byNum[row[0]];
      var item = {
        c: row[0],
        code: row[4] || "",
        s: row[1],
        zh: row[2],
        en: row[3] || "",
        cls: cls
      };
      item.h = (item.zh + " " + item.en + " " + item.s + " " + item.code).toLowerCase();
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
      JSON.parse(raw).forEach(function (item) {
        if (item && item.c && item.zh) state.selection.set(keyOf(item), item);
      });
    } catch (err) {
      /* corrupted or blocked storage — start clean */
    }
  }

  function saveSelection() {
    try {
      window.localStorage.setItem(
        STORE_KEY,
        JSON.stringify(Array.from(state.selection.values()))
      );
    } catch (err) {
      /* private mode: keep it in memory only */
    }
  }

  /* --------------------------------------------------------------- filters */

  function matches(item) {
    if (state.activeClasses.size && !state.activeClasses.has(item.c)) return false;
    if (!state.tokens.length) return true;
    for (var i = 0; i < state.tokens.length; i += 1) {
      if (item.h.indexOf(state.tokens[i]) === -1) return false;
    }
    return true;
  }

  function filtered() {
    if (!state.tokens.length && !state.activeClasses.size) return state.items;
    var out = [];
    for (var i = 0; i < state.items.length; i += 1) {
      if (matches(state.items[i])) out.push(state.items[i]);
    }
    return out;
  }

  /* ---------------------------------------------------------------- render */

  function buildShell() {
    root.innerHTML =
      '<div class="tm-bar">' +
        '<div class="tm-field">' +
          '<svg class="tm-field__icon" viewBox="0 0 24 24" aria-hidden="true"><path d="M10.5 3a7.5 7.5 0 1 1-4.6 13.4l-3.2 3.2a1 1 0 1 1-1.4-1.4l3.2-3.2A7.5 7.5 0 0 1 10.5 3Zm0 2a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11Z"/></svg>' +
          '<input id="tm-q" class="tm-field__input" type="search" autocomplete="off" spellcheck="false"' +
            ' placeholder="Search in English or Chinese — computer software, 化妆品, 4209"' +
            ' aria-label="Search goods and services">' +
          '<kbd class="tm-kbd" aria-hidden="true">/</kbd>' +
          '<button id="tm-clear" class="tm-field__clear" type="button" aria-label="Clear search" hidden>&times;</button>' +
        '</div>' +
        '<p id="tm-status" class="tm-status">Loading 32,665 items…</p>' +
      '</div>' +
      '<div id="tm-chips" class="tm-chips" role="group" aria-label="Filter by class"></div>' +
      '<div class="tm-layout">' +
        '<div class="tm-main">' +
          '<div class="tm-head">' +
            '<span id="tm-count" class="tm-count"></span>' +
            '<button id="tm-reset" class="tm-linkbtn" type="button">Reset filters</button>' +
          '</div>' +
          '<div id="tm-tablewrap" class="tm-tablewrap" hidden>' +
            '<table class="tm-table">' +
              '<thead><tr>' +
                '<th scope="col" class="tm-col-cls">Class</th>' +
                '<th scope="col" class="tm-col-sub">Sub-class</th>' +
                '<th scope="col">中文</th>' +
                '<th scope="col">English</th>' +
                '<th scope="col" class="tm-col-code">Code</th>' +
                '<th scope="col" class="tm-col-add"><span class="tm-sr">Add to list</span></th>' +
              '</tr></thead>' +
              '<tbody id="tm-rows"></tbody>' +
            '</table>' +
          '</div>' +
          '<button id="tm-more" class="tm-more" type="button" hidden>Show more results</button>' +
          '<div id="tm-empty" class="tm-empty" hidden></div>' +
        '</div>' +
        '<aside class="tm-panel" aria-label="Your application list">' +
          '<div class="tm-panel__head">' +
            '<h2 class="tm-panel__title">Application list</h2>' +
            '<span id="tm-selcount" class="tm-panel__count">0</span>' +
          '</div>' +
          '<p class="tm-panel__hint">CNIPA: 10 items are included per class; each extra item costs USD 10.</p>' +
          '<div id="tm-selbody" class="tm-selbody"></div>' +
          '<div class="tm-panel__actions">' +
            '<button id="tm-copy" class="tm-btn tm-btn--primary" type="button">Copy list</button>' +
            '<button id="tm-csv" class="tm-btn" type="button">Download CSV</button>' +
            '<button id="tm-clearall" class="tm-btn tm-btn--ghost" type="button">Clear</button>' +
          '</div>' +
        '</aside>' +
      '</div>';

    el.q = document.getElementById("tm-q");
    el.clear = document.getElementById("tm-clear");
    el.status = document.getElementById("tm-status");
    el.chips = document.getElementById("tm-chips");
    el.count = document.getElementById("tm-count");
    el.reset = document.getElementById("tm-reset");
    el.wrap = document.getElementById("tm-tablewrap");
    el.rows = document.getElementById("tm-rows");
    el.more = document.getElementById("tm-more");
    el.empty = document.getElementById("tm-empty");
    el.selcount = document.getElementById("tm-selcount");
    el.selbody = document.getElementById("tm-selbody");
    el.copy = document.getElementById("tm-copy");
    el.csv = document.getElementById("tm-csv");
    el.clearall = document.getElementById("tm-clearall");
  }

  function buildChips() {
    var html = ['<button class="tm-chip is-all is-on" type="button" data-c="">All 45 classes</button>'];
    state.classes.forEach(function (c) {
      html.push(
        '<button class="tm-chip" type="button" data-c="' + c.code + '"' +
        ' title="Class ' + c.code + ' — ' + escapeHtml(c.en) + '">' +
        c.code + '<span class="tm-chip__n">' + c.count + "</span></button>"
      );
    });
    el.chips.innerHTML = html.join("");
  }

  function syncChips() {
    var chips = el.chips.querySelectorAll(".tm-chip");
    for (var i = 0; i < chips.length; i += 1) {
      var code = chips[i].getAttribute("data-c");
      if (code === "") {
        chips[i].classList.toggle("is-on", state.activeClasses.size === 0);
      } else {
        chips[i].classList.toggle("is-on", state.activeClasses.has(code));
        chips[i].setAttribute("aria-pressed", state.activeClasses.has(code) ? "true" : "false");
      }
    }
  }

  function renderResults() {
    var list = filtered();

    if (!state.query && !state.activeClasses.size) {
      el.count.innerHTML = "<b>" + list.length.toLocaleString() + "</b> items across 45 classes";
    } else {
      var scope = state.activeClasses.size
        ? " in " + state.activeClasses.size + (state.activeClasses.size > 1 ? " classes" : " class")
        : "";
      el.count.innerHTML = "<b>" + list.length.toLocaleString() + "</b> match" +
        (list.length === 1 ? "" : "es") + scope;
    }

    el.status.textContent = state.query || state.activeClasses.size
      ? list.length.toLocaleString() + " of " + state.items.length.toLocaleString() + " items"
      : state.items.length.toLocaleString() + " items · 45 classes · " +
        Object.keys(state.subNames).length + " sub-classes";

    if (!list.length) {
      el.wrap.hidden = true;
      el.more.hidden = true;
      el.empty.hidden = false;
      el.empty.innerHTML =
        '<p class="tm-empty__title">No item matches “' + escapeHtml(state.query) + '”.</p>' +
        '<p>Chinese and English names are both searchable. Try a broader term, a class number, ' +
        "or one of these:</p>" +
        '<div class="tm-empty__eg">' +
          ['computer software', 'cosmetics', 'beer', 'medical apparatus', 'clothing'].map(function (eg) {
            return '<button type="button" class="tm-eg" data-q="' + eg + '">' + eg + "</button>";
          }).join("") +
        "</div>";
      return;
    }

    el.empty.hidden = true;
    el.wrap.hidden = false;

    var slice = list.slice(0, state.limit);
    var html = "";
    for (var i = 0; i < slice.length; i += 1) {
      var item = slice[i];
      var k = keyOf(item);
      var on = state.selection.has(k);
      html +=
        "<tr>" +
          '<td class="tm-col-cls"><a class="tm-clink" href="' +
            (item.cls && item.cls.page ? item.cls.page : "#") + '">' +
            String(item.c).padStart(2, "0") + "</a></td>" +
          '<td class="tm-col-sub"><span class="tm-sub" title="' +
            escapeHtml(state.subNames[item.s] || "") + '">' + item.s + "</span></td>" +
          '<td class="tm-zh">' + highlight(item.zh, state.tokens) + "</td>" +
          '<td class="tm-en">' + highlight(item.en, state.tokens) + "</td>" +
          '<td class="tm-col-code"><code>' + escapeHtml(item.code) + "</code></td>" +
          '<td class="tm-col-add"><button class="tm-add' + (on ? " is-on" : "") +
            '" type="button" data-k="' + escapeHtml(k) + '" aria-pressed="' + (on ? "true" : "false") +
            '" aria-label="' + (on ? "Remove from" : "Add to") + ' application list">' +
            (on ? "&check;" : "+") + "</button></td>" +
        "</tr>";
    }
    el.rows.innerHTML = html;
    el.more.hidden = list.length <= state.limit;
    el.more.textContent = "Show " + Math.min(PAGE_SIZE, list.length - state.limit) + " more of " +
      list.length.toLocaleString();
  }

  function renderSelection() {
    var groups = new Map();
    state.selection.forEach(function (item) {
      if (!groups.has(item.c)) groups.set(item.c, []);
      groups.get(item.c).push(item);
    });

    el.selcount.textContent = String(state.selection.size);

    if (!groups.size) {
      el.selbody.innerHTML =
        '<p class="tm-selbody__empty">Pick items with <span class="tm-plus">+</span> to build a ' +
        "filing list. It stays in this browser and can be copied or exported at any time.</p>";
      return;
    }

    var html = "";
    Array.from(groups.keys()).sort(function (a, b) { return a - b; }).forEach(function (num) {
      var list = groups.get(num);
      var cls = list[0].cls;
      var over = list.length > 10;
      html +=
        '<div class="tm-group' + (over ? " is-over" : "") + '">' +
          '<div class="tm-group__head">' +
            "<b>Class " + String(num).padStart(2, "0") + "</b>" +
            '<span class="tm-group__meta">' + escapeHtml(cls ? cls.en : "") + "</span>" +
            '<span class="tm-group__count">' + list.length + "/10</span>" +
          "</div>" +
          '<ul class="tm-group__list">' +
            list.map(function (item) {
              return "<li><span>" + escapeHtml(item.zh) + "</span>" +
                '<button type="button" class="tm-remove" data-k="' + escapeHtml(keyOf(item)) +
                '" aria-label="Remove">&times;</button></li>';
            }).join("") +
          "</ul>" +
          (over
            ? '<p class="tm-group__warn">' + (list.length - 10) +
              " extra item(s) — USD " + (list.length - 10) * 10 + " additional official handling.</p>"
            : "") +
        "</div>";
    });
    el.selbody.innerHTML = html;
  }

  function syncUrl() {
    var params = new URLSearchParams();
    if (state.query) params.set("q", state.query);
    if (state.activeClasses.size) {
      params.set("class", Array.from(state.activeClasses).join(","));
    }
    var qs = params.toString();
    var url = window.location.pathname + (qs ? "?" + qs : "") + window.location.hash;
    window.history.replaceState(null, "", url);
  }

  function refresh(keepLimit) {
    if (!keepLimit) state.limit = PAGE_SIZE;
    renderResults();
    syncChips();
    syncUrl();
  }

  function applyQuery(value) {
    state.query = value.trim();
    state.tokens = state.query.toLowerCase().split(/\s+/).filter(Boolean);
    el.clear.hidden = state.query === "";
    refresh();
  }

  /* --------------------------------------------------------------- actions */

  function toggleItem(k) {
    var item = state.itemsByKey[k];
    if (!item) return;
    if (state.selection.has(k)) state.selection.delete(k);
    else state.selection.set(k, item);
    saveSelection();
    renderSelection();
    renderResults();
  }

  function selectionText() {
    var groups = new Map();
    state.selection.forEach(function (item) {
      if (!groups.has(item.c)) groups.set(item.c, []);
      groups.get(item.c).push(item);
    });
    var lines = [
      "China trademark application — goods & services list",
      "Source: China Nice Classification (32,665 items), " + new Date().toISOString().slice(0, 10),
      ""
    ];
    Array.from(groups.keys()).sort(function (a, b) { return a - b; }).forEach(function (num) {
      var list = groups.get(num);
      var cls = list[0].cls;
      lines.push(
        "Class " + String(num).padStart(2, "0") + " — " +
        (cls ? cls.zh + " / " + cls.en : "") + " (" + list.length + " item" +
        (list.length === 1 ? "" : "s") + (list.length > 10 ? ", " + (list.length - 10) + " over the 10 included" : "") + ")"
      );
      list.forEach(function (item, index) {
        lines.push(
          "  " + (index + 1) + ". " + item.zh + " — " + item.en +
          (item.code ? " [" + item.code + "]" : "") + " (sub-class " + item.s + ")"
        );
      });
      lines.push("");
    });
    return lines.join("\n");
  }

  function downloadCsv() {
    var rows = [["class", "class_en", "subclass", "item_zh", "item_en", "code"]];
    Array.from(state.selection.values()).forEach(function (item) {
      rows.push([
        String(item.c).padStart(2, "0"),
        item.cls ? item.cls.en : "",
        item.s,
        item.zh,
        item.en,
        item.code
      ]);
    });
    var csv = rows.map(function (row) {
      return row.map(function (cell) {
        return '"' + String(cell).replace(/"/g, '""') + '"';
      }).join(",");
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

  function flash(button, message) {
    var original = button.textContent;
    button.textContent = message;
    button.disabled = true;
    window.setTimeout(function () {
      button.textContent = original;
      button.disabled = false;
    }, 1400);
  }

  /* ------------------------------------------------------------------ boot */

  function bind() {
    var timer = null;
    el.q.addEventListener("input", function () {
      window.clearTimeout(timer);
      timer = window.setTimeout(function () { applyQuery(el.q.value); }, 130);
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

    el.chips.addEventListener("click", function (event) {
      var chip = event.target.closest(".tm-chip");
      if (!chip) return;
      var code = chip.getAttribute("data-c");
      if (code === "") {
        state.activeClasses.clear();
      } else if (state.activeClasses.has(code)) {
        state.activeClasses.delete(code);
      } else {
        state.activeClasses.add(code);
      }
      refresh();
    });

    el.reset.addEventListener("click", function () {
      el.q.value = "";
      state.activeClasses.clear();
      applyQuery("");
    });

    el.rows.addEventListener("click", function (event) {
      var button = event.target.closest(".tm-add");
      if (!button) return;
      toggleItem(button.getAttribute("data-k"));
    });

    el.selbody.addEventListener("click", function (event) {
      var button = event.target.closest(".tm-remove");
      if (!button) return;
      toggleItem(button.getAttribute("data-k"));
    });

    el.more.addEventListener("click", function () {
      state.limit += PAGE_SIZE;
      renderResults();
    });

    el.empty.addEventListener("click", function (event) {
      var example = event.target.closest(".tm-eg");
      if (!example) return;
      el.q.value = example.getAttribute("data-q");
      applyQuery(el.q.value);
    });

    el.copy.addEventListener("click", function (event) {
      var text = selectionText();
      var button = event.currentTarget;
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { flash(button, "Copied"); });
      } else {
        var area = document.createElement("textarea");
        area.value = text;
        document.body.appendChild(area);
        area.select();
        try { document.execCommand("copy"); flash(button, "Copied"); } catch (err) { flash(button, "Copy failed"); }
        document.body.removeChild(area);
      }
    });

    el.csv.addEventListener("click", downloadCsv);

    el.clearall.addEventListener("click", function () {
      state.selection.clear();
      saveSelection();
      renderSelection();
      renderResults();
    });

    document.addEventListener("keydown", function (event) {
      if (event.key !== "/" || event.metaKey || event.ctrlKey) return;
      var tag = (document.activeElement && document.activeElement.tagName) || "";
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      event.preventDefault();
      el.q.focus();
    });
  }

  function readUrl() {
    var params = new URLSearchParams(window.location.search);
    var q = params.get("q");
    var cls = params.get("class");
    if (q) {
      el.q.value = q;
      applyQuery(q);
    }
    if (cls) {
      cls.split(",").forEach(function (code) {
        var clean = code.trim();
        if (/^\d{1,2}$/.test(clean)) state.activeClasses.add(clean.padStart(2, "0"));
      });
      refresh();
    }
  }

  function init(payload) {
    normalise(payload);
    loadSelection();
    buildChips();
    bind();
    readUrl();
    renderSelection();
    refresh();
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
      el.status.textContent = "Could not load the index (" + error.message + ").";
      el.empty.hidden = false;
      el.empty.innerHTML =
        '<p class="tm-empty__title">The search index did not load.</p>' +
        "<p>Reload the page, or open the <a href=\"../data/search-index.json\">raw JSON</a> " +
        "and the <a href=\"index.html\">45 class pages</a> instead.</p>";
    });
})();
