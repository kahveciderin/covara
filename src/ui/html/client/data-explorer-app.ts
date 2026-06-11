// Client-side Data Explorer: a full data tool over any registered resource —
// sortable grid, cursor pagination, visual filter builder, free-text quick
// search, row selection + bulk delete, column visibility, saved views, density,
// CSV/JSON export, inline cell editing, schema-driven create/edit, a detail
// drawer, and auto-refresh. Talks to the admin JSON API at {base}/api/explorer.
// Served verbatim as JS (no build step).
export const dataExplorerScript = String.raw`
(function () {
  // On a full page load this body script can run before the deferred runtime
  // (window.Covara) has executed, and before #dx-root is parsed. Wait for both
  // so the app boots reliably whether reached by direct URL or htmx navigation.
  function whenReady(cb) {
    var attempt = function () {
      if (document.getElementById('dx-root') && window.Covara) { cb(); return; }
      setTimeout(attempt, 30);
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', attempt);
    else attempt();
  }
  whenReady(function () {
  var root = document.getElementById('dx-root');
  var C = window.Covara;
  var api = C.base + '/api/explorer';
  var LS = 'covara.dx.';

  var state = {
    resource: null, schema: null, readOnly: true, columns: [], pk: 'id', allResources: [],
    rows: [], orderBy: null, dir: 'asc', filters: [], search: '', limit: 50,
    cursorStack: [], nextCursor: null, total: null, autoRefresh: false, timer: null,
    hidden: {}, density: 'comfortable', selected: {}, filtersOpen: false, pop: null
  };

  var OPS = [
    { v: '==', label: '=' }, { v: '!=', label: '≠' },
    { v: '>', label: '>' }, { v: '>=', label: '≥' }, { v: '<', label: '<' }, { v: '<=', label: '≤' },
    { v: '=contains=', label: 'contains' }, { v: '=in=', label: 'in (a,b)' }, { v: '=isnull=', label: 'is null' }
  ];

  function qs() { var m = (location.search.match(/[?&]resource=([^&]+)/) || [])[1]; return m ? decodeURIComponent(m) : null; }
  function isNum(t) { return /int|float|double|decimal|number|real|numeric/i.test(t || ''); }
  function isBool(t) { return /bool/i.test(t || ''); }
  function isJson(t) { return /json/i.test(t || ''); }
  function isDate(t) { return /date|time|timestamp/i.test(t || ''); }
  function isText(t) { return /text|char|string|varchar/i.test(t || ''); }
  function colType(name) { var c = state.columns.find(function (c) { return c.name === name; }); return c ? c.type : ''; }

  // ---- localStorage prefs --------------------------------------------------
  function pref(key) { return LS + state.resource + '.' + key; }
  function loadPrefs() {
    try {
      var h = JSON.parse(localStorage.getItem(pref('hidden')) || '{}'); state.hidden = h || {};
    } catch (e) { state.hidden = {}; }
    state.density = localStorage.getItem(LS + 'density') || 'comfortable';
  }
  function saveHidden() { try { localStorage.setItem(pref('hidden'), JSON.stringify(state.hidden)); } catch (e) {} }
  function savedViews() { try { return JSON.parse(localStorage.getItem(pref('views')) || '[]'); } catch (e) { return []; } }
  function setViews(v) { try { localStorage.setItem(pref('views'), JSON.stringify(v)); } catch (e) {} }

  // ---- filter construction -------------------------------------------------
  function quote(field, op, raw) {
    var t = colType(field);
    if (op === '=isnull=') return field + '=isnull=true';
    if (op === '=in=') return field + '=in=(' + raw + ')';
    if (isNum(t) || isBool(t)) return field + op + raw;
    return field + op + '"' + String(raw).replace(/"/g, '\\"') + '"';
  }
  function buildFilter() {
    var parts = state.filters.filter(function (f) { return f.field && f.op && (f.op === '=isnull=' || f.value !== ''); })
      .map(function (f) { return quote(f.field, f.op, f.value); });
    if (state.search) {
      var q = state.search.replace(/"/g, '\\"');
      var textCols = state.columns.filter(function (c) { return isText(c.type); });
      if (textCols.length) {
        var group = textCols.map(function (c) { return c.name + '=contains="' + q + '"'; }).join(',');
        parts.push('(' + group + ')');
      }
    }
    return parts.join(';');
  }

  // ---- data load -----------------------------------------------------------
  async function loadSchemas() {
    var r = await C.fetchJSON(api + '/schemas');
    state.readOnly = !!r.readOnly;
    return (r.schemas || []).map(function (s) { return s.name || s.resource || s; });
  }
  async function selectResource(name) {
    state.resource = name; state.cursorStack = []; state.nextCursor = null; state.filters = []; state.search = ''; state.selected = {};
    var s = await C.fetchJSON(api + '/schemas/' + encodeURIComponent(name));
    state.schema = s.schema || s;
    state.columns = state.schema.columns || [];
    state.pk = (state.columns.find(function (c) { return c.isPrimary; }) || state.columns[0] || {}).name || 'id';
    state.orderBy = state.pk; state.dir = 'asc';
    loadPrefs();
    var url = new URL(location.href); url.searchParams.set('resource', name); history.replaceState(null, '', url);
    await loadData(); render();
  }
  async function loadData(cursor) {
    if (!state.resource) return;
    var p = new URLSearchParams();
    p.set('limit', String(state.limit));
    p.set('orderBy', state.orderBy + (state.dir === 'desc' ? ':desc' : ':asc'));
    p.set('totalCount', 'true');
    var f = buildFilter(); if (f) p.set('filter', f);
    if (cursor) p.set('cursor', cursor);
    var r = await C.fetchJSON(api + '/data/' + encodeURIComponent(state.resource) + '?' + p.toString());
    state.rows = r.items || [];
    state.nextCursor = r.nextCursor || r.cursor || null;
    state.total = (typeof r.totalCount === 'number') ? r.totalCount : (typeof r.total === 'number' ? r.total : null);
  }

  // ---- helpers -------------------------------------------------------------
  function visibleCols() { return state.columns.filter(function (c) { return !state.hidden[c.name]; }); }
  function selCount() { return Object.keys(state.selected).filter(function (k) { return state.selected[k]; }).length; }
  function fmtCell(val, col) {
    if (val === null || val === undefined) return '<span class="cell-null">null</span>';
    if (typeof val === 'boolean') return '<span class="cell-bool">' + val + '</span>';
    if (typeof val === 'object') return '<span class="cell-json">' + C.escapeHtml(JSON.stringify(val)) + '</span>';
    var s = String(val);
    if (col && col.isPrimary) return '<span class="pk">' + C.escapeHtml(s) + '</span>';
    return C.escapeHtml(s.length > 200 ? s.slice(0, 200) + '…' : s);
  }
  function closePop() { if (state.pop) { state.pop = null; render(); } }
  document.addEventListener('click', function (e) {
    if (state.pop && !e.target.closest('.dx-pop-wrap')) closePop();
  });

  // ---- render --------------------------------------------------------------
  function render() {
    root.innerHTML = '';
    root.appendChild(toolbar());
    if (state.filtersOpen) root.appendChild(filterPanel());
    if (selCount() > 0) root.appendChild(bulkBar());
    if (!state.resource) { root.appendChild(C.el('div', { class: 'card', html: '<div class="empty-state"><div class="empty-icon">▣</div><div class="empty-title">Select a resource</div><div class="empty-desc">Pick a resource above to browse its data.</div></div>' })); return; }
    root.appendChild(grid());
    root.appendChild(footer());
  }

  function popMenu(label, builder) {
    var id = label.toLowerCase();
    var btn = C.el('button', { class: 'btn btn-secondary btn-sm', onclick: function (e) { e.stopPropagation(); state.pop = state.pop === id ? null : id; render(); } }, [label + ' ▾']);
    var wrap = C.el('div', { class: 'dx-pop-wrap' }, [btn]);
    if (state.pop === id) wrap.appendChild(builder());
    return wrap;
  }

  function toolbar() {
    var sel = C.el('select', { class: 'select dx-resource-select', onchange: function (e) { selectResource(e.target.value); } });
    sel.appendChild(C.el('option', { value: '', text: 'Select resource…' }));
    state.allResources.forEach(function (name) { var o = C.el('option', { value: name, text: name }); if (name === state.resource) o.selected = true; sel.appendChild(o); });

    var search = C.el('input', { class: 'input dx-search', type: 'search', placeholder: '⌕  Quick search…', value: state.search });
    var t;
    search.addEventListener('input', function (e) { state.search = e.target.value; clearTimeout(t); t = setTimeout(function () { reload(); }, 280); });

    var filterBtn = C.el('button', { class: 'btn btn-secondary btn-sm', onclick: function () { state.filtersOpen = !state.filtersOpen; if (state.filtersOpen && !state.filters.length) addFilter(); render(); } },
      ['⚲ Filters' + (state.filters.length ? ' (' + state.filters.length + ')' : '')]);

    var right = C.el('div', { class: 'row' });
    if (state.resource) {
      right.appendChild(popMenu('Columns', columnsMenu));
      right.appendChild(popMenu('Views', viewsMenu));
      right.appendChild(popMenu('Export', exportMenu));
      right.appendChild(densityToggle());
      var autoWrap = C.el('label', { class: 'row', style: 'font-size:12.5px;color:var(--text-2);gap:7px' }, [makeSwitch(state.autoRefresh, toggleAuto), 'Live']);
      right.appendChild(autoWrap);
      right.appendChild(C.el('button', { class: 'btn btn-secondary btn-sm', title: 'Refresh', onclick: function () { reload(); } }, ['↻']));
      if (!state.readOnly) right.appendChild(C.el('button', { class: 'btn btn-primary btn-sm', onclick: function () { openForm(null); } }, ['+ New']));
    }

    var left = C.el('div', { class: 'row', style: 'flex:1' }, [sel, search, filterBtn]);
    return C.el('div', { class: 'dx-toolbar' }, [left, C.el('span', { class: 'dx-spacer' }), right]);
  }

  function makeSwitch(on, cb) {
    var w = C.el('span', { class: 'switch' }); var i = C.el('input', { type: 'checkbox' }); i.checked = on;
    i.addEventListener('change', function () { cb(i.checked); }); w.appendChild(i); w.appendChild(C.el('span', { class: 'track' })); return w;
  }
  function densityToggle() {
    return C.el('div', { class: 'segmented' }, ['comfortable', 'compact'].map(function (d) {
      return C.el('button', { class: state.density === d ? 'active' : '', title: d, onclick: function () { state.density = d; localStorage.setItem(LS + 'density', d); render(); } }, [d === 'compact' ? '≡' : '☰']);
    }));
  }

  function columnsMenu() {
    var items = state.columns.map(function (c) {
      return C.el('label', { class: 'dx-pop-item' }, [
        (function () { var i = C.el('input', { type: 'checkbox' }); i.checked = !state.hidden[c.name]; i.addEventListener('change', function () { if (i.checked) delete state.hidden[c.name]; else state.hidden[c.name] = true; saveHidden(); render(); }); return i; })(),
        C.el('span', { text: c.name }), C.el('span', { class: 'cmdk-hint', text: c.type })
      ]);
    });
    var reset = C.el('div', { class: 'dx-pop-item', onclick: function () { state.hidden = {}; saveHidden(); render(); } }, ['↺ Show all']);
    return C.el('div', { class: 'dx-pop' }, [C.el('div', { class: 'dx-pop-title', text: 'Columns' })].concat(items).concat([C.el('div', { class: 'dx-pop-sep' }), reset]));
  }

  function viewsMenu() {
    var views = savedViews();
    var nodes = [C.el('div', { class: 'dx-pop-title', text: 'Saved views' })];
    if (!views.length) nodes.push(C.el('div', { class: 'dx-pop-item muted', text: 'No saved views' }));
    views.forEach(function (v, i) {
      nodes.push(C.el('div', { class: 'dx-pop-item', onclick: function () { applyView(v); } }, [
        C.el('span', { text: '▸' }), C.el('span', { text: v.name, style: 'flex:1' }),
        C.el('button', { class: 'copy-btn', title: 'Delete', onclick: function (e) { e.stopPropagation(); views.splice(i, 1); setViews(views); render(); } }, ['✕'])
      ]));
    });
    nodes.push(C.el('div', { class: 'dx-pop-sep' }));
    nodes.push(C.el('div', { class: 'dx-pop-item', onclick: function () {
      var name = prompt('Save current view as:'); if (!name) return;
      var v = { name: name, filters: state.filters, search: state.search, orderBy: state.orderBy, dir: state.dir, hidden: state.hidden };
      var vs = savedViews(); vs.push(v); setViews(vs); C.toast('View saved', 'success'); render();
    } }, ['＋ Save current view']));
    return C.el('div', { class: 'dx-pop' }, nodes);
  }
  function applyView(v) {
    state.filters = JSON.parse(JSON.stringify(v.filters || [])); state.search = v.search || '';
    state.orderBy = v.orderBy || state.pk; state.dir = v.dir || 'asc'; state.hidden = Object.assign({}, v.hidden || {});
    saveHidden(); reload();
  }

  function exportMenu() {
    return C.el('div', { class: 'dx-pop' }, [
      C.el('div', { class: 'dx-pop-title', text: 'Export current page' }),
      C.el('div', { class: 'dx-pop-item', onclick: function () { exportCSV(); } }, ['⤓ CSV']),
      C.el('div', { class: 'dx-pop-item', onclick: function () { exportJSON(); } }, ['⤓ JSON'])
    ]);
  }
  function download(name, content, mime) {
    var blob = new Blob([content], { type: mime }); var url = URL.createObjectURL(blob);
    var a = C.el('a', { href: url, download: name }); document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  }
  function exportJSON() { download(state.resource + '.json', JSON.stringify(state.rows, null, 2), 'application/json'); C.toast('Exported JSON', 'success'); }
  function exportCSV() {
    var cols = visibleCols().map(function (c) { return c.name; });
    var esc = function (v) { if (v === null || v === undefined) return ''; var s = typeof v === 'object' ? JSON.stringify(v) : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
    var lines = [cols.join(',')].concat(state.rows.map(function (r) { return cols.map(function (c) { return esc(r[c]); }).join(','); }));
    download(state.resource + '.csv', lines.join('\n'), 'text/csv'); C.toast('Exported CSV', 'success');
  }

  // ---- filter builder ------------------------------------------------------
  function filterPanel() {
    var rows = state.filters.map(function (f, i) { return filterRow(f, i); });
    var add = C.el('button', { class: 'btn btn-ghost btn-sm', onclick: function () { addFilter(); render(); } }, ['+ Add condition']);
    var apply = C.el('button', { class: 'btn btn-primary btn-sm', onclick: function () { reload(); } }, ['Apply']);
    var clear = C.el('button', { class: 'btn btn-ghost btn-sm', onclick: function () { state.filters = []; reload(); } }, ['Clear']);
    return C.el('div', { class: 'dx-filters' }, rows.concat([C.el('div', { class: 'row', style: 'margin-top:4px' }, [add, C.el('span', { class: 'dx-spacer' }), clear, apply])]));
  }
  function filterRow(f, i) {
    var fieldSel = C.el('select', { class: 'select', onchange: function (e) { f.field = e.target.value; } });
    state.columns.forEach(function (c) { var o = C.el('option', { value: c.name, text: c.name }); if (c.name === f.field) o.selected = true; fieldSel.appendChild(o); });
    var opSel = C.el('select', { class: 'select', style: 'max-width:150px', onchange: function (e) { f.op = e.target.value; render(); } });
    OPS.forEach(function (op) { var o = C.el('option', { value: op.v, text: op.label }); if (op.v === f.op) o.selected = true; opSel.appendChild(o); });
    var val = C.el('input', { class: 'input', placeholder: f.op === '=in=' ? 'a,b,c' : 'value', value: f.value || '', oninput: function (e) { f.value = e.target.value; } });
    if (f.op === '=isnull=') val.style.display = 'none';
    var del = C.el('button', { class: 'btn btn-ghost btn-icon btn-sm', onclick: function () { state.filters.splice(i, 1); render(); } }, ['✕']);
    return C.el('div', { class: 'dx-filter-row' }, [fieldSel, opSel, val, del]);
  }
  function addFilter() { state.filters.push({ field: (state.columns[0] || {}).name || '', op: '==', value: '' }); }

  // ---- bulk bar ------------------------------------------------------------
  function bulkBar() {
    var n = selCount();
    var nodes = [C.el('span', { text: n + ' selected' }), C.el('span', { class: 'dx-spacer', style: 'flex:1' }),
      C.el('button', { class: 'btn btn-ghost btn-sm', onclick: function () { state.selected = {}; render(); } }, ['Clear'])];
    if (!state.readOnly) nodes.push(C.el('button', { class: 'btn btn-danger btn-sm', onclick: bulkDelete }, ['🗑 Delete ' + n]));
    return C.el('div', { class: 'dx-bulkbar' }, nodes);
  }
  async function bulkDelete() {
    var ids = Object.keys(state.selected).filter(function (k) { return state.selected[k]; });
    if (!confirm('Delete ' + ids.length + ' ' + state.resource + ' record(s)? This cannot be undone.')) return;
    var ok = 0, fail = 0;
    for (var i = 0; i < ids.length; i++) {
      try { await C.fetchJSON(api + '/data/' + encodeURIComponent(state.resource) + '/' + encodeURIComponent(ids[i]), { method: 'DELETE' }); ok++; }
      catch (e) { fail++; }
    }
    state.selected = {}; C.toast(ok + ' deleted' + (fail ? ', ' + fail + ' failed' : ''), fail ? 'error' : 'success'); reload();
  }

  // ---- grid ----------------------------------------------------------------
  function grid() {
    var cols = visibleCols();
    var allSel = state.rows.length && state.rows.every(function (r) { return state.selected[r[state.pk]]; });
    var headChk = C.el('th', { class: 'dx-check' }, [(function () { var i = C.el('input', { type: 'checkbox' }); i.checked = !!allSel; i.addEventListener('change', function () { state.rows.forEach(function (r) { state.selected[r[state.pk]] = i.checked; }); render(); }); return i; })()]);
    var thead = C.el('tr', {}, [headChk].concat(cols.map(function (c) {
      return C.el('th', { class: c.name === state.orderBy ? 'sorted' : '', onclick: function () { sortBy(c.name); } }, [c.name, C.el('span', { class: 'sort', text: c.name === state.orderBy ? (state.dir === 'asc' ? '▲' : '▼') : '↕' })]);
    })));
    if (!state.readOnly) thead.appendChild(C.el('th', { style: 'width:70px' }, ['']));

    var tbody = C.el('tbody');
    if (!state.rows.length) {
      tbody.appendChild(C.el('tr', {}, [C.el('td', { colspan: String(cols.length + 2), html: '<div class="empty-state"><div class="empty-icon">∅</div><div class="empty-title">No rows</div><div class="empty-desc">Nothing matches the current filter.</div></div>' })]));
    }
    state.rows.forEach(function (row) {
      var pkv = row[state.pk];
      var tr = C.el('tr', { class: state.selected[pkv] ? 'selected' : '' });
      var chk = C.el('td', { class: 'dx-check', onclick: function (e) { e.stopPropagation(); } }, [(function () { var i = C.el('input', { type: 'checkbox' }); i.checked = !!state.selected[pkv]; i.addEventListener('change', function () { state.selected[pkv] = i.checked; tr.classList.toggle('selected', i.checked); if (selCount() === 0 || selCount() === 1) render(); }); return i; })()]);
      tr.appendChild(chk);
      cols.forEach(function (c) {
        var editable = !state.readOnly && !c.isPrimary;
        var td = C.el('td', { class: editable ? 'dx-editable' : '', html: fmtCell(row[c.name], c) });
        td.addEventListener('click', function () { openDetail(row); });
        if (editable) td.addEventListener('dblclick', function (e) { e.stopPropagation(); editCell(td, row, c); });
        tr.appendChild(td);
      });
      if (!state.readOnly) {
        var actions = C.el('div', { class: 'dx-rowactions' }, [
          C.el('button', { class: 'btn btn-ghost btn-icon btn-sm', title: 'Edit', onclick: function (e) { e.stopPropagation(); openForm(row); } }, ['✎']),
          C.el('button', { class: 'btn btn-ghost btn-icon btn-sm', title: 'Delete', onclick: function (e) { e.stopPropagation(); del(row); } }, ['🗑'])
        ]);
        tr.appendChild(C.el('td', { onclick: function (e) { e.stopPropagation(); } }, [actions]));
      }
      tbody.appendChild(tr);
    });
    return C.el('div', { class: 'dx-grid-wrap' }, [C.el('table', { class: 'dx-grid' + (state.density === 'compact' ? ' compact' : '') }, [C.el('thead', {}, [thead]), tbody])]);
  }

  function footer() {
    var info = state.total != null ? (state.total.toLocaleString() + ' rows') : (state.rows.length + ' shown');
    var prev = C.el('button', { class: 'btn btn-secondary btn-sm', onclick: pagePrev }, ['← Prev']); prev.disabled = state.cursorStack.length === 0;
    var next = C.el('button', { class: 'btn btn-secondary btn-sm', onclick: pageNext }, ['Next →']); next.disabled = !state.nextCursor;
    var sizes = C.el('select', { class: 'select', style: 'width:auto;height:28px', onchange: function (e) { state.limit = parseInt(e.target.value, 10); reload(); } });
    [25, 50, 100, 200].forEach(function (n) { var o = C.el('option', { value: String(n), text: n + ' / page' }); if (n === state.limit) o.selected = true; sizes.appendChild(o); });
    return C.el('div', { class: 'dx-foot', style: 'padding:4px 2px' }, [C.el('span', { text: info }), C.el('span', { class: 'dx-spacer', style: 'flex:1' }), sizes, prev, next]);
  }

  // ---- inline cell edit ----------------------------------------------------
  function editCell(td, row, col) {
    var current = row[col.name];
    td.classList.add('editing'); td.innerHTML = '';
    var inp = C.el('input', { class: 'dx-cell-edit', value: current != null && typeof current !== 'object' ? String(current) : (current != null ? JSON.stringify(current) : '') });
    if (isNum(col.type)) inp.type = 'number';
    td.appendChild(inp); inp.focus(); inp.select();
    var done = false;
    function commit() {
      if (done) return; done = true;
      var raw = inp.value, val;
      try {
        if (raw === '') val = null;
        else if (isNum(col.type)) val = Number(raw);
        else if (isBool(col.type)) val = raw === 'true' || raw === '1';
        else if (isJson(col.type)) val = JSON.parse(raw);
        else val = raw;
      } catch (e) { C.toast('Invalid value: ' + e.message, 'error'); render(); return; }
      if (val === current) { render(); return; }
      var patch = {}; patch[col.name] = val;
      C.fetchJSON(api + '/data/' + encodeURIComponent(state.resource) + '/' + encodeURIComponent(row[state.pk]), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(patch) })
        .then(function () { C.toast('Updated ' + col.name, 'success'); reload(); })
        .catch(function (e) { C.toast(e.message, 'error'); render(); });
    }
    inp.addEventListener('keydown', function (e) { if (e.key === 'Enter') commit(); else if (e.key === 'Escape') { done = true; render(); } });
    inp.addEventListener('blur', commit);
  }

  // ---- actions -------------------------------------------------------------
  async function reload() { try { state.cursorStack = []; await loadData(); render(); } catch (e) { C.toast(e.message, 'error'); } }
  function sortBy(col) { if (state.orderBy === col) state.dir = state.dir === 'asc' ? 'desc' : 'asc'; else { state.orderBy = col; state.dir = 'asc'; } reload(); }
  async function pageNext() { if (!state.nextCursor) return; state.cursorStack.push(state.nextCursor); try { await loadData(state.nextCursor); render(); } catch (e) { C.toast(e.message, 'error'); } }
  async function pagePrev() { state.cursorStack.pop(); var c = state.cursorStack[state.cursorStack.length - 1]; try { await loadData(c); render(); } catch (e) { C.toast(e.message, 'error'); } }
  function toggleAuto(on) { state.autoRefresh = on; if (state.timer) { clearInterval(state.timer); state.timer = null; } if (on) state.timer = setInterval(function () { loadData(state.cursorStack[state.cursorStack.length - 1]).then(render).catch(function () {}); }, 5000); }

  // ---- drawers -------------------------------------------------------------
  function drawer(title, bodyNode, footerNodes) {
    var existing = document.getElementById('dx-overlay'); if (existing) existing.remove();
    var overlay = C.el('div', { class: 'overlay open', id: 'dx-overlay' });
    var d = C.el('div', { class: 'drawer' }, [
      C.el('div', { class: 'drawer-header' }, [C.el('div', { class: 'drawer-title', text: title }), C.el('button', { class: 'btn btn-ghost btn-icon', onclick: close }, ['✕'])]),
      C.el('div', { class: 'drawer-body' }, [bodyNode]),
      footerNodes ? C.el('div', { class: 'drawer-footer' }, footerNodes) : null
    ]);
    overlay.appendChild(d); overlay.addEventListener('click', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', escClose);
    document.body.appendChild(overlay);
    function close() { document.removeEventListener('keydown', escClose); overlay.remove(); }
    function escClose(e) { if (e.key === 'Escape') close(); }
    return { close: close };
  }

  function openDetail(row) {
    var body = C.el('div', {}, [C.el('div', { class: 'jsonview', html: C.highlightJSON(row) })]);
    var foot = [C.el('button', { class: 'btn btn-secondary', 'data-copy': JSON.stringify(row, null, 2) }, ['Copy JSON'])];
    if (!state.readOnly) {
      foot.push(C.el('button', { class: 'btn btn-secondary', onclick: function () { dlg.close(); openForm(row); } }, ['Edit']));
      foot.push(C.el('button', { class: 'btn btn-danger', onclick: function () { dlg.close(); del(row); } }, ['Delete']));
    }
    var dlg = drawer(state.resource + ' · ' + row[state.pk], body, foot);
  }

  function fieldInput(col, value) {
    if (isBool(col.type)) { var w = makeSwitch(!!value, function () {}); w._get = function () { return w.querySelector('input').checked; }; return w; }
    if (isJson(col.type)) { var ta = C.el('textarea', { class: 'input input-mono', rows: '5' }); ta.value = value != null ? JSON.stringify(value, null, 2) : ''; ta._get = function () { var v = ta.value.trim(); return v ? JSON.parse(v) : null; }; return ta; }
    var inp = C.el('input', { class: 'input' + (col.isPrimary ? ' input-mono' : ''), value: value != null ? String(value) : '' });
    if (isNum(col.type)) inp.type = 'number'; else if (isDate(col.type)) inp.placeholder = 'ISO 8601 or blank';
    inp._get = function () { var v = inp.value; if (v === '') return undefined; return isNum(col.type) ? Number(v) : v; };
    return inp;
  }

  function openForm(row) {
    var editing = !!row, fields = {}, body = C.el('div', {});
    state.columns.forEach(function (col) {
      if (editing && col.isPrimary) {
        body.appendChild(C.el('div', { style: 'margin-bottom:14px' }, [C.el('label', { class: 'form-label', text: col.name + ' (primary key)' }), C.el('div', { class: 'mono muted', text: String(row[col.name]) })]));
        return;
      }
      var input = fieldInput(col, editing ? row[col.name] : undefined); fields[col.name] = input;
      body.appendChild(C.el('div', { style: 'margin-bottom:14px' }, [
        C.el('label', { class: 'form-label' }, [col.name, C.el('span', { class: 'muted', style: 'font-weight:400', text: '  ' + col.type + (col.nullable ? ' · nullable' : '') })]), input
      ]));
    });
    var save = C.el('button', { class: 'btn btn-primary' }, [editing ? 'Save changes' : 'Create']);
    save.addEventListener('click', async function () {
      var payload = {};
      try { Object.keys(fields).forEach(function (n) { var v = fields[n]._get(); if (v !== undefined) payload[n] = v; }); }
      catch (e) { C.toast('Invalid JSON: ' + e.message, 'error'); return; }
      save.disabled = true;
      try {
        if (editing) { await C.fetchJSON(api + '/data/' + encodeURIComponent(state.resource) + '/' + encodeURIComponent(row[state.pk]), { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); C.toast('Record updated', 'success'); }
        else { await C.fetchJSON(api + '/data/' + encodeURIComponent(state.resource), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); C.toast('Record created', 'success'); }
        dlg.close(); reload();
      } catch (e) { C.toast(e.message, 'error'); save.disabled = false; }
    });
    var dlg = drawer((editing ? 'Edit ' : 'New ') + state.resource, body, [C.el('button', { class: 'btn btn-ghost', onclick: function () { dlg.close(); } }, ['Cancel']), save]);
  }

  async function del(row) {
    if (!confirm('Delete this ' + state.resource + ' record?\\n\\n' + row[state.pk])) return;
    try { await C.fetchJSON(api + '/data/' + encodeURIComponent(state.resource) + '/' + encodeURIComponent(row[state.pk]), { method: 'DELETE' }); C.toast('Record deleted', 'success'); reload(); }
    catch (e) { C.toast(e.message, 'error'); }
  }

  // ---- boot ----------------------------------------------------------------
  render();
  loadSchemas().then(function (names) {
    state.allResources = names;
    var pre = qs() || names[0]; render();
    if (pre && names.indexOf(pre) >= 0) selectResource(pre);
  }).catch(function (e) {
    root.innerHTML = '<div class="card"><div class="card-body"><div class="alert alert-error">Failed to load resources: ' + C.escapeHtml(e.message) + '</div></div></div>';
  });
  });
})();
`;
