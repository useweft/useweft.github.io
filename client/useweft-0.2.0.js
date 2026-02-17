/**
 * useWeft Client v0.2.0
 *
 * Usage:
 *   <script src="https://useweft.dev/client/useweft-0.2.0.js"></script>
 *
 * Options (data attributes on the script tag):
 *   data-api="..."          API base URL (default: inferred from script src)
 *   data-observe="true"     Enable MutationObserver (off by default)
 *
 * Public API (window.useweft):
 *   useweft.rehash()          — Rescan DOM, recompile if needed. Returns Promise.
 *   useweft.preload(classes)  — Pre-warm server cache for classes. Returns Promise.
 *   useweft.observe(opts?)    — Start MutationObserver. Returns disconnect fn.
 *   useweft.status()          — { bundleId, version, ready }
 *   useweft.version           — "0.2.0"
 *
 * How it prevents jank:
 *
 *   FIRST VISIT: Body is cloaked (visibility:hidden). DOM scanned on
 *   DOMContentLoaded. Classes sent to edge worker. CSS injected inline.
 *   Uncloak. ~100-150ms total.
 *
 *   REPEAT VISIT (same tab session): sessionStorage stores a
 *   URL→bundleId mapping. On load, BEFORE DOMContentLoaded, a <link>
 *   to the cached CSS is injected. The browser HTTP cache serves it
 *   instantly. When the DOM is ready, we verify the hash matches. If
 *   it does: uncloak immediately, zero FOUC. If the page changed: swap
 *   CSS and uncloak.
 *
 *   REPEAT VISIT (new session): No sessionStorage, but localStorage
 *   knows the bundleId exists. After scan+hash, we inject a <link>
 *   (browser HTTP cache hit). Fast, but slightly slower than the
 *   optimistic path since we wait for DOMContentLoaded to scan first.
 */

