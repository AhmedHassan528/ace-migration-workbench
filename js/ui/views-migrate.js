/* Page 2: IBM App Connect 13 Migration. Input: source code (a Toolkit workspace ZIP or folder; not a BAR or a JAR) on this page only. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;
  var fixOpen = {}, jFilter = 'application';

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
          try { ACE.transforms.apply(ws, p); V.ctl.analyze(); UI.refresh(); }
          catch (e) { UI.refresh(); UI.notify('The change was not applied: ' + e.message); }
        }, { ok: 'Accept and replace' });
      };
      var r = UI.$('.fxReject', card); if (r) r.onclick = function () { p.status = 'rejected'; ws.ws13.changelog.push({ t: util.nowIso(), path: p.outPath, action: 'rejected', kind: 'autofix', fixId: p.fixId, ruleId: p.ruleId, title: 'Rejected: ' + p.title }); ACE.log.info('Rejected fix ' + p.fixId + ' for ' + p.outPath); UI.refresh(); };
      var u = UI.$('.fxUndo', card); if (u) u.onclick = function () { ACE.transforms.undo(ws, 'ws13', p.outPath); V.ctl.analyze(); UI.refresh(); };
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

  var V = {
    input: { title: 'Source code', hint: 'A Toolkit workspace ZIP or folder. Several ZIPs (for example the applications and the libraries they use) are combined. A BAR or a JAR is not accepted here.', accept: '.zip', multiple: true, folder: true, kind: 'workspace', reject: /[.](bar|jar|appzip|libzip|shlibzip)$/i, rejectWhy: 'this page migrates source code, not a BAR or a JAR' },
    render: function (st) {
      var ws = st.ws;
      if (!ws) return '<h1>IBM App Connect 13 Migration</h1><p class="lead">Takes source code and checks it for ACE ' + esc(window.ACE_VERSIONS.source) + ' &rarr; ' + esc(window.ACE_VERSIONS.target) + ' (Java 8 &rarr; 17). Fixes are only proposed; each one shows its change and must be accepted.</p>' + UI.inputHtml(V);
      var j = ws.java17;
      var h = '<h1>IBM App Connect 13 Migration</h1><p class="lead">Java 8 → 17 analysis (bytecode and source) and ACE 12 → 13 rule checks. Fixes are only <b>proposed</b>; each shows its diff and must be confirmed. Applied fixes change only the ACE 13 working copy, keep the original, can be undone, and go into the change log. <b>' + esc(j.disclaimer) + '</b></p>';
      h += UI.inputHtml(V) + migrationSection(ws);
      h += '<h2>Java 8 → 17 (' + j.findings.length + ' findings)</h2><p class="small">' + j.summary.classesAnalysed + ' classes in ' + j.summary.jarsAnalysed + ' JAR(s) and ' + j.summary.sourcesAnalysed + ' source file(s). Application bytecode: ' + esc(Object.keys(j.summary.applicationTargets).map(function (k) { return 'Java ' + k + ' ×' + j.summary.applicationTargets[k]; }).join(', ') || 'none') + '.</p>';
      h += '<div class="row">Show: <select id="jScope"><option value="application"' + (jFilter === 'application' ? ' selected' : '') + '>application code</option><option value="dependency"' + (jFilter === 'dependency' ? ' selected' : '') + '>dependency / driver JARs</option><option value="all"' + (jFilter === 'all' ? ' selected' : '') + '>all</option></select> ' + UI.sevCounts(j.findings.filter(function (f) { return jFilter === 'all' || f.scope === jFilter; })) + '</div>';
      h += UI.findingsTable(j.findings.filter(function (f) { return jFilter === 'all' || f.scope === jFilter; }));
      h += '<h2>All suggested solutions</h2>';
      var props = ws.proposals || [];
      if (!props.length) h += '<p class="muted">No automatic fixes apply.' + '' + '</p>';
      props.forEach(function (p) { h += proposalCard(p, false); });
      h += '<h2>Java 17 compilation</h2><div class="banner">Not performed: a browser-only workbench has no Java compiler. The findings above are static analysis. Import the exported project into the ACE 13 Toolkit to compile and test it.</div>';
      var a = ws.aceFindings || [];
      h += '<h2>ACE 12 → 13 rule findings (' + a.length + ')</h2><p class="small">' + UI.sevCounts(a) + '. Rule sets: ' + esc(ws.ruleSetsUsed.map(function (r) { return r.id + ' v' + r.version + ' (' + r.rules + ' rules)'; }).join(', ')) + '. Rules that IBM documents are marked UNVERIFIED because the IBM documentation is not available offline.</p>';
      h += UI.findingsTable(a);
      h += '<h2>Export</h2>' + UI.exportCard(V.ctl, 'ace13');
      return h;
    },
    bind: function (el, st) {
      UI.bindInput(el, V);
      if (!st.ws) return;
      var ws = st.ws;
      bindMigration(el);
      UI.$('#jScope', el).onchange = function (e) { jFilter = e.target.value; UI.refresh(); };
      bindProposals(el, ws);
      UI.bindExport(el, V.ctl, 'ace13');
    }
  };
  UI.register('migrate13', V);
})(window.ACE);
