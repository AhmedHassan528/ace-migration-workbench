/* Views: Dashboard, BAR Inspector, Source Extraction. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;

  function fileById(ws, id) { return ws.files.filter(function (f) { return f.id === id; })[0]; }

  /* ===================== 1. Dashboard ===================== */
  UI.register('dashboard', {
    render: function (st) {
      var cap = util.capabilities(), S = ACE.settings.current;
      var h = '<h1>Dashboard</h1><p class="lead">Offline workbench for extracting, decompiling and migrating IBM ACE BAR files. Every result says how it was obtained. Static analysis does not prove runtime compatibility, and nothing here replaces validation in the IBM Toolkit and runtime.</p>';
      h += '<div class="card"><h3 style="margin-top:0">Environment</h3><div class="kv">' +
        '<div>Opened via</div><div>' + esc(cap.protocol) + (cap.protocol === 'file:' ? ' (local file, no web server: OK)' : '') + '</div>' +
        '<div>ZIP inflate (DecompressionStream)</div><div>' + (cap.deflateRaw ? '<span class="st-pass">available</span>' : '<span class="st-fail">NOT available - deflated BAR entries cannot be extracted in this browser</span>') + '</div>' +
        '<div>ZIP deflate (CompressionStream)</div><div>' + (cap.compressionStream ? 'available' : 'not available - exports are written uncompressed (stored)') + '</div>' +
        '<div>SHA-256 (WebCrypto)</div><div>' + (cap.subtleCrypto ? 'available' : 'not available - manifests will have no hashes') + '</div>' +
        '<div>Java decompilation</div><div>Built-in JavaScript decompiler (' + esc(ACE.decompiler.name + ' ' + ACE.decompiler.version) + '), runs in this page. No Java runtime, Fernflower, script or server is used.</div>' +
        '</div></div>';
      var ws = st.ws;
      if (!ws) return h + '<div class="banner">No BAR loaded. Use <b>Open BAR file…</b> at the top. The file is read locally and never uploaded.</div>';
      if (ws.fatal) return h + '<div class="banner err"><b>BAR could not be opened.</b> ' + esc(ws.fatal.message) + '</div>';
      var errs = ws.issues.filter(function (i) { return i.severity === 'error'; }).length, warns = ws.issues.filter(function (i) { return i.severity === 'warning'; }).length;
      var j = ws.java17 ? ws.java17.findings : [], a = ws.aceFindings || [];
      var apps = ws.model.deployables.filter(function (d) { return d.type === 'application'; }), libs = ws.model.deployables.filter(function (d) { return /library/.test(d.type); });
      h += '<div class="card"><h3 style="margin-top:0">' + esc(ws.barName) + '</h3><div class="kv">' +
        '<div>Size / SHA-256</div><div>' + util.fmtBytes(ws.barSize) + ' &middot; <code>' + esc(ws.barSha256 || 'n/a') + '</code></div>' +
        '<div>Input</div><div>' + (ws.inputKind === 'workspace' ? 'Toolkit workspace ZIP (' + ws.model.deployables.length + ' projects with original .project files)' : 'BAR file') + '</div>' + '<div>Versions (strict)</div><div>ACE ' + esc(S.sourceVersion) + ' &rarr; ACE ' + esc(S.targetVersion) + (ws.migration ? ' &middot; ' + esc(ws.migration.versions.statement) : '') + '</div>' +
        '<div>Build evidence</div><div>' + ws.model.buildEvidence.map(function (b) { return esc(b.text); }).join('<br>') + ((ws.jars || []).filter(function (x) { return x.info.manifest && x.info.manifest.main['Created-By']; }).map(function (x) { return '<br>' + esc(x.name + ' manifest Created-By: ' + x.info.manifest.main['Created-By']); }).join('')) + '</div>' +
        '<div>Extraction</div><div>' + (ws.complete ? '<span class="st-pass">COMPLETE</span>' : '<span class="st-fail">INCOMPLETE</span>') + ' - ' + ws.files.length + ' files in ' + ws.containers.length + ' containers, ' + util.fmtBytes(ws.totalExtracted) + ' extracted, ' + ws.rejected.length + ' unsafe entries rejected, ' + ws.stats.elapsedMs + ' ms</div>' +
        '<div>Deployables</div><div>' + apps.length + ' application(s): ' + esc(apps.map(function (d) { return d.name; }).join(', ')) + '<br>' + libs.length + ' librar(y/ies): ' + esc(libs.map(function (d) { return d.name + ' (' + d.type + ')'; }).join(', ')) + '</div>' +
        '<div>Issues</div><div>' + errs + ' error(s), ' + warns + ' warning(s) during extraction' + (ws.model.warnings.length ? '<br>' + ws.model.warnings.map(esc).join('<br>') : '') + '</div>' +
        '</div></div>';
      var cat = ws.stats.byCategory;
      h += '<div class="cards">' + Object.keys(cat).map(function (k) { return '<div class="stat"><div class="n">' + cat[k] + '</div><div class="l">' + UI.tag(k) + '</div></div>'; }).join('') +
        '<div class="stat"><div class="n">' + (ws.jars || []).length + '</div><div class="l">distinct JARs (' + (ws.jars || []).filter(function (x) { return /driver/.test(x.classification.type); }).length + ' driver)</div></div>' +
        '<div class="stat"><div class="n">' + Object.keys(ws.decompiled || {}).length + '</div><div class="l">JARs decompiled</div></div>' +
        '<div class="stat"><div class="n">' + (ws.facts ? ws.facts.stats.flows : 0) + '</div><div class="l">flows/subflows, ' + (ws.facts ? ws.facts.stats.nodes : 0) + ' nodes</div></div></div>';
      h += '<h2>Analysis status</h2><div class="card"><div class="kv">' +
        '<div>Java 8 → 17</div><div>' + UI.sevCounts(j) + '</div>' +
        '<div>ACE 12 → 13</div><div>' + UI.sevCounts(a) + ' &nbsp; (' + a.filter(function (f) { return f.blocker; }).length + ' blocker rule(s))</div>' +
        '<div>Documentation</div><div>' + (st.docs.length ? st.docs.length + ' IBM document(s) imported' : '<span class="st-attention">No IBM documentation imported: documented rules are shown as UNVERIFIED offline (Settings)</span>') + '</div>' +
        '<div>Applied fixes</div><div>' + (ws.ws13.changelog.filter(function (c) { return c.action === 'applied'; }).length) + ' (ACE 13 working copy), ' + (ws.ws12.changelog.length + ws.ws13.changelog.filter(function (c) { return c.kind === 'user-edit'; }).length) + ' manual edit(s)</div>' +
        '<div>Java 17 compilation</div><div><span class="muted">not available in a browser-only tool: compile the exported project in the ACE Toolkit</span></div>' +
        '</div></div>';
      h += '<h2>Workflows</h2><div class="card"><b>A - Extract ACE 12 source:</b> BAR Inspector → Source Extraction → Java Decompiler → ACE 12 Export<br><b>B - Migrate to ACE 13.0.8:</b> Workflow A → ACE 13 Migration (Java 17 + ACE rules, review fixes) → Pre-Migration Checks → ACE 13 export</div>';
      return h;
    },
    bind: function (el) {
    }
  });

  /* ===================== 2. BAR Inspector ===================== */
  var inspFilter = { q: '', cat: '' }, inspSel = null;
  UI.register('inspector', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>BAR Inspector</h1>' + n;
      var ws = st.ws;
      var h = '<h1>BAR Inspector</h1><p class="lead">Every archive entry at every nesting level, read from the ZIP central directory and verified (local header, size, CRC-32). Paths use <code>!/</code> to mark a container boundary. Nothing is modified.</p>';
      h += '<h2>Containers</h2><table class="grid"><tr><th>Container</th><th>Type</th><th>Depth</th><th class="num">Entries</th><th>Notes</th></tr>' + ws.containers.map(function (c) {
        return '<tr><td><code>' + esc(c.vpath || ws.barName + ' (root)') + '</code></td><td>' + esc(c.type) + '</td><td class="num">' + c.depth + '</td><td class="num">' + c.entryCount + '</td><td class="small">' + esc([c.backslashNames ? 'backslash path separators (normalised)' : '', c.zip64 ? 'ZIP64' : '', c.comment ? 'comment: ' + c.comment : ''].concat(c.issues.map(function (i) { return i.message; })).filter(Boolean).join('; ')) + '</td></tr>';
      }).join('') + '</table>';
      if (ws.rejected.length) h += '<h2>Rejected unsafe entries</h2><table class="grid"><tr><th>Container</th><th>Raw name</th><th>Reason</th></tr>' + ws.rejected.map(function (r) { return '<tr><td>' + esc(r.container) + '</td><td><code>' + esc(r.rawName) + '</code></td><td class="sev-Error">' + esc(r.reason) + '</td></tr>'; }).join('') + '</table>';
      var errs = ws.issues.filter(function (i) { return i.severity !== 'info'; });
      if (errs.length) h += '<h2>Issues</h2><table class="grid"><tr><th>Severity</th><th>Message</th><th>Where</th></tr>' + errs.map(function (i) { return '<tr><td>' + UI.sev(i.severity === 'error' ? 'Error' : 'Warning') + '</td><td>' + esc(i.message) + '</td><td><code>' + esc(i.where || '') + '</code></td></tr>'; }).join('') + '</table>';
      var cats = Object.keys(ws.stats.byCategory);
      h += '<h2>Entries</h2><div class="row"><input type="text" id="inspQ" placeholder="Filter path…" value="' + esc(inspFilter.q) + '"> <select id="inspCat"><option value="">All categories</option>' + cats.map(function (c) { return '<option value="' + esc(c) + '"' + (inspFilter.cat === c ? ' selected' : '') + '>' + esc(ACE.classify.CATEGORY_LABELS[c] || c) + '</option>'; }).join('') + '</select> <span class="muted small" id="inspCount"></span></div>';
      h += '<div class="scroll"><table class="grid" id="inspTable"><tr><th>Path</th><th>Kind</th><th class="num">Size</th><th class="num">Packed</th><th>Method</th><th>CRC-32</th><th>Modified</th><th>Status</th></tr>';
      ws.files.forEach(function (f) {
        var bad = f.extractError ? '<span class="sev-Error">' + esc(f.extractError) + '</span>' : (f.issues.filter(function (i) { return i.severity !== 'info'; }).map(function (i) { return '<span class="sev-Warning">' + esc(i.message) + '</span>'; }).join('<br>') || '<span class="st-pass">verified</span>');
        h += '<tr data-id="' + f.id + '" data-path="' + esc(f.vpath.toLowerCase()) + '" data-cat="' + esc(f.cls ? f.cls.category : '') + '"' + (inspSel === f.id ? ' class="sel"' : '') + '><td><code>' + esc(f.vpath) + '</code></td><td>' + UI.tag(f.cls ? f.cls.category : 'unknown', f.cls ? f.cls.label : '?') + '</td><td class="num">' + util.fmtBytes(f.size) + '</td><td class="num">' + util.fmtBytes(f.compressedSize) + '</td><td>' + esc(f.method) + '</td><td><code>' + ((f.crc >>> 0).toString(16).padStart(8, '0')) + '</code></td><td class="small">' + esc((f.mtime || '').replace('T', ' ').slice(0, 19)) + '</td><td class="small">' + bad + '</td></tr>';
      });
      h += '</table></div><div id="inspDetail"></div>';
      return h;
    },
    bind: function (el, st) {
      if (!st.ws || st.ws.fatal) return;
      function apply() {
        var q = inspFilter.q.toLowerCase(), c = inspFilter.cat, n = 0;
        UI.$$('#inspTable tr[data-id]', el).forEach(function (tr) { var ok = (!q || tr.getAttribute('data-path').indexOf(q) >= 0) && (!c || tr.getAttribute('data-cat') === c); tr.style.display = ok ? '' : 'none'; if (ok) n++; });
        UI.$('#inspCount', el).textContent = n + ' of ' + st.ws.files.length + ' entries';
      }
      UI.$('#inspQ', el).oninput = function (e) { inspFilter.q = e.target.value; apply(); };
      UI.$('#inspCat', el).onchange = function (e) { inspFilter.cat = e.target.value; apply(); };
      apply();
      UI.$('#inspTable', el).onclick = function (e) {
        var tr = e.target.closest('tr[data-id]'); if (!tr) return;
        inspSel = tr.getAttribute('data-id');
        UI.$$('#inspTable tr.sel', el).forEach(function (x) { x.classList.remove('sel'); }); tr.classList.add('sel');
        var f = fileById(st.ws, inspSel);
        UI.$('#inspDetail', el).innerHTML = '<div class="card"><h3 style="margin-top:0">' + esc(f.name) + '</h3><div class="kv">' +
          '<div>Virtual path</div><div><code>' + esc(f.vpath) + '</code></div><div>Raw entry name</div><div><code>' + esc(f.rawName) + '</code></div>' +
          '<div>Classification</div><div>' + esc(f.cls.label) + ' (' + esc(f.cls.category) + ')' + (f.cls.note ? ' - ' + esc(f.cls.note) : '') + '</div>' +
          '<div>Size</div><div>' + f.size + ' bytes (compressed ' + f.compressedSize + ', ' + esc(f.method) + ')</div><div>SHA-256</div><div><code>' + esc(f.sha256 || '-') + '</code></div>' +
          '<div>ZIP made by</div><div>version ' + f.versionMadeBy + ', host ' + f.hostOS + '</div><div>Encoding</div><div>' + esc(f.encoding || (f.cls.textual ? 'not decoded yet' : 'binary')) + '</div>' +
          '<div>Issues</div><div>' + (f.issues.map(function (i) { return esc(i.severity + ': ' + i.message); }).join('<br>') || 'none') + '</div></div>' +
          '<div class="row"><button class="btn small" id="inspDl">Download this file</button></div></div>';
        UI.$('#inspDl', el).onclick = function () { util.download(f.bytes, f.name); };
      };
    }
  });

  /* ===================== 3. Source Extraction ===================== */
  UI.register('extraction', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>Source Extraction</h1>' + n;
      var ws = st.ws, lay = ACE.project.layout(ws), facts = ws.facts;
      var h = '<h1>Source Extraction</h1><p class="lead">How the BAR contents map onto Toolkit projects, which artifacts are real editable source and which are binary only, and which references resolve.</p>';
      h += '<h2>Projects</h2><table class="grid"><tr><th>Project</th><th>Type</th><th>From container</th><th class="num">Files</th><th>Source / binary / config</th><th>Descriptor</th><th>Inferred references</th></tr>';
      var refs = ACE.project.references(ws, facts);
      lay.projects.forEach(function (p) {
        var fs = lay.files.filter(function (l) { return l.project === p.name; }).map(function (l) { return fileById(ws, l.fileId); });
        var c = util.groupBy(fs, function (f) { return f.cls.category; });
        h += '<tr><td><b>' + esc(p.name) + '</b></td><td>' + esc(p.type) + '</td><td><code class="small">' + esc(p.containerVPath) + '</code></td><td class="num">' + fs.length + '</td><td>' + Object.keys(c).map(function (k) { return UI.tag(k) + ' ' + c[k].length; }).join(' ') + '</td><td>' + (p.descriptor ? 'original (from BAR)' : '<span class="sev-Warning">missing</span>') + '</td><td class="small">' + ((refs[p.name] || []).map(function (r) { return '<b>' + esc(r.project) + '</b> <span class="muted">(' + esc(r.reasons.slice(0, 2).join('; ')) + (r.reasons.length > 2 ? '; …' : '') + ')</span>'; }).join('<br>') || '-') + '</td></tr>';
      });
      h += '</table>' + (lay.notes.length ? '<div class="banner warn">' + lay.notes.map(esc).join('<br>') + '</div>' : '');
      var bin = ws.files.filter(function (f) { return f.cls && (f.cls.category === 'binary' || f.cls.category === 'library'); });
      h += '<h2>Binary-only and compiled artifacts</h2><p class="muted small">Preserved unchanged in the export. Their editable originals are not in the BAR. JARs are covered in Java Decompiler.</p><table class="grid"><tr><th>File</th><th>Kind</th><th class="num">Size</th></tr>' + bin.map(function (f) { return '<tr><td><code>' + esc(f.vpath) + '</code></td><td>' + UI.tag(f.cls.category, f.cls.label) + '</td><td class="num">' + util.fmtBytes(f.size) + '</td></tr>'; }).join('') + '</table>';
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
  });

  /* 5. Project Explorer: see views-explorer.js */
})(window.ACE);
