/* Page 4: BAR vs Source Comparison (js/compare/bar-source-compare.js). It has its own two inputs (a BAR and the source code)
 * and keeps its own state (S below); it does not use any other page's input. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc, C = ACE.cmp;
  var PAGE = 200;
  var S = { bar: null, srcZip: null, srcFiles: null, srcLabel: '', opt: { ignoreFramework: true, ignoreWhitespace: true, frameworkPatterns: '' }, result: null, page: 0,
    f: { q: '', status: 'diff', severity: '', type: '', app: '' }, err: null };
  var SEV_CLS = { critical: 'sev-Error', difference: 'sev-Warning', warning: 'st-info', ok: 'st-pass' };
  var STATUS_HELP = {
    'missing-in-bar': 'A file of the source (the master) that is not in the BAR',
    'extra-in-bar': 'A file in the BAR that the source does not have (non-critical)',
    modified: 'The file exists on both sides with different content', identical: 'Same content', 'not-comparable': 'Cannot be compared'
  };

  function barLabel(st) { return S.bar ? S.bar.name + ' (' + util.fmtBytes(S.bar.size) + ')' : 'none selected'; }
  function srcLabel() { return S.srcZip ? S.srcZip.name + ' (ZIP, ' + util.fmtBytes(S.srcZip.size) + ')' : S.srcFiles ? S.srcLabel : 'none selected'; }
  function sevBadge(s) { return '<span class="sev ' + SEV_CLS[s] + '">' + esc(C.SEVERITY[s]) + '</span>'; }

  function filtered() {
    var r = S.result, f = S.f, q = f.q.trim().toLowerCase();
    return r.files.filter(function (x) {
      if (f.status === 'diff' ? x.status === 'identical' : f.status && x.status !== f.status) return false;
      if (f.severity && x.severity !== f.severity) return false;
      if (f.type && x.type !== f.type) return false;
      if (f.app && x.app !== f.app) return false;
      if (q && (x.app + '/' + x.path).toLowerCase().indexOf(q) < 0) return false;
      return true;
    });
  }

  function summaryHtml(r) {
    var s = r.summary, st = s.byStatus;
    function card(n, l, cls, title) { return '<div class="stat"' + (title ? ' title="' + esc(title) + '"' : '') + '><div class="n ' + (cls || '') + '">' + n + '</div><div class="l">' + l + '</div></div>'; }
    var h = '';
    if (s.critical) h += '<div class="banner err"><b>' + s.critical + ' critical issue(s):</b> ' + (st['missing-in-bar'] || 0) + ' source file(s) missing in the BAR, ' + s.wsdlXsdChanges + ' WSDL/XSD change(s)' + (s.applications.error ? ', ' + s.applications.error + ' application archive(s) unreadable' : '') + '.</div>';
    else h += '<div class="banner ok"><b>No critical differences</b> in the ' + s.applications.compared + ' compared application(s).</div>';
    h += '<div class="cards">' +
      card(s.applications.compared, 'applications compared (matched by name)') +
      card(s.files, 'files compared') +
      card(st.identical || 0, 'identical' + (s.cosmetic ? ' (' + s.cosmetic + ' only line endings / trailing blanks)' : ''), 'st-pass') +
      card(st.modified || 0, 'modified (' + s.wsdlXsdChanges + ' WSDL/XSD critical)', 'sev-Warning') +
      card(st['missing-in-bar'] || 0, 'missing in BAR - critical', 'sev-Error', STATUS_HELP['missing-in-bar']) +
      card(st['extra-in-bar'] || 0, 'extra in BAR - warning', 'st-info', STATUS_HELP['extra-in-bar']) +
      card(st['not-comparable'] || 0, 'not comparable (compiled flow, unreadable)') +
      card(s.ignored, 'framework ESQL files ignored') +
      '</div>';
    h += '<p class="small muted">Scanned only ESQL, WSDL, XSD, message flows and subflows. ' + util.fmtBytes(r.bar.size) + ' BAR with ' + s.jarsNotOpened + ' JAR(s) and ' + s.librariesNotOpened + ' library archive(s) (at the BAR root and inside the compared applications): the JARs and the libraries were not opened, nothing was decompiled. Source: ' + r.source.stats.files + ' files in ' + r.source.stats.projects + ' project(s); ' + r.source.ignoredProjects.length + ' library / Java / other project(s) ignored. ' + s.elapsedMs + ' ms.</p>';
    return h;
  }

  function appsHtml(r) {
    var rows = r.apps.map(function (a) {
      var c = a.counts || {}, n = a.status === 'compared';
      return '<tr><td><a class="cmpApp" data-app="' + esc(a.name) + '">' + esc(a.name) + '</a></td><td>' + (a.status === 'compared' ? 'compared' : a.status === 'only-in-bar' ? '<span class="st-info">only in the BAR</span>' : a.status === 'only-in-source' ? '<span class="muted">only in the source</span>' : '<span class="st-fail">error</span>') + '</td><td>' + esc(a.srcProject || '-') + '</td><td>' + esc(a.barApp || '-') + '</td>' +
        (n ? '<td class="num">' + (c.identical || 0) + '</td><td class="num">' + (c.modified || 0) + '</td><td class="num">' + (c['missing-in-bar'] || 0) + '</td><td class="num">' + (c['extra-in-bar'] || 0) + '</td><td class="num">' + (c.ignored || 0) + '</td>' : '<td colspan="5" class="small muted">' + esc(a.note || '') + '</td>') +
        '<td>' + sevBadge(a.severity) + '</td></tr>';
    }).join('');
    return '<div class="scroll" style="max-height:34vh"><table class="grid"><tr><th>Application</th><th>Match</th><th>Source project</th><th>BAR archive</th><th class="num">Identical</th><th class="num">Modified</th><th class="num">Missing in BAR</th><th class="num">Extra in BAR</th><th class="num">Ignored</th><th>Result</th></tr>' + rows + '</table></div>';
  }

  function filesTable() {
    var r = S.result, list = filtered(), pages = Math.max(1, Math.ceil(list.length / PAGE));
    if (S.page >= pages) S.page = pages - 1;
    var from = S.page * PAGE, rows = list.slice(from, from + PAGE).map(function (x) {
      var btn = x.status === 'identical' || x.status === 'not-comparable' && x.srcText == null ? '' : '<button class="btn small cmpView" data-id="' + x.id + '">' + (x.status === 'modified' ? 'View differences' : 'View file') + '</button>';
      return '<tr><td>' + esc(x.app) + '</td><td><code>' + esc(x.path) + '</code>' + (x.note ? '<div class="small muted">' + esc(x.note) + '</div>' : '') + '</td><td>' + esc(x.type) + '</td><td>' + esc(x.srcStatus) + '</td><td>' + esc(x.barStatus) + '</td>' +
        '<td title="' + esc(STATUS_HELP[x.status] || '') + '">' + esc(C.STATUS[x.status]) + '</td><td>' + sevBadge(x.severity) + '</td><td class="small">' + esc(x.summary || '') + '</td><td>' + btn + '</td></tr>';
    }).join('');
    var h = '<div class="row small" style="margin:6px 0">' + list.length + ' of ' + r.files.length + ' file(s)' +
      (pages > 1 ? ' &nbsp; <button class="btn small" id="cmpPrev"' + (S.page ? '' : ' disabled') + '>&laquo;</button> page ' + (S.page + 1) + ' / ' + pages + ' <button class="btn small" id="cmpNext"' + (S.page < pages - 1 ? '' : ' disabled') + '>&raquo;</button>' : '') + '</div>';
    h += '<div class="scroll" style="max-height:60vh"><table class="grid"><tr><th>Application</th><th>File</th><th>Type</th><th>Source</th><th>BAR</th><th>Status</th><th>Severity</th><th>Differences</th><th></th></tr>' +
      (rows || '<tr><td colspan="9" class="muted">Nothing matches the filter.</td></tr>') + '</table></div>';
    return h;
  }

  function resultHtml() {
    var r = S.result, apps = r.apps.filter(function (a) { return a.status === 'compared' && (a.counts.modified || a.counts['missing-in-bar'] || a.counts['extra-in-bar']); }).map(function (a) { return a.name; });
    var types = Object.keys(C.SCOPE).map(function (k) { return C.SCOPE[k]; });
    function opt(v, l, cur) { return '<option value="' + esc(v) + '"' + (cur === v ? ' selected' : '') + '>' + esc(l) + '</option>'; }
    var h = '<h2>Summary</h2>' + summaryHtml(r);
    if (r.notes.length || r.source.warnings.length || r.bar.warnings.length) h += '<div class="banner warn small">' + r.notes.concat(r.source.warnings, r.bar.warnings).map(esc).join('<br>') + '</div>';
    h += '<h2>Applications</h2>' + appsHtml(r);
    h += '<h2>Files</h2><div class="row" style="gap:8px;flex-wrap:wrap">' +
      '<input type="search" id="cmpQ" placeholder="Filter by application or file name" value="' + esc(S.f.q) + '" style="min-width:240px">' +
      '<select id="cmpFStatus">' + opt('diff', 'All differences', S.f.status) + opt('', 'Everything (incl. identical)', S.f.status) + Object.keys(C.STATUS).map(function (k) { return opt(k, C.STATUS[k], S.f.status); }).join('') + '</select>' +
      '<select id="cmpFSev">' + opt('', 'Any severity', S.f.severity) + Object.keys(C.SEVERITY).map(function (k) { return opt(k, C.SEVERITY[k], S.f.severity); }).join('') + '</select>' +
      '<select id="cmpFType">' + opt('', 'Any type', S.f.type) + types.map(function (t) { return opt(t, t, S.f.type); }).join('') + '</select>' +
      '<select id="cmpFApp">' + opt('', 'All applications', S.f.app) + apps.map(function (a) { return opt(a, a, S.f.app); }).join('') + '</select>' +
      '<button class="btn small" id="cmpCsv">Export CSV</button><button class="btn small" id="cmpJson">Export JSON</button></div>';
    h += '<div id="cmpFiles">' + filesTable() + '</div>';
    if (r.ignored.length) h += '<details><summary class="small">' + r.ignored.length + ' framework-related ESQL file(s) in the BAR were ignored</summary><div class="scroll" style="max-height:30vh"><table class="grid"><tr><th>Application</th><th>File</th><th>Why</th></tr>' + r.ignored.map(function (x) { return '<tr><td>' + esc(x.app) + '</td><td><code>' + esc(x.path) + '</code></td><td class="small">' + esc(x.reason) + '</td></tr>'; }).join('') + '</table></div></details>';
    if (r.source.ignoredProjects.length) h += '<details><summary class="small">' + r.source.ignoredProjects.length + ' source project(s) ignored as framework / library / Java</summary><p class="small">' + r.source.ignoredProjects.map(function (p) { return esc(p.name) + ' <span class="muted">(' + esc(p.type) + ')</span>'; }).join(', ') + '</p></details>';
    return h;
  }

  UI.register('compare', {
    render: function (st) {
      var h = '<h1>BAR vs Source Comparison</h1><p class="lead">Compares the applications of a BAR with the source code. The source is the master. Applications are matched by name; only ESQL, WSDL, XSD, message flows and subflows are scanned. Java and JAR files are neither read nor decompiled, and framework / library content is ignored. Everything runs in this page; nothing is uploaded.</p>';
      h += '<div class="card"><div class="formgrid">' +
        '<label>BAR file</label><div><label class="btn" for="cmpBarIn">Choose BAR…</label><input type="file" id="cmpBarIn" accept=".bar,.zip" hidden> ' +
          '<span class="muted">' + esc(barLabel()) + '</span></div>' +
        '<label>Source code</label><div><label class="btn" for="cmpZipIn">Choose ZIP…</label><input type="file" id="cmpZipIn" accept=".zip" hidden> <label class="btn" for="cmpDirIn">Choose folder…</label><input type="file" id="cmpDirIn" webkitdirectory multiple hidden> <span class="muted">' + esc(srcLabel()) + '</span>' +
          '<div class="small muted">A Toolkit workspace ZIP, or a workspace folder from the file explorer. Projects are found by their .project files.</div></div>' +
        '<label>Framework</label><label class="inline"><input type="checkbox" id="cmpFw"' + (S.opt.ignoreFramework ? ' checked' : '') + '> ignore additional framework ESQL files inside the BAR applications</label>' +
        '<label>Ignore names</label><div><input type="text" class="wide" id="cmpPat" placeholder="optional: file-name patterns to ignore, e.g. Common*.esql, *_Lib.esql" value="' + esc(S.opt.frameworkPatterns) + '"></div>' +
        '<label>Whitespace</label><label class="inline"><input type="checkbox" id="cmpWs"' + (S.opt.ignoreWhitespace ? ' checked' : '') + '> ignore differences in line endings, BOM and trailing blanks</label>' +
        '</div><div class="row"><button class="btn primary" id="cmpRun"' + (S.bar && (S.srcZip || S.srcFiles) ? '' : ' disabled') + '>Compare</button></div>' +
        (S.err ? '<div class="banner err">' + esc(S.err) + '</div>' : '') + '</div>';
      h += '<details class="small"><summary>How the result is classified</summary><ul>' +
        '<li><b>Missing in BAR</b> (critical): a file of the source that is not in the BAR.</li>' +
        '<li><b>Modified WSDL / XSD</b> (critical). Modified ESQL, message flow or subflow: <b>Difference</b>.</li>' +
        '<li><b>Extra in BAR</b> (warning, not critical): a file in the BAR that the source does not have. Framework ESQL files are ignored.</li>' +
        '<li>Files are paired by path; a file in another folder is paired by its unique name and says so. A source flow for which the BAR only has a compiled <code>.cmf</code> is "not comparable".</li></ul></details>';
      if (S.result) h += resultHtml();
      return h;
    },
    bind: function (el, st) {
      function again() { UI.refresh(); }
      UI.$('#cmpBarIn', el).onchange = function (e) { if (e.target.files[0]) { S.bar = e.target.files[0]; S.result = null; S.err = null; again(); } };
      UI.$('#cmpZipIn', el).onchange = function (e) { if (e.target.files[0]) { S.srcZip = e.target.files[0]; S.srcFiles = null; S.result = null; S.err = null; again(); } };
      UI.$('#cmpDirIn', el).onchange = function (e) {
        var fl = Array.prototype.slice.call(e.target.files || []);
        if (fl.length) { S.srcFiles = fl; S.srcZip = null; S.srcLabel = 'folder ' + ((fl[0].webkitRelativePath || '').split('/')[0] || '') + ' (' + fl.length + ' files)'; S.result = null; S.err = null; again(); }
      };
      UI.$('#cmpFw', el).onchange = function (e) { S.opt.ignoreFramework = e.target.checked; };
      UI.$('#cmpWs', el).onchange = function (e) { S.opt.ignoreWhitespace = e.target.checked; };
      UI.$('#cmpPat', el).onchange = function (e) { S.opt.frameworkPatterns = e.target.value; };
      UI.$('#cmpRun', el).onclick = function () {
        S.opt.frameworkPatterns = UI.$('#cmpPat', el).value; S.err = null;
        UI.run('Compare BAR with source', async function (cancel, progress) {
          try {
            var source = await C.readSource(S.srcZip ? { zip: S.srcZip } : { files: S.srcFiles }, { cancel: cancel, progress: progress });
            var bar = await C.readBar(S.bar, { cancel: cancel, progress: progress });
            S.result = await C.compare(source, bar, S.opt, { cancel: cancel, progress: progress });
            S.page = 0; S.f = { q: '', status: 'diff', severity: '', type: '', app: '' };
            ACE.log[S.result.summary.critical ? 'warn' : 'ok']('BAR vs source: ' + S.result.summary.applications.compared + ' application(s), ' + S.result.summary.files + ' file(s), ' + S.result.summary.critical + ' critical issue(s)');
          } catch (e) { if (util.isCancel(e)) throw e; S.err = 'The comparison failed: ' + e.message; ACE.log.error(S.err, e.stack); }
        });
      };
      if (!S.result) return;
      function table() { var box = UI.$('#cmpFiles', el); box.innerHTML = filesTable(); bindTable(box); }
      function bindTable(box) {
        UI.$$('.cmpView', box).forEach(function (b) { b.onclick = function () { openDetail(Number(b.getAttribute('data-id'))); }; });
        var p = UI.$('#cmpPrev', box), n = UI.$('#cmpNext', box);
        if (p) p.onclick = function () { S.page--; table(); }; if (n) n.onclick = function () { S.page++; table(); };
      }
      bindTable(el);
      var q = UI.$('#cmpQ', el), t0 = null; q.oninput = function () { clearTimeout(t0); t0 = setTimeout(function () { S.f.q = q.value; S.page = 0; table(); }, 150); };
      [['#cmpFStatus', 'status'], ['#cmpFSev', 'severity'], ['#cmpFType', 'type'], ['#cmpFApp', 'app']].forEach(function (m) { UI.$(m[0], el).onchange = function (e) { S.f[m[1]] = e.target.value; S.page = 0; table(); }; });
      UI.$$('.cmpApp', el).forEach(function (a) { a.style.cursor = 'pointer'; a.onclick = function () { S.f.app = a.getAttribute('data-app'); S.f.status = 'diff'; S.page = 0; UI.$('#cmpFApp', el).value = S.f.app; UI.$('#cmpFStatus', el).value = 'diff'; table(); UI.$('#cmpFiles', el).scrollIntoView(); }; });
      UI.$('#cmpCsv', el).onclick = function () { util.download('﻿' + C.reportCsv(S.result), 'bar-vs-source.csv', 'text/csv'); };
      UI.$('#cmpJson', el).onclick = function () { util.download(C.reportJson(S.result), 'bar-vs-source.json', 'application/json'); };
    }
  });

  /* ---------- side-by-side detail window ---------- */
  function markHtml(text, mark) {
    if (!text) return '&#8203;';
    if (!mark || mark[0] >= mark[1]) return esc(text);
    return esc(text.slice(0, mark[0])) + '<mark>' + esc(text.slice(mark[0], mark[1])) + '</mark>' + esc(text.slice(mark[1]));
  }
  function openDetail(id) {
    var f = S.result.files.filter(function (x) { return x.id === id; })[0]; if (!f) return;
    var old = document.getElementById('cmpDetail'); if (old) old.remove();
    var rows = C.sideBySide(f.srcText || '', f.barText || '', S.result.options.ignoreWhitespace), ctx = 5, cur = -1, MAXROWS = 8000;
    var back = document.createElement('div'); back.id = 'cmpDetail'; back.className = 'dlg-back cmp-back';
    var chg = rows.filter(function (r) { return r.kind !== 'eq'; }).length;
    back.innerHTML = '<div class="cmp-win" role="dialog" aria-modal="true">' +
      '<div class="cmp-head"><div><b>' + esc(f.app) + ' / ' + esc(f.path) + '</b> &nbsp; ' + esc(f.type) + ' &nbsp; ' + sevBadge(f.severity) + ' <span class="small muted">' + esc(C.STATUS[f.status]) + ' - ' + esc(f.summary || '') + '</span></div>' +
      '<div class="row" style="gap:6px"><span class="small">Context</span><select id="cmpCtx"><option value="3">3 lines</option><option value="5" selected>5 lines</option><option value="15">15 lines</option><option value="50">50 lines</option><option value="all">whole file</option></select>' +
      '<button class="btn small" id="cmpP">&#9650; Previous change</button><button class="btn small" id="cmpN">&#9660; Next change</button><span class="small muted" id="cmpPos"></span><button class="btn small primary" id="cmpX">Close</button></div></div>' +
      '<div class="cmp-cols"><div>Source (master): <code>' + esc(f.srcStatus === 'Absent' ? '- not in the source -' : f.path) + '</code></div><div>BAR: <code>' + esc(f.barPath ? f.barPath : '- not in the BAR -') + '</code></div></div>' +
      '<div class="cmp-body" id="cmpBody"></div></div>';
    document.body.appendChild(back);
    var body = back.querySelector('#cmpBody'), blocks = [];
    function draw() {
      var vis = C.visibleRows(rows, ctx), html = '<table class="cmp-tbl"><colgroup><col class="ln"><col><col class="ln"><col></colgroup>', shown = 0, skipped = 0, blk = -1, prevCh = false;
      blocks = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], ch = r.kind !== 'eq';
        if (!vis.keep[i]) { skipped++; prevCh = false; continue; }
        if (skipped) { html += '<tr class="gap"><td colspan="4">&#8943; ' + skipped + ' unchanged line(s)</td></tr>'; skipped = 0; }
        if (shown >= MAXROWS) { html += '<tr class="gap"><td colspan="4">Display limited to ' + MAXROWS + ' lines: choose a smaller context.</td></tr>'; break; }
        var attr = ''; if (ch && !prevCh) { blk++; blocks.push(blk); attr = ' data-blk="' + blk + '"'; } prevCh = ch;
        html += '<tr class="k-' + r.kind + '"' + attr + '><td class="ln">' + (r.l ? r.l.n : '') + '</td><td class="code l">' + (r.l ? markHtml(r.l.text, r.l.mark) : '') + '</td><td class="ln">' + (r.r ? r.r.n : '') + '</td><td class="code r">' + (r.r ? markHtml(r.r.text, r.r.mark) : '') + '</td></tr>';
        shown++;
      }
      if (skipped) html += '<tr class="gap"><td colspan="4">&#8943; ' + skipped + ' unchanged line(s)</td></tr>';
      body.innerHTML = html + '</table>'; cur = -1; pos();
    }
    function pos() { back.querySelector('#cmpPos').textContent = blocks.length ? (cur >= 0 ? (cur + 1) + ' / ' : '') + blocks.length + ' block(s) of changes, ' + chg + ' line(s)' : 'no differences'; }
    function go(d) {
      if (!blocks.length) return; cur = (cur + d + blocks.length) % blocks.length;
      var tr = body.querySelector('tr[data-blk="' + cur + '"]'); if (tr) { body.scrollTop = tr.offsetTop - 40; tr.classList.add('flash'); setTimeout(function () { tr.classList.remove('flash'); }, 700); }
      pos();
    }
    function close() { back.remove(); document.removeEventListener('keydown', onKey, true); }
    function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } else if (e.key === 'F3' || (e.altKey && e.key === 'ArrowDown')) { e.preventDefault(); go(1); } else if (e.altKey && e.key === 'ArrowUp') { e.preventDefault(); go(-1); } }
    document.addEventListener('keydown', onKey, true);
    back.querySelector('#cmpX').onclick = close;
    back.querySelector('#cmpN').onclick = function () { go(1); }; back.querySelector('#cmpP').onclick = function () { go(-1); };
    back.querySelector('#cmpCtx').onchange = function (e) { ctx = e.target.value === 'all' ? null : Number(e.target.value); draw(); };
    draw(); if (blocks.length) go(1);
  }
  UI.cmpOpenDetail = openDetail;
  UI.cmpState = S;
})(window.ACE);
