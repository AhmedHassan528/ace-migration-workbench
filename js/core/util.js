/* IBM ACE Migration Workbench - core utilities.
 * Classic script (no ES modules) so the app works when opened from file://.
 * Everything hangs off the single global namespace window.ACE. */
(function (global) {
  'use strict';
  var ACE = global.ACE = global.ACE || {};

  var util = ACE.util = {};

  util.VERSION = '1.0.0';

  util.fmtBytes = function (n) {
    if (n == null || isNaN(n)) return '-';
    if (n < 1024) return n + ' B';
    var u = ['KB', 'MB', 'GB', 'TB'], i = -1;
    do { n /= 1024; i++; } while (n >= 1024 && i < u.length - 1);
    return n.toFixed(n < 10 ? 2 : 1) + ' ' + u[i];
  };

  util.esc = function (s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  };

  util.ext = function (name) {
    var base = String(name).split('/').pop();
    var i = base.lastIndexOf('.');
    return i <= 0 ? '' : base.slice(i + 1).toLowerCase();
  };

  util.basename = function (p) { return String(p).split('/').pop(); };
  util.dirname = function (p) { var a = String(p).split('/'); a.pop(); return a.join('/'); };
  util.stripExt = function (name) { var b = util.basename(name); var i = b.lastIndexOf('.'); return i > 0 ? b.slice(0, i) : b; };

  util.nowIso = function () { return new Date().toISOString(); };

  util.uid = (function () { var n = 0; return function (p) { n++; return (p || 'id') + '_' + n.toString(36); }; })();

  /* Yield to the event loop so the UI stays responsive during long loops. */
  util.yieldUI = function () { return new Promise(function (r) { setTimeout(r, 0); }); };

  /* Cooperative cancellation token. */
  util.CancelToken = function () { this.cancelled = false; this.reason = null; this._cbs = []; };
  util.CancelToken.prototype.cancel = function (reason) {
    if (this.cancelled) return;
    this.cancelled = true; this.reason = reason || 'Cancelled by user';
    this._cbs.forEach(function (cb) { try { cb(); } catch (e) { /* ignore */ } });
  };
  util.CancelToken.prototype.onCancel = function (cb) { this._cbs.push(cb); };
  util.CancelToken.prototype.check = function () {
    if (this.cancelled) { var e = new Error(this.reason); e.name = 'CancelledError'; throw e; }
  };
  util.isCancel = function (e) { return e && e.name === 'CancelledError'; };

  var utf8Fatal = null, utf8 = new TextDecoder('utf-8'), latin1 = null;
  try { utf8Fatal = new TextDecoder('utf-8', { fatal: true }); } catch (e) { utf8Fatal = null; }
  try { latin1 = new TextDecoder('windows-1252'); } catch (e) { latin1 = null; }

  /* Decode bytes to text. Returns {text, encoding, lossy}. Never silently claims UTF-8. */
  util.decodeText = function (bytes) {
    var start = 0, enc = 'utf-8';
    if (bytes.length >= 3 && bytes[0] === 0xEF && bytes[1] === 0xBB && bytes[2] === 0xBF) { start = 3; enc = 'utf-8 (BOM)'; }
    else if (bytes.length >= 2 && bytes[0] === 0xFF && bytes[1] === 0xFE) {
      return { text: new TextDecoder('utf-16le').decode(bytes.subarray(2)), encoding: 'utf-16le (BOM)', lossy: false };
    } else if (bytes.length >= 2 && bytes[0] === 0xFE && bytes[1] === 0xFF) {
      return { text: new TextDecoder('utf-16be').decode(bytes.subarray(2)), encoding: 'utf-16be (BOM)', lossy: false };
    }
    var body = bytes.subarray(start);
    if (utf8Fatal) {
      try { return { text: utf8Fatal.decode(body), encoding: enc, lossy: false }; }
      catch (e) {
        if (latin1) return { text: latin1.decode(body), encoding: 'windows-1252 (not valid UTF-8)', lossy: false };
        return { text: utf8.decode(body), encoding: 'utf-8 (invalid sequences replaced)', lossy: true };
      }
    }
    return { text: utf8.decode(body), encoding: enc, lossy: false };
  };

  /* Heuristic: does this byte array look like text? */
  util.looksText = function (bytes) {
    var n = Math.min(bytes.length, 8192), bad = 0;
    if (n === 0) return true;
    for (var i = 0; i < n; i++) {
      var b = bytes[i];
      if (b === 0) return false;
      if (b < 7 || (b > 13 && b < 32 && b !== 27)) bad++;
    }
    return bad / n < 0.02;
  };

  util.encodeUtf8 = function (s) { return new TextEncoder().encode(s); };

  util.sha256Hex = async function (bytes) {
    if (!(global.crypto && crypto.subtle && crypto.subtle.digest)) return null; // not a secure context
    try {
      var h = await crypto.subtle.digest('SHA-256', bytes);
      return Array.prototype.map.call(new Uint8Array(h), function (b) { return ('0' + b.toString(16)).slice(-2); }).join('');
    } catch (e) { return null; }
  };

  util.download = function (data, filename, mime) {
    var blob = data instanceof Blob ? data : new Blob([data], { type: mime || 'application/octet-stream' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url; a.download = filename; a.style.display = 'none';
    document.body.appendChild(a); a.click();
    setTimeout(function () { URL.revokeObjectURL(url); a.remove(); }, 2000);
  };

  util.readFileBytes = function (file) {
    if (file.arrayBuffer) return file.arrayBuffer().then(function (b) { return new Uint8Array(b); });
    return new Promise(function (res, rej) {
      var r = new FileReader();
      r.onload = function () { res(new Uint8Array(r.result)); };
      r.onerror = function () { rej(r.error); };
      r.readAsArrayBuffer(file);
    });
  };

  util.bytesToBase64 = function (bytes) {
    var s = '', CH = 0x8000;
    for (var i = 0; i < bytes.length; i += CH) s += String.fromCharCode.apply(null, bytes.subarray(i, i + CH));
    return btoa(s);
  };
  util.base64ToBytes = function (b64) {
    var s = atob(b64), out = new Uint8Array(s.length);
    for (var i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
    return out;
  };

  util.bytesEqual = function (a, b) {
    if (a.length !== b.length) return false;
    for (var i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
  };

  /* Split text into lines, keeping line numbers 1-based. */
  util.lines = function (text) { return String(text).split(/\r\n|\r|\n/); };

  /* Line number of a character offset. */
  util.lineAt = function (text, offset) {
    var n = 1;
    for (var i = 0; i < offset && i < text.length; i++) if (text.charCodeAt(i) === 10) n++;
    return n;
  };

  util.groupBy = function (arr, fn) {
    var m = {};
    arr.forEach(function (x) { var k = fn(x); (m[k] = m[k] || []).push(x); });
    return m;
  };

  util.uniq = function (arr) { return Array.from(new Set(arr)); };

  util.deepClone = function (o) { return JSON.parse(JSON.stringify(o)); };

  /* Minimal event bus. */
  var listeners = {};
  ACE.on = function (ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); };
  ACE.emit = function (ev, data) { (listeners[ev] || []).forEach(function (fn) { try { fn(data); } catch (e) { console.error(e); } }); };

  /* Logging: in-memory log shown in the log panel and included in reports. */
  var logEntries = [];
  ACE.log = function (level, msg, detail) {
    var e = { t: util.nowIso(), level: level, msg: String(msg), detail: detail == null ? null : detail };
    logEntries.push(e);
    if (logEntries.length > 20000) logEntries.shift();
    ACE.emit('log', e);
    if (level === 'error') console.error('[ACE]', msg, detail || ''); else if (global.ACE_DEBUG) console.log('[ACE]', level, msg, detail || '');
    return e;
  };
  ACE.log.entries = function () { return logEntries.slice(); };
  ACE.log.clear = function () { logEntries.length = 0; ACE.emit('log-clear'); };
  ['info', 'warn', 'error', 'debug', 'ok'].forEach(function (l) { ACE.log[l] = function (m, d) { return ACE.log(l, m, d); }; });

  /* Environment capability probe - reported honestly in the dashboard and reports. */
  util.capabilities = function () {
    var c = {
      protocol: global.location ? global.location.protocol : 'unknown',
      decompressionStream: typeof global.DecompressionStream === 'function',
      compressionStream: typeof global.CompressionStream === 'function',
      deflateRaw: false,
      subtleCrypto: !!(global.crypto && crypto.subtle),
      indexedDB: (function () { try { return !!global.indexedDB; } catch (e) { return false; } })(),
      domParser: typeof global.DOMParser === 'function',
      canExecuteJava: false, // a browser page can never launch a JVM itself
      userAgent: global.navigator ? navigator.userAgent : ''
    };
    try { if (c.decompressionStream) { new DecompressionStream('deflate-raw'); c.deflateRaw = true; } } catch (e) { c.deflateRaw = false; }
    return c;
  };
})(window);