(function () {
  "use strict";

  // ── Config ──

  var s = document.currentScript;
  var API = (s && s.getAttribute("data-api")) || "https://api.useweft.dev";

  var autoObserve = s && s.getAttribute("data-observe") === "true";
  var CLOAK_TIMEOUT = 3000;
  var DEBOUNCE_MS = 200;

  // ── Storage helpers ──

  function ssGet(k) {
    try {
      return sessionStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function ssSet(k, v) {
    try {
      sessionStorage.setItem(k, v);
    } catch (e) {}
  }
  function ssDel(k) {
    try {
      sessionStorage.removeItem(k);
    } catch (e) {}
  }
  function lsGet(k) {
    try {
      return localStorage.getItem(k);
    } catch (e) {
      return null;
    }
  }
  function lsSet(k, v) {
    try {
      localStorage.setItem(k, v);
    } catch (e) {}
  }

  // ── Page key ──

  var pageKey = "weft:p:" + location.pathname + location.search;

  // ── FOUC Cloak ──

  var cloak = document.createElement("style");
  cloak.id = "weft-cloak";
  cloak.textContent = "body{visibility:hidden!important}";
  (document.head || document.documentElement).appendChild(cloak);

  var cloakTimer = setTimeout(uncloak, CLOAK_TIMEOUT);
  var uncloaked = false;

  function uncloak() {
    if (uncloaked) return;
    uncloaked = true;
    clearTimeout(cloakTimer);
    if (cloak.parentNode) cloak.parentNode.removeChild(cloak);
  }

  // ── Optimistic link ──
  //
  // Injected synchronously, BEFORE DOMContentLoaded.
  // On a warm browser cache, CSS loads before the DOM finishes parsing.
  // This is the zero-FOUC path for repeat visits in the same session.

  var optimisticId = ssGet(pageKey);
  var optimisticEl = null;
  var optimisticLoaded = false;

  if (optimisticId) {
    optimisticEl = document.createElement("link");
    optimisticEl.rel = "stylesheet";
    optimisticEl.href = API + "/css/" + optimisticId;
    optimisticEl.onload = function () {
      optimisticLoaded = true;
      // If the DOM scan has already confirmed this bundle, uncloak now
      if (currentId === optimisticId) uncloak();
    };
    optimisticEl.onerror = function () {
      // Bundle expired or version changed — clear the stale hint
      optimisticEl = null;
      optimisticLoaded = false;
      ssDel(pageKey);
    };
    (document.head || document.documentElement).appendChild(optimisticEl);
  }

  // ── CSS Injection ──

  var active = null;

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
    // Clean up optimistic element once real CSS is in place
    if (optimisticEl && optimisticEl !== el && optimisticEl.parentNode) {
      optimisticEl.parentNode.removeChild(optimisticEl);
      optimisticEl = null;
    }
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

  // ── Hash ──

  function computeHash(ver, sorted) {
    var input = ver + "\n" + sorted.join(",");
    return crypto.subtle
      .digest("SHA-256", new TextEncoder().encode(input))
      .then(function (buf) {
        for (var h = "", b = new Uint8Array(buf), i = 0; i < b.length; i++)
          h += (b[i] < 16 ? "0" : "") + b[i].toString(16);
        return "b_" + h.slice(0, 16);
      });
  }

  // ── Version ──

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
        console.warn("[weft] version fetch failed", e);
        versionToken = "unknown";
        return versionToken;
      });
  }

  function getVersion() {
    return versionToken ? Promise.resolve(versionToken) : fetchVersion();
  }

  // ── Core ──

  var currentId = null;
  var ready = false;
  var loading = false;
  var needsRescan = false;

  function load(sorted) {
    if (!sorted.length) {
      uncloak();
      ready = true;
      return Promise.resolve();
    }

    // Deduplicate: one compile in flight at a time.
    // If rehash() is called during a compile, queue one rescan.
    if (loading) {
      needsRescan = true;
      return Promise.resolve();
    }

    loading = true;
    return doLoad(sorted).then(
      function () {
        loading = false;
        if (needsRescan) {
          needsRescan = false;
          return load(scan());
        }
      },
      function (e) {
        loading = false;
        console.warn("[weft]", e);
        uncloak();
      },
    );
  }

  function doLoad(sorted) {
    return getVersion().then(function (ver) {
      return computeHash(ver, sorted).then(function (bundleId) {
        // ── Path 1: Optimistic hit ──
        // The bundle we guessed before DOMContentLoaded is correct.
        if (bundleId === optimisticId && optimisticEl) {
          currentId = bundleId;
          ready = true;
          active = optimisticEl;
          optimisticEl = null;
          ssSet(pageKey, bundleId);
          lsSet("weft:" + bundleId, "1");
          // Only uncloak if the CSS has actually loaded.
          // If still loading, the onload handler will uncloak.
          if (optimisticLoaded) uncloak();
          return;
        }

        // ── Path 2: Already current ──
        if (bundleId === currentId) {
          ready = true;
          uncloak();
          return;
        }

        var cssUrl = API + "/css/" + bundleId;

        // ── Path 3: Known bundle (localStorage) → browser cache ──
        if (lsGet("weft:" + bundleId)) {
          currentId = bundleId;
          ready = true;
          ssSet(pageKey, bundleId);
          injectLink(cssUrl, uncloak);
          return;
        }

        // ── Path 4: Cold compile ──
        return fetch(API + "/compile", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ classes: sorted }),
        })
          .then(function (r) {
            if (!r.ok) throw new Error("compile " + r.status);
            return r.json();
          })
          .then(function (d) {
            currentId = d.bundleId;
            ready = true;

            // Inline CSS for instant display
            if (d.css) injectStyle(d.css, uncloak);
            else injectLink(API + "/css/" + d.bundleId, uncloak);

            // Persist hints
            lsSet("weft:" + d.bundleId, "1");
            ssSet(pageKey, d.bundleId);

            // Prime browser HTTP cache so next visit is Path 1 or 3
            if (d.css) {
              var pf = document.createElement("link");
              pf.rel = "prefetch";
              pf.href = API + "/css/" + d.bundleId;
              document.head.appendChild(pf);
            }
          });
      });
    });
  }

  // ── Public API ──

  var disconnectFn = null;

  var api = {
    version: "0.2.0",

    /**
     * Rescan the DOM and recompile if classes changed.
     * Call after programmatic DOM mutations.
     *
     * @returns {Promise<void>}
     *
     * @example
     *   // HTMX
     *   document.body.addEventListener('htmx:afterSwap', () => useweft.rehash())
     *
     * @example
     *   // Alpine.js
     *   <div x-init="$nextTick(() => useweft.rehash())">
     *
     * @example
     *   // Livewire
     *   Livewire.hook('morph.updated', () => useweft.rehash())
     */
    rehash: function () {
      return load(scan());
    },

    /**
     * Pre-warm the server cache for classes that will appear soon.
     * Merges the given classes with what's currently on the page and
     * compiles the union. If the DOM swap produces exactly that union,
     * rehash() will be a localStorage fast-path hit.
     *
     * @param {string[]} classes
     * @returns {Promise<void>}
     *
     * @example
     *   // Preload before HTMX swap
     *   useweft.preload(['bg-amber-100', 'border-amber-300'])
     *     .then(() => htmx.ajax('GET', '/alerts', '#container'))
     */
    preload: function (classes) {
      if (!Array.isArray(classes) || !classes.length) return Promise.resolve();

      var current = scan();
      var merged = Object.create(null);
      for (var i = 0; i < current.length; i++) merged[current[i]] = 1;
      for (var j = 0; j < classes.length; j++) merged[classes[j]] = 1;
      var sorted = Object.keys(merged).sort();

      return fetch(API + "/compile", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ classes: sorted }),
      })
        .then(function (r) {
          if (!r.ok) throw new Error("preload " + r.status);
          return r.json();
        })
        .then(function (d) {
          lsSet("weft:" + d.bundleId, "1");
        })
        .catch(function (e) {
          console.warn("[weft] preload failed", e);
        });
    },

    /**
     * Start a MutationObserver that calls rehash() on DOM changes.
     * Off by default. Returns a function to disconnect.
     *
     * @param {{ debounce?: number }} [opts]
     * @returns {function} disconnect
     *
     * @example
     *   const stop = useweft.observe()
     *   // Later: stop()
     *
     * @example
     *   useweft.observe({ debounce: 500 })
     */
    observe: function (opts) {
      if (typeof MutationObserver === "undefined") return function () {};

      // Disconnect previous if any
      if (disconnectFn) disconnectFn();

      var ms = (opts && opts.debounce) || DEBOUNCE_MS;
      var timer = null;

      var mo = new MutationObserver(function (muts) {
        for (var i = 0; i < muts.length; i++) {
          var m = muts[i];
          if (
            (m.type === "attributes" && m.attributeName === "class") ||
            (m.type === "childList" && m.addedNodes.length)
          ) {
            clearTimeout(timer);
            timer = setTimeout(function () {
              load(scan());
            }, ms);
            return;
          }
        }
      });

      mo.observe(document.documentElement, {
        attributes: true,
        attributeFilter: ["class"],
        childList: true,
        subtree: true,
      });

      disconnectFn = function () {
        clearTimeout(timer);
        mo.disconnect();
        disconnectFn = null;
      };

      return disconnectFn;
    },

    /**
     * Current client state.
     * @returns {{ bundleId: string|null, version: string|null, ready: boolean }}
     */
    status: function () {
      return { bundleId: currentId, version: versionToken, ready: ready };
    },
  };

  window.useweft = api;

  // ── Init ──

  function init() {
    load(scan()).then(function () {
      if (autoObserve) api.observe();
    });
  }

  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", init);
  else init();
})();
