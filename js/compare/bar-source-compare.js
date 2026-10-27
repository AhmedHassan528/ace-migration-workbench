/* BAR vs source-code comparison (ACE.cmp).
 *
 *  - The SOURCE code (a Toolkit workspace ZIP or a folder picked in the file explorer) is the master.
 *  - Applications are matched BY NAME: the project name in .project (folder name when there is none)
 *    against the application archive name (<name>.appzip) in the BAR.
 *  - Only ESQL, WSDL, XSD, message flows and subflows are scanned. Java sources, JARs and every other
 *    file are never read (JARs are not even opened); nothing is decompiled; nothing is modified.
 *  - Framework / library content is ignored: library, shared-library and Java projects of the source,
 *    .libzip / .shlibzip archives of the BAR, and extra framework ESQL files found inside an application.
 *  - Scanning is lazy and cheap: only the central directories of the BAR and of the source ZIP are read up
 *    front; an application archive is extracted only when a source application of the same name exists;
 *    entries whose size and CRC-32 are equal on both sides are identical without extracting them.
 *
 * Result per file: status (identical | modified | missing-in-bar | extra-in-bar | not-comparable) and
 * severity (critical | difference | warning | ok):
 *   missing-in-bar  a source (master) file that is not in the BAR                          -> critical
 *   modified        WSDL or XSD differs                                                    -> critical
 *   modified        ESQL / message flow / subflow differs                                  -> difference
 *   extra-in-bar    a BAR file with no source file                                         -> warning (non-critical)
 *   not-comparable  the BAR holds only a compiled .cmf for a source flow                   -> warning
 */
