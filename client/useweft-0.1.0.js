/**
 * useWeft Client v0.1.0 — ~2kb minified
 *
 * Usage:
 *   <script src="/client/useweft-0.1.0.js"></script>
 *
 * With explicit API URL:
 *   <script src="/client/useweft-0.1.0.js"
 *           data-api="https://..."></script>
 *
 * Options (data attributes on the script tag):
 *   data-api="..."          API base URL (default: inferred from script src)
 *   data-observe="false"    Disable MutationObserver for dynamic content
 *
 * How it works:
 *   1. Cloak: hides body immediately (prevents FOUC)
 *   2. Version: GET /v → short token (edge-cached 5min) — ensures cache busts on engine upgrades
 *   3. Scan: querySelectorAll('[class]') → deduplicated sorted class list
 *   4. Hash: SHA-256 of (versionToken + classes) — matches server algorithm → same bundle ID
 *   5. Check localStorage: if we've seen this bundle before → inject <link> (browser HTTP cache → instant)
 *   6. Else: POST /compile → inject <style> with returned CSS → store hint in localStorage
 *   7. Watch: MutationObserver catches HTMX swaps, Alpine reactivity, dynamic content
 *   8. Safety: cloak auto-removes after 3s no matter what
 */

(function () {
  "use strict";

  // ── Config ──

  var s = document.currentScript;
  var API = (s && s.getAttribute("data-api")) || "https://api.useweft.dev";

  var observe = !(s && s.getAttribute("data-observe") === "false");
  var CLOAK_TIMEOUT = 3000;
  var DEBOUNCE_MS = 200;

  // ── FOUC Cloak ──
  // Injected synchronously before first render.
  // visibility:hidden preserves layout — no reflow on reveal.

  var cloak = document.createElement("style");
  cloak.id = "useweft-cloak";
  cloak.textContent = "body{visibility:hidden!important}";
  (document.head || document.documentElement).appendChild(cloak);

  var cloakTimer = setTimeout(uncloak, CLOAK_TIMEOUT);

  function uncloak() {
    clearTimeout(cloakTimer);
    if (cloak.parentNode) cloak.parentNode.removeChild(cloak);
  }

  // ── Scan ──

  function scan() {
    var set = Object.create(null);
    var els = document.querySelectorAll("[class]");
    for (var i = 0; i < els.length; i++) {
      var cl = els[i].classList;
      for (var j = 0; j < cl.length; j++) set[cl[j]] = 1;
    }
    return Object.keys(set).sort();
  }

  // ── Hash (SHA-256, matches server: version + classes) ──

  function hashClasses(ver, sorted) {
    var input = ver + "\n" + sorted.join(",");
    return crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(input))
      .then(function (buf) {
        for (var h = "", b = new Uint8Array(buf), i = 0; i < b.length; i++)
          h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
        return "b_" + h.slice(0, 16);
      });
  }

  // ── CSS Injection ──

  var active = null; // current <style> or <link>

  function injectLink(url, cb) {
    var el = document.createElement("link");
    el.rel = "stylesheet";
    el.href = url;
    el.onload = el.onerror = cb || null;
    swapActive(el);
  }

  function injectStyle(css, cb) {
    var el = document.createElement("style");
    el.textContent = css;
    swapActive(el);
    if (cb) cb();
  }

  function swapActive(el) {
    if (active && active.parentNode) active.parentNode.removeChild(active);
    active = el;
    document.head.appendChild(el);
  }

  // ── Storage (all try/catch — never trust it) ──

  function sGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function sSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {}
  }

  // ── Version ──
  // Fetched once per page session from GET /v (edge-cached 5 min).
  // Folded into the hash so bundles auto-bust when the engine upgrades.

  var versionToken = null;

  function fetchVersion() {
    return fetch(API + "/v")
      .then(function (r) {
        if (!r.ok) throw new Error(r.status);
        return r.json();
      })
      .then(function (d) {
        versionToken = d.v;
        return d.v;
      })
      .catch(function (e) {
        // Fallback: if /v is unreachable, use "unknown" so the client
        // still works — it'll just miss the localStorage fast-path
        // on version changes until /v comes back.
        console.warn("[useweft] version fetch failed, using fallback", e);
        versionToken = "unknown";
        return versionToken;
      });
  }

  // ── Core ──

  var currentId = null;

  function getVersion() {
    // Re-use in-memory token for the lifetime of this page
    return versionToken ? Promise.resolve(versionToken) : fetchVersion();
  }

  function load(sorted) {
    if (!sorted.length) {
      uncloak();
      return Promise.resolve();
    }

    return getVersion().then(function (ver) {
      return hashClasses(ver, sorted).then(function (bundleId) {
        if (bundleId === currentId) return; // already loaded

        var cssUrl = API + "/css/" + bundleId;

        // Fast path: we know this bundle exists → <link> from browser cache
        if (sGet("useweft:" + bundleId)) {
          currentId = bundleId;
          injectLink(cssUrl, uncloak);
          return;
        }

        // Slow path: compile on the server → inline CSS
        return fetch(API + "/compile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ classes: sorted }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error(r.status);
            return r.json();
          })
          .then(function (d) {
            currentId = d.bundleId;
            if (d.css) injectStyle(d.css, uncloak);
            else injectLink(API + "/css/" + d.bundleId, uncloak);

            sSet("useweft:" + d.bundleId, "1");

            // Prime the browser HTTP cache for next page load.
            if (d.css) {
              var pf = document.createElement("link");
              pf.rel = "prefetch";
              pf.href = API + "/css/" + d.bundleId;
              document.head.appendChild(pf);
            }
          })
          .catch(function (e) {
            console.warn("[useweft]", e);
            uncloak(); // never leave the page invisible
          });
      });
    });
  }

  // ── MutationObserver ──

  var debTimer = null;

  function startObserver() {
    if (!observe || typeof MutationObserver === "undefined") return;

    new MutationObserver(function (muts) {
      for (var i = 0; i < muts.length; i++) {
        var m = muts[i];
        if (
          (m.type === "attributes" && m.attributeName === "class") ||
          (m.type === "childList" && m.addedNodes.length)
        ) {
          clearTimeout(debTimer);
          debTimer = setTimeout(function () {
            load(scan());
          }, DEBOUNCE_MS);
          return;
        }
      }
    }).observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"],
      childList: true,
      subtree: true,
    });
  }

  // ── Init ──

  function init() {
    load(scan()).then(startObserver);
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
