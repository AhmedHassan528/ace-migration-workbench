/* Settings (localStorage) and imported documentation / rule store (IndexedDB, memory fallback).
 * All storage access is wrapped: the app keeps working when storage is unavailable (private mode,
 * file:// restrictions), and says so in the log. */
(function (ACE) {
  'use strict';
  var KEY = 'ace-migration-workbench.settings.v1';
  var st = ACE.settings = {};

  function merge(base, over) {
    var out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
    Object.keys(over || {}).forEach(function (k) {
      if (over[k] && typeof over[k] === 'object' && !Array.isArray(over[k]) && base[k] && typeof base[k] === 'object' && !Array.isArray(base[k])) out[k] = merge(base[k], over[k]);
      else out[k] = over[k];
    });
    return out;
  }

  st.load = function () {
    var saved = null;
    try { saved = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (e) { ACE.log.warn('Settings storage not available; using defaults (' + e.message + ')'); }
    // Settings saved before "separate" became the default carry the old default "refactor" (merge into one
    // library) without the user having chosen it: move them to the new default.
    var slc = saved && saved.libraryConversion;
    if (slc && slc.strategyVersion !== 2) { if (slc.strategy === 'refactor') slc.strategy = 'separate'; slc.strategyVersion = 2; }
    st.current = merge(ACE.util.deepClone(window.ACE_DEFAULT_CONFIG), saved || {});
    // Strict version mode: the versions are fixed by config/versions.js and never taken from saved settings.
    if (window.ACE_VERSIONS) { st.current.sourceVersion = window.ACE_VERSIONS.source; st.current.targetVersion = window.ACE_VERSIONS.target; }
    return st.current;
  };
  st.save = function () {
    try { localStorage.setItem(KEY, JSON.stringify(st.current)); return true; }
    catch (e) { ACE.log.warn('Could not persist settings: ' + e.message); return false; }
  };
  st.reset = function () { try { localStorage.removeItem(KEY); } catch (e) { /* ignore */ } return st.load(); };

  /* Limits converted to bytes for the BAR engine. */
  st.limits = function () {
    var l = st.current.limits;
    return { maxFileSize: l.maxFileSizeMB * 1048576, maxTotalSize: l.maxTotalSizeMB * 1048576, maxEntries: l.maxEntries, maxDepth: l.maxDepth, maxRatio: l.maxRatio };
  };

  /* ---------- document & rule store ---------- */
  var mem = { docs: [], rules: [] }, dbp = null;
  function db() {
    if (dbp) return dbp;
    dbp = new Promise(function (res) {
      try {
        var r = indexedDB.open('ace-migration-workbench', 1);
        r.onupgradeneeded = function () { var d = r.result; if (!d.objectStoreNames.contains('docs')) d.createObjectStore('docs', { keyPath: 'id' }); if (!d.objectStoreNames.contains('rules')) d.createObjectStore('rules', { keyPath: 'id' }); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { ACE.log.warn('IndexedDB unavailable; imported documents are kept for this session only'); res(null); };
      } catch (e) { ACE.log.warn('IndexedDB unavailable (' + e.message + '); imported documents are kept for this session only'); res(null); }
    });
    return dbp;
  }
  function tx(store, mode, fn) {
    return db().then(function (d) {
      if (!d) return fn(null);
      return new Promise(function (res, rej) {
        var t = d.transaction(store, mode), s = t.objectStore(store), out = fn(s);
        t.oncomplete = function () { res(out && out.result !== undefined ? out.result : out); };
        t.onerror = function () { rej(t.error); };
      });
    });
  }
  st.listStore = function (store) {
    return db().then(function (d) {
      if (!d) return mem[store].slice();
      return new Promise(function (res) { var q = d.transaction(store).objectStore(store).getAll(); q.onsuccess = function () { res(q.result || []); }; q.onerror = function () { res(mem[store].slice()); }; });
    });
  };
  st.putStore = function (store, obj) {
    mem[store] = mem[store].filter(function (x) { return x.id !== obj.id; }).concat([obj]);
    return tx(store, 'readwrite', function (s) { if (s) s.put(obj); return obj; });
  };
  st.deleteStore = function (store, id) {
    mem[store] = mem[store].filter(function (x) { return x.id !== id; });
    return tx(store, 'readwrite', function (s) { if (s) s.delete(id); return true; });
  };

  /* Turn an imported documentation file (HTML/TXT/XML/JSON) into searchable plain text. */
  st.docText = function (name, text) {
    if (/\.(html?|xhtml)$/i.test(name)) {
      try { var d = new DOMParser().parseFromString(text, 'text/html'); Array.prototype.forEach.call(d.querySelectorAll('script,style,nav'), function (n) { n.remove(); }); return (d.body ? d.body.textContent : text).replace(/\s+/g, ' ').trim(); } catch (e) { return text; }
    }
    if (/\.xml$/i.test(name)) { try { var x = new DOMParser().parseFromString(text, 'application/xml'); return (x.documentElement.textContent || text).replace(/\s+/g, ' ').trim(); } catch (e) { return text; } }
    if (/\.json$/i.test(name)) { try { return JSON.stringify(JSON.parse(text)); } catch (e) { return text; } }
    return text;
  };
})(window.ACE);
