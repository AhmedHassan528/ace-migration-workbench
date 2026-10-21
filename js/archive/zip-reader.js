/* ZIP archive reader built only on native browser APIs.
 *
 * - Reads the End Of Central Directory (EOCD) record, then the central directory.
 * - Supports ZIP64 records, stored (method 0) and deflate (method 8) entries.
 * - Inflation uses the native DecompressionStream('deflate-raw'); if the browser lacks it,
 *   deflated entries are reported as not extractable rather than faked.
 * - Every entry is CRC-32 and size verified after extraction.
 * - Unsafe paths (absolute, drive letters, '..' traversal, control characters) are flagged and
 *   never extracted into the virtual tree.
 * - Data is read through a "source" ({size, read(offset, length)}) so a large top-level BAR is
 *   read slice-by-slice from the File object instead of being loaded whole into memory.
 */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var zip = ACE.zip = ACE.zip || {};

  var SIG_LOCAL = 0x04034b50, SIG_CENTRAL = 0x02014b50, SIG_EOCD = 0x06054b50;
  var SIG_Z64_LOC = 0x07064b50, SIG_Z64_EOCD = 0x06064b50;

  var METHODS = { 0: 'stored', 1: 'shrunk', 6: 'imploded', 8: 'deflate', 9: 'deflate64', 12: 'bzip2', 14: 'lzma', 93: 'zstd', 95: 'xz', 98: 'ppmd', 99: 'aes-encrypted' };
  zip.methodName = function (m) { return METHODS[m] || ('method ' + m); };

  /* ---------- sources ---------- */
  zip.blobSource = function (blob) {
    return {
      kind: 'blob', size: blob.size,
      read: async function (off, len) {
        if (off < 0 || off + len > blob.size) throw zipError('E_RANGE', 'Read beyond end of archive (offset ' + off + ', length ' + len + ', size ' + blob.size + ')');
        return new Uint8Array(await blob.slice(off, off + len).arrayBuffer());
      }
    };
  };
  zip.bytesSource = function (u8) {
    return {
      kind: 'bytes', size: u8.length,
      read: async function (off, len) {
        if (off < 0 || off + len > u8.length) throw zipError('E_RANGE', 'Read beyond end of archive (offset ' + off + ', length ' + len + ', size ' + u8.length + ')');
        return u8.subarray(off, off + len);
      }
    };
  };

  function zipError(code, msg) { var e = new Error(msg); e.code = code; e.name = 'ZipError'; return e; }
  zip.ZipError = zipError;

  function u16(b, o) { return b[o] | (b[o + 1] << 8); }
  function u32(b, o) { return (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0; }
  function u64(b, o) {
    var lo = u32(b, o), hi = u32(b, o + 4);
    if (hi > 0x1FFFFF) throw zipError('E_Z64_RANGE', 'ZIP64 value exceeds safe integer range');
    return hi * 0x100000000 + lo;
  }

  function dosDate(time, date) {
    if (!date) return null;
    var y = ((date >> 9) & 0x7F) + 1980, mo = ((date >> 5) & 0x0F) - 1, d = date & 0x1F;
    var h = (time >> 11) & 0x1F, mi = (time >> 5) & 0x3F, s = (time & 0x1F) * 2;
    var dt = new Date(y, mo, d, h, mi, s);
    return isNaN(dt.getTime()) ? null : dt.toISOString();
  }

  var cp437 = null;
  function decodeName(bytes, utf8Flag) {
    if (utf8Flag) return { name: new TextDecoder('utf-8').decode(bytes), encoding: 'utf-8 (flag)' };
    var ascii = true;
    for (var i = 0; i < bytes.length; i++) if (bytes[i] > 0x7F) { ascii = false; break; }
    if (ascii) return { name: String.fromCharCode.apply(null, bytes), encoding: 'ascii' };
    // No UTF-8 flag: many Java/Windows tools still write UTF-8. Try strict UTF-8 first, then CP437.
    try { return { name: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'utf-8 (unflagged)' }; } catch (e) { /* fallthrough */ }
    try { cp437 = cp437 || new TextDecoder('ibm437'); return { name: cp437.decode(bytes), encoding: 'cp437' }; }
    catch (e) { return { name: new TextDecoder('windows-1252').decode(bytes), encoding: 'windows-1252 (cp437 unavailable)' }; }
  }

  /* Normalise an entry name into a safe relative path. Never throws; reports instead. */
  zip.sanitizePath = function (raw) {
    var notes = [], unsafe = null;
    var p = String(raw);
    if (p.indexOf('\\') >= 0) { notes.push('backslash path separators normalised to "/"'); p = p.replace(/\\/g, '/'); }
    if (/[\u0000-\u001F]/.test(p)) unsafe = 'control characters in name';
    if (/^\//.test(p)) unsafe = unsafe || 'absolute path';
    if (/^[A-Za-z]:/.test(p)) unsafe = unsafe || 'drive-letter path';
    if (/^\/\//.test(raw) || /^\\\\/.test(raw)) unsafe = unsafe || 'UNC path';
    var isDir = /\/$/.test(p);
    var segs = p.split('/'), out = [];
    for (var i = 0; i < segs.length; i++) {
      var s = segs[i];
      if (s === '' || s === '.') continue;
      if (s === '..') { unsafe = unsafe || 'path traversal ("..")'; continue; }
      if (/[<>:"|?*]/.test(s)) notes.push('segment "' + s + '" contains characters invalid on Windows');
      if (/[ .]$/.test(s)) notes.push('segment "' + s + '" ends with space or dot (invalid on Windows)');
      out.push(s);
    }
    if (out.length === 0 && !unsafe) unsafe = 'empty path';
    return { path: out.join('/') + (isDir && out.length ? '/' : ''), unsafe: unsafe, notes: notes, isDir: isDir };
  };

  async function findEOCD(src) {
    if (src.size < 22) throw zipError('E_TOO_SMALL', 'File is ' + src.size + ' bytes: too small to be a ZIP archive (minimum 22 bytes)');
    var maxBack = Math.min(src.size, 22 + 0xFFFF);
    var tail = await src.read(src.size - maxBack, maxBack);
    var MAX_TRAILING = 32; // tolerate a little padding after the record, nothing more
    for (var i = tail.length - 22; i >= 0; i--) {
      if (u32(tail, i) === SIG_EOCD) {
        var commentLen = u16(tail, i + 20);
        if (i + 22 + commentLen > tail.length) continue;
        var trailing = tail.length - (i + 22 + commentLen);
        // The record must close the file. A record found further back usually belongs to a NESTED
        // archive stored inside a truncated outer archive (e.g. a stored .appzip); accepting it would
        // silently present the inner archive as the BAR.
        if (trailing > MAX_TRAILING) {
          throw zipError('E_EOCD_NOT_AT_END', 'The last end-of-central-directory record is followed by ' + trailing + ' unexplained bytes: the archive is truncated or corrupt (the record found most likely belongs to a nested archive)');
        }
        return { offset: src.size - maxBack + i, buf: tail.subarray(i), trailing: trailing };
      }
    }
    throw zipError('E_NO_EOCD', 'End of central directory record not found: the file is not a ZIP-compatible archive, or it is truncated/corrupt');
  }

  /* Open an archive and parse its central directory.
   * opts: {maxEntries, label}
   * returns {entries:[...], issues:[...], comment, zip64, source} */
  zip.open = async function (src, opts) {
    opts = opts || {};
    var issues = [];
    function issue(sev, code, msg, entryName) { issues.push({ severity: sev, code: code, message: msg, entry: entryName || null }); }

    var head = await src.read(0, Math.min(4, src.size));
    var headSig = head.length >= 4 ? u32(head, 0) : 0;
    if (headSig !== SIG_LOCAL && headSig !== SIG_EOCD) {
      if (head[0] === 0x50 && head[1] === 0x4B) issue('warning', 'W_ODD_SIGNATURE', 'Archive starts with "PK" but not a local-file header (spanned or self-extracting archive?)');
      else issue('warning', 'W_PREFIX_DATA', 'Archive does not start with a ZIP local-file signature; data precedes the archive (self-extracting stub or corruption)');
    }

    var eocd = await findEOCD(src);
    var e = eocd.buf;
    var diskNo = u16(e, 4), cdDisk = u16(e, 6);
    var count = u16(e, 10), cdSize = u32(e, 12), cdOffset = u32(e, 16);
    var commentLen = u16(e, 20);
    var comment = commentLen ? new TextDecoder().decode(e.subarray(22, 22 + commentLen)) : '';
    var zip64 = false;

    if (count === 0xFFFF || cdSize === 0xFFFFFFFF || cdOffset === 0xFFFFFFFF) {
      if (eocd.offset < 20) throw zipError('E_Z64', 'ZIP64 markers present but no ZIP64 locator');
      var loc = await src.read(eocd.offset - 20, 20);
      if (u32(loc, 0) !== SIG_Z64_LOC) throw zipError('E_Z64', 'ZIP64 markers present but ZIP64 end-of-central-directory locator is missing');
      var z64off = u64(loc, 8);
      var z = await src.read(z64off, 56);
      if (u32(z, 0) !== SIG_Z64_EOCD) throw zipError('E_Z64', 'ZIP64 end-of-central-directory record signature mismatch');
      count = u64(z, 32); cdSize = u64(z, 40); cdOffset = u64(z, 48);
      zip64 = true;
      issue('info', 'I_ZIP64', 'Archive uses ZIP64 extensions');
    }
    if (diskNo !== 0 || cdDisk !== 0) throw zipError('E_MULTIDISK', 'Multi-volume (spanned) ZIP archives are not supported');

    // Some writers prepend data (SFX). Detect the real CD start relative to EOCD.
    var prefix = 0;
    if (!zip64 && cdOffset + cdSize !== eocd.offset) {
      var guess = eocd.offset - cdSize;
      if (guess >= 0) {
        var probe = await src.read(guess, 4);
        if (u32(probe, 0) === SIG_CENTRAL) { prefix = guess - cdOffset; issue('warning', 'W_PREFIX_OFFSET', 'Central directory offset is off by ' + prefix + ' bytes; archive has prepended data. Offsets were adjusted.'); }
      }
    }
    if (cdOffset + prefix + cdSize > src.size) throw zipError('E_CD_RANGE', 'Central directory extends beyond the end of the file (truncated archive)');
    var maxEntries = opts.maxEntries || 200000;
    if (count > maxEntries) throw zipError('E_TOO_MANY', 'Archive declares ' + count + ' entries; the configured limit is ' + maxEntries);

    var cd = await src.read(cdOffset + prefix, cdSize);
    var entries = [], p = 0, seen = {};
    for (var i = 0; i < count; i++) {
      if (p + 46 > cd.length || u32(cd, p) !== SIG_CENTRAL) throw zipError('E_CD_CORRUPT', 'Central directory entry ' + (i + 1) + ' of ' + count + ' is corrupt (bad signature at CD offset ' + p + ')');
      var madeBy = u16(cd, p + 4), needed = u16(cd, p + 6), flags = u16(cd, p + 8), method = u16(cd, p + 10);
      var mtime = u16(cd, p + 12), mdate = u16(cd, p + 14), crc = u32(cd, p + 16);
      var csize = u32(cd, p + 20), usize = u32(cd, p + 24);
      var nlen = u16(cd, p + 28), xlen = u16(cd, p + 30), clen = u16(cd, p + 32);
      var extAttr = u32(cd, p + 38), lhOff = u32(cd, p + 42);
      if (p + 46 + nlen + xlen + clen > cd.length) throw zipError('E_CD_CORRUPT', 'Central directory entry ' + (i + 1) + ' overruns the directory');
      var nameBytes = cd.subarray(p + 46, p + 46 + nlen);
      var extra = cd.subarray(p + 46 + nlen, p + 46 + nlen + xlen);
      // ZIP64 extended information extra field (0x0001)
      var xo = 0;
      while (xo + 4 <= extra.length) {
        var hid = u16(extra, xo), hsz = u16(extra, xo + 2), q = xo + 4;
        if (hid === 0x0001) {
          if (usize === 0xFFFFFFFF && q + 8 <= xo + 4 + hsz) { usize = u64(extra, q); q += 8; }
          if (csize === 0xFFFFFFFF && q + 8 <= xo + 4 + hsz) { csize = u64(extra, q); q += 8; }
          if (lhOff === 0xFFFFFFFF && q + 8 <= xo + 4 + hsz) { lhOff = u64(extra, q); q += 8; }
        }
        xo += 4 + hsz;
      }
      var dn = decodeName(nameBytes, (flags & 0x0800) !== 0);
      var san = zip.sanitizePath(dn.name);
      var ent = {
        index: i, rawName: dn.name, nameEncoding: dn.encoding, path: san.path, isDir: san.isDir || (dn.name.slice(-1) === '/'),
        unsafe: san.unsafe, pathNotes: san.notes, method: method, methodName: zip.methodName(method),
        flags: flags, encrypted: (flags & 1) !== 0, crc: crc, compressedSize: csize, size: usize,
        localHeaderOffset: lhOff + prefix, mtime: dosDate(mtime, mdate), versionMadeBy: (madeBy & 0xFF) / 10,
        hostOS: madeBy >> 8, versionNeeded: needed / 10, externalAttr: extAttr, issues: []
      };
      if (ent.isDir && usize > 0) ent.issues.push({ severity: 'warning', code: 'W_DIR_DATA', message: 'Directory entry carries ' + usize + ' bytes of data' });
      if (ent.unsafe) ent.issues.push({ severity: 'error', code: 'E_UNSAFE_PATH', message: 'Unsafe entry path rejected: ' + ent.unsafe + ' (raw name: ' + dn.name + ')' });
      san.notes.forEach(function (n) { ent.issues.push({ severity: 'info', code: 'I_PATH_NOTE', message: n }); });
      if (ent.encrypted) ent.issues.push({ severity: 'error', code: 'E_ENCRYPTED', message: 'Entry is encrypted; encrypted entries are not supported' });
      if (!ent.isDir && method !== 0 && method !== 8) ent.issues.push({ severity: 'error', code: 'E_METHOD', message: 'Unsupported compression method: ' + ent.methodName });
      if (!ent.isDir && method === 0 && csize !== usize) ent.issues.push({ severity: 'error', code: 'E_STORED_SIZE', message: 'Stored entry has different compressed (' + csize + ') and uncompressed (' + usize + ') sizes' });
      if (ent.localHeaderOffset + 30 > src.size) ent.issues.push({ severity: 'error', code: 'E_LH_RANGE', message: 'Local header offset beyond end of file' });
      var ratio = csize > 0 ? usize / csize : (usize > 0 ? Infinity : 1);
      ent.ratio = ratio;
      if (usize > 10 * 1024 * 1024 && ratio > (opts.maxRatio || 1000)) ent.issues.push({ severity: 'warning', code: 'W_RATIO', message: 'Suspicious compression ratio ' + (ratio === Infinity ? 'infinite' : ratio.toFixed(0)) + ':1 (possible ZIP bomb)' });

      if (!ent.unsafe && ent.path) {
        var key = ent.path.toLowerCase();
        if (seen[key] != null) {
          var first = entries[seen[key]];
          if (first.path === ent.path) {
            ent.duplicateOf = first.index;
            ent.issues.push({ severity: 'error', code: 'E_DUPLICATE', message: 'Duplicate entry path "' + ent.path + '" (also entry #' + (first.index + 1) + '). Neither copy is overwritten; the duplicate is kept under a separate name.' });
          } else {
            ent.caseCollisionWith = first.index;
            ent.issues.push({ severity: 'warning', code: 'W_CASE_COLLISION', message: 'Path "' + ent.path + '" differs only by letter case from "' + first.path + '"; these collide on Windows file systems' });
          }
        } else seen[key] = entries.length;
      }
      entries.push(ent);
      p += 46 + nlen + xlen + clen;
    }
    if (p !== cd.length) issue('warning', 'W_CD_TRAILING', 'Central directory has ' + (cd.length - p) + ' unexplained trailing bytes');

    return { entries: entries, issues: issues, comment: comment, zip64: zip64, source: src, label: opts.label || '' };
  };

  async function inflateRaw(data, expected, maxSize, cancel) {
    if (typeof DecompressionStream !== 'function') throw zipError('E_NO_INFLATE', 'This browser has no native DecompressionStream; deflated entries cannot be extracted. Use a current Chrome, Edge or Firefox.');
    var ds;
    try { ds = new DecompressionStream('deflate-raw'); } catch (e) { throw zipError('E_NO_INFLATE', 'This browser does not support DecompressionStream("deflate-raw"). Use Chrome/Edge 103+, Firefox 113+ or Safari 16.4+.'); }
    var reader = new Blob([data]).stream().pipeThrough(ds).getReader();
    var chunks = [], total = 0;
    try {
      while (true) {
        if (cancel && cancel.cancelled) { try { reader.cancel(); } catch (e) { /* ignore */ } cancel.check(); }
        var r = await reader.read();
        if (r.done) break;
        total += r.value.length;
        if (total > maxSize) { try { reader.cancel(); } catch (e) { /* ignore */ } throw zipError('E_LIMIT', 'Decompressed data exceeds the limit of ' + util.fmtBytes(maxSize)); }
        if (expected >= 0 && total > expected) { try { reader.cancel(); } catch (e) { /* ignore */ } throw zipError('E_SIZE', 'Decompressed data is larger than the declared size (' + expected + ' bytes): corrupt entry'); }
        chunks.push(r.value);
      }
    } catch (e) {
      if (e.code || util.isCancel(e)) throw e;
      throw zipError('E_INFLATE', 'Deflate data is corrupt: ' + (e.message || e));
    }
    var out = new Uint8Array(total), o = 0;
    chunks.forEach(function (c) { out.set(c, o); o += c.length; });
    return out;
  }

  /* Extract one entry's bytes. Verifies the local header, size and CRC-32.
   * opts: {maxSize, cancel} */
  zip.extract = async function (archive, ent, opts) {
    opts = opts || {};
    var maxSize = opts.maxSize || 512 * 1024 * 1024;
    if (ent.isDir) return new Uint8Array(0);
    if (ent.unsafe) throw zipError('E_UNSAFE_PATH', 'Refusing to extract unsafe path: ' + ent.unsafe);
    if (ent.encrypted) throw zipError('E_ENCRYPTED', 'Encrypted entry');
    if (ent.method !== 0 && ent.method !== 8) throw zipError('E_METHOD', 'Unsupported compression method: ' + ent.methodName);
    if (ent.size > maxSize) throw zipError('E_LIMIT', 'Entry size ' + util.fmtBytes(ent.size) + ' exceeds the per-file limit of ' + util.fmtBytes(maxSize));
    var src = archive.source;
    var lh = await src.read(ent.localHeaderOffset, 30);
    if (u32(lh, 0) !== SIG_LOCAL) throw zipError('E_LH_SIG', 'Local file header signature mismatch (corrupt archive)');
    var lnlen = u16(lh, 26), lxlen = u16(lh, 28);
    var dataStart = ent.localHeaderOffset + 30 + lnlen + lxlen;
    if (dataStart + ent.compressedSize > src.size) throw zipError('E_TRUNC', 'Entry data extends beyond end of archive (truncated)');
    var raw = await src.read(dataStart, ent.compressedSize);
    var out;
    if (ent.method === 0) out = raw.slice ? raw.slice() : new Uint8Array(raw);
    else out = await inflateRaw(raw, ent.size, maxSize, opts.cancel);
    if (out.length !== ent.size) throw zipError('E_SIZE', 'Extracted size ' + out.length + ' does not match declared size ' + ent.size);
    var crc = ACE.crc32(out);
    if (crc !== ent.crc) throw zipError('E_CRC', 'CRC-32 mismatch (expected ' + ent.crc.toString(16) + ', got ' + crc.toString(16) + '): corrupt entry');
    return out;
  };
})(window.ACE);
