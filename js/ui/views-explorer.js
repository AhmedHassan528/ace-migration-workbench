/* Page 5: Source Code Explorer = source extraction + Project Explorer (IBM ACE Toolkit style) with file preview/editing and ZIP export.
 * Input: a BAR or a Toolkit workspace ZIP, on this page only.
 * The tree comes from ACE.explorer.build(ws) - nothing is hard-coded. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc, EX = ACE.explorer;
  var st = { showHidden: false, copy: 'ws12', expanded: new Set(), sel: null, multi: new Set(), anchor: null, filter: '', dirty: false, pending: null, status: null, model: null, modelKey: null, edText: null };

  var V = {};

  /* ---------- icons (inline SVG, no external resources) ---------- */
  function svg(body, title) { return '<svg class="ic" viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">' + body + '</svg>'; }
  var PAGE = '<path d="M3 1.5h7l3 3v10H3z" fill="#fff" stroke="#7a8794"/><path d="M10 1.5v3h3" fill="none" stroke="#7a8794"/>';
  function pageWith(color, letter) { return svg(PAGE + '<rect x="4.5" y="7" width="7" height="6" rx="1" fill="' + color + '"/><text x="8" y="12" font-size="5.5" font-family="Arial" font-weight="700" fill="#fff" text-anchor="middle">' + letter + '</text>'); }
  var ICONS = {
    'project-app': svg('<rect x="1.5" y="2.5" width="13" height="11" rx="1.5" fill="#2f6fd6"/><path d="M4 11l2.5-6h1l2.5 6M5 9h4" stroke="#fff" stroke-width="1.2" fill="none"/>'),
    'project-lib': svg('<rect x="2" y="3" width="3" height="11" fill="#e58a1f"/><rect x="6" y="2" width="3" height="12" fill="#f0a742"/><rect x="10.2" y="3.4" width="3" height="10.6" transform="rotate(-12 11.7 8.7)" fill="#c8661a"/>'),
    'project-shlib': svg('<rect x="2" y="3" width="3" height="11" fill="#1f9fe5"/><rect x="6" y="2" width="3" height="12" fill="#42b6f0"/><rect x="10" y="3" width="3" height="11" fill="#1a7ac8"/>'),
    'project-java': svg('<rect x="1.5" y="3" width="13" height="11" rx="1.5" fill="#f5e6c8" stroke="#a9772b"/><text x="8" y="12" font-size="8" font-family="Georgia" font-weight="700" fill="#b0461d" text-anchor="middle">J</text>'),
    group: svg('<path d="M1.5 4h5l1 1.5h7v8h-13z" fill="#d9dee5" stroke="#8a96a3"/><circle cx="11.5" cy="10" r="2" fill="#6a7682"/>'),
    folder: svg('<path d="M1.5 3.5h5l1.2 1.5h6.8v9h-13z" fill="#f2c94c" stroke="#c99a1a"/>'),
    schema: svg('<path d="M1.5 3.5h5l1.2 1.5h6.8v9h-13z" fill="#bfe3b0" stroke="#5c9a3f"/>'),
    'package': svg('<path d="M2 5l6-3 6 3v7l-6 3-6-3z" fill="#e6c98f" stroke="#a07b2b"/><path d="M2 5l6 3 6-3M8 8v7" fill="none" stroke="#a07b2b"/>'),
    libref: svg('<rect x="2" y="3" width="3" height="10" fill="#e58a1f"/><rect x="6" y="2" width="3" height="11" fill="#f0a742"/><path d="M10 12l4-4M11 8h3v3" stroke="#2f6fd6" stroke-width="1.4" fill="none"/>'),
    info: svg('<circle cx="8" cy="8" r="6" fill="#dfe6ee"/><text x="8" y="11.5" font-size="9" font-family="Arial" font-weight="700" fill="#4b5966" text-anchor="middle">i</text>'),
    java: pageWith('#2f6fd6', 'J'), esql: pageWith('#2a9d5c', 'ES'), msgflow: pageWith('#8e44ad', 'MF'), subflow: pageWith('#b06fd1', 'SF'),
    xsd: pageWith('#c0392b', 'XS'), wsdl: pageWith('#d35400', 'WS'), xml: pageWith('#7f8c8d', '&lt;&gt;'), properties: pageWith('#7f8c8d', 'P'),
    map: pageWith('#16a085', 'M'), eclipse: pageWith('#5d4a8a', 'E'), text: svg(PAGE), json: pageWith('#7f8c8d', '{}'), other: svg(PAGE), binary: pageWith('#555', '01'),
    'class': pageWith('#6d6d6d', 'C'),
    jar: svg('<rect x="3" y="4" width="10" height="10" rx="2" fill="#f4d9a6" stroke="#a0722b"/><rect x="5" y="2" width="6" height="2.5" fill="#a0722b"/><path d="M5 8h6M5 10.5h6" stroke="#a0722b"/>')
  };
  function iconOf(n) { return n.kind === 'file' ? (ICONS[n.ftype] || ICONS.other) : (ICONS[n.kind] || ICONS.folder); }

  /* ---------- helpers ---------- */
  function model(ws) {
    var key = ws.loadedAt + '|' + Object.keys(ws.decompiled || {}).map(function (k) { return ws.decompiled[k].projectName + ws.decompiled[k].at; }).join(',') + '|' + ws.ws12.changelog.length + '|' + ws.ws13.changelog.length;
    if (st.modelKey !== key) {
      st.model = EX.build(ws); st.modelKey = key;
      if (!st.expanded.size) st.model.roots.forEach(function (r) { st.expanded.add(r.id); });
    }
    return st.model;
  }
  function rootOf(m, n) { while (n && n.parentId && m.byId[n.parentId]) n = m.byId[n.parentId]; return n; }
  /* The project a node belongs to: the nearest Java project (FrameworkJPrj shown inside a library)
   * or else the top-level Toolkit project. Returns {label, leaves}. */
  function projectOf(m, n) {
    for (var x = n; x; x = x.parentId ? m.byId[x.parentId] : null) {
      if (x.kind === 'project-java' && x.javaProject) {
        var jp = m.javaProjects.filter(function (j) { return j.name === x.javaProject; })[0];
        if (jp) return { label: jp.name, leaves: jp.leaves.slice() };
      }
    }
    var r = n ? rootOf(m, n) : m.roots[0];
    return r ? { label: r.label, leaves: EX.leavesUnder(r) } : null;
  }
  function selNode(m) { return st.sel ? m.byId[st.sel] : null; }
  function modifiedIn(ws, path) { return (ws.ws12.overlay[path] ? '12' : '') + (ws.ws13.overlay[path] ? '13' : ''); }
  function matches(n, q) { if (!q) return true; if (n.kind === 'file' || n.kind === 'libref') return n.label.toLowerCase().indexOf(q) >= 0 || (n.path || '').toLowerCase().indexOf(q) >= 0; return n.children.some(function (c) { return matches(c, q); }); }
  function decompStatus(ws, leaf) {
    if (leaf.src !== 'java' || !/\/src\/.*\.java$/.test(leaf.path)) return null;
    var d = ws.decompiled[leaf.jar.sha256]; if (!d) return null;
    var rel = leaf.path.slice(leaf.path.indexOf('/src/') + 5);
    return d.results.filter(function (r) { return r.path === rel; })[0] || null;
  }

  /* ---------- tree rendering ---------- */
  function rows(ws, list, depth, out, q, visible) {
    list.forEach(function (n) {
      if (!matches(n, q)) return;
      if (n.hidden && !st.showHidden) return;
      var hasKids = n.children.length > 0, open = q ? true : st.expanded.has(n.id);
      var isSel = st.sel === n.id || (n.kind === 'file' && st.multi.has(n.path));
      var badge = '';
      if (n.kind === 'file') {
        var mod = modifiedIn(ws, n.path);
        if (mod) badge += ' <span class="tbadge mod" title="changed in ACE ' + mod.replace('1213', '12+13') + ' working copy">✎' + mod + '</span>';
        if (st.dirty && st.sel === n.id) badge += ' <span class="tbadge dirty" title="unsaved changes">●</span>';
        var ds = decompStatus(ws, n); if (ds && ds.status !== 'complete') badge += ' <span class="tbadge warn">' + ds.status + '</span>';
        if (n.origin === 'generated') badge += ' <span class="tbadge gen">generated</span>';
        visible.push(n);
      }
      if (n.kind === 'project-java' && n.parentId && /g:java/.test(n.parentId)) badge += ' <span class="tbadge dec">decompiled</span>';
      out.push('<div class="tn' + (isSel ? ' sel' : '') + '" data-id="' + esc(n.id) + '" style="padding-left:' + (4 + depth * 16) + 'px" draggable="false">' +
        '<span class="tw">' + (hasKids ? (open ? '▾' : '▸') : '') + '</span>' + iconOf(n) + '<span class="tl">' + esc(n.label) + '</span>' + badge + '</div>');
      if (hasKids && open) rows(ws, n.children, depth + 1, out, q, visible);
    });
  }

  /* ---------- right panel ---------- */
  function detailHtml(ws, m) {
    var n = selNode(m);
    if (st.multi.size > 1) return '<div class="card"><b>' + st.multi.size + ' files selected</b><p class="small muted">Use "Export Selected Files ZIP". Ctrl+click toggles a file, Shift+click selects a range.</p></div>';
    if (!n) return '<p class="muted">Select a project, folder or file.</p>';
    if (n.kind !== 'file') {
      var lv = EX.leavesUnder(n), size = 0; lv.forEach(function (l) { var b = l.rec ? l.rec.size : 0; size += b; });
      return '<div class="card"><h3 style="margin-top:0">' + iconOf(n) + ' ' + esc(n.label) + '</h3><div class="kv"><div>Kind</div><div>' + esc(n.kind.replace('project-', 'project: ')) + '</div><div>Files shown below</div><div>' + lv.length + '</div>' + (n.kind === 'project-java' ? '<div>Project ZIP export</div><div>' + projectOf(m, n).leaves.length + ' files (Eclipse layout: src/, bin/, Lib/, .project, .classpath, .settings)</div>' : '') + (n.kind === 'libref' ? '<div>Reference</div><div>' + esc(n.note || '') + ' <button class="btn small" id="goLib">Go to ' + esc(n.label) + '</button></div>' : '') + '</div></div>';
    }
    var ds = decompStatus(ws, n), rec = n.rec;
    var info = '<div class="kv">' +
      '<div>Export path</div><div><code>' + esc(n.path) + '</code></div>' +
      '<div>Type</div><div>' + esc(n.ftype) + (n.pkg !== undefined ? ' &middot; package <code>' + esc(n.pkg || '(default package)') + '</code> (from its package declaration)' : '') + '</div>' +
      '<div>Origin</div><div>' + esc(n.src === 'bar' ? 'original file from the BAR' : n.src === 'toolkit-project' ? 'generated Toolkit project file' : (n.origin === 'decompiled' ? 'decompiled from ' + n.jar.name : n.origin === 'generated' ? 'generated Eclipse metadata' : 'original (' + (n.note || '') + ')')) + '</div>' +
      (rec ? '<div>Location in BAR</div><div><code>' + esc(rec.vpath) + '</code></div><div>Size / SHA-256</div><div>' + util.fmtBytes(rec.size) + ' &middot; <code>' + esc(rec.sha256 || '-') + '</code></div>' : '') +
      (ds ? '<div>Decompilation</div><div><b class="' + (ds.status === 'complete' ? 'st-pass' : 'st-attention') + '">' + ds.status.toUpperCase() + '</b>' + (ds.notes.length ? ' - ' + esc(ds.notes.join('; ')) : '') + '</div>' : '') +
      (modifiedIn(ws, n.path) ? '<div>Working copy</div><div class="sev-Warning">changed in ACE ' + esc(modifiedIn(ws, n.path)) + ' copy</div>' : '') + '</div>';
    var h = '<div class="card"><h3 style="margin-top:0">' + iconOf(n) + ' ' + esc(n.label) + ' <span class="tbadge dirty" id="dirtyFlag"' + (st.dirty ? '' : ' hidden') + '>● unsaved</span></h3>' + info + '</div>';
    if (n.ftype === 'jar') {
      var bytes = EX.readBytes(ws, n, 'orig'), jr = (ws.jars || []).filter(function (j) { return j.name === n.label && j.size === (bytes ? bytes.length : -1); })[0];
      h += '<div class="banner">Binary JAR, shown read-only and exported unchanged. ' + (jr ? 'Classification: <b>' + esc(jr.classification.type + (jr.classification.driverName ? ' - ' + jr.classification.driverName : '')) + '</b>, ' + jr.info.classCount + ' classes' + (jr.decision.selected ? '' : ' (not decompiled: ' + esc(jr.decision.excludedBy || 'excluded') + ')') : '') + '</div>';
      if (jr) h += '<pre class="small" style="max-height:30vh">' + esc(Object.keys(jr.info.packages).sort().slice(0, 60).map(function (p) { return p + '  (' + jr.info.packages[p] + ' classes)'; }).join('\n')) + '</pre>';
      return h;
    }
    if (n.ftype === 'class') {
      try {
        var cf = ACE.java.parseClass(EX.readBytes(ws, n, 'orig'));
        h += '<div class="banner">Compiled class (bytecode), shown read-only. The source is in <code>src/</code>; this file is exported unchanged.</div><pre class="small" style="max-height:45vh">' + esc('class ' + cf.name.replace(/\//g, '.') + '  (Java ' + cf.javaVersion + ', major ' + cf.major + ')\nextends ' + (cf.superName || '-') + '\n\n' + cf.methods.map(function (mm) { return mm.name + mm.desc + '\n' + ACE.bytecode.disassemble(cf, mm).split('\n').map(function (x) { return '    ' + x; }).join('\n'); }).join('\n\n')) + '</pre>';
      } catch (e) { h += '<div class="banner err">Class file could not be parsed: ' + esc(e.message) + '</div>'; }
      return h;
    }
    var bytesNow = EX.read(ws, n, st.copy);
    var isText = EX.isText(n.ftype) && (typeof bytesNow === 'string' || (bytesNow && util.looksText(bytesNow)));
    if (!isText) return h + '<div class="banner">Binary file - not displayed as text. It is exported unchanged.</div>';
    var text = st.edText != null ? st.edText : EX.readText(ws, n, st.copy);
    var editable = st.copy !== 'orig' && !(rec && rec.cls && rec.cls.category === 'security');
    h += '<div class="row small"><span class="muted">' + (editable ? 'Editing the <b>' + (st.copy === 'ws12' ? 'ACE 12' : 'ACE 13') + ' working copy</b> - saved edits are included in project ZIP exports and packages.' : 'Original content (read-only). Choose a working copy above to edit.') + '</span></div>' +
      '<textarea class="editor" id="pxEd" spellcheck="false"' + (editable ? '' : ' readonly') + '>' + esc(text) + '</textarea>' +
      '<div class="row">' + (editable ? '<button class="btn primary small" id="pxSave"' + (st.dirty ? '' : ' disabled') + '>Save</button> <button class="btn small" id="pxRevert"' + (st.dirty ? '' : ' disabled') + '>Discard unsaved</button> <button class="btn small" id="pxUndo"' + (modifiedIn(ws, n.path).indexOf(st.copy === 'ws12' ? '12' : '13') >= 0 ? '' : ' disabled') + '>Undo last saved change</button> ' : '') + '<button class="btn small" id="pxDl">Download file</button></div>';
    return h;
  }

  /* ---------- export ---------- */
  function exportSummary(ws) {
    var p = st.pending; if (!p) return '';
    var size = 0; p.leaves.forEach(function (l) { var d = EX.read(ws, l, st.copy); size += d == null ? 0 : (typeof d === 'string' ? util.encodeUtf8(d).length : d.length); });
    var tree = p.leaves.map(function (l) { return l.path; }).sort();
    return '<div class="card" id="expCard"><h3 style="margin-top:0">Export: ' + esc(p.title) + '</h3><div class="kv">' +
      '<div>ZIP file</div><div><code>' + esc(p.fileName) + '</code></div><div>Root</div><div>' + esc(p.root) + '</div>' +
      '<div>Files</div><div><b>' + p.leaves.length + '</b></div><div>Total uncompressed size</div><div>' + util.fmtBytes(size) + '</div>' +
      '<div>Content</div><div>' + (st.copy === 'orig' ? 'original files' : (st.copy === 'ws12' ? 'ACE 12' : 'ACE 13') + ' working copy (saved edits included)') + '</div>' +
      '<div>Status</div><div id="expStatus">' + (st.status ? st.status : 'ready - not exported yet') + '</div></div>' +
      '<details class="small"><summary>' + tree.length + ' paths</summary><pre>' + esc(tree.join('\n')) + '</pre></details>' +
      '<div class="row"><button class="btn primary" id="expGo">Build, verify and download ZIP</button> <button class="btn" id="expCancel">Close</button></div></div>';
  }
  function prepare(ws, m, kind) {
    var n = selNode(m), leaves, title, root, fileName;
    if (kind === 'project') {
      var pr = projectOf(m, n);
      if (!pr) return UI.notify('Nothing to export.');
      leaves = pr.leaves; root = pr.label; title = 'project ' + pr.label; fileName = pr.label.replace(/[^\w.\-]+/g, '_') + '.zip';
    } else if (kind === 'folder') {
      if (!n || n.kind === 'file') return UI.notify('Select a folder, group, package or project in the tree first.');
      leaves = EX.leavesUnder(n); var rr = rootOf(m, n); root = rr.label; title = 'folder "' + n.label + '" of ' + rr.label; fileName = (rr.label + '-' + n.label).replace(/[^\w.\-]+/g, '_') + '.zip';
    } else {
      var paths = st.multi.size ? Array.from(st.multi) : (n && n.kind === 'file' ? [n.path] : []);
      if (!paths.length) return UI.notify('Select one or more files (Ctrl+click / Shift+click) first.');
      leaves = paths.map(function (p) { return m.leaves[p]; }).filter(Boolean); root = '(selection)'; title = paths.length + ' selected file(s)'; fileName = 'selected-files.zip';
    }
    if (!leaves.length) return UI.notify('The selection contains no files.');
    st.pending = { kind: kind, leaves: leaves, title: title, root: root, fileName: fileName }; st.status = null;
    UI.refresh();
  }

  /* ---------- context menu ---------- */
  function closeMenu() { var mm = document.getElementById('pxMenu'); if (mm) mm.remove(); }
  function openMenu(ws, m, n, x, y) {
    closeMenu();
    var items = [];
    if (n.kind === 'file') {
      items.push(['Open', function () { select(ws, m, n.id); }]);
      items.push(['Download file', function () { var d = EX.readBytes(ws, n, st.copy); util.download(d, n.label); }]);
      items.push(['Export file as ZIP', function () { st.sel = n.id; st.multi = new Set([n.path]); prepare(ws, m, 'files'); }]);
      items.push(['Copy export path', function () { try { navigator.clipboard.writeText(n.path); ACE.log.info('Copied ' + n.path); } catch (e) { UI.notify('Export path: ' + n.path); } }]);
    } else if (n.kind === 'libref') {
      items.push(['Go to ' + n.label, function () { goto(ws, m, n.target); }]);
    } else {
      items.push(['Expand all below', function () { (function ex(k) { st.expanded.add(k.id); k.children.forEach(ex); })(n); UI.refresh(); }]);
      items.push(['Collapse', function () { (function co(k) { st.expanded.delete(k.id); k.children.forEach(co); })(n); UI.refresh(); }]);
      var isProj = !n.parentId || n.kind === 'project-java';
      items.push(['Export this ' + (isProj ? 'project' : 'folder') + ' as ZIP', function () { st.sel = n.id; prepare(ws, m, isProj ? 'project' : 'folder'); }]);
    }
    var menu = document.createElement('div'); menu.id = 'pxMenu'; menu.className = 'ctxmenu';
    items.forEach(function (it) { var b = document.createElement('div'); b.textContent = it[0]; b.onclick = function () { closeMenu(); it[1](); }; menu.appendChild(b); });
    menu.style.left = x + 'px'; menu.style.top = y + 'px';
    document.body.appendChild(menu);
  }
  function goto(ws, m, id) { var t = m.byId[id]; if (!t) return; st.expanded.add(id); st.sel = id; st.multi.clear(); UI.refresh(); setTimeout(function () { var r = document.querySelector('.tn[data-id="' + CSS.escape(id) + '"]'); if (r) r.scrollIntoView({ block: 'center' }); }, 0); }
  function select(ws, m, id, ev) {
    var n = m.byId[id] || Object.keys(m.byId).map(function (k) { return m.byId[k]; }).filter(function (x) { return x.id === id; })[0];
    if (!n) return;
    if (ev && (ev.ctrlKey || ev.metaKey) && n.kind === 'file') {
      if (st.multi.has(n.path)) st.multi.delete(n.path); else st.multi.add(n.path);
      st.anchor = n.path; UI.refresh(); return;
    }
    if (ev && ev.shiftKey && n.kind === 'file' && st.anchor && st.visible) {
      var paths = st.visible.map(function (v) { return v.path; }), a = paths.indexOf(st.anchor), b = paths.indexOf(n.path);
      if (a >= 0 && b >= 0) { st.multi = new Set(paths.slice(Math.min(a, b), Math.max(a, b) + 1)); UI.refresh(); return; }
    }
    function go() {
      st.dirty = false; st.edText = null;
      st.sel = id; st.multi = new Set(n.kind === 'file' ? [n.path] : []); st.anchor = n.kind === 'file' ? n.path : null;
      UI.refresh();
    }
    if (st.dirty && st.sel !== id) UI.ask('Discard unsaved changes to ' + (selNode(m) || {}).label + '?', go, { ok: 'Discard changes' });
    else go();
  }

  var X = {
    render: function (s) {
      var ws = s.ws, m = model(ws), q = st.filter.toLowerCase().trim(), out = [], visible = [];
      rows(ws, m.roots, 0, out, q, visible); st.visible = visible;
      var n = selNode(m), root = n ? projectOf(m, n) : null;
      var h = '<p class="lead">Toolkit-style view of the reconstructed workspace: Message Flows, Subflows, ESQLs (by BROKER SCHEMA), Java (by package declaration), Included Libraries and Other Resources. As in the Toolkit, .project/.classpath/.settings and bin are hidden (tick "show hidden"); they are still exported. The grouping is only a view: every file keeps its real path in exports, and a Java project exports with the Eclipse layout (src, bin, Lib).</p>';
      h += '<div class="row pxbar"><span class="small">Content:</span> <select id="pxCopy"><option value="ws12"' + (st.copy === 'ws12' ? ' selected' : '') + '>Working copy (saved edits)</option><option value="orig"' + (st.copy === 'orig' ? ' selected' : '') + '>Original (read-only)</option></select>' +
        ' <input type="text" id="pxFilter" placeholder="Filter files…" value="' + esc(st.filter) + '"> <button class="btn small" id="pxExpand">Expand all</button> <button class="btn small" id="pxCollapse">Collapse all</button> <label class="inline small"><input type="checkbox" id="pxHidden"' + (st.showHidden ? ' checked' : '') + '> show hidden (.project, .classpath, .settings, bin)</label></div>';
      h += '<div class="row pxbar"><button class="btn primary" id="pxExpProj"' + (m.roots.length ? '' : ' disabled') + '>Export Project ZIP' + (root ? ' (' + esc(root.label) + ')' : '') + '</button> <button class="btn" id="pxExpFolder"' + (n && n.kind !== 'file' ? '' : ' disabled') + '>Export Selected Folder ZIP</button> <button class="btn" id="pxExpFiles"' + (st.multi.size ? '' : ' disabled') + '>Export Selected Files ZIP' + (st.multi.size ? ' (' + st.multi.size + ')' : '') + '</button></div>';
      h += exportSummary(ws);
      h += '<div class="split"><div class="left ptree" id="pxTree" tabindex="0">' + (out.join('') || '<p class="muted small" style="padding:8px">No files match the filter.</p>') + '</div><div class="right" id="pxRight">' + detailHtml(ws, m) + '</div></div>';
      return h;
    },
    bind: function (el, s) {
      var ws = s.ws, m = model(ws);
      UI.$('#pxCopy', el).onchange = function (e) {
        var want = e.target.value;
        function go() { st.copy = want; st.dirty = false; st.edText = null; st.status = null; UI.refresh(); }
        if (st.dirty) { e.target.value = st.copy; UI.ask('Discard unsaved changes?', go, { ok: 'Discard changes' }); } else go();
      };
      var fi = UI.$('#pxFilter', el); fi.oninput = function () { st.filter = fi.value; var pos = fi.selectionStart; UI.refresh(); var f2 = UI.$('#pxFilter'); f2.focus(); f2.setSelectionRange(pos, pos); };
      UI.$('#pxExpand', el).onclick = function () { Object.keys(m.byId).forEach(function (k) { if (m.byId[k].children.length) st.expanded.add(k); }); UI.refresh(); };
      UI.$('#pxCollapse', el).onclick = function () { st.expanded.clear(); UI.refresh(); };
      UI.$('#pxHidden', el).onchange = function (e) { st.showHidden = e.target.checked; UI.refresh(); };
      UI.$('#pxExpProj', el).onclick = function () { prepare(ws, m, 'project'); };
      UI.$('#pxExpFolder', el).onclick = function () { prepare(ws, m, 'folder'); };
      UI.$('#pxExpFiles', el).onclick = function () { prepare(ws, m, 'files'); };
      var go = UI.$('#expGo', el); if (go) go.onclick = async function () {
        var p = st.pending; go.disabled = true;
        UI.$('#expStatus').textContent = 'building ZIP…';
        try {
          var r = await EX.exportZip(ws, p.leaves, st.copy, function (d, t) { var x = UI.$('#expStatus'); if (x) x.textContent = 'writing ' + d + '/' + t + '…'; });
          util.download(r.blob, p.fileName);
          st.status = '<span class="st-pass">✓ Exported and verified</span>: ' + r.files + ' files, ' + util.fmtBytes(r.size) + ' uncompressed, ZIP ' + util.fmtBytes(r.zipSize) + ' (' + r.ms + ' ms). The ZIP was re-read, and every entry is present, CRC-correct and byte-identical.';
          ACE.log.ok('Exported ' + p.fileName + ': ' + r.files + ' files, verified');
        } catch (e) {
          st.status = '<span class="st-fail">✗ Export FAILED</span>: ' + esc(e.message) + '. No file was downloaded.';
          ACE.log.error('Export of ' + p.fileName + ' failed: ' + e.message);
        }
        UI.refresh();
      };
      var cc = UI.$('#expCancel', el); if (cc) cc.onclick = function () { st.pending = null; st.status = null; UI.refresh(); };
      var tree = UI.$('#pxTree', el);
      tree.onclick = function (e) {
        var row = e.target.closest('.tn'); if (!row) return;
        var id = row.getAttribute('data-id'), n = m.byId[id] || null;
        if (e.target.classList.contains('tw')) { if (st.expanded.has(id)) st.expanded.delete(id); else st.expanded.add(id); UI.refresh(); return; }
        if (n && n.kind === 'libref' && e.detail === 2) { goto(ws, m, n.target); return; }
        select(ws, m, id, e);
      };
      tree.ondblclick = function (e) { var row = e.target.closest('.tn'); if (!row) return; var id = row.getAttribute('data-id'), n = m.byId[id]; if (n && n.children.length) { if (st.expanded.has(id)) st.expanded.delete(id); else st.expanded.add(id); UI.refresh(); } };
      tree.oncontextmenu = function (e) { var row = e.target.closest('.tn'); if (!row) return; e.preventDefault(); var n = m.byId[row.getAttribute('data-id')]; if (n) openMenu(ws, m, n, e.pageX, e.pageY); };
      document.addEventListener('click', closeMenu, { once: true });
      var gl = UI.$('#goLib', el); if (gl) gl.onclick = function () { goto(ws, m, selNode(m).target); };
      var ed = UI.$('#pxEd', el), n = selNode(m);
      if (ed && n) {
        var base = EX.readText(ws, n, st.copy);
        ed.oninput = function () {
          st.edText = ed.value; var d = ed.value !== base;
          if (d !== st.dirty) { st.dirty = d; var fl = UI.$('#dirtyFlag'); if (fl) fl.hidden = !d; var sv = UI.$('#pxSave'); if (sv) sv.disabled = !d; var rv = UI.$('#pxRevert'); if (rv) rv.disabled = !d; var row = tree.querySelector('.tn.sel .tl'); if (row) row.classList.toggle('unsaved', d); }
        };
        ed.onkeydown = function (e) { if (e.key === 'Tab' && !ed.readOnly) { e.preventDefault(); var p0 = ed.selectionStart; ed.value = ed.value.slice(0, p0) + '\t' + ed.value.slice(ed.selectionEnd); ed.selectionStart = ed.selectionEnd = p0 + 1; ed.oninput(); } if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); var sv = UI.$('#pxSave'); if (sv && !sv.disabled) sv.click(); } };
        var sv = UI.$('#pxSave', el); if (sv) sv.onclick = function () {
          var orig = EX.readText(ws, n, 'orig');
          if (ACE.transforms.recordEdit(ws, st.copy, n.path, orig, ed.value)) ACE.log.ok('Saved ' + n.path + ' to the ' + (st.copy === 'ws12' ? 'ACE 12' : 'ACE 13') + ' working copy');
          st.dirty = false; st.edText = null; V.ctl.analyze(); UI.refresh();
        };
        var rv = UI.$('#pxRevert', el); if (rv) rv.onclick = function () { st.dirty = false; st.edText = null; UI.refresh(); };
        var un = UI.$('#pxUndo', el); if (un) un.onclick = function () { if (ACE.transforms.undo(ws, st.copy, n.path)) { V.ctl.analyze(); UI.refresh(); } };
      }
      var dl = UI.$('#pxDl', el); if (dl && n) dl.onclick = function () { util.download(ed ? ed.value : EX.readBytes(ws, n, st.copy), n.label, 'text/plain'); };
    }
  };

  /* ---------- extraction report (how the input maps onto Toolkit projects) ---------- */
  function fileById(ws, id) { return ws.files.filter(function (f) { return f.id === id; })[0]; }
  function extractionHtml(ws) {
      var lay = ACE.project.layout(ws), facts = ws.facts;
      var h = '<p class="lead">How the BAR contents map onto Toolkit projects, which artifacts are real editable source and which are binary only, and which references resolve.</p>';
      h += '<h2>Projects</h2><table class="grid"><tr><th>Project</th><th>Type</th><th>From container</th><th class="num">Files</th><th>Source / binary / config</th><th>Descriptor</th><th>Inferred references</th></tr>';
      var refs = ACE.project.references(ws, facts);
      lay.projects.forEach(function (p) {
        var fs = lay.files.filter(function (l) { return l.project === p.name; }).map(function (l) { return fileById(ws, l.fileId); });
        var c = util.groupBy(fs, function (f) { return f.cls.category; });
        h += '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.type) + '</td><td><code class="small">' + esc(p.containerVPath) + '</code></td><td class="num">' + fs.length + '</td><td>' + Object.keys(c).map(function (k) { return UI.tag(k) + ' ' + c[k].length; }).join(' ') + '</td><td>' + (p.descriptor ? 'original (from BAR)' : '<span class="sev-Warning">missing</span>') + '</td><td class="small">' + ((refs[p.name] || []).map(function (r) { return '<b>' + esc(r.project) + '</b> <span class="muted">(' + esc(r.reasons.slice(0, 2).join('; ')) + (r.reasons.length > 2 ? '; …' : '') + ')</span>'; }).join('<br>') || '-') + '</td></tr>';
      });
      h += '</table>' + (lay.notes.length ? '<div class="banner warn">' + lay.notes.map(esc).join('<br>') + '</div>' : '');
      var bin = ws.files.filter(function (f) { return f.cls && (f.cls.category === 'binary' || f.cls.category === 'library'); });
      h += '<h2>Binary-only and compiled artifacts</h2><p class="muted small">Preserved unchanged in the export. Their editable originals are not in the BAR.</p><table class="grid"><tr><th>File</th><th>Kind</th><th class="num">Size</th></tr>' + bin.map(function (f) { return '<tr><td><code>' + esc(f.vpath) + '</code></td><td>' + UI.tag(f.cls.category, f.cls.label) + '</td><td class="num">' + util.fmtBytes(f.size) + '</td></tr>'; }).join('') + '</table>';
      if (facts) {
        h += '<h2>Message flows and subflows (' + facts.flows.length + ')</h2><div class="scroll"><table class="grid"><tr><th>Flow</th><th>Project</th><th class="num">Nodes</th><th>Node types</th><th>ESQL modules</th><th>Subflows</th><th>Java</th></tr>';
        facts.flows.forEach(function (fl) {
          var types = util.groupBy(fl.nodes, function (x) { return x.typeLabel; });
          h += '<tr><td><b>' + esc(fl.name) + '</b>' + (fl.errors.length ? '<br><span class="sev-Error">' + esc(fl.errors.join('; ')) + '</span>' : '') + '</td><td>' + esc(fl.project) + '</td><td class="num">' + fl.nodes.length + '</td><td class="small">' + Object.keys(types).sort().map(function (t) { return esc(t) + (types[t].length > 1 ? ' ×' + types[t].length : ''); }).join(', ') + '</td><td class="small">' + fl.esqlRefs.map(function (r) { return (r.resolvedTo ? '' : '<span class="sev-Error">✗ </span>') + esc(r.module); }).join('<br>') + '</td><td class="small">' + fl.subflowRefs.map(function (s) { return (s.resolvedTo ? '' : '<span class="sev-Error">✗ </span>') + esc(s.path) + (s.resolvedTo ? ' <span class="muted">→ ' + esc(s.resolvedTo.join(', ')) + '</span>' : ''); }).join('<br>') + '</td><td class="small">' + fl.javaClasses.map(function (j) { return (j.resolvedTo ? '' : '<span class="sev-Error">✗ </span>') + esc(j.className) + (j.resolvedTo ? ' <span class="muted">→ ' + esc(j.resolvedTo.join(', ')) + '</span>' : ''); }).join('<br>') + '</td></tr>';
        });
        h += '</table></div>';
        h += '<h2>Key node configuration</h2><div class="scroll"><table class="grid"><tr><th>Flow</th><th>Node</th><th>Type</th><th>Configuration (effective; BAR overrides applied)</th></tr>';
        facts.nodes.filter(function (n) { return n.kind === 'builtin' && ['soap', 'http', 'mq', 'database', 'java', 'file', 'jms', 'email', 'corba', 'tcpip', 'kafka', 'adapter'].indexOf(n.family) >= 0; }).forEach(function (n) {
          var kc = ACE.msgflow.keyConfig({ attrs: n.effective });
          h += '<tr><td>' + esc(n.flow) + '</td><td>' + esc(n.label) + '</td><td>' + esc(n.typeLabel) + '</td><td class="small mono">' + Object.keys(kc).map(function (k) { return esc(k) + '=' + esc(kc[k]) + (n.overridden[k] ? ' <span class="tag metadata">override</span>' : ''); }).join('<br>') + '</td></tr>';
        });
        h += '</table></div>';
        h += '<h2>ESQL (' + facts.esql.length + ' files, ' + facts.stats.esqlModules + ' modules)</h2><div class="scroll"><table class="grid"><tr><th>File</th><th>BROKER SCHEMA</th><th>Modules</th><th>Routines</th><th>Database</th></tr>';
        facts.esql.forEach(function (e) {
          h += '<tr><td><code class="small">' + esc(e.project + '/' + e.relPath) + '</code></td><td>' + esc(e.schema || '(default)') + (e.schemaMismatch ? '<br><span class="sev-Warning">folder implies "' + esc(e.expectedSchema || '(default)') + '"</span>' : '') + '</td><td class="small">' + e.modules.map(function (m) { return esc(m.type.toLowerCase() + ' ' + m.name); }).join('<br>') + '</td><td class="small">' + e.routines.map(function (r) { return esc(r.kind.toLowerCase() + ' ' + r.name + (r.language !== 'ESQL' ? ' [' + r.language + (r.external ? ' ' + r.external : '') + ']' : '')); }).join('<br>') + '</td><td class="small">' + (e.passthru.length ? e.passthru.length + ' PASSTHRU' : '') + (e.dbRoutines.length ? ' ' + e.dbRoutines.length + ' stored proc' : '') + '</td></tr>';
        });
        h += '</table></div>';
        h += '<h2>Unresolved references (' + facts.unresolved.length + ')</h2>' + (facts.unresolved.length ? '<table class="grid"><tr><th>Kind</th><th>Reference</th><th>Where</th></tr>' + facts.unresolved.map(function (u) { return '<tr><td>' + esc(u.kind) + '</td><td><code>' + esc(u.ref) + '</code></td><td class="small">' + esc(u.where) + (u.line ? ':' + u.line : '') + '</td></tr>'; }).join('') + '</table>' : '<p class="st-pass">All ESQL module, subflow and JavaCompute class references resolve within the BAR.</p>');
      }
      return h;
  }

  V.input = { title: 'BAR file or source code', hint: 'A BAR, or a Toolkit workspace ZIP. Read in this browser; nothing is uploaded.', accept: '.bar,.zip,.appzip,.libzip', kind: 'any', multiple: false };
  V.tab = 'explorer';
  V.onLoaded = function () { st.expanded = new Set(); st.sel = null; st.multi = new Set(); st.anchor = null; st.filter = ''; st.dirty = false; st.edText = null; st.pending = null; st.status = null; st.model = null; st.modelKey = null; };
  V.render = function (s) {
    var ws = s.ws;
    var h = '<h1>Source Code Explorer</h1><p class="lead">Extracts the source from a BAR or a Toolkit workspace ZIP. <b>Explorer</b> shows it the way the Toolkit does, with file preview, editing and ZIP export. <b>Extraction report</b> shows how the content maps onto projects, which artifacts are real editable source and which references resolve.</p>' + UI.inputHtml(V);
    if (!ws) return h;
    h += '<div class="row"><button class="btn' + (V.tab === 'explorer' ? ' primary' : '') + '" data-tab="explorer">Explorer</button> <button class="btn' + (V.tab === 'extract' ? ' primary' : '') + '" data-tab="extract">Extraction report</button></div>';
    return h + (V.tab === 'extract' ? extractionHtml(ws) : X.render(s));
  };
  V.bind = function (el, s) {
    UI.bindInput(el, V);
    if (!s.ws) return;
    UI.$$('[data-tab]', el).forEach(function (b) { b.onclick = function () { V.tab = b.getAttribute('data-tab'); UI.refresh(); }; });
    if (V.tab !== 'extract') X.bind(el, s);
  };
  UI.register('explorer', V);
  ACE.ui.explorerState = st; // exposed for tests
})(window.ACE);
