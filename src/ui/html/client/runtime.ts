// Browser runtime for the Covara admin UI: command palette (Cmd/Ctrl-K),
// rich toasts, clipboard copy, relative timestamps, and a small fetch helper.
// Served verbatim as application/javascript; no build step, no dependencies.
export const runtimeScript = String.raw`
(function () {
  var cfg = window.__COVARA__ || {};
  var base = cfg.basePath || '/__covara';

  // ---- helpers -------------------------------------------------------------
  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') n.className = attrs[k];
      else if (k === 'html') n.innerHTML = attrs[k];
      else if (k === 'text') n.textContent = attrs[k];
      else if (k.slice(0,2) === 'on' && typeof attrs[k] === 'function') n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null) n.setAttribute(k, attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c != null) n.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return n;
  }
  function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;' }[c];
    });
  }

  // ---- toasts --------------------------------------------------------------
  function ensureToasts() {
    var c = document.getElementById('toast-container');
    if (!c) { c = el('div', { id: 'toast-container', class: 'toast-container' }); document.body.appendChild(c); }
    return c;
  }
  function toast(message, type) {
    type = type || 'success';
    var icons = { success: '✓', error: '✕', info: 'ℹ', warning: '⚠' };
    var t = el('div', { class: 'toast toast-' + type }, [
      el('span', { text: icons[type] || '', style: 'font-weight:700;color:var(--' + (type==='success'?'success':type==='error'?'error':'info') + ')' }),
      el('span', { text: message, style: 'flex:1' })
    ]);
    ensureToasts().appendChild(t);
    setTimeout(function () { t.style.opacity = '0'; t.style.transform = 'translateY(6px)'; setTimeout(function(){ t.remove(); }, 200); }, 3200);
  }
  window.showToast = toast; // back-compat with existing inline handlers

  // ---- fetch helper --------------------------------------------------------
  async function fetchJSON(url, opts) {
    var res = await fetch(url, Object.assign({ headers: { 'Accept': 'application/json' }, credentials: 'same-origin' }, opts || {}));
    var body = null;
    try { body = await res.json(); } catch (e) {}
    if (!res.ok) {
      var msg = (body && (body.detail || body.title)) || ('Request failed (' + res.status + ')');
      var err = new Error(msg); err.status = res.status; err.body = body; throw err;
    }
    return body;
  }

  // ---- clipboard -----------------------------------------------------------
  function copy(text) {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(function () { toast('Copied to clipboard', 'success'); });
    }
  }
  document.addEventListener('click', function (e) {
    var b = e.target.closest && e.target.closest('[data-copy]');
    if (b) { e.preventDefault(); copy(b.getAttribute('data-copy')); }
  });

  // ---- relative time -------------------------------------------------------
  function relTime(ts) {
    var d = (typeof ts === 'number' ? ts : Date.parse(ts));
    if (isNaN(d)) return '';
    var s = Math.round((Date.now() - d) / 1000);
    if (s < 60) return s + 's ago';
    if (s < 3600) return Math.floor(s/60) + 'm ago';
    if (s < 86400) return Math.floor(s/3600) + 'h ago';
    return Math.floor(s/86400) + 'd ago';
  }
  function refreshTimes() {
    document.querySelectorAll('[data-time]').forEach(function (n) { n.textContent = relTime(n.getAttribute('data-time')); });
  }
  setInterval(refreshTimes, 30000);

  // ---- JSON syntax highlight ----------------------------------------------
  function highlightJSON(value) {
    var json = typeof value === 'string' ? value : JSON.stringify(value, null, 2);
    return escapeHtml(json).replace(
      /("(\\u[a-zA-Z0-9]{4}|\\[^u]|[^\\"])*"(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d*)?(?:[eE][+\-]?\d+)?)/g,
      function (m) {
        var cls = 'n';
        if (/^"/.test(m)) cls = /:$/.test(m) ? 'k' : 's';
        else if (/true|false|null/.test(m)) cls = 'b';
        return '<span class="' + cls + '">' + m + '</span>';
      }
    );
  }

  // ---- command palette -----------------------------------------------------
  var palette = null, paletteItems = [], paletteFiltered = [], paletteIdx = 0;

  function buildPalette() {
    var overlay = el('div', { class: 'overlay', id: 'cmdk-overlay' });
    var box = el('div', { class: 'cmdk' }, [
      el('div', { class: 'cmdk-box' }, [
        el('input', { class: 'input cmdk-input', id: 'cmdk-input', placeholder: 'Search pages, resources, actions…', autocomplete: 'off' }),
        el('div', { class: 'cmdk-list', id: 'cmdk-list' })
      ])
    ]);
    overlay.appendChild(box);
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closePalette(); });
    document.body.appendChild(overlay);
    palette = overlay;
    var input = overlay.querySelector('#cmdk-input');
    input.addEventListener('input', function () { renderPalette(input.value); });
    input.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowDown') { e.preventDefault(); paletteIdx = Math.min(paletteIdx + 1, paletteFiltered.length - 1); renderActive(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); paletteIdx = Math.max(paletteIdx - 1, 0); renderActive(); }
      else if (e.key === 'Enter') { e.preventDefault(); if (paletteFiltered[paletteIdx]) runItem(paletteFiltered[paletteIdx]); }
      else if (e.key === 'Escape') { closePalette(); }
    });
  }

  function collectItems() {
    var items = [];
    (cfg.nav || []).forEach(function (s) {
      (s.items || []).forEach(function (it) {
        items.push({ group: s.title, icon: it.icon, label: it.label, hint: 'Page', action: function () { go(it.href); } });
      });
    });
    var ICO_THEME = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3a6 6 0 0 0 9 9 9 9 0 1 1-9-9Z"/></svg>';
    var ICO_RES = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><path d="M3 9h18"/><path d="M3 15h18"/><path d="M9 3v18"/></svg>';
    items.push({ group: 'Appearance', icon: ICO_THEME, label: 'Toggle theme', hint: '', action: function () { if (window.toggleTheme) window.toggleTheme(); } });
    paletteItems = items;
    // resources (best-effort) for quick jump into the data explorer
    fetchJSON(base + '/api/explorer/schemas').then(function (r) {
      (r.schemas || []).forEach(function (s) {
        var name = s.name || s.resource || s;
        paletteItems.push({ group: 'Resources', icon: ICO_RES, label: name, hint: 'Open in Data Explorer',
          action: function () { go(base + '/ui/data-explorer?resource=' + encodeURIComponent(name)); } });
      });
    }).catch(function () {});
  }

  function go(href) { closePalette(); window.location.href = href; }
  function runItem(it) { it.action(); }

  function renderPalette(q) {
    q = (q || '').toLowerCase().trim();
    paletteFiltered = q ? paletteItems.filter(function (it) { return it.label.toLowerCase().indexOf(q) >= 0 || (it.group||'').toLowerCase().indexOf(q) >= 0; }) : paletteItems.slice();
    paletteIdx = 0;
    var list = palette.querySelector('#cmdk-list');
    list.innerHTML = '';
    var lastGroup = null;
    if (!paletteFiltered.length) { list.appendChild(el('div', { class: 'cmdk-group', text: 'No results' })); return; }
    paletteFiltered.forEach(function (it, i) {
      if (it.group !== lastGroup) { list.appendChild(el('div', { class: 'cmdk-group', text: it.group })); lastGroup = it.group; }
      var row = el('div', { class: 'cmdk-item' + (i === 0 ? ' active' : ''), 'data-idx': i }, [
        el('span', { class: 'cmdk-ico', html: it.icon || '' }),
        el('span', { text: it.label }),
        it.hint ? el('span', { class: 'cmdk-hint', text: it.hint }) : null
      ]);
      row.addEventListener('click', function () { runItem(it); });
      row.addEventListener('mousemove', function () { paletteIdx = i; renderActive(); });
      list.appendChild(row);
    });
  }
  function renderActive() {
    palette.querySelectorAll('.cmdk-item').forEach(function (n) {
      var on = parseInt(n.getAttribute('data-idx'), 10) === paletteIdx;
      n.classList.toggle('active', on);
      if (on) n.scrollIntoView({ block: 'nearest' });
    });
  }
  function openPalette() {
    if (!palette) buildPalette();
    if (!paletteItems.length) collectItems();
    renderPalette('');
    palette.classList.add('open');
    var input = palette.querySelector('#cmdk-input'); input.value = ''; setTimeout(function () { input.focus(); }, 10);
  }
  function closePalette() { if (palette) palette.classList.remove('open'); }

  document.addEventListener('keydown', function (e) {
    if ((e.metaKey || e.ctrlKey) && (e.key === 'k' || e.key === 'K')) { e.preventDefault(); openPalette(); }
  });

  // ---- public namespace ----------------------------------------------------
  window.Covara = {
    base: base, toast: toast, fetchJSON: fetchJSON, copy: copy, el: el,
    escapeHtml: escapeHtml, highlightJSON: highlightJSON, relTime: relTime,
    openPalette: openPalette, closePalette: closePalette
  };

  document.addEventListener('DOMContentLoaded', refreshTimes);
  refreshTimes();
})();
`;
