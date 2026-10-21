/* Views: ACE 12 Export, ACE 13 Migration, Pre-Migration Checks, Reports. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;
  var lastExport = {}, fixOpen = {}, jFilter = 'application';

  function exportCard(st, target) {
    var ws = st.ws, S = ACE.settings.current, lay = ACE.project.layout(ws), dec = Object.keys(ws.decompiled || {}).length;
    var le = lastExport[target];
    var h = '<div class="card"><div class="kv"><div>Projects</div><div>' + lay.projects.map(function (p) { return esc(p.name) + ' <span class="muted">(' + esc(p.type) + ')</span>'; }).join(', ') + (dec ? '<br>+ ' + dec + ' decompiled Java project(s)' : '<br><span class="muted">No decompiled Java projects (no successful decompilation)</span>') + '</div>' +
      '<div>Original files</div><div>' + lay.files.length + ' project files + ' + (lay.metadata.length + lay.unassigned.length) + ' metadata/other, copied byte-for-byte</div>' +
      '<div>Working-copy changes</div><div>' + Object.keys((target === 'ace13' ? ws.ws13 : ws.ws12).overlay).length + ' file(s) differ from the original</div>' +
      '<div>Options</div><div><label class="inline"><input type="checkbox" id="optBar"' + (S.export.includeOriginalBar ? ' checked' : '') + '> include the original BAR under _original/</label> <label class="inline"><input type="checkbox" id="optHdr"' + (S.export.decompileHeader ? ' checked' : '') + '> mark decompiled files with a header comment</label></div></div>' +
      '<div class="row"><button class="btn primary" id="doExport">Build and download ' + (target === 'ace13' ? 'ACE 13' : 'ACE 12') + ' project ZIP</button> <button class="btn" id="dlManifest"' + (le ? '' : ' disabled') + '>Download MANIFEST.json</button> <button class="btn" id="dlInstr"' + (le ? '' : ' disabled') + '>Download import instructions</button></div>' +
      (le ? '<div class="banner ok">Last package: ' + esc(le.name) + ' - ' + le.manifest.files.length + ' entries, ' + util.fmtBytes(le.size) + ', ' + esc(le.at) + '. Origins: ' + Object.entries(util.groupBy(le.manifest.files, function (f) { return f.origin; })).map(function (e) { return esc(e[0]) + ' ' + e[1].length; }).join(', ') + '</div>' : '') + '</div>';
    return h;
  }
  function bindExport(el, st, target) {
    var S = ACE.settings.current;
    UI.$('#optBar', el).onchange = function (e) { S.export.includeOriginalBar = e.target.checked; ACE.settings.save(); };
    UI.$('#optHdr', el).onchange = function (e) { S.export.decompileHeader = e.target.checked; ACE.settings.save(); };
    UI.$('#doExport', el).onclick = function () {
      UI.run('Build ' + target.toUpperCase() + ' package', async function (cancel, progress) {
        var r = await ACE.workflow.exportPackage(target, function (d, t) { progress('zip', d, t); }, cancel);
        var name = util.stripExt(st.ws.barName) + (target === 'ace13' ? '-ACE' + window.ACE_VERSIONS.target + '-migration' : '-ACE' + window.ACE_VERSIONS.source + '-source') + '.zip';
        lastExport[target] = { name: name, manifest: r.manifest, size: r.blob.size, at: util.nowIso() };
        util.download(r.blob, name);
      });
    };
    if (UI.$('#dlManifest', el)) UI.$('#dlManifest', el).onclick = function () { util.download(JSON.stringify(lastExport[target].manifest, null, 2), 'MANIFEST-' + target + '.json', 'application/json'); };
    if (UI.$('#dlInstr', el)) UI.$('#dlInstr', el).onclick = function () { var ws = st.ws, lay = ACE.project.layout(ws); util.download(ACE.project.instructions(ws, target, lay, ACE.project.references(ws, ws.facts), Object.keys(ws.decompiled).map(function (k) { return ws.decompiled[k].projectName; }), Object.keys((target === 'ace13' ? ws.ws13 : ws.ws12).overlay)), 'IMPORT-INSTRUCTIONS-' + target + '.txt', 'text/plain'); };
  }

  /* A fix proposal: what it does, when to choose it (for alternatives), diff, Accept and replace / Reject / Undo. */
  var STATUS_TXT = { proposed: 'suggested - not applied', applied: 'ACCEPTED - old code replaced in the ACE 13 copy', rejected: 'rejected', superseded: 'not needed - another option was accepted', 'not-applicable': 'cannot be applied automatically' };
  function proposalCard(p, compact) {
    var alt = p.group ? ' <span class="tag">option</span>' + (p.recommended ? ' <span class="tag source">recommended</span>' : '') : '';
    return '<div class="card" data-fx="' + esc(p.id) + '"><div class="row"><b>' + esc(p.title) + '</b>' + alt + (compact ? '' : ' <code class="muted">' + esc(p.fixId) + '</code> on <code>' + esc(p.outPath) + '</code>') + ' ' + UI.status(p.status === 'applied' ? 'pass' : p.status === 'proposed' ? 'attention' : 'unknown') + ' <span class="small">' + esc(STATUS_TXT[p.status] || p.status) + '</span></div>' +
      (p.when ? '<p class="small"><b>When to choose:</b> ' + esc(p.when) + '</p>' : '') +
      (compact ? '' : '<p class="small">' + esc(p.why) + '</p>') + (p.reason ? '<p class="small sev-Warning">' + esc(p.reason) + '</p>' : '') + (!compact && p.notes.length ? '<ul class="small">' + p.notes.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>' : '') +
      (p.status === 'proposed' ? '<div class="row"><button class="btn small fxShow">' + (fixOpen[p.id] ? 'Hide' : 'Show') + ' change (+' + p.stats.added + ' / -' + p.stats.removed + ')</button> <button class="btn primary small fxApply">Accept and replace…</button> <button class="btn small fxReject">Reject</button></div>' + (fixOpen[p.id] ? UI.diffHtml(p.diff) : '') : '') +
      (p.status === 'applied' ? '<div class="row"><button class="btn small fxUndo">Undo (restore the old code)</button></div>' : '') + '</div>';
  }
  function bindProposals(el, ws) {
    UI.$$('[data-fx]', el).forEach(function (card) {
      var p = ws.proposals.filter(function (x) { return x.id === card.getAttribute('data-fx'); })[0]; if (!p) return;
      var s = UI.$('.fxShow', card); if (s) s.onclick = function () { fixOpen[p.id] = !fixOpen[p.id]; UI.refresh(); };
      var a = UI.$('.fxApply', card); if (a) a.onclick = function () {
        var alts = ACE.transforms.alternatives(ws, p).filter(function (x) { return x.status === 'proposed'; });
        UI.ask('Accept "' + p.title + '"?\n\nThe old code in ' + p.outPath + ' is replaced in the ACE 13 working copy (and in the ACE 13 export).\n' + p.notes.join('\n') + (alts.length ? '\n\nThe other option' + (alts.length > 1 ? 's' : '') + ' for this problem will be withdrawn.' : '') + '\n\nThe original file is kept unchanged (exported under _original-before-changes/) and Undo restores it.', function () {
          try { ACE.transforms.apply(ws, p); ACE.workflow.analyze(); UI.refresh(); }
          catch (e) { UI.refresh(); UI.notify('The change was not applied: ' + e.message); }
        }, { ok: 'Accept and replace' });
      };
      var r = UI.$('.fxReject', card); if (r) r.onclick = function () { p.status = 'rejected'; ws.ws13.changelog.push({ t: util.nowIso(), path: p.outPath, action: 'rejected', kind: 'autofix', fixId: p.fixId, ruleId: p.ruleId, title: 'Rejected: ' + p.title }); ACE.log.info('Rejected fix ' + p.fixId + ' for ' + p.outPath); UI.refresh(); };
      var u = UI.$('.fxUndo', card); if (u) u.onclick = function () { ACE.transforms.undo(ws, 'ws13', p.outPath); ACE.workflow.analyze(); UI.refresh(); };
    });
  }

  /* Classified ACE 12.0.5 -> 13.0.8 findings (all analysers), dependencies, artifacts, open risks. */
  var mClass = 'all';
  function migrationSection(ws) {
    var pending = (ws.proposals || []).filter(function (p) { return p.status === 'proposed'; }).length;
    var m = ws.migration, V = window.ACE_VERSIONS; if (!m) return '';
    var list = m.findings.filter(function (f) { return mClass === 'all' || f.classification === mClass || (mClass === 'open-high' && f.risk === 'high' && !f.resolvedInWorkingCopy) || (mClass === 'fixable' && (f.autoFixIds || []).length > 0); });
    var h = '<h2>Migration assessment: ACE ' + esc(V.source) + ' → ' + esc(V.target) + ' (' + esc(V.mode) + ' mode)</h2>';
    h += '<p class="small">Input: <b>' + (ws.inputKind === 'workspace' ? 'Toolkit workspace ZIP (original projects)' : 'BAR file') + '</b>. ' + esc(m.versions.statement) + ' Every finding below is classified; nothing is applied without your confirmation.</p>' + (pending ? '<div class="banner warn"><b>' + m.findings.filter(function (f) { return (f.autoFixIds || []).some(function (id) { return ws.proposals.some(function (p) { return p.id === id && p.status === 'proposed'; }); }); }).length + ' finding(s) have suggested solutions</b> (' + pending + ' option(s)) waiting for your decision: use <b>Accept and replace…</b> in the Recommended action column (filter: "with suggested solution").</div>' : '');
    h += '<div class="cards">' + ACE.migScan.CLASSES.map(function (c) { return '<div class="stat"><div class="n">' + m.counts[c] + '</div><div class="l">' + esc(c) + '</div></div>'; }).join('') + '<div class="stat"><div class="n sev-Error">' + m.unresolvedRisks.length + '</div><div class="l">open high-risk items</div></div></div>';
    h += '<div class="row">Show: <select id="mClass"><option value="all">all (' + m.findings.length + ')</option><option value="open-high"' + (mClass === 'open-high' ? ' selected' : '') + '>open high-risk</option><option value="fixable"' + (mClass === 'fixable' ? ' selected' : '') + '>with suggested solution</option>' + ACE.migScan.CLASSES.map(function (c) { return '<option value="' + c + '"' + (mClass === c ? ' selected' : '') + '>' + c + ' (' + m.counts[c] + ')</option>'; }).join('') + '</select></div>';
    h += '<div class="scroll"><table class="grid"><tr><th>Class</th><th>Risk / confidence</th><th>Finding</th><th>Location</th><th>Recommended action</th><th>Docs</th></tr>';
    list.forEach(function (f) {
      h += '<tr><td><b>' + esc(f.classification) + '</b>' + (f.resolvedInWorkingCopy ? '<br><span class="st-pass small">resolved in ACE 13 copy</span>' : '') + '</td><td class="small">' + esc(f.risk) + ' / ' + esc(f.confidence) + '<br><span class="muted">' + esc(f.evidenceStatus) + '</span></td>' +
        '<td><b>' + esc(f.title) + '</b> <code class="small muted">' + esc(f.ruleId) + '</code><br><span class="small">' + esc(f.why) + '</span>' + (f.assumption ? '<br><span class="small sev-Manual">Unverified assumption: ' + esc(f.assumption) + '</span>' : '') + '</td>' +
        '<td class="small">' + f.locations.slice(0, 5).map(function (l) { return '<code>' + esc((l.file || '') + (l.line ? ':' + l.line : '')) + '</code>'; }).join('<br>') + (f.locations.length > 5 ? '<br>… ' + (f.locations.length - 5) + ' more' : '') + '</td>' +
        '<td class="small">' + esc(f.action) + fixesFor(ws, f) + '</td>' +
        '<td class="small">' + (f.refs || []).map(function (r) { return '<a href="' + esc(r.url) + '" target="_blank" rel="noopener">' + esc(r.title) + '</a>'; }).join('<br>') + '</td></tr>';
    });
    h += '</table></div>';
    var d = m.dependencies;
    h += '<h3>Dependencies</h3><table class="grid"><tr><th>JAR</th><th>Type</th><th>Copies</th><th>Version (manifest)</th><th>On .classpath</th><th>Referenced by</th><th>Missing Class-Path JARs</th></tr>' + d.jars.map(function (j) { return '<tr><td>' + esc(j.name) + '</td><td>' + esc(j.type + (j.driver ? ' (' + j.driver + ')' : '')) + '</td><td class="num">' + j.copies + '</td><td>' + esc(j.implementationVersion || j.createdBy || '-') + '</td><td>' + (j.onBuildPath.length ? 'yes' : 'no') + '</td><td class="small">' + esc(j.referencedBy.join(', ') || 'nothing in the input') + '</td><td class="small">' + esc(j.missingClassPath.join(', ') || '-') + '</td></tr>'; }).join('') + '</table>';
    h += '<h3>Scanned artifacts</h3><p class="small">' + m.artifacts.summary.map(function (s) { return esc(s.category) + ': ' + s.count; }).join(' · ') + (m.artifacts.notFound.length ? '<br>Not present in the input: ' + esc(m.artifacts.notFound.join(', ')) + ' (scripts are read as data, never run).' : '') + '</p>';
    h += '<h3>Unverified assumptions</h3><ul class="small">' + m.unverifiedAssumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>';
    return h;
  }
  /* Suggested solutions for a finding: every proposal (and alternative) for the same rule and file. */
  function fixesFor(ws, f) {
    var ps = (f.autoFixIds || []).map(function (id) { return ws.proposals.filter(function (p) { return p.id === id; })[0]; }).filter(function (p) { return p && p.status !== 'not-applicable'; });
    if (!ps.length) return f.autoFix && f.autoFix.status === 'no-matching-source' ? '<br><span class="muted">An automatic fix exists, but this code is not in a supported form.</span>' : '';
    var open = ps.some(function (p) { return p.status === 'proposed'; });
    return '<div style="margin-top:6px"><b>' + (open ? (ps.length > 1 ? 'Suggested solutions - choose one:' : 'Suggested solution:') : 'Solution:') + '</b>' + ps.map(function (p) { return proposalCard(p, true); }).join('') + '</div>';
  }
  function bindMigration(el) {
    var s = UI.$('#mClass', el); if (s) s.onchange = function (e) { mClass = e.target.value; UI.refresh(); };
  }

  /* ===================== 6. ACE 12 Export ===================== */
  UI.register('export12', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>ACE 12 Export</h1>' + n;
      var ws = st.ws;
      var h = '<h1>ACE 12 Export (Workflow A)</h1><p class="lead">The source projects for the <b>ACE ' + esc(window.ACE_VERSIONS.source) + ' Toolkit</b>' + (ws.inputKind === 'workspace' ? ' (input was a Toolkit workspace ZIP: every project file, including .project/.classpath/.settings, is the original)' : '') + ': original source byte-for-byte, original descriptors, generated (and labelled) <code>.project</code> files, decompiled Java where it succeeded, all original JARs, BAR metadata, the extraction manifest and reports. Importability must be confirmed in the Toolkit.</p>';
      if (!ws.complete) h += '<div class="banner err">Extraction was incomplete. The package will list the missing files as "missing" in MANIFEST.json.</div>';
      var appJars = (ws.jars || []).filter(function (j) { return j.classification.type === 'application'; }), undone = appJars.filter(function (j) { return !ws.decompiled[j.sha256]; });
      if (undone.length) h += '<div class="banner warn">' + undone.length + ' application JAR(s) are not decompiled (' + esc(undone.map(function (j) { return j.name; }).join(', ')) + '). They are exported as binary JARs only. Use Java Decompiler first if you need their source.</div>';
      return h + exportCard(st, 'ace12');
    },
    bind: function (el, st) { if (st.ws && !st.ws.fatal) bindExport(el, st, 'ace12'); }
  });

  /* ===================== 7. ACE 13 Migration ===================== */
  UI.register('migrate13', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>ACE 13 Migration</h1>' + n;
      var ws = st.ws, j = ws.java17, S = ACE.settings.current;
      var h = '<h1>ACE 13 Migration (Workflow B)</h1><p class="lead">Java 8 → 17 analysis (bytecode and source) and ACE 12 → 13 rule checks. Fixes are only <b>proposed</b>; each shows its diff and must be confirmed. Applied fixes change only the ACE 13 working copy, keep the original, can be undone, and go into the change log. <b>' + esc(j.disclaimer) + '</b></p>';
      h += migrationSection(ws);
      h += '<h2>Java 8 → 17 (' + j.findings.length + ' findings)</h2><p class="small">' + j.summary.classesAnalysed + ' classes in ' + j.summary.jarsAnalysed + ' JAR(s) and ' + j.summary.sourcesAnalysed + ' source file(s). Application bytecode: ' + esc(Object.keys(j.summary.applicationTargets).map(function (k) { return 'Java ' + k + ' ×' + j.summary.applicationTargets[k]; }).join(', ') || 'none') + '. API reference index: ' + (ACE.workflow.state.apiIndex ? 'loaded (' + ACE.workflow.state.apiIndex.sources.map(function (s) { return s.name; }).join(', ') + ')' : 'not loaded (Settings)') + '.</p>';
      h += '<div class="row">Show: <select id="jScope"><option value="application"' + (jFilter === 'application' ? ' selected' : '') + '>application code</option><option value="dependency"' + (jFilter === 'dependency' ? ' selected' : '') + '>dependency / driver JARs</option><option value="all"' + (jFilter === 'all' ? ' selected' : '') + '>all</option></select> ' + UI.sevCounts(j.findings.filter(function (f) { return jFilter === 'all' || f.scope === jFilter; })) + '</div>';
      h += UI.findingsTable(j.findings.filter(function (f) { return jFilter === 'all' || f.scope === jFilter; }));
      h += '<h2>All suggested solutions</h2>';
      var props = ws.proposals || [];
      if (!props.length) h += '<p class="muted">No automatic fixes apply.' + (Object.keys(ws.decompiled).length ? '' : ' Fixes work on Java source: run Java Source Recovery first.') + '</p>';
      props.forEach(function (p) { h += proposalCard(p, false); });
      h += '<h2>Java 17 compilation</h2><div class="banner">Not performed: a browser-only workbench has no Java compiler. The findings above are static analysis. Import the exported project into the ACE 13 Toolkit to compile and test it.</div>';
      var a = ws.aceFindings || [];
      h += '<h2>ACE 12 → 13 rule findings (' + a.length + ')</h2><p class="small">' + UI.sevCounts(a) + '. Rule sets: ' + esc(ws.ruleSetsUsed.map(function (r) { return r.id + ' v' + r.version + ' (' + r.rules + ' rules)'; }).join(', ')) + '. Imported IBM docs: ' + (st.docs.length ? st.docs.length : '<b>none - documented rules are UNVERIFIED offline</b>') + '.</p>';
      h += UI.findingsTable(a);
      h += '<h2>Export</h2>' + exportCard(st, 'ace13');
      return h;
    },
    bind: function (el, st) {
      if (!st.ws || st.ws.fatal) return;
      var ws = st.ws;
      bindMigration(el);
      UI.$('#jScope', el).onchange = function (e) { jFilter = e.target.value; UI.refresh(); };
      bindProposals(el, ws);
      bindExport(el, st, 'ace13');
    }
  });

  /* ===================== 8. Pre-Migration Checks ===================== */
  UI.register('checks', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>Pre-Migration Checks</h1>' + n;
      var ws = st.ws, items = ws.checklist || [];
      var h = '<h1>Pre-Migration Checks</h1><p class="lead">The checklist built from the IBM pre-migration guidance, the verified probes and the facts found in this BAR. The basis column separates IBM-documented rules from facts observed in the BAR and from heuristics. Items marked TOOLKIT can only be confirmed in the IBM Toolkit or runtime.</p>';
      var c = util.groupBy(items, function (i) { return i.status; });
      h += '<div class="row">' + ['fail', 'attention', 'toolkit', 'unknown', 'info', 'pass'].map(function (s) { return UI.status(s) + ' ' + (c[s] ? c[s].length : 0); }).join(' &nbsp; ') + ' <button class="btn small" id="ckDl">Download checklist (.txt)</button></div>';
      var cat = null;
      h += '<table class="grid"><tr><th>Status</th><th>Check</th><th>Basis</th><th>Evidence / detail</th></tr>';
      items.forEach(function (i) {
        if (i.category !== cat) { cat = i.category; h += '<tr><th colspan="4">' + esc(cat) + '</th></tr>'; }
        h += '<tr><td>' + UI.status(i.status) + '</td><td>' + esc(i.title) + (i.refs && i.refs.length ? '<br><span class="small">' + UI.refs(i.refs) + '</span>' : '') + '</td><td class="small">' + esc(i.basis) + '</td><td class="small"><pre style="margin:0">' + esc(i.detail || '') + '</pre></td></tr>';
      });
      return h + '</table>';
    },
    bind: function (el, st) { if (st.ws && !st.ws.fatal) UI.$('#ckDl', el).onclick = function () { util.download(ACE.reports.checklistText(st.ws), 'migration-checklist.txt', 'text/plain'); }; }
  });

  /* ===================== 9. Reports ===================== */
  UI.register('reports', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>Reports</h1>' + n;
      var list = [['extraction', 'Extraction report', 'JSON'], ['decompilation', 'Decompilation report', 'JSON'], ['exclusions', 'Excluded driver / JAR list', 'JSON'], ['compatibility', 'Java 17 compatibility report', 'JSON'], ['migration', 'ACE ' + window.ACE_VERSIONS.source + ' → ' + window.ACE_VERSIONS.target + ' migration report (classified findings, dependencies, risks, assumptions, change log)', 'JSON'], ['migrationText', 'Migration report (human-readable)', 'Markdown'],['changelog', 'Migration change log', 'TXT'], ['checklist', 'Pre-migration checklist', 'TXT'], ['html', 'Complete report', 'HTML'], ['manifest', 'Source manifest (all extracted files, hashes, classification)', 'JSON']];
      return '<h1>Reports</h1><p class="lead">Every report is generated from the current session state. The JSON reports are machine-readable. The HTML report is self-contained (no external resources).</p><table class="grid"><tr><th>Report</th><th>Format</th><th></th></tr>' + list.map(function (r) { return '<tr><td>' + esc(r[1]) + '</td><td>' + r[2] + '</td><td><button class="btn small rep" data-r="' + r[0] + '">Download</button>' + (r[0] === 'html' ? ' <button class="btn small" id="repOpen">Open in new tab</button>' : '') + '</td></tr>'; }).join('') + '</table>';
    },
    bind: function (el, st) {
      if (!st.ws || st.ws.fatal) return;
      var ws = st.ws, base = util.stripExt(ws.barName);
      UI.$$('.rep', el).forEach(function (b) {
        b.onclick = function () {
          var r = b.getAttribute('data-r'), R = ACE.reports, J = function (o) { return JSON.stringify(o, null, 2); };
          if (r === 'html') util.download(R.html(ws), base + '-report.html', 'text/html');
          else if (r === 'migrationText') util.download(R.migrationText(ws), base + '-migration-report.md', 'text/markdown');
          else if (r === 'changelog') util.download(R.changeLogText(ws), base + '-change-log.txt', 'text/plain');
          else if (r === 'checklist') util.download(R.checklistText(ws), base + '-checklist.txt', 'text/plain');
          else if (r === 'manifest') util.download(J({ bar: ws.barName, sha256: ws.barSha256, generatedAt: util.nowIso(), files: R.extraction(ws).files }), base + '-source-manifest.json', 'application/json');
          else util.download(J(R[r](ws)), base + '-' + r + '-report.json', 'application/json');
        };
      });
      UI.$('#repOpen', el).onclick = function () { var u = URL.createObjectURL(new Blob([ACE.reports.html(ws)], { type: 'text/html' })); window.open(u, '_blank'); };
    }
  });
})(window.ACE);
