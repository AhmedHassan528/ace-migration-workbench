/* Pre-migration checklist. Built from extraction results, rule findings and Java findings.
 * Each item states its basis (documented / verified / observed / heuristic) so nothing is presented
 * as an IBM rule unless it is one. */
(function (ACE) {
  'use strict';
  var pm = ACE.premigration = {};

  pm.CATEGORIES = ['Source completeness', 'Java runtime compatibility', 'Required dependencies', 'Unsupported or changed nodes', 'Security configuration', 'External endpoints', 'Policies and configurable services', 'Database connectivity', 'Messaging connectivity', 'Deployment configuration', 'Items requiring Toolkit / runtime verification'];

  var SEV_RANK = { 'Error': 4, 'Warning': 3, 'Manual Review': 2, 'Information': 1 };

  pm.build = function (ws, aceFindings, javaResult, decomp) {
    var items = [];
    function add(cat, title, status, basis, detail, refs) { items.push({ category: cat, title: title, status: status, basis: basis, detail: detail, refs: refs || [] }); }

    // Source completeness
    add('Source completeness', 'All BAR entries extracted and CRC-verified', ws.complete ? 'pass' : 'fail', 'observed',
      ws.complete ? ws.files.length + ' files extracted, ' + ws.rejected.length + ' unsafe entries rejected' : 'Extraction incomplete: ' + ws.files.filter(function (f) { return f.extractError; }).length + ' file(s) failed. See BAR Inspector.');
    var srcFlows = ws.files.filter(function (f) { return f.ext === 'msgflow' || f.ext === 'subflow'; }).length;
    var cmf = ws.files.filter(function (f) { return f.ext === 'cmf'; }).length;
    add('Source completeness', 'Message flows present as source', cmf ? 'fail' : (srcFlows ? 'pass' : 'unknown'), 'observed', srcFlows + ' .msgflow/.subflow source file(s); ' + cmf + ' compiled-only .cmf file(s)');
    var appJars = (ws.jars || []).filter(function (j) { return j.classification.type === 'application'; });
    var decompiledCount = appJars.filter(function (j) { return ws.decompiled && ws.decompiled[j.sha256] && ws.decompiled[j.sha256].files.length; }).length;
    if (appJars.length) add('Source completeness', 'Java source for application JARs', decompiledCount === appJars.length ? 'attention' : 'fail', 'observed',
      appJars.length + ' application JAR(s) with compiled classes only; ' + decompiledCount + ' decompiled (decompiled code is a reconstruction, not the original source)' + (decompiledCount < appJars.length ? '. Run decompilation (Java Decompiler) or obtain the original source.' : ''));

    // Java runtime compatibility
    var jf = (javaResult && javaResult.findings) || [];
    var appErr = jf.filter(function (f) { return f.scope === 'application' && f.severity === 'Error' && !f.resolvedInWorkingCopy; });
    var appFixed = jf.filter(function (f) { return f.scope === 'application' && f.severity === 'Error' && f.resolvedInWorkingCopy; });
    var depErr = jf.filter(function (f) { return f.scope === 'dependency' && f.severity === 'Error'; });
    add('Java runtime compatibility', 'Application Java code has no open Java 17 errors', javaResult ? (appErr.length ? 'fail' : 'pass') : 'unknown', 'verified/documented',
      javaResult ? appErr.length + ' open error finding(s) in application code' + (appErr.length ? ': ' + ACE.util.uniq(appErr.map(function (f) { return f.ruleId + ' (' + (f.className || f.file) + ')'; })).join(', ') : '') : 'Java analysis not run');
    if (appFixed.length) add('Java runtime compatibility', 'Fixed Java source must be rebuilt into the deployed JAR', 'attention', 'observed',
      appFixed.length + ' error finding(s) are fixed in the ACE 13 working copy (' + ACE.util.uniq(appFixed.map(function (f) { return f.ruleId; })).join(', ') + '). The library still contains the ORIGINAL JAR. Rebuild it from the fixed Java project in the ACE 13 Toolkit (see IMPORT-INSTRUCTIONS) or the old bytecode will be deployed.');
    if (javaResult) add('Java runtime compatibility', 'Dependency JARs have no Java 17 errors', depErr.length ? 'attention' : 'pass', 'verified/documented', depErr.length + ' error finding(s) inside dependency/driver JARs: ' + ACE.util.uniq(depErr.map(function (f) { return f.jar + ':' + f.ruleId; })).join(', '));
    add('Java runtime compatibility', 'Java sources compile for Java 17 against the ACE 13 classes', 'toolkit', 'requires a Java compiler',
      'NOT performed: this browser-only workbench has no Java compiler. Static analysis is not proof of compatibility. Compile the exported Java project in the ACE 13 Toolkit.');
    // Rule findings by category
    var byCat = ACE.util.groupBy(aceFindings || [], function (f) { return f.category; });
    Object.keys(byCat).forEach(function (cat) {
      byCat[cat].forEach(function (f) {
        var st = f.severity === 'Error' ? 'fail' : (f.severity === 'Warning' || f.severity === 'Manual Review') ? 'attention' : 'info';
        if (f.category === 'Items requiring Toolkit / runtime verification') st = 'toolkit';
        add(pm.CATEGORIES.indexOf(cat) >= 0 ? cat : 'Deployment configuration', f.title, st, f.status + (f.docVerification ? ' / ' + f.docVerification.state : ''), f.evidence.slice(0, 6).map(function (e) { return e.text + (e.where ? ' [' + e.where + ']' : ''); }).join('\n') + (f.evidence.length > 6 ? '\n... ' + (f.evidence.length - 6) + ' more' : ''), f.refs);
      });
    });

    // Toolkit verification always
    add('Items requiring Toolkit / runtime verification', 'Projects import and build in the ACE 13 Toolkit', 'toolkit', 'requires IBM Toolkit', 'Not verifiable by this tool.');
    add('Items requiring Toolkit / runtime verification', 'BAR built from the migrated projects deploys and passes regression tests on ACE 13.0.8 (Java 17)', 'toolkit', 'requires IBM runtime', 'Not verifiable by this tool.');

    // Blockers
    var blockers = (aceFindings || []).filter(function (f) { return f.blocker || f.severity === 'Error'; }).map(function (f) { return f.title + ' (' + f.evidence.length + ')'; })
      .concat(appErr.length ? ['Java 17 errors in application code (' + appErr.length + ')'] : []);
    add('Migration blockers', blockers.length ? blockers.length + ' blocker(s) must be resolved before go-live' : 'No blockers detected by static checks', blockers.length ? 'fail' : 'pass', 'summary', blockers.join('\n'));

    items.sort(function (a, b) {
      var ca = pm.CATEGORIES.indexOf(a.category), cb = pm.CATEGORIES.indexOf(b.category);
      return (ca < 0 ? 99 : ca) - (cb < 0 ? 99 : cb);
    });
    return items;
  };

  pm.SEV_RANK = SEV_RANK;
})(window.ACE);
