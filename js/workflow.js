/* Workflow controller: the processing pipeline, independent of the UI (also used by the tests).
 *
 * Every feature page creates its OWN controller with ACE.workflow.create(): its own input (workspace),
 * its own options (JAR overrides, export options, library-conversion settings) and its own analysis.
 * Nothing is shared between controllers, so loading a file on one page never changes another page.
 * ACE.workflow itself is one more controller that reads the global defaults; the test suite uses it.
 *
 *  BAR Export:  load BAR -> extract -> classify -> JAR analysis -> (decompile Java) -> ACE 12 export
 *  Migration:   load source code -> Java 17 analysis + ACE rules -> proposals -> (apply) -> ACE 13 export
 *  Libraries:   load source code -> library-conversion plan -> (convert) -> export */
(function (ACE) {
  'use strict';
  var util = ACE.util;

  function create(opts) {
    opts = opts || {};
    var legacy = !!opts.legacy;   // the default controller falls back to the global settings
    var wf = { state: { ws: null, file: null, docs: [], extraRules: [],
      jarOverrides: legacy ? null : {}, exportOpts: legacy ? null : { includeOriginalBar: true, decompileHeader: true }, libconv: null } };

    /* Settings seen by this controller: the global defaults plus this controller's own overrides. */
    function cfg() {
      var S = ACE.settings.current;
      return wf.state.jarOverrides ? Object.assign({}, S, { jarOverrides: wf.state.jarOverrides }) : S;
    }
    wf.settings = cfg;
    wf.libconvConfig = function () { return wf.state.libconv || (legacy ? ACE.settings.current.libraryConversion : null); };

    wf.load = async function (file, o) {
      o = o || {};
      var ws = await ACE.bar.load(file, { limits: ACE.settings.limits(), cancel: o.cancel, progress: o.progress });
      ws.decompiled = {}; ws.decompileAttempts = []; ws.ws12 = { overlay: {}, changelog: [] }; ws.ws13 = { overlay: {}, changelog: [] };
      wf.state.ws = ws; wf.state.file = file;
      if (ws.fatal) return ws;
      await ACE.jars.analyzeWorkspace(ws, cfg(), { cancel: o.cancel, progress: o.progress });
      wf.analyze();
      return ws;
    };

    /* Forget the loaded input (a rejected file must not leave a half-loaded workspace behind). */
    wf.clear = function () { wf.state.ws = null; wf.state.file = null; };

    /* Re-run every analysis on the current workspace (cheap; no re-extraction). */
    wf.analyze = function () {
      var ws = wf.state.ws; if (!ws || ws.fatal) return;
      var S = cfg();
      (ws.jars || []).forEach(function (j) { j.decision = ACE.jars.decide(j, S); });
      ws._layout = null;
      ws.facts = ACE.aceRules.buildFacts(ws);
      ws.java17 = ACE.java17.analyzeWorkspace(ws, {});
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
      ACE.migScan.analyze(ws);
      // Static-to-shared library conversion: analysed (planned) only on the page that owns it; applied on request.
      var lcCfg = wf.libconvConfig();
      ws.libConversion = lcCfg && lcCfg.enabled ? ACE.libconv.run(ws, lcCfg, { apply: false }) : null;
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

    /* Run the library conversion on the configured target working copies (idempotent; returns the run report). */
    wf.convertLibraries = function () {
      var ws = wf.state.ws, c = wf.libconvConfig();
      if (!c || !c.enabled) throw new Error('Library conversion is disabled.');
      var run = ACE.libconv.run(ws, c, { apply: true });
      ws.libConversionRun = run;
      wf.analyze();
      return run;
    };
    wf.undoLibraryConversion = function () {
      var ws = wf.state.ws, n = ACE.libconv.undo(ws, 'ws12') + ACE.libconv.undo(ws, 'ws13');
      ws.libConversionRun = null;
      wf.analyze();
      return n;
    };
    /* The conversion report for an export: the last applied run, else the current plan. */
    wf.libraryConversionReport = function (ws, target) {
      var run = ws.libConversionRun || ws.libConversion;
      if (!run) return null;
      var t = Object.assign({}, run, { targets: run.targets.filter(function (x) { return !target || x.target === target; }) });
      return t.targets.length || !run.enabled ? t : null;
    };

    wf.reportsFor = function (ws, target) {
      var r = {
        'EXTRACTION-REPORT.json': JSON.stringify(ACE.reports.extraction(ws), null, 2),
        'DECOMPILATION-REPORT.json': JSON.stringify(ACE.reports.decompilation(ws), null, 2),
        'EXCLUDED-JARS.json': JSON.stringify(ACE.reports.exclusions(ws), null, 2),
        'REPORT.html': ACE.reports.html(ws)
      };
      var lc = wf.libraryConversionReport(ws, target);
      if (lc) { r['LIBRARY-CONVERSION-REPORT.json'] = JSON.stringify(ACE.libconv.reportJson(lc), null, 2); r['LIBRARY-CONVERSION-REPORT.md'] = ACE.libconv.reportText(lc); }
      if (target === 'ace13') {
        r['COMPATIBILITY-REPORT.json'] = JSON.stringify(ACE.reports.compatibility(ws), null, 2);
        r['MIGRATION-REPORT.json'] = JSON.stringify(ACE.reports.migration(ws), null, 2);
        r['MIGRATION-REPORT.md'] = ACE.reports.migrationText(ws);
        r['CHANGE-LOG.txt'] = ACE.reports.changeLogText(ws);
      }
      return r;
    };

    wf.exportPackage = async function (target, progress, cancel) {
      var ws = wf.state.ws, S = ACE.settings.current, eo = wf.state.exportOpts || S.export;
      var res = await ACE.project.buildPackage(ws, target, { facts: ws.facts, reports: wf.reportsFor(ws, target), includeOriginalBar: eo.includeOriginalBar, barFile: wf.state.file, keepOriginalJar: S.project.keepOriginalJar, libIncludeExcluded: S.project.libIncludeExcluded, decompileHeader: eo.decompileHeader, progress: progress, cancel: cancel });
      ACE.log.ok('Built ' + target.toUpperCase() + ' package: ' + res.manifest.files.length + ' entries, ' + util.fmtBytes(res.blob.size));
      return res;
    };
    return wf;
  }

  var wf0 = create({ legacy: true });
  wf0.create = function (o) { return create(Object.assign({}, o, { legacy: false })); };

  /* One ZIP for a feature that takes source code: a single ZIP is used as it is; several ZIPs (for example the
   * applications and the libraries they use) or a folder are combined into one workspace ZIP. Same path twice = error. */
  wf0.sourceZip = async function (input, o) {
    o = o || {};
    var zips = input.zips || [], folder = input.folder || null;
    if (zips.length === 1 && !folder) return zips[0];
    var w = new ACE.zip.Writer({ compress: false }), n = 0;
    for (var i = 0; i < zips.length; i++) {
      var arc = await ACE.zip.open(ACE.zip.blobSource(zips[i]), { label: zips[i].name });
      for (var k = 0; k < arc.entries.length; k++) {
        var e = arc.entries[k]; if (o.cancel) o.cancel.check();
        if (e.isDir || e.unsafe || !e.path) continue;
        if (w.has(e.path)) throw new Error('"' + e.path + '" is in more than one of the selected ZIP files (last: ' + zips[i].name + '). The source and the libraries must not overlap.');
        w.add(e.path, await ACE.zip.extract(arc, e, { cancel: o.cancel }), { store: true }); n++;
        if (n % 50 === 0 && o.progress) { o.progress('combine', n, 0, zips[i].name); await util.yieldUI(); }
      }
    }
    if (folder) {
      for (var j = 0; j < folder.length; j++) {
        if (o.cancel) o.cancel.check();
        var p = ACE.zip.sanitizePath(folder[j].webkitRelativePath || folder[j].name);
        if (p.unsafe || p.isDir || !p.path) continue;
        if (w.has(p.path)) throw new Error('"' + p.path + '" is in the selected folder and in a selected ZIP file.');
        w.add(p.path, await util.readFileBytes(folder[j]), { store: true });
        if (j % 50 === 0 && o.progress) { o.progress('combine', j, folder.length, p.path); await util.yieldUI(); }
      }
    }
    var name = zips.length ? util.stripExt(zips[0].name) + (zips.length > 1 ? '+' + (zips.length - 1) : '') + '.zip' : ((folder && folder[0] && (folder[0].webkitRelativePath || '').split('/')[0]) || 'source') + '.zip';
    return new File([await w.build()], name);
  };

  ACE.workflow = wf0;
})(window.ACE);
