/* ZIP writer using only native browser APIs.
 * Entries are deflated with CompressionStream('deflate-raw') when available, else stored.
 * Names are written as UTF-8 with general-purpose flag bit 11 set. Classic (non-ZIP64) format:
 * a package over 4 GB or 65535 entries is refused with a clear error instead of being written corrupt. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var zip = ACE.zip = ACE.zip || {};

  function dosTime(d) {
    d = d || new Date();
    var y = Math.max(1980, d.getFullYear());
    return {
      time: (d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2)),
      date: ((y - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
    };
  }

  async function deflateRaw(bytes) {
    var cs = new CompressionStream('deflate-raw');
    var buf = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
    return new Uint8Array(buf);
  }

  zip.Writer = function (opts) {
    this.opts = opts || {};
    this.entries = [];
    this.paths = {};
    this.compress = this.opts.compress !== false && typeof CompressionStream === 'function';
    if (this.compress) { try { new CompressionStream('deflate-raw'); } catch (e) { this.compress = false; } }
  };

  /* Add a file. data: Uint8Array or string. Duplicate paths are refused (never silently overwritten). */
  zip.Writer.prototype.add = function (path, data, meta) {
    var san = zip.sanitizePath(path);
    if (san.unsafe) throw new Error('Refusing to write unsafe path into ZIP: ' + path + ' (' + san.unsafe + ')');
    var p = san.path;
    var key = p.toLowerCase();
    if (this.paths[key]) throw new Error('Duplicate path in output package: ' + p);
    this.paths[key] = true;
    var bytes = typeof data === 'string' ? util.encodeUtf8(data) : data;
    this.entries.push({ path: p, bytes: bytes, date: (meta && meta.date) ? new Date(meta.date) : new Date(), store: meta && meta.store });
    return p;
  };
  zip.Writer.prototype.has = function (path) { return !!this.paths[String(path).toLowerCase()]; };

  zip.Writer.prototype.build = async function (progress, cancel) {
    var parts = [], central = [], offset = 0, n = this.entries.length;
    if (n > 0xFFFF) throw new Error('Package has ' + n + ' entries; this writer supports at most 65535 (no ZIP64). Use the manifest/individual downloads fallback.');
    for (var i = 0; i < n; i++) {
      if (cancel) cancel.check();
      var e = this.entries[i];
      var name = util.encodeUtf8(e.path);
      var crc = ACE.crc32(e.bytes);
      var data = e.bytes, method = 0;
      if (this.compress && !e.store && e.bytes.length > 64) {
        var d = await deflateRaw(e.bytes);
        if (d.length < e.bytes.length) { data = d; method = 8; }
      }
      var t = dosTime(e.date);
      var lh = new Uint8Array(30 + name.length), v = new DataView(lh.buffer);
      v.setUint32(0, 0x04034b50, true); v.setUint16(4, 20, true); v.setUint16(6, 0x0800, true);
      v.setUint16(8, method, true); v.setUint16(10, t.time, true); v.setUint16(12, t.date, true);
      v.setUint32(14, crc, true); v.setUint32(18, data.length, true); v.setUint32(22, e.bytes.length, true);
      v.setUint16(26, name.length, true); v.setUint16(28, 0, true); lh.set(name, 30);
      var ch = new Uint8Array(46 + name.length), c = new DataView(ch.buffer);
      c.setUint32(0, 0x02014b50, true); c.setUint16(4, 20, true); c.setUint16(6, 20, true); c.setUint16(8, 0x0800, true);
      c.setUint16(10, method, true); c.setUint16(12, t.time, true); c.setUint16(14, t.date, true);
      c.setUint32(16, crc, true); c.setUint32(20, data.length, true); c.setUint32(24, e.bytes.length, true);
      c.setUint16(28, name.length, true); c.setUint32(42, offset, true); ch.set(name, 46);
      parts.push(lh, data); central.push(ch);
      offset += lh.length + data.length;
      if (offset > 0xFFFFFFFF) throw new Error('Package exceeds 4 GB; this writer does not create ZIP64 archives.');
      if (progress && (i % 20 === 0)) { progress(i + 1, n); await util.yieldUI(); }
    }
    var cdSize = central.reduce(function (s, x) { return s + x.length; }, 0);
    var eocd = new Uint8Array(22), ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true); ev.setUint16(8, n, true); ev.setUint16(10, n, true);
    ev.setUint32(12, cdSize, true); ev.setUint32(16, offset, true);
    if (progress) progress(n, n);
    return new Blob(parts.concat(central, [eocd]), { type: 'application/zip' });
  };
})(window.ACE);
