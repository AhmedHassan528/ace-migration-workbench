/* Workflow controller: the processing pipeline, independent of the UI (also used by the tests).
 *  Workflow A: load -> inspect -> extract -> classify -> JAR analysis -> (decompile) -> ACE 12 export
 *  Workflow B: Workflow A -> Java 17 analysis -> ACE rules -> proposals -> (apply) -> (compile) -> ACE 13 export */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var wf = ACE.workflow = { state: { ws: null, file: null, docs: [], apiIndex: null, extraRules: [] } };

  wf.load = async function (file, opts) {
    opts = opts || {};
    var S = ACE.settings.current;
    var ws = await ACE.bar.load(file, { limits: ACE.settings.limits(), cancel: opts.cancel, progress: opts.progress });
    ws.decompiled = {}; ws.decompileAttempts = []; ws.ws12 = { overlay: {}, changelog: [] }; ws.ws13 = { overlay: {}, changelog: [] };
    wf.state.ws = ws; wf.state.file = file;
    if (ws.fatal) return ws;
    await ACE.jars.analyzeWorkspace(ws, S, { cancel: opts.cancel, progress: opts.progress });
    wf.analyze();
    return ws;
  };

  /* Re-run every analysis on the current workspace (cheap; no re-extraction). */
  wf.analyze = function () {
    var ws = wf.state.ws; if (!ws || ws.fatal) return;
    var S = ACE.settings.current;
    (ws.jars || []).forEach(function (j) { j.decision = ACE.jars.decide(j, S); });
    ws._layout = null;
    ws.facts = ACE.aceRules.buildFacts(ws);
    ws.java17 = ACE.java17.analyzeWorkspace(ws, { apiIndex: wf.state.apiIndex });
    var ruleSets = [window.ACE_ACE_RULES].concat(wf.state.extraRules || []);
    ws.ruleSetsUsed = ruleSets.map(function (r) { return { id: r.id, version: r.version, rules: (r.rules || []).length }; });
    ws.docsUsed = wf.state.docs;
    ws.aceFindings = [];
    ruleSets.forEach(function (rs) { ws.aceFindings = ws.aceFindings.concat(ACE.aceRules.evaluate(ws.facts, rs, ws, wf.state.docs)); });
    // Decisions already taken (applied / rejected) are kept; fresh proposals are computed for the rest.
    var decided = (ws.proposals || []).filter(function (p) { return p.status === 'applied' || p.status === 'rejected' || p.status === 'superseded'; });
    var fresh = ACE.transforms.propose(ws.java17.findings, wf.javaSources(ws)).filter(function (p) {
      return !decided.some(function (d) { return d.fixId === p.fixId && d.outPath === p.outPath; });
    });
    ws.proposals = decided.concat(fresh);
    ws.checklist = ACE.premigration.build(ws, ws.aceFindings, ws.java17);
    ACE.migScan.analyze(ws);
    ACE.emit('analysis-updated', ws);
  };

  /* Java sources that fixes may operate on (current ACE 13 text). */
  wf.javaSources = function (ws) {
    var out = [];
    Object.keys(ws.decompiled || {}).forEach(function (sha) {
      var d = ws.decompiled[sha];
      d.files.forEach(function (df) {
        var p = d.outputPrefix + df.path, ov = ws.ws13.overlay[p];
        out.push({ outPath: p, text: ov ? ov.text : df.text, findingFile: 'decompiled:' + d.jar + '/' + df.path, className: df.path.replace(/\.java$/, '').replace(/\//g, '.'), label: 'decompiled from ' + d.jar });
      });
    });
    var lay = ACE.project.layout(ws);
    lay.files.forEach(function (l) {
      var f = ws.files.filter(function (x) { return x.id === l.fileId; })[0];
      if (!f || f.ext !== 'java' || !f.bytes) return;
      var ov = ws.ws13.overlay[l.outPath];
      out.push({ outPath: l.outPath, text: ov ? ov.text : ACE.bar.text(f), findingFile: f.vpath, className: null, label: 'original source' });
    });
    return out;
  };

  function projectNameFor(ws, jr) {
    var base = util.stripExt(jr.name), taken = ACE.project.layout(ws).projects.map(function (p) { return p.name; });
    Object.keys(ws.decompiled || {}).forEach(function (k) { if (ws.decompiled[k].sha256 !== jr.sha256) taken.push(ws.decompiled[k].projectName); });
    var n = base; if (taken.indexOf(n) >= 0) n = base + '_decompiled';
    return n;
  }

  /* Run the built-in JavaScript decompiler on the selected JARs. Records, per JAR, the stage
   * results the UI reports separately: extracted, inspected, classes detected, source generated. */
  wf.decompile = async function (jarRecs, cancel, progress, projectNames) {
    var ws = wf.state.ws, out = [];
    for (var i = 0; i < jarRecs.length; i++) {
      if (cancel) cancel.check();
      var jr = jarRecs[i];
      if (progress) progress('decompile', i, jarRecs.length, jr.name);
      await util.yieldUI();
      var t0 = Date.now(), res;
      try { res = ACE.decompiler.decompileJar(jr.info, { cancel: cancel }); }
      catch (e) { if (util.isCancel(e)) throw e; ACE.log.error('Decompiler failed on ' + jr.name + ': ' + e.message); ws.decompileAttempts.push({ jar: jr.name, at: util.nowIso(), error: e.message }); continue; }
      var stats = { classes: jr.info.classCount, files: res.results.length, complete: 0, partial: 0, failed: 0, methods: 0, methodsFailed: 0 };
      res.results.forEach(function (r) { stats[r.status]++; stats.methods += r.methods.length; stats.methodsFailed += r.methods.filter(function (m) { return m.status !== 'ok'; }).length; });
      var rec = {
        jar: jr.name, sha256: jr.sha256, occurrences: jr.occurrences, engine: ACE.decompiler.name + ' ' + ACE.decompiler.version, mode: 'browser', at: util.nowIso(), ms: Date.now() - t0,
        results: res.results, skipped: res.skipped, stats: stats, scope: jr.classification.type === 'application' ? 'application' : 'dependency',
        files: res.results.filter(function (r) { return r.source; }).map(function (r) { return { path: r.path, text: r.source, status: r.status }; })
      };
      rec.projectName = (projectNames && projectNames[jr.sha256]) || projectNameFor(ws, jr);
      rec.outputPrefix = rec.projectName + '/src/';
      ws.decompiled[jr.sha256] = rec;
      ws.decompileAttempts.push({ jar: jr.name, at: rec.at, stats: stats });
      ACE.log[stats.complete === stats.files ? 'ok' : 'warn']('Decompiled ' + jr.name + ': ' + stats.classes + ' classes -> ' + stats.complete + ' complete, ' + stats.partial + ' partial, ' + stats.failed + ' failed source file(s); ' + (stats.methods - stats.methodsFailed) + '/' + stats.methods + ' methods recovered (' + rec.ms + ' ms)');
      out.push(rec);
    }
    if (progress) progress('decompile', jarRecs.length, jarRecs.length, '');
    wf.analyze();
    return out;
  };

  /* Genuine source supplied by the user (e.g. from source control) for a JAR: a ZIP or .java files.
   * Each file is matched to a class of the JAR by its package path; unmatched files are rejected. */
  wf.importSources = async function (jr, files) {
    var ws = wf.state.ws, list = [];
    for (var i = 0; i < files.length; i++) {
      var f = files[i], bytes = await util.readFileBytes(f);
      if (/\.(zip|jar)$/i.test(f.name)) {
        var arc = await ACE.zip.open(ACE.zip.bytesSource(bytes));
        for (var k = 0; k < arc.entries.length; k++) { var e = arc.entries[k]; if (!e.isDir && !e.unsafe && /\.java$/.test(e.path)) list.push({ path: e.path.replace(/^(.*\/)?src\//, ''), text: util.decodeText(await ACE.zip.extract(arc, e)).text }); }
      } else if (/\.java$/.test(f.name)) {
        var txt = util.decodeText(bytes).text, pkg = /\bpackage\s+([\w.]+)\s*;/.exec(txt);
        list.push({ path: (pkg ? pkg[1].replace(/\./g, '/') + '/' : '') + f.name, text: txt });
      }
    }
    var names = new Set(jr.info.classes.map(function (c) { return c.name + '.java'; }));
    var ok = list.filter(function (s) { return names.has(s.path); }), rejected = list.filter(function (s) { return !names.has(s.path); });
    if (!ok.length) return { accepted: 0, rejected: rejected.map(function (s) { return s.path; }) };
    var rec = { jar: jr.name, sha256: jr.sha256, occurrences: jr.occurrences, engine: 'source imported by the user (not decompiled)', mode: 'imported', at: util.nowIso(),
      results: ok.map(function (s) { return { className: s.path.replace(/\.java$/, ''), path: s.path, source: s.text, status: 'complete', methods: [], notes: ['imported source file'] }; }),
      stats: { classes: jr.info.classCount, files: ok.length, complete: ok.length, partial: 0, failed: 0, methods: 0, methodsFailed: 0 }, scope: 'application',
      files: ok.map(function (s) { return { path: s.path, text: s.text, status: 'complete' }; }) };
    rec.projectName = projectNameFor(ws, jr); rec.outputPrefix = rec.projectName + '/src/';
    ws.decompiled[jr.sha256] = rec;
    ACE.log.ok('Imported ' + ok.length + ' source file(s) for ' + jr.name + (rejected.length ? '; ' + rejected.length + ' file(s) did not match any class and were ignored' : ''));
    wf.analyze();
    return { accepted: ok.length, rejected: rejected.map(function (s) { return s.path; }) };
  };

  wf.reportsFor = function (ws, target) {
    var r = {
      'EXTRACTION-REPORT.json': JSON.stringify(ACE.reports.extraction(ws), null, 2),
      'DECOMPILATION-REPORT.json': JSON.stringify(ACE.reports.decompilation(ws), null, 2),
      'EXCLUDED-JARS.json': JSON.stringify(ACE.reports.exclusions(ws), null, 2),
      'REPORT.html': ACE.reports.html(ws)
    };
    if (target === 'ace13') {
      r['COMPATIBILITY-REPORT.json'] = JSON.stringify(ACE.reports.compatibility(ws), null, 2);
      r['MIGRATION-REPORT.json'] = JSON.stringify(ACE.reports.migration(ws), null, 2);
      r['MIGRATION-REPORT.md'] = ACE.reports.migrationText(ws);
      r['MIGRATION-CHECKLIST.txt'] = ACE.reports.checklistText(ws);
      r['CHANGE-LOG.txt'] = ACE.reports.changeLogText(ws);
    }
    return r;
  };

  wf.exportPackage = async function (target, progress, cancel) {
    var ws = wf.state.ws, S = ACE.settings.current;
    var res = await ACE.project.buildPackage(ws, target, { facts: ws.facts, reports: wf.reportsFor(ws, target), includeOriginalBar: S.export.includeOriginalBar, barFile: wf.state.file, keepOriginalJar: S.project.keepOriginalJar, libIncludeExcluded: S.project.libIncludeExcluded, decompileHeader: S.export.decompileHeader, progress: progress, cancel: cancel });
    ACE.log.ok('Built ' + target.toUpperCase() + ' package: ' + res.manifest.files.length + ' entries, ' + util.fmtBytes(res.blob.size));
    return res;
  };
})(window.ACE);
