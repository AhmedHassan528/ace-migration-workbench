/* Report generation: JSON (machine-readable) and standalone HTML (no external resources). */
(function (ACE) {
  'use strict';
  var util = ACE.util, esc = util.esc;
  var rep = ACE.reports = {};

  function header(ws) {
    return { tool: 'IBM ACE Migration Workbench', toolVersion: util.VERSION, generatedAt: util.nowIso(),
      bar: { name: ws.barName, size: ws.barSize, sha256: ws.barSha256, lastModified: ws.barLastModified },
      input: { kind: ws.inputKind || 'bar' },
      versions: { mode: window.ACE_VERSIONS.mode, source: window.ACE_VERSIONS.source, target: window.ACE_VERSIONS.target },
      assumptions: { sourceRuntime: window.ACE_VERSIONS.sourceLabel + ' / IBM Java 8 (strict source version; ' + (ws.migration ? ws.migration.versions.statement : 'no version evidence evaluated') + ')', targetRuntime: window.ACE_VERSIONS.targetLabel + ' / Java 17 (ACE 13 default; Java 8 also supplied)' },
      environment: util.capabilities() };
  }

  rep.extraction = function (ws) {
    return Object.assign(header(ws), {
      report: 'extraction', complete: ws.complete, fatal: ws.fatal || null, stats: ws.stats,
      containers: ws.containers.map(function (c) { return { vpath: c.vpath || '(BAR root)', name: c.name, type: c.type, depth: c.depth, entries: c.entryCount, backslashNames: c.backslashNames, issues: c.issues }; }),
      deployables: (ws.model ? ws.model.deployables : []).map(function (d) { return { name: d.name, type: d.type, vpath: d.vpath, descriptor: !!d.descriptor, overrides: d.brokerXml ? d.brokerXml.parsed.properties.filter(function (p) { return p.override != null; }).length : 0 }; }),
      buildEvidence: ws.model ? ws.model.buildEvidence : [], modelWarnings: ws.model ? ws.model.warnings : [],
      rejected: ws.rejected, issues: ws.issues,
      files: ws.files.map(function (f) { return { vpath: f.vpath, rawName: f.rawName, size: f.size, compressedSize: f.compressedSize, method: f.method, crc32: (f.crc >>> 0).toString(16), sha256: f.sha256, mtime: f.mtime, kind: f.cls && f.cls.label, category: f.cls && f.cls.category, extracted: f.extracted, error: f.extractError || null, issues: f.issues.filter(function (i) { return i.severity !== 'info'; }) }; })
    });
  };

  rep.decompilation = function (ws) {
    return Object.assign(header(ws), {
      report: 'decompilation',
      note: 'Decompiled code is reconstructed from bytecode by the built-in JavaScript decompiler (not Fernflower). It is not the original source; local names come from debug information when present.',
      jars: (ws.jars || []).map(function (j) {
        var d = ws.decompiled && ws.decompiled[j.sha256];
        return { name: j.name, sha256: j.sha256, size: j.size, occurrences: j.occurrences, classes: j.info.classCount, classVersions: j.info.versions, nestedJars: j.info.nestedJars, manifest: j.info.manifest ? j.info.manifest.main : null,
          classification: j.classification, decision: j.decision,
          result: d ? { engine: d.engine, mode: d.mode, at: d.at, stats: d.stats, project: d.projectName, classes: d.results.map(function (r) { return { className: r.className, path: r.path, status: r.status, notes: r.notes, methodsNotRecovered: r.methods.filter(function (m) { return m.status !== 'ok'; }).map(function (m) { return m.name + m.desc + ': ' + m.reason; }) }; }) } : { status: 'NOT PERFORMED' } };
      }),
      attempts: ws.decompileAttempts || []
    });
  };

  rep.exclusions = function (ws) {
    return Object.assign(header(ws), { report: 'driver-and-exclusion-list',
      excluded: (ws.jars || []).filter(function (j) { return !j.decision.selected; }).map(function (j) { return { name: j.name, sha256: j.sha256, type: j.classification.type, driver: j.classification.driverName || null, reason: j.decision.reason, evidence: j.classification.evidence, preservedAt: j.occurrences }; }) });
  };

  rep.compatibility = function (ws) {
    return Object.assign(header(ws), { report: 'java17-compatibility', disclaimer: ws.java17 ? ws.java17.disclaimer : null, summary: ws.java17 ? ws.java17.summary : null, ruleSet: ws.java17 ? ws.java17.ruleSet : null, findings: ws.java17 ? ws.java17.findings : [], compileCheck: 'not performed (browser-only workbench has no Java compiler)' });
  };

  rep.migration = function (ws) {
    return Object.assign(header(ws), { report: 'ace13-migration',
      disclaimer: 'Static analysis cannot prove runtime compatibility. Every result must be confirmed in the ' + window.ACE_VERSIONS.targetLabel + ' Toolkit and on an ACE ' + window.ACE_VERSIONS.target + ' integration server.',
      versionFacts: window.ACE_VERSIONS.facts,
      classification: ws.migration ? { legend: ACE.migScan.CLASSES, counts: ws.migration.counts, findings: ws.migration.findings } : null,
      dependencies: ws.migration ? ws.migration.dependencies : null, runtime: ws.migration ? ws.migration.runtime : null,
      scannedArtifacts: ws.migration ? { summary: ws.migration.artifacts.summary, files: ws.migration.artifacts.files, notFound: ws.migration.artifacts.notFound, generatedCode: ws.migration.artifacts.generatedCode } : null,
      concurrency: ws.migration ? { instances: ws.migration.concurrency.instances, java: ws.migration.concurrency.java, esql: ws.migration.concurrency.esql } : null,
      unresolvedRisks: ws.migration ? ws.migration.unresolvedRisks : [], unverifiedAssumptions: ws.migration ? ws.migration.unverifiedAssumptions : [],
      validation: rep.validation(ws),
      importedDocs: (ws.docsUsed || []).map(function (d) { return { name: d.name, size: d.text.length, importedAt: d.importedAt }; }),
      ruleSets: ws.ruleSetsUsed || [], facts: ws.facts ? { stats: ws.facts.stats, dataSources: ws.facts.dataSources, endpoints: ws.facts.endpoints, policyRefs: ws.facts.policyRefs, missingPolicyProjects: ws.facts.missingPolicyProjects, unresolved: ws.facts.unresolved, filePaths: ws.facts.filePaths } : null,
      findings: ws.aceFindings || [],
      changeLog: rep.changeLog(ws), proposals: (ws.proposals || []).map(function (p) { return { fixId: p.fixId, outPath: p.outPath, status: p.status, reason: p.reason, notes: p.notes }; }) });
  };

  /* What was and was not validated. Only checks this tool actually performs are listed as performed. */
  rep.validation = function (ws) {
    var tests = ws.files.some(function (f) { return /(^|\/)(test|tests)\//i.test(f.path) || /Test\.java$/.test(f.path); });
    return {
      performedInTool: ['ZIP structure and CRC-32 of every extracted entry (' + ws.files.filter(function (f) { return f.extracted; }).length + ' entries)', 'Static analysis: Java source/bytecode rules, ACE flow/ESQL rules, dependency, configuration and concurrency scans', 'Every exported ZIP is re-read and byte-compared before it is offered for download', 'Approved fixes are re-checked: the working copy is re-analysed and the fixed rule must no longer match'],
      notPerformed: ['Java compilation (no compiler in the browser; use the ' + window.ACE_VERSIONS.targetLabel + ' Toolkit)', 'ESQL compilation and message flow validation', 'BAR build, deployment and runtime tests on ' + window.ACE_VERSIONS.target, tests ? 'Test sources were found in the input but cannot be run in the browser' : 'Application unit/regression tests: none are contained in the input']
    };
  };

  /* Human-readable migration report (Markdown). */
  rep.migrationText = function (ws) {
    var V = window.ACE_VERSIONS, m = ws.migration, L = [], FENCE = '```';
    L.push('# ACE ' + V.source + ' to ' + V.target + ' migration report', '', '- Input: `' + ws.barName + '` (' + (ws.inputKind === 'workspace' ? 'Toolkit workspace ZIP' : 'BAR file') + ', sha256 `' + (ws.barSha256 || 'n/a') + '`)', '- Generated: ' + util.nowIso() + ' by IBM ACE Migration Workbench ' + util.VERSION, '- Version mode: **' + V.mode + '** - source ' + V.sourceLabel + ', target ' + V.targetLabel, '- Version evidence: ' + (m ? m.versions.statement : 'n/a'), '');
    L.push('> Static analysis cannot prove runtime compatibility. Nothing in this report is a compatibility guarantee.', '');
    if (!m) return L.join('\n');
    L.push('## 1. Summary', '', '| Classification | Findings |', '|---|---|');
    ACE.migScan.CLASSES.forEach(function (c) { L.push('| ' + c + ' | ' + m.counts[c] + ' |'); });
    L.push('', 'High-risk items still open: **' + m.unresolvedRisks.length + '**', '');
    L.push('## 2. Projects and dependencies', '');
    m.dependencies.projects.forEach(function (p) { L.push('- **' + p.project + '** (' + p.type + ', metadata ' + p.metadata + ')' + (p.references.length ? ' - references: ' + p.references.join(', ') : '')); });
    L.push('', '| JAR | Type | Copies | Version | On build path | Referenced by |', '|---|---|---|---|---|---|');
    m.dependencies.jars.forEach(function (j) { L.push('| ' + j.name + ' | ' + j.type + (j.driver ? ' (' + j.driver + ')' : '') + ' | ' + j.copies + ' | ' + (j.implementationVersion || j.createdBy || '-') + ' | ' + (j.onBuildPath.length ? 'yes' : 'no') + ' | ' + (j.referencedBy.length ? j.referencedBy.join(', ') : 'nothing in the input') + ' |'); });
    L.push('', '## 3. Java runtime', '');
    if (!m.runtime.projects.length) L.push('No Java project in the input.');
    m.runtime.projects.forEach(function (p) { L.push('- ' + p.project + ': compiler compliance ' + (p.compliance || 'NOT RECORDED')); });
    L.push('', '## 4. Scanned artifacts', '');
    m.artifacts.summary.forEach(function (s) { L.push('- ' + s.category + ': ' + s.count); });
    if (m.artifacts.notFound.length) L.push('', 'Not present in the input (nothing to migrate for these): ' + m.artifacts.notFound.join(', ') + '.');
    L.push('', '## 5. Findings', '');
    m.findings.forEach(function (f, i) {
      L.push('### ' + (i + 1) + '. [' + f.classification + '] ' + f.title, '', '- Rule: `' + f.ruleId + '` - risk **' + f.risk + '**, confidence ' + f.confidence + ', basis: ' + f.evidenceStatus);
      f.locations.slice(0, 8).forEach(function (l) { if (l.file) L.push('- Location: `' + l.file + (l.line ? ':' + l.line : '') + '`'); });
      if (f.locations.length > 8) L.push('- ... ' + (f.locations.length - 8) + ' more location(s)');
      L.push('- Why: ' + f.why, '- Recommended action: ' + f.action);
      f.docUrls.forEach(function (u) { L.push('- Documentation: ' + u); });
      if (f.assumption) L.push('- Unverified assumption: ' + f.assumption);
      if (f.note) L.push('- Note: ' + f.note);
      if (f.autoFixOptions && f.autoFixOptions.length) {
        L.push('- Suggested solution' + (f.autoFixOptions.length > 1 ? 's (choose one)' : '') + ':');
        f.autoFixOptions.forEach(function (o) { L.push('  - **' + o.title + '**' + (o.recommended ? ' (recommended)' : '') + ' - status: ' + o.status + (o.when ? '. When to choose: ' + o.when : '')); });
      } else if (f.autoFix) L.push('- Automatic fix: ' + f.autoFix.fixId + ' (' + f.autoFix.status + ')');
      if (f.diff) L.push('', FENCE + 'diff', f.diff, FENCE);
      L.push('');
    });
    L.push('## 6. Unresolved risks', '');
    if (!m.unresolvedRisks.length) L.push('None of high risk.');
    m.unresolvedRisks.forEach(function (r) { L.push('- [' + r.classification + '] ' + r.title + (r.location && r.location.file ? ' (`' + r.location.file + (r.location.line ? ':' + r.location.line : '') + '`)' : '')); });
    L.push('', '## 7. Unverified assumptions', '');
    m.unverifiedAssumptions.forEach(function (a) { L.push('- ' + a); });
    var v = rep.validation(ws);
    L.push('', '## 8. Validation', '', 'Performed by this tool:'); v.performedInTool.forEach(function (x) { L.push('- ' + x); });
    L.push('', 'NOT performed:'); v.notPerformed.forEach(function (x) { L.push('- ' + x); });
    L.push('', '## 9. Changes and rollback', '');
    var cl = rep.changeLog(ws);
    if (!cl.length) L.push('No changes applied. All exported files are original.');
    else { cl.forEach(function (e) { L.push('- ' + e.action + ' ' + e.path + ': ' + e.title); }); L.push('', 'Rollback: every changed file is exported unchanged under `_original-before-changes/`; in the tool, use Undo in the ACE 13 Migration view.'); }
    L.push('', '## 10. IBM documentation used', '');
    V.facts.forEach(function (x) { L.push('- ' + x.text + ' - ' + x.url); });
    return L.join('\n') + '\n';
  };

  rep.changeLog = function (ws) {
    var out = [];
    ['ws12', 'ws13'].forEach(function (c) { ((ws[c] && ws[c].changelog) || []).forEach(function (e) { out.push({ copy: c === 'ws12' ? 'ACE 12 working copy' : 'ACE 13 working copy', t: e.t, path: e.path, action: e.action, kind: e.kind, title: e.title, fixId: e.fixId || null, ruleId: e.ruleId || null, notes: e.notes || [], unifiedDiff: e.unified || null }); }); });
    return out;
  };

  rep.changeLogText = function (ws) {
    var L = ['MIGRATION CHANGE LOG', '====================', 'BAR: ' + ws.barName + '   generated ' + util.nowIso(), ''];
    var cl = rep.changeLog(ws);
    if (!cl.length) L.push('No changes have been applied. All exported files are original (or decompiled) content.');
    cl.forEach(function (e, i) {
      L.push((i + 1) + '. [' + e.t + '] ' + e.copy + ' - ' + e.action.toUpperCase() + ' - ' + e.path, '   ' + e.title + (e.fixId ? ' (fix ' + e.fixId + ', rule ' + e.ruleId + ')' : ''));
      (e.notes || []).forEach(function (n) { L.push('   - ' + n); });
      if (e.unifiedDiff) L.push('', e.unifiedDiff.split('\n').map(function (x) { return '   ' + x; }).join('\n'));
      L.push('');
    });
    return L.join('\r\n');
  };

  /* ---------- HTML ---------- */
  var CSS = 'body{font:14px/1.45 Segoe UI,Arial,sans-serif;margin:24px;color:#1b1f24;background:#fff}h1{font-size:22px}h2{font-size:17px;margin-top:28px;border-bottom:1px solid #ccd;padding-bottom:4px}table{border-collapse:collapse;width:100%;margin:8px 0}td,th{border:1px solid #d5d9de;padding:4px 6px;vertical-align:top;text-align:left;font-size:13px}th{background:#f1f3f5}code,pre{font:12px Consolas,monospace}pre{background:#f6f8fa;padding:8px;overflow:auto;white-space:pre-wrap}.Error,.fail{color:#a40e26;font-weight:600}.Warning,.attention{color:#8a5300;font-weight:600}.Manual{color:#5b3ea6;font-weight:600}.pass{color:#1a7f37;font-weight:600}.muted{color:#667}.box{border:1px solid #d5d9de;border-radius:6px;padding:10px;margin:8px 0;background:#fafbfc}';

  function table(rows, cols) {
    var h = '<table><tr>' + cols.map(function (c) { return '<th>' + esc(c[0]) + '</th>'; }).join('') + '</tr>';
    rows.forEach(function (r) { h += '<tr>' + cols.map(function (c) { var v = c[1](r); return '<td' + (c[2] ? ' class="' + esc(c[2](r)) + '"' : '') + '>' + (v == null ? '' : v) + '</td>'; }).join('') + '</tr>'; });
    return h + '</table>';
  }

  rep.html = function (ws) {
    var ex = rep.extraction(ws), dc = rep.decompilation(ws), cp = rep.compatibility(ws), mg = rep.migration(ws);
    var h = '<!doctype html><html><head><meta charset="utf-8"><title>ACE Migration Report - ' + esc(ws.barName) + '</title><style>' + CSS + '</style></head><body>';
    h += '<h1>IBM ACE Migration Workbench report</h1><div class="box">BAR <b>' + esc(ws.barName) + '</b> (' + util.fmtBytes(ws.barSize) + ', sha256 <code>' + esc(ws.barSha256 || 'n/a') + '</code>)<br>Generated ' + esc(ex.generatedAt) + ' by workbench ' + esc(util.VERSION) + '<br>Source: ' + esc(ex.assumptions.sourceRuntime) + '<br>Target: ' + esc(ex.assumptions.targetRuntime) + '<br><b>' + esc(mg.disclaimer) + '</b></div>';
    h += '<h2>1. Extraction</h2><p>Status: <b class="' + (ws.complete ? 'pass' : 'fail') + '">' + (ws.complete ? 'COMPLETE' : 'INCOMPLETE') + '</b> - ' + ws.files.length + ' files, ' + ws.containers.length + ' containers, ' + ws.rejected.length + ' rejected unsafe entries, ' + util.fmtBytes(ws.totalExtracted) + ' extracted.</p>';
    h += table(ex.containers, [['Container', function (c) { return esc(c.vpath); }], ['Type', function (c) { return esc(c.type); }], ['Entries', function (c) { return c.entries; }], ['Notes', function (c) { return esc((c.backslashNames ? 'backslash separators; ' : '') + c.issues.map(function (i) { return i.message; }).join('; ')); }]]);
    h += '<h3>Build evidence</h3><ul>' + ex.buildEvidence.map(function (b) { return '<li>' + esc(b.text) + ' <span class="muted">(' + esc(b.source) + ')</span></li>'; }).join('') + '</ul>';
    var cats = ws.stats.byCategory;
    h += '<p>By category: ' + Object.keys(cats).map(function (k) { return esc((ACE.classify.CATEGORY_LABELS[k] || k) + ': ' + cats[k]); }).join(', ') + '</p>';
    if (ws.issues.filter(function (i) { return i.severity !== 'info'; }).length) h += '<h3>Issues</h3>' + table(ws.issues.filter(function (i) { return i.severity !== 'info'; }), [['Severity', function (i) { return esc(i.severity); }], ['Message', function (i) { return esc(i.message); }], ['Where', function (i) { return esc(i.where); }]]);
    h += '<h2>2. Java archives and decompilation</h2><p class="muted">' + esc(dc.note) + '</p>' + table(dc.jars, [['JAR', function (j) { return '<b>' + esc(j.name) + '</b><br><span class="muted">' + esc(j.occurrences.length + ' occurrence(s)') + '</span>'; }], ['Classification', function (j) { return esc(j.classification.type + (j.classification.driverName ? ' - ' + j.classification.driverName : '')) + '<br><span class="muted">' + esc(j.classification.evidence.join('; ')) + '</span>'; }], ['Classes / bytecode', function (j) { return j.classes + '<br>' + esc(Object.keys(j.classVersions).map(function (v) { return 'Java ' + ACE.java.javaVersionOf(Number(v)) + ' x' + j.classVersions[v]; }).join(', ')); }], ['Decision', function (j) { return esc((j.decision.selected ? 'SELECTED' : 'EXCLUDED') + ': ' + (j.decision.reason || 'application code')); }], ['Result', function (j) { var r = j.result; return r.status ? '<b>' + esc(r.status) + '</b>' : esc(r.mode + ', exit ' + r.exitCode + ', ' + r.files + ' .java file(s)' + (r.missing && r.missing.length ? ', MISSING: ' + r.missing.join(', ') : '') + (r.error ? ', ERROR: ' + r.error : '')); }]]);
    h += '<h2>3. Java 8 to 17 compatibility</h2>';
    if (cp.summary) h += '<p>' + cp.summary.classesAnalysed + ' classes in ' + cp.summary.jarsAnalysed + ' JAR(s), ' + cp.summary.sourcesAnalysed + ' source file(s). Application bytecode targets: ' + esc(JSON.stringify(cp.summary.applicationTargets)) + '</p>';
    h += table(cp.findings, [['Severity', function (f) { return esc(f.severity); }, function (f) { return f.severity.split(' ')[0]; }], ['Finding', function (f) { return '<b>' + esc(f.title) + '</b> <code>' + esc(f.ruleId) + '</code><br>' + esc(f.why) + (f.note ? '<br><i>' + esc(f.note) + '</i>' : ''); }], ['Location', function (f) { return '<code>' + esc(f.file) + (f.line ? ':' + f.line : '') + '</code><br><span class="muted">' + esc(f.source + ', scope ' + f.scope) + '</span>'; }], ['Evidence', function (f) { return esc(f.evidence.join('; ')); }], ['Action', function (f) { return esc(f.action) + '<br><span class="muted">Auto-fix: ' + (f.autofixAvailable ? 'yes (' + esc(f.autofix) + ')' : 'no') + '</span>'; }], ['Basis', function (f) { return esc(f.status + ', confidence ' + f.confidence) + '<br>' + (f.refs || []).map(function (r) { return '<a href="' + esc(r.url) + '">' + esc(r.title) + '</a>'; }).join('<br>'); }]]);
    h += '<h2>4. ACE 12 to 13 migration findings</h2><p>Imported documentation: ' + (mg.importedDocs.length ? esc(mg.importedDocs.map(function (d) { return d.name; }).join(', ')) : '<b>none</b> - documented rules are marked UNVERIFIED offline') + '</p>';
    h += table(mg.findings, [['Severity', function (f) { return esc(f.severity) + (f.blocker ? '<br><b>BLOCKER</b>' : ''); }, function (f) { return f.severity.split(' ')[0]; }], ['Finding', function (f) { return '<b>' + esc(f.title) + '</b> <code>' + esc(f.ruleId) + '</code><br>' + esc(f.why); }], ['Evidence', function (f) { return f.evidence.map(function (e) { return esc(e.text) + (e.where ? ' <span class="muted">[' + esc(e.where) + (e.line ? ':' + e.line : '') + ']</span>' : ''); }).join('<br>'); }], ['Action', function (f) { return esc(f.action); }], ['Basis', function (f) { return esc(f.status) + '<br><span class="muted">' + esc(f.docVerification.text) + '</span><br>' + f.refs.map(function (r) { return '<a href="' + esc(r.url) + '">' + esc(r.title) + '</a>'; }).join('<br>'); }]]);
    if (mg.classification) {
      h += '<h2>4b. Classified findings (ACE ' + esc(mg.versions.source) + ' to ' + esc(mg.versions.target) + ')</h2><p>' + mg.classification.legend.map(function (c) { return esc(c) + ': <b>' + mg.classification.counts[c] + '</b>'; }).join(' &middot; ') + '</p>';
      h += table(mg.classification.findings, [['Class / risk', function (f) { return '<b>' + esc(f.classification) + '</b><br>risk ' + esc(f.risk) + ', confidence ' + esc(f.confidence); }], ['Finding', function (f) { return '<b>' + esc(f.title) + '</b> <code>' + esc(f.ruleId) + '</code><br>' + esc(f.why) + (f.assumption ? '<br><i>Unverified assumption: ' + esc(f.assumption) + '</i>' : ''); }], ['Location', function (f) { return f.locations.slice(0, 6).map(function (l) { return '<code>' + esc((l.file || '') + (l.line ? ':' + l.line : '')) + '</code>'; }).join('<br>'); }], ['Action', function (f) { return esc(f.action) + (f.diff ? '<pre>' + esc(f.diff) + '</pre>' : ''); }], ['Docs', function (f) { return f.docUrls.map(function (u) { return '<a href="' + esc(u) + '">' + esc(u.replace(/^https:\/\/(www\.)?/, '').slice(0, 60)) + '</a>'; }).join('<br>'); }]]);
      h += '<h3>Unresolved risks</h3>' + (mg.unresolvedRisks.length ? '<ul>' + mg.unresolvedRisks.map(function (r) { return '<li>[' + esc(r.classification) + '] ' + esc(r.title) + '</li>'; }).join('') + '</ul>' : '<p>None of high risk.</p>');
      h += '<h3>Unverified assumptions</h3><ul>' + mg.unverifiedAssumptions.map(function (a) { return '<li>' + esc(a) + '</li>'; }).join('') + '</ul>';
    }
    h += '<h2>5. Change log</h2>' + (mg.changeLog.length ? mg.changeLog.map(function (e) { return '<div class="box"><b>' + esc(e.action.toUpperCase() + ' ' + e.path) + '</b> - ' + esc(e.title) + ' <span class="muted">' + esc(e.copy + ', ' + e.t) + '</span>' + (e.notes.length ? '<ul>' + e.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>' : '') + (e.unifiedDiff ? '<pre>' + esc(e.unifiedDiff) + '</pre>' : '') + '</div>'; }).join('') : '<p>No changes applied.</p>');
    h += '<h2>6. Not verified by this tool</h2><ul><li>Import and build in the IBM ACE Toolkit (12 or 13)</li><li>ESQL compilation and flow validation</li><li>Deployment and runtime behaviour on ACE ' + esc(window.ACE_VERSIONS.target) + ' / Java 17</li><li>Equivalence of decompiled Java with the original source</li></ul>';
    return h + '</body></html>';
  };
})(window.ACE);