(function (ACE) {
  'use strict';
  var util = ACE.util, zip = ACE.zip;
  var C = ACE.cmp = {};

  C.SCOPE = { esql: 'ESQL', wsdl: 'WSDL', xsd: 'XSD', msgflow: 'Message flow', subflow: 'Subflow' };
  C.STATUS = { identical: 'Identical', modified: 'Modified', 'missing-in-bar': 'Missing in BAR', 'extra-in-bar': 'Extra in BAR', 'not-comparable': 'Not comparable' };
  C.SEVERITY = { critical: 'Critical', difference: 'Difference', warning: 'Warning', ok: 'OK' };
  C.DEFAULTS = { ignoreFramework: true, frameworkPatterns: '', ignoreWhitespace: true, maxFileSize: 64 * 1024 * 1024 };

  var SKIP_DIR = /(^|\/)(\.settings|\.git|\.svn|node_modules)(\/|$)/;
  function noop() {}
  function extOf(p) { return util.ext(p).toLowerCase(); }
  function inScope(p) { return !!C.SCOPE[extOf(p)]; }
  function normPath(p) { return zip.sanitizePath(String(p).replace(/^\.\//, '')).path.replace(/\/$/, ''); }
  function lc(s) { return String(s).toLowerCase(); }

  /* ================= source ================= */

  /* input: {zip: File} | {files: [File...]} (a folder from <input webkitdirectory>, paths from webkitRelativePath).
   * Returns {name, kind, projects:[{name, folder, prefix, type, natures, refs, files:[{rel, ext, size, crc, read()}]}], stats, warnings}. */
  C.readSource = async function (input, opts) {
    opts = opts || {};
    var cancel = opts.cancel || new util.CancelToken(), progress = opts.progress || noop, maxSize = opts.maxFileSize || C.DEFAULTS.maxFileSize;
    var warnings = [], all = [], name, kind;
    if (input.zip) {
      kind = 'zip'; name = input.zip.name;
      progress('source', 0, 1, 'reading the central directory of ' + name);
      var arc = await zip.open(zip.blobSource(input.zip), { label: name });
      arc.entries.forEach(function (e) {
        if (e.isDir) return;
        if (e.unsafe) { warnings.push('Source entry rejected (' + e.unsafe + '): ' + e.rawName); return; }
        if (e.duplicateOf != null || !e.path) return;
        all.push({ path: e.path, size: e.size, crc: e.crc, read: function () { return zip.extract(arc, e, { maxSize: maxSize, cancel: cancel }); } });
      });
    } else {
      kind = 'folder'; var fl = input.files || [];
      name = fl.length && fl[0].webkitRelativePath ? fl[0].webkitRelativePath.split('/')[0] : 'folder';
      fl.forEach(function (f) {
        var p = normPath(f.webkitRelativePath || f.name); if (!p) return;
        all.push({ path: p, size: f.size, crc: null, read: function () { return util.readFileBytes(f); } });
      });
    }
    var stats = { files: all.length, scoped: 0, jars: 0, projects: 0, ignoredJavaOrOther: 0 };
    var dots = all.filter(function (e) { return e.path === '.project' || /\/\.project$/.test(e.path); });
    var projs = [], i;
    for (i = 0; i < dots.length; i++) {
      cancel.check();
      var d = dots[i], dp;
      try { dp = ACE.bar.parseDotProject(util.decodeText(await d.read()).text); } catch (e) { warnings.push('Could not read ' + d.path + ': ' + e.message); continue; }
      var prefix = d.path.slice(0, d.path.length - '.project'.length), folder = prefix.replace(/\/$/, '').split('/').pop() || util.stripExt(name);
      if (dp.parseError) warnings.push(d.path + ' could not be parsed (' + dp.parseError + '); the folder name "' + folder + '" is used.');
      projs.push({ name: dp.name || folder, folder: folder, prefix: prefix, type: ACE.bar.projectTypeFromNatures(dp.natures || []), natures: dp.natures || [], refs: dp.projects || [], files: [] });
    }
    // A .project below another project belongs to the outer project (as in the workspace import).
    projs = projs.filter(function (p) { return !projs.some(function (q) { return q !== p && q.prefix.length < p.prefix.length && p.prefix.indexOf(q.prefix) === 0; }); });
    if (!projs.length) {
      var tops = {};
      all.forEach(function (e) { var s = e.path.split('/'); tops[s.length > 1 ? s[0] : ''] = true; });
      Object.keys(tops).forEach(function (t) { projs.push({ name: t || util.stripExt(name), folder: t || util.stripExt(name), prefix: t ? t + '/' : '', type: 'unknown', natures: [], refs: [], files: [] }); });
      warnings.push('No .project file found: every top-level folder is treated as a project (project type unknown, so it is compared when an application of the same name is in the BAR).');
    }
    projs.sort(function (a, b) { return b.prefix.length - a.prefix.length; });
    all.forEach(function (e) {
      if (extOf(e.path) === 'jar') { stats.jars++; return; }
      if (!inScope(e.path)) { stats.ignoredJavaOrOther++; return; }
      var pr = projs.filter(function (p) { return !p.prefix || e.path.indexOf(p.prefix) === 0; })[0];
      if (!pr) return;
      var rel = e.path.slice(pr.prefix.length);
      if (SKIP_DIR.test(rel)) return;
      stats.scoped++;
      pr.files.push({ rel: rel, ext: extOf(rel), size: e.size, crc: e.crc, read: e.read });
    });
    projs.sort(function (a, b) { return lc(a.name) < lc(b.name) ? -1 : 1; });
    stats.projects = projs.length;
    progress('source', 1, 1, projs.length + ' project(s)');
    return { name: name, kind: kind, projects: projs, stats: stats, warnings: warnings };
  };

  /* ================= BAR ================= */

  /* Reads only the entry lists. Application archives are opened later (app.open()), and only when needed. */
  C.readBar = async function (file, opts) {
    opts = opts || {};
    var cancel = opts.cancel || new util.CancelToken(), progress = opts.progress || noop, maxSize = opts.maxFileSize || C.DEFAULTS.maxFileSize;
    var apps = [], libs = [], warnings = [], stats = { entries: 0, jars: 0, looseScoped: 0, nestedBars: 0 };
    progress('BAR', 0, 1, 'reading the central directory of ' + file.name);
    var root = await zip.open(zip.blobSource(file), { label: file.name });
    async function scan(arc, label, depth) {
      for (var i = 0; i < arc.entries.length; i++) {
        var e = arc.entries[i]; cancel.check();
        if (e.isDir || e.unsafe || !e.path) continue;
        stats.entries++;
        var ext = extOf(e.path), top = e.path.indexOf('/') < 0;
        if (ext === 'jar') { stats.jars++; continue; }
        if (!top) continue;
        if (ext === 'appzip') apps.push({ name: util.stripExt(e.path), fileName: e.path, size: e.size, from: label, archive: arc, ent: e, opened: null });
        else if (ext === 'libzip' || ext === 'shlibzip') libs.push({ name: util.stripExt(e.path), type: ext, from: label });
        else if (ext === 'bar') {
          stats.nestedBars++;
          if (depth >= 3) { warnings.push('Nested BAR not opened (depth limit): ' + e.path); continue; }
          try { var inner = await zip.open(zip.bytesSource(await zip.extract(arc, e, { maxSize: maxSize, cancel: cancel })), { label: e.path }); await scan(inner, label + e.path + '!/', depth + 1); }
          catch (er) { if (util.isCancel(er)) throw er; warnings.push('Nested BAR ' + e.path + ' could not be opened: ' + er.message); }
        } else if (C.SCOPE[ext]) stats.looseScoped++;
      }
    }
    await scan(root, '', 0);
    progress('BAR', 1, 1, apps.length + ' application(s)');
    /* Open one application archive: its in-scope files, plus what is ignored or only counted. */
    apps.forEach(function (app) {
      app.open = async function (oo) {
        if (app.opened) return app.opened;
        var c = (oo && oo.cancel) || cancel, res = { files: [], libs: [], jars: 0, cmf: {}, other: 0, error: null };
        try {
          var inner = await zip.open(zip.bytesSource(await zip.extract(app.archive, app.ent, { maxSize: maxSize, cancel: c })), { label: app.fileName });
          inner.entries.forEach(function (e) {
            if (e.isDir || e.unsafe || !e.path || e.duplicateOf != null) return;
            var x = extOf(e.path);
            if (x === 'jar') { res.jars++; return; }
            if (x === 'libzip' || x === 'shlibzip') { res.libs.push(util.stripExt(e.path)); return; }
            if (x === 'cmf') { res.cmf[lc(e.path.replace(/\.cmf$/i, ''))] = true; return; }
            if (!C.SCOPE[x]) { res.other++; return; }
            res.files.push({ rel: e.path, ext: x, size: e.size, crc: e.crc, read: function () { return zip.extract(inner, e, { maxSize: maxSize, cancel: c }); } });
          });
        } catch (er) { if (util.isCancel(er)) throw er; res.error = er.message; }
        app.opened = res; return res;
      };
    });
    return { name: file.name, size: file.size, apps: apps, libraries: libs, stats: stats, warnings: warnings };
  };

  /* ================= text and diff ================= */

  function decode(bytes) { return util.decodeText(bytes).text; }
  /* Comparison form of a text: no BOM, "\n" line ends and (optionally) no trailing blanks or trailing empty lines. */
  C.normalize = function (text, ignoreWs) {
    if (!ignoreWs) return String(text);
    return String(text).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n').replace(/[ \t]+$/gm, '').replace(/\n+$/, '');
  };

  /* Line diff: [{op:' '|'-'|'+', a, b, text}] (1-based line numbers). Prefix/suffix trimming, full LCS for
   * moderate sizes, and unique-line anchoring (patience) for big files so that large files still diff well. */
  C.lineDiff = function (aLines, bLines) {
    var out = [];
    function eq(ai, bi) { out.push({ op: ' ', a: ai + 1, b: bi + 1, text: aLines[ai] }); }
    function del(ai) { out.push({ op: '-', a: ai + 1, b: null, text: aLines[ai] }); }
    function add(bi) { out.push({ op: '+', a: null, b: bi + 1, text: bLines[bi] }); }
    function dp(a0, a1, b0, b1) {
      var n = a1 - a0, m = b1 - b0, W = m + 1, L = new Uint32Array((n + 1) * W), i, j;
      for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i * W + j] = aLines[a0 + i] === bLines[b0 + j] ? L[(i + 1) * W + j + 1] + 1 : Math.max(L[(i + 1) * W + j], L[i * W + j + 1]);
      i = 0; j = 0;
      while (i < n && j < m) {
        if (aLines[a0 + i] === bLines[b0 + j]) { eq(a0 + i, b0 + j); i++; j++; }
        else if (L[(i + 1) * W + j] >= L[i * W + j + 1]) { del(a0 + i); i++; } else { add(b0 + j); j++; }
      }
      while (i < n) { del(a0 + i); i++; }
      while (j < m) { add(b0 + j); j++; }
    }
    function seg(a0, a1, b0, b1) {
      while (a0 < a1 && b0 < b1 && aLines[a0] === bLines[b0]) { eq(a0, b0); a0++; b0++; }
      var sa = a1, sb = b1;
      while (sa > a0 && sb > b0 && aLines[sa - 1] === bLines[sb - 1]) { sa--; sb--; }
      var tail = [];
      for (var k = 0; sa + k < a1; k++) tail.push([sa + k, sb + k]);
      if (a0 === sa) for (var x = b0; x < sb; x++) add(x);
      else if (b0 === sb) for (var y = a0; y < sa; y++) del(y);
      else if ((sa - a0) * (sb - b0) <= 2500000) dp(a0, sa, b0, sb);
      else {
        // anchors: lines that occur exactly once on each side, kept in order (longest increasing subsequence)
        var ca = {}, cb = {}, posB = {}, i;
        for (i = a0; i < sa; i++) ca[aLines[i]] = (ca[aLines[i]] || 0) + 1;
        for (i = b0; i < sb; i++) { cb[bLines[i]] = (cb[bLines[i]] || 0) + 1; posB[bLines[i]] = i; }
        var cand = [];
        for (i = a0; i < sa; i++) { var t = aLines[i]; if (ca[t] === 1 && cb[t] === 1 && t.trim() !== '') cand.push([i, posB[t]]); }
        var tails = [], prev = [];
        cand.forEach(function (c, idx) {
          var lo = 0, hi = tails.length;
          while (lo < hi) { var mid = (lo + hi) >> 1; if (cand[tails[mid]][1] < c[1]) lo = mid + 1; else hi = mid; }
          prev[idx] = lo > 0 ? tails[lo - 1] : -1; tails[lo] = idx;
        });
        var anchors = [], cur = tails.length ? tails[tails.length - 1] : -1;
        while (cur >= 0) { anchors.unshift(cand[cur]); cur = prev[cur]; }
        if (!anchors.length) { for (i = a0; i < sa; i++) del(i); for (i = b0; i < sb; i++) add(i); }
        else {
          var pa = a0, pb = b0;
          anchors.forEach(function (an) { seg(pa, an[0], pb, an[1]); eq(an[0], an[1]); pa = an[0] + 1; pb = an[1] + 1; });
          seg(pa, sa, pb, sb);
        }
      }
      tail.forEach(function (t2) { eq(t2[0], t2[1]); });
    }
    seg(0, aLines.length, 0, bLines.length);
    return out;
  };

  function inlineRange(a, b) {
    var pre = 0, n = Math.min(a.length, b.length);
    while (pre < n && a.charCodeAt(pre) === b.charCodeAt(pre)) pre++;
    var suf = 0;
    while (suf < n - pre && a.charCodeAt(a.length - 1 - suf) === b.charCodeAt(b.length - 1 - suf)) suf++;
    return { a: [pre, a.length - suf], b: [pre, b.length - suf] };
  }

  /* Side-by-side rows: {kind:'eq'|'chg'|'del'|'add', l:{n,text,mark:[from,to]}|null, r:{...}|null}. Left = source, right = BAR. */
  C.sideBySide = function (srcText, barText, ignoreWs) {
    var a = util.lines(C.normalize(srcText, ignoreWs)), b = util.lines(C.normalize(barText, ignoreWs));
    if (srcText === '' || srcText == null) a = [];
    if (barText === '' || barText == null) b = [];
    var ops = C.lineDiff(a, b), rows = [], i = 0;
    while (i < ops.length) {
      if (ops[i].op === ' ') { rows.push({ kind: 'eq', l: { n: ops[i].a, text: ops[i].text }, r: { n: ops[i].b, text: ops[i].text } }); i++; continue; }
      var dels = [], adds = [];
      while (i < ops.length && ops[i].op === '-') dels.push(ops[i++]);
      while (i < ops.length && ops[i].op === '+') adds.push(ops[i++]);
      var k = Math.min(dels.length, adds.length);
      for (var j = 0; j < k; j++) { var rg = inlineRange(dels[j].text, adds[j].text); rows.push({ kind: 'chg', l: { n: dels[j].a, text: dels[j].text, mark: rg.a }, r: { n: adds[j].b, text: adds[j].text, mark: rg.b } }); }
      for (var d = k; d < dels.length; d++) rows.push({ kind: 'del', l: { n: dels[d].a, text: dels[d].text }, r: null });
      for (var ad = k; ad < adds.length; ad++) rows.push({ kind: 'add', l: null, r: { n: adds[ad].b, text: adds[ad].text } });
    }
    return rows;
  };

  /* Which rows to show for a context size (null = all) and the starting row of every block of changes. */
  C.visibleRows = function (rows, context) {
    var keep = [], blocks = [], prevChanged = false;
    rows.forEach(function (r, i) { var ch = r.kind !== 'eq'; if (ch && !prevChanged) blocks.push(i); prevChanged = ch; });
    if (context == null) { rows.forEach(function () { keep.push(true); }); return { keep: keep, blocks: blocks }; }
    rows.forEach(function () { keep.push(false); });
    rows.forEach(function (r, i) { if (r.kind !== 'eq') for (var q = Math.max(0, i - context); q <= Math.min(rows.length - 1, i + context); q++) keep[q] = true; });
    return { keep: keep, blocks: blocks };
  };

  /* ================= comparison ================= */

  function severityOf(status, ext) {
    if (status === 'identical') return 'ok';
    if (status === 'missing-in-bar') return 'critical';
    if (status === 'modified') return ext === 'wsdl' || ext === 'xsd' ? 'critical' : 'difference';
    return 'warning';
  }
  var RANK = { ok: 0, warning: 1, difference: 2, critical: 3 };

  async function pool(items, n, fn, cancel) {
    var idx = 0, workers = [];
    for (var w = 0; w < Math.min(n, items.length); w++) workers.push((async function () {
      while (idx < items.length) { cancel.check(); var my = idx++; await fn(items[my], my); }
    })());
    await Promise.all(workers);
  }

  /* source: C.readSource() result; bar: C.readBar() result.
   * options: C.DEFAULTS. opts: {cancel, progress(stage, done, total, detail)} */
  C.compare = async function (source, bar, options, opts) {
    opts = opts || {};
    var o = Object.assign({}, C.DEFAULTS, options || {}), cancel = opts.cancel || new util.CancelToken(), progress = opts.progress || noop, t0 = Date.now();
    var patterns = String(o.frameworkPatterns || '').split(/[\s,;]+/).filter(Boolean).map(function (p) { return new RegExp('^' + p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); });
    var res = { options: o, source: { name: source.name, kind: source.kind, stats: source.stats, warnings: source.warnings.slice() }, bar: { name: bar.name, size: bar.size, stats: bar.stats, libraries: bar.libraries.map(function (l) { return l.name + '.' + l.type; }), warnings: bar.warnings.slice() },
      apps: [], files: [], ignored: [], notes: [], at: util.nowIso() };

    // ---- source projects: applications are compared, everything else is framework / library content
    var srcApps = [], srcOther = [], srcByName = {}, srcByLower = {};
    source.projects.forEach(function (p) {
      if (p.type === 'application' || p.type === 'unknown') {
        srcApps.push(p);
        if (srcByName[p.name]) res.notes.push('Two source projects are named "' + p.name + '"; the first one is used.'); else srcByName[p.name] = p;
        if (!srcByLower[lc(p.name)]) srcByLower[lc(p.name)] = p;
      } else srcOther.push(p);
    });
    var fwFiles = {}, fwNames = {};   // framework ESQL: base names of the source libraries' ESQL files, library project names
    srcOther.forEach(function (p) {
      fwNames[lc(p.name)] = true;
      p.files.forEach(function (f) { if (f.ext === 'esql') fwFiles[lc(util.basename(f.rel))] = p.name; });
    });
    bar.libraries.forEach(function (l) { fwNames[lc(l.name)] = true; });
    res.source.ignoredProjects = srcOther.map(function (p) { return { name: p.name, type: p.type, files: p.files.length }; });

    // ---- match applications by name
    var barByName = {}, pairs = [], used = {};
    bar.apps.forEach(function (a) { (barByName[a.name] = barByName[a.name] || []).push(a); });
    bar.apps.forEach(function (a) {
      var sp = srcByName[a.name], how = 'exact';
      if (!sp && srcByLower[lc(a.name)]) { sp = srcByLower[lc(a.name)]; how = 'case-insensitive'; }
      if (sp && !used[sp.name + '|' + a.fileName + a.from]) { used[sp.name + '|' + a.fileName + a.from] = true; pairs.push({ src: sp, app: a, how: how }); }
      else if (!sp) res.apps.push({ name: a.name, status: 'only-in-bar', severity: 'warning', srcProject: null, barApp: a.fileName, counts: {}, note: 'No source project of this name: the application cannot be compared.' });
    });
    var matchedSrc = {}; pairs.forEach(function (p) { matchedSrc[p.src.name] = true; });
    srcApps.forEach(function (p) { if (!matchedSrc[p.name]) res.apps.push({ name: p.name, status: 'only-in-source', severity: 'ok', srcProject: p.name, barApp: null, counts: {}, note: 'Source application that is not part of this BAR.' }); });

    // ---- compare the files of each matched application
    var id = 0, total = pairs.length;
    for (var pi = 0; pi < pairs.length; pi++) {
      cancel.check();
      var pr = pairs[pi], sp2 = pr.src, app = pr.app;
      progress('Compare', pi, total, app.name);
      await util.yieldUI();
      var opened = await app.open({ cancel: cancel });
      var ar = { name: app.name, status: 'compared', severity: 'ok', srcProject: sp2.name, barApp: app.fileName, how: pr.how, counts: { identical: 0, modified: 0, 'missing-in-bar': 0, 'extra-in-bar': 0, 'not-comparable': 0, ignored: 0 }, note: pr.how === 'exact' ? '' : 'Matched by name ignoring letter case.', libs: opened.libs.length, jars: opened.jars };
      res.apps.push(ar);
      if (opened.error) { ar.status = 'error'; ar.severity = 'critical'; ar.note = 'The application archive could not be read: ' + opened.error; continue; }
      var sMap = {}, sLower = {}, bMap = {}, bLower = {};
      sp2.files.forEach(function (f) { sMap[f.rel] = f; (sLower[lc(f.rel)] = sLower[lc(f.rel)] || []).push(f); });
      opened.files.forEach(function (f) { bMap[f.rel] = f; (bLower[lc(f.rel)] = bLower[lc(f.rel)] || []).push(f); });
      var pairF = [], sLeft = {}, bLeft = {};
      sp2.files.forEach(function (f) { sLeft[f.rel] = f; }); opened.files.forEach(function (f) { bLeft[f.rel] = f; });
      Object.keys(sLeft).forEach(function (r) { if (bMap[r]) { pairF.push({ s: sMap[r], b: bMap[r], note: '' }); delete sLeft[r]; delete bLeft[r]; } });
      Object.keys(sLeft).slice().forEach(function (r) {
        var c = (bLower[lc(r)] || []).filter(function (x) { return bLeft[x.rel]; });
        if (c.length === 1) { pairF.push({ s: sMap[r], b: c[0], note: 'Path differs only in letter case in the BAR (' + c[0].rel + ').' }); delete sLeft[r]; delete bLeft[c[0].rel]; }
      });
      var byBaseS = {}, byBaseB = {};
      Object.keys(sLeft).forEach(function (r) { (byBaseS[lc(util.basename(r))] = byBaseS[lc(util.basename(r))] || []).push(sLeft[r]); });
      Object.keys(bLeft).forEach(function (r) { (byBaseB[lc(util.basename(r))] = byBaseB[lc(util.basename(r))] || []).push(bLeft[r]); });
      Object.keys(byBaseS).forEach(function (k) {
        if (byBaseS[k].length === 1 && byBaseB[k] && byBaseB[k].length === 1) {
          var s1 = byBaseS[k][0], b1 = byBaseB[k][0];
          pairF.push({ s: s1, b: b1, note: 'Found in a different folder: source "' + s1.rel + '", BAR "' + b1.rel + '".' }); delete sLeft[s1.rel]; delete bLeft[b1.rel];
        }
      });
      function push(f) { f.id = ++id; f.app = app.name; res.files.push(f); ar.counts[f.status]++; if (RANK[f.severity] > RANK[ar.severity]) ar.severity = f.severity; }
      // pairs: read and compare in small parallel batches
      await pool(pairF, 6, async function (pf) {
        var s = pf.s, b = pf.b, ext = s.ext, f = { path: s.rel, barPath: b.rel, type: C.SCOPE[ext], ext: ext, srcStatus: 'Present', barStatus: 'Present', note: pf.note, srcText: null, barText: null };
        if (s.crc != null && b.crc != null && s.crc === b.crc && s.size === b.size) { f.status = 'identical'; f.how = 'size and CRC-32 equal'; }
        else {
          var sb, bb;
          try { sb = await s.read(); bb = await b.read(); } catch (e) { if (util.isCancel(e)) throw e; f.status = 'not-comparable'; f.severity = 'warning'; f.summary = 'Could not be read: ' + e.message; f.how = 'read error'; f.srcStatus = 'Unreadable'; push(f); return; }
          if (util.bytesEqual(sb, bb)) { f.status = 'identical'; f.how = 'bytes equal'; }
          else {
            var st = decode(sb), bt = decode(bb), ns = C.normalize(st, o.ignoreWhitespace), nb = C.normalize(bt, o.ignoreWhitespace);
            if (ns === nb) { f.status = 'identical'; f.how = 'line endings / trailing blanks only'; f.cosmetic = true; }
            else {
              f.status = 'modified'; f.srcText = st; f.barText = bt;
              var d = C.lineDiff(util.lines(ns), util.lines(nb)), added = 0, removed = 0, first = null;
              d.forEach(function (x) { if (x.op === '+') added++; else if (x.op === '-') removed++; if (x.op !== ' ' && first == null) first = x.a || x.b; });
              f.added = added; f.removed = removed; f.firstLine = first;
              f.summary = removed + added ? (removed + added) + ' changed line(s): ' + removed + ' only in source, ' + added + ' only in BAR; first at line ' + first : 'Only line endings or encoding differ (every line is equal)';
            }
          }
        }
        if (f.status === 'identical') f.summary = f.cosmetic ? 'Only line endings or trailing blanks differ' : '';
        f.severity = severityOf(f.status, ext);
        push(f);
      }, cancel);
      // source files with no BAR counterpart
      for (var sr in sLeft) {
        var sf = sLeft[sr], text = null;
        try { text = decode(await sf.read()); } catch (e) { if (util.isCancel(e)) throw e; }
        var compiled = (sf.ext === 'msgflow' || sf.ext === 'subflow') && opened.cmf[lc(sf.rel.replace(/\.[^.]+$/, ''))];
        push(compiled ? { path: sf.rel, barPath: null, type: C.SCOPE[sf.ext], ext: sf.ext, srcStatus: 'Present', barStatus: 'Compiled only (.cmf)', status: 'not-comparable', severity: 'warning', summary: 'The BAR holds only the compiled flow (.cmf): no source to compare.', note: '', srcText: text, barText: null }
          : { path: sf.rel, barPath: null, type: C.SCOPE[sf.ext], ext: sf.ext, srcStatus: 'Present', barStatus: 'Missing', status: 'missing-in-bar', severity: 'critical', summary: 'The source file is not in the BAR.', note: '', srcText: text, barText: null });
      }
      // BAR files with no source counterpart (framework ESQL is ignored)
      for (var br in bLeft) {
        var bf = bLeft[br], why = null;
        if (o.ignoreFramework && bf.ext === 'esql') {
          var seg0 = bf.rel.split('/')[0];
          if (fwFiles[lc(util.basename(bf.rel))]) why = 'same file name as an ESQL file of the source library ' + fwFiles[lc(util.basename(bf.rel))];
          else if (bf.rel.indexOf('/') > 0 && fwNames[lc(seg0)]) why = 'inside the framework library folder ' + seg0;
          else if (patterns.some(function (p) { return p.test(util.basename(bf.rel)) || p.test(bf.rel); })) why = 'matches an ignore pattern';
        }
        if (why) { res.ignored.push({ app: app.name, path: bf.rel, reason: why }); ar.counts.ignored++; continue; }
        var btext = null;
        try { btext = decode(await bf.read()); } catch (e) { if (util.isCancel(e)) throw e; }
        push({ path: bf.rel, barPath: bf.rel, type: C.SCOPE[bf.ext], ext: bf.ext, srcStatus: 'Absent', barStatus: 'Present', status: 'extra-in-bar', severity: 'warning', summary: 'The BAR has this file; the source does not.', note: '', srcText: null, barText: btext });
      }
    }
    progress('Compare', total, total, '');
    res.files.sort(function (x, y) { return x.app === y.app ? (x.path < y.path ? -1 : x.path > y.path ? 1 : 0) : (lc(x.app) < lc(y.app) ? -1 : 1); });
    res.apps.sort(function (x, y) { return lc(x.name) < lc(y.name) ? -1 : 1; });
    if (bar.stats.looseScoped) res.notes.push(bar.stats.looseScoped + ' ESQL/WSDL/XSD/flow file(s) sit directly in the BAR outside any application; they are not compared.');
    if (!bar.apps.length) res.notes.push('The BAR contains no application archive (.appzip).');
    res.summary = C.summarize(res); res.summary.elapsedMs = Date.now() - t0;
    return res;
  };

  C.summarize = function (res) {
    var s = { applications: { compared: 0, onlyInBar: 0, onlyInSource: 0, error: 0 }, files: res.files.length, byStatus: {}, bySeverity: { critical: 0, difference: 0, warning: 0, ok: 0 }, wsdlXsdChanges: 0, ignored: res.ignored.length, cosmetic: 0 };
    res.apps.forEach(function (a) { if (a.status === 'compared') s.applications.compared++; else if (a.status === 'only-in-bar') s.applications.onlyInBar++; else if (a.status === 'only-in-source') s.applications.onlyInSource++; else s.applications.error++; if (a.status === 'error') s.bySeverity.critical++; });
    res.files.forEach(function (f) {
      s.byStatus[f.status] = (s.byStatus[f.status] || 0) + 1; s.bySeverity[f.severity]++;
      if (f.status === 'modified' && (f.ext === 'wsdl' || f.ext === 'xsd')) s.wsdlXsdChanges++;
      if (f.cosmetic) s.cosmetic++;
    });
    s.critical = s.bySeverity.critical;
    s.jarsNotOpened = res.bar.stats.jars; s.librariesNotOpened = res.bar.libraries.length;
    res.apps.forEach(function (a) { s.jarsNotOpened += a.jars || 0; s.librariesNotOpened += a.libs || 0; });
    return s;
  };

  /* ================= reports ================= */

  C.reportJson = function (res) {
    return JSON.stringify({
      tool: 'IBM ACE Migration Workbench - BAR vs source comparison', generated: res.at, source: { name: res.source.name, kind: res.source.kind, warnings: res.source.warnings, ignoredProjects: res.source.ignoredProjects },
      bar: { name: res.bar.name, size: res.bar.size, libraries: res.bar.libraries, warnings: res.bar.warnings }, options: res.options, summary: res.summary, notes: res.notes,
      applications: res.apps, files: res.files.map(function (f) { return { application: f.app, path: f.path, barPath: f.barPath, type: f.type, source: f.srcStatus, bar: f.barStatus, status: f.status, severity: f.severity, differences: f.summary, added: f.added, removed: f.removed, firstChangedLine: f.firstLine, note: f.note }; }),
      ignoredFrameworkFiles: res.ignored
    }, null, 2);
  };
  C.reportCsv = function (res) {
    function q(v) { v = v == null ? '' : String(v); return /[",\r\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; }
    var rows = [['Application', 'File', 'Type', 'Source', 'BAR', 'Status', 'Severity', 'Differences', 'Note']];
    res.files.forEach(function (f) { rows.push([f.app, f.path, f.type, f.srcStatus, f.barStatus, C.STATUS[f.status], C.SEVERITY[f.severity], f.summary, f.note]); });
    return rows.map(function (r) { return r.map(q).join(','); }).join('\r\n') + '\r\n';
  };
})(window.ACE);
