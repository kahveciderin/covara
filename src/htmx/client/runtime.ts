// The covara/htmx client runtime. Shipped (with vendored htmx core) by
// serveHtmxBundle(). htmx core powers the mutation controls (hx-post/hx-patch/
// hx-delete emitted by the c.* helpers); this runtime adds:
//   - the live SSE channel (connect each <Live> container, apply named events),
//   - optimistic create rendered from the server-shipped row <template> (no
//     ghost) reconciled by the authoritative HTML response,
//   - optimistic delete (row hidden immediately, restored on failure),
//   - a basic offline queue (mutations replay + resync on reconnect).
export const covaraRuntimeScript = String.raw`(function () {
  var LIVE = "/__covara/live/";
  var QUEUE_KEY = "cv-offline-queue";

  function firstEl(html) {
    var tpl = document.createElement("template");
    tpl.innerHTML = (html || "").trim();
    return tpl.content.firstElementChild;
  }
  function process(el) { if (window.htmx && el) window.htmx.process(el); }

  function escapeHtml(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;").replace(/'/g, "&#039;");
  }
  function applyTemplate(tmpl, values) {
    return tmpl.replace(/\{\{(\w+)\}\}/g, function (_m, k) { return escapeHtml(values[k]); });
  }

  function upsert(container, html) {
    var el = firstEl(html);
    if (!el) return;
    var existing = el.id ? document.getElementById(el.id) : null;
    if (existing) existing.replaceWith(el); else container.appendChild(el);
    process(el);
  }
  // For "changed": only patch a row this client is actually showing. A change
  // for a row outside the loaded page (pagination) is ignored rather than
  // appended out of order — the row arrives when this client loads that page.
  function replaceExisting(html) {
    var el = firstEl(html);
    if (!el || !el.id) return;
    var existing = document.getElementById(el.id);
    if (existing) {
      existing.replaceWith(el);
      process(el);
    }
  }
  function removeById(domId) {
    var el = document.getElementById((domId || "").trim());
    if (el) el.remove();
  }
  function refetch(container) {
    var url = container.getAttribute("data-cv-list");
    if (!url) return;
    fetch(url, { credentials: "include", headers: { "HX-Request": "true" } })
      .then(function (r) { return r.text(); })
      .then(function (html) { container.innerHTML = html; process(container); });
  }

  function connect(container) {
    var url = container.getAttribute("data-cv-sse");
    if (!url || container.__cvES) return;
    var es = new EventSource(url, { withCredentials: true });
    es.addEventListener("added", function (e) { upsert(container, e.data); });
    es.addEventListener("changed", function (e) { replaceExisting(e.data); });
    es.addEventListener("removed", function (e) { removeById(e.data); });
    es.addEventListener("aggregate", function (e) { container.innerHTML = e.data; process(container); });
    es.addEventListener("invalidate", function () { refetch(container); });
    container.__cvES = es;
  }
  function init(root) {
    (root || document).querySelectorAll("[data-cv-sse]").forEach(connect);
  }

  // ---- region helpers ----------------------------------------------------
  function regionOf(url) {
    if (!url || url.indexOf(LIVE) !== 0) return null;
    return url.slice(LIVE.length).split("/")[0];
  }
  function containerFor(region) {
    return document.querySelector('[data-cv-region="' + region + '"]');
  }
  function templateFor(container) {
    var id = container && container.getAttribute("data-cv-template");
    var tpl = id && document.getElementById(id);
    return tpl ? tpl.innerHTML : null;
  }
  function formValues(form) {
    var out = {};
    if (!form) return out;
    new FormData(form).forEach(function (v, k) { out[k] = v; });
    return out;
  }

  // ---- offline queue -----------------------------------------------------
  function loadQueue() {
    try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || "[]"); } catch (e) { return []; }
  }
  function saveQueue(q) {
    try { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); } catch (e) {}
  }
  function enqueue(entry) { var q = loadQueue(); q.push(entry); saveQueue(q); }
  function flushQueue() {
    var q = loadQueue();
    if (!q.length) return;
    saveQueue([]);
    var regions = {};
    q.reduce(function (p, e) {
      return p.then(function () {
        regions[e.region] = true;
        return fetch(e.url, {
          method: e.method,
          credentials: "include",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: e.body,
        }).catch(function () { enqueue(e); });
      });
    }, Promise.resolve()).then(function () {
      Object.keys(regions).forEach(function (r) {
        var c = containerFor(r);
        if (c) refetch(c);
      });
    });
  }
  window.addEventListener("online", flushQueue);

  // ---- optimistic mutations (htmx integration) ---------------------------
  // Per-request state, keyed by the xhr (the one object htmx shares across
  // beforeRequest/afterRequest — event.detail is NOT shared between them).
  var pending = new WeakMap();

  function reqPath(detail) {
    return (detail.pathInfo && detail.pathInfo.requestPath) ||
      detail.path || (detail.requestConfig && detail.requestConfig.path) || "";
  }
  function reqVerb(detail) {
    return (detail.requestConfig && detail.requestConfig.verb) || "";
  }

  document.addEventListener("htmx:beforeRequest", function (evt) {
    var detail = evt.detail || {};
    var region = regionOf(reqPath(detail));
    if (!region || !detail.xhr) return;
    var verb = reqVerb(detail);
    var el = detail.elt;

    // CREATE is NOT optimistically inserted here. The create response uses
    // hx-swap="none"; the new row is inserted exactly once by the SSE "added"
    // event (same path every tab uses), which avoids the duplicate + phantom
    // row that an optimistic placeholder caused.
    if (verb === "delete") {
      var row = el && el.closest && el.closest("[data-covara-id]");
      if (row) {
        row.style.display = "none";
        pending.set(detail.xhr, { hidden: row });
      }
    }
  });

  document.addEventListener("htmx:afterRequest", function (evt) {
    var detail = evt.detail || {};
    if (!detail.xhr) return;
    var p = pending.get(detail.xhr);
    if (!p) return;
    pending.delete(detail.xhr);
    // On failure, restore the optimistically-hidden row. On success the row is
    // removed by the response swap / SSE "removed" event.
    if (p.hidden && !detail.successful) p.hidden.style.display = "";
  });

  document.addEventListener("htmx:sendError", function (evt) {
    var detail = evt.detail || {};
    var cfg = detail.requestConfig || {};
    var region = regionOf(cfg.path || "");
    if (!region) return;
    if (cfg.verb === "post") {
      enqueue({ region: region, url: LIVE + region, method: "POST", body: serialize(cfg.parameters) });
    }
  });

  function serialize(params) {
    if (!params) return "";
    var p = new URLSearchParams();
    Object.keys(params).forEach(function (k) { p.append(k, params[k]); });
    return p.toString();
  }

  if (document.readyState !== "loading") init();
  else document.addEventListener("DOMContentLoaded", function () { init(); });
  if (navigator.onLine) flushQueue();
  window.Covara = { init: init, flushQueue: flushQueue };
})();
`;
