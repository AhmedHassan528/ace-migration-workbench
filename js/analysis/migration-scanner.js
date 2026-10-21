/* ACE 12.0.5 -> 13.0.8 migration scanner (strict version mode, see config/versions.js).
 *
 * Adds the analyses the Java 17 analyser and the ACE rule engine do not cover:
 *   dependencies  - project references, .classpath entries, packaged JARs (product JAR versions,
 *                   manifest Class-Path, duplicates, build-path membership)
 *   runtime       - Java runtime requirements per Java project and per JAR
 *   artifacts     - recursive inventory of build files, scripts (read as data, never run), wizard /
 *                   pattern metadata, templates, extension points, configuration and .settings
 *   concurrency   - multi-threading, synchronisation and resource-lifecycle review items
 *                   (always MANUAL_REVIEW: static analysis cannot prove thread safety)
 * and unifies every finding of the workbench into one classified list:
 *   COMPATIBLE | DEPRECATED | REMOVED | UNSUPPORTED | BEHAVIOR_CHANGED | UNKNOWN | MANUAL_REVIEW
 * Each unified finding has: location(s), diff (when a reviewed fix exists), documentation URL(s),
 * risk, confidence and the recommended action. Nothing here changes any file. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var M = ACE.migScan = {};
  var V = function () { return window.ACE_VERSIONS; };

  M.CLASSES = ['COMPATIBLE', 'DEPRECATED', 'REMOVED', 'UNSUPPORTED', 'BEHAVIOR_CHANGED', 'UNKNOWN', 'MANUAL_REVIEW'];

  /* Classification of the built-in rules. A rule that is not listed (e.g. an imported rule set) is
   * MANUAL_REVIEW when it is heuristic and UNKNOWN otherwise, unless it declares "classification". */
  M.RULE_CLASS = {
    'ACE13-WSSEC-JAVA17': 'BEHAVIOR_CHANGED', 'ACE13-POLICY-MISSING': 'MANUAL_REVIEW', 'ACE13-ODBC': 'MANUAL_REVIEW',
    'ACE13-JAVA17-DEFAULT': 'BEHAVIOR_CHANGED', 'ACE13-SSL-IBMNAMES': 'UNSUPPORTED', 'ACE13-SSL-TLS': 'COMPATIBLE',
    'ACE13-CORBA': 'UNSUPPORTED', 'ACE13-DEPRECATED-NODES': 'DEPRECATED', 'ACE13-SECPROFILE': 'MANUAL_REVIEW',
    'ACE13-ENDPOINT': 'MANUAL_REVIEW', 'ACE13-PLAIN-HTTP': 'MANUAL_REVIEW', 'ACE13-ENV-PATH': 'MANUAL_REVIEW', 'ACE13-MQ': 'MANUAL_REVIEW',
    'ACE13-ESQL-JAVA': 'MANUAL_REVIEW', 'ACE13-ESQL-DBPROC': 'MANUAL_REVIEW', 'ACE13-ESQL-PASSTHRU': 'MANUAL_REVIEW', 'ACE13-ESQL-EVAL': 'UNKNOWN',
    'ACE13-DRIVER-PACKAGED': 'MANUAL_REVIEW', 'ACE13-UNRESOLVED': 'UNKNOWN', 'ACE13-CMF': 'UNKNOWN', 'ACE13-BINARY-JAVA': 'UNKNOWN',
    'ACE13-BAR-MODIFIED': 'MANUAL_REVIEW', 'ACE13-TOOLKIT': 'MANUAL_REVIEW', 'ACE13-BEHAVIOUR': 'MANUAL_REVIEW', 'ACE13-BACKUP': 'MANUAL_REVIEW',
    'ACE13-MIGRATION-METHOD': 'MANUAL_REVIEW', 'ACE13-SUPPORTED-PATH': 'COMPATIBLE',
    'J17-IBM-MISC': 'REMOVED', 'J17-SUN-BASE64': 'REMOVED', 'J17-IBM-PROVIDER': 'REMOVED', 'J17-IBM-INTERNAL-CRYPTO': 'MANUAL_REVIEW',
    'J17-JCEKS-SECRETKEY': 'BEHAVIOR_CHANGED', 'J17-IBM-TLS-NAMES': 'UNSUPPORTED', 'J17-LEGACY-TLS': 'BEHAVIOR_CHANGED',
    'J17-JAVAEE-REMOVED': 'REMOVED', 'J17-NASHORN': 'REMOVED', 'J17-PACK200': 'REMOVED', 'J17-RMI-ACTIVATION': 'REMOVED', 'J17-REMOVED-METHODS': 'REMOVED',
    'J17-JDK-INTERNAL': 'UNSUPPORTED', 'J17-UNSUPPORTED': 'MANUAL_REVIEW', 'J17-SETACCESSIBLE': 'BEHAVIOR_CHANGED',
    'J17-SECURITYMANAGER': 'DEPRECATED', 'J17-APPLET': 'DEPRECATED', 'J17-BOXED-CTOR': 'DEPRECATED', 'J17-FINALIZE': 'DEPRECATED',
    'J17-DEFAULT-CHARSET': 'MANUAL_REVIEW', 'J17-WEAK-CRYPTO': 'MANUAL_REVIEW', 'J17-CLASSVERSION-NEW': 'UNSUPPORTED', 'J17-CLASSVERSION-OLD': 'COMPATIBLE',
    'J17-UNDERSCORE': 'UNSUPPORTED', 'J17-ACE-GLOBALCACHE': 'MANUAL_REVIEW', 'J17-ACE-API': 'MANUAL_REVIEW'
  };
  var RISK = { Error: 'high', Warning: 'medium', 'Manual Review': 'medium', Information: 'low' };

  function fact(id) { return (V().facts || []).filter(function (f) { return f.id === id; })[0]; }
  function factRefs(ids) { return ids.map(fact).filter(Boolean).map(function (f) { return { title: f.title, url: f.url, factId: f.id }; }); }
  function F(o) {
    return Object.assign({ id: util.uid('mf'), severity: 'Manual Review', status: 'observed', confidence: 'medium', refs: [], evidence: [], ruleSet: 'migration-scanner' }, o);
  }

  /* ---------- helpers over the layout ---------- */
  function ctx(ws) {
    var lay = ACE.project.layout(ws), byId = {};
    ws.files.forEach(function (f) { byId[f.id] = f; });
    var rows = lay.files.map(function (l) { return { l: l, f: byId[l.fileId] }; }).filter(function (r) { return r.f && r.f.bytes; });
    // every file, including those outside any project (loose scripts, BAR metadata)
    var all = rows.concat(lay.unassigned.concat(lay.metadata).map(function (m) { return { l: { outPath: m.outPath, project: null, relPath: m.outPath }, f: byId[m.fileId] }; }).filter(function (r) { return r.f && r.f.bytes; }));
    return { lay: lay, rows: rows, all: all, byId: byId };
  }
  function text(f) { return ACE.bar.text(f) || ''; }

  /* Brace ranges [{open, close}] for blocks whose header matches re (masked code). */
  function blocks(code, re) {
    var out = [], m; re = new RegExp(re.source, 'g');
    while ((m = re.exec(code))) {
      var open = code.indexOf('{', m.index + m[0].length - 1); if (open < 0) continue;
      var d = 0;
      for (var i = open; i < code.length; i++) { if (code[i] === '{') d++; else if (code[i] === '}') { d--; if (!d) { out.push({ open: open, close: i }); break; } } }
    }
    return out;
  }
  function inside(rs, off) { return rs.some(function (r) { return off > r.open && off < r.close; }); }

  /* ---------- 1. dependencies ---------- */
  M.dependencies = function (ws, C) {
    var out = { projects: [], jars: [], findings: [] }, names = {};
    C.lay.projects.forEach(function (p) { names[p.name] = true; });
    // project references
    C.lay.projects.forEach(function (p) {
      var dp = p.eclipse && p.eclipse.dotProject, cp = p.eclipse && p.eclipse.classpath;
      var rec = { project: p.name, type: p.type, natures: dp ? dp.natures : [], builders: dp ? dp.builders : [], references: dp ? dp.projects : [], classpath: cp ? cp.entries : null, metadata: p.eclipse ? 'original' : 'generated/none' };
      out.projects.push(rec);
      if (!dp) return;
      dp.projects.forEach(function (r) {
        if (names[r]) return;
        out.findings.push(F({ ruleId: 'DEP-MISSING-PROJECT', classification: 'MANUAL_REVIEW', severity: 'Error', risk: 'high', confidence: 'high', category: 'Dependencies',
          title: 'Referenced project is missing from the input', why: p.name + ' declares a project reference to "' + r + '" in its .project file, but no project with that name is in the input. Flows, ESQL or Java in ' + p.name + ' that use it cannot be built or validated.',
          action: 'Add "' + r + '" (from source control) to the workspace before building in the ' + V().targetLabel + ' Toolkit, then re-run this analysis.',
          evidence: [{ text: p.name + ' -> ' + r + ' (not found)', where: p.eclipse.dotProjectVPath, line: lineOf(text(fileByVPath(ws, p.eclipse.dotProjectVPath)), '<project>' + r + '</project>') }] }));
      });
      if (!cp) return;
      cp.entries.forEach(function (e) {
        var where = p.eclipse.classpathVPath;
        if (e.kind === 'var') {
          var v = e.path.split('/')[0];
          out.findings.push(F({ ruleId: 'DEP-CLASSPATH-VAR', classification: 'MANUAL_REVIEW', risk: 'medium', confidence: 'medium', status: 'observed', category: 'Dependencies',
            title: 'Build path uses classpath variable ' + v, why: 'The .classpath entry "' + e.path + '" resolves through the Eclipse classpath variable ' + v + ', which the Toolkit defines for its own installation. After migration it must point to the ' + V().target + ' installation, not to ' + V().source + '. (Assumption: the ' + V().target + ' Toolkit defines ' + v + '; not verified in IBM documentation by this tool.)',
            action: 'In the ' + V().targetLabel + ' Toolkit open Window > Preferences > Java > Build Path > Classpath Variables and confirm ' + v + ' points to the 13.0.8 installation; rebuild the project.',
            evidence: [{ text: 'classpathentry kind="var" path="' + e.path + '"', where: where, line: e.line }], assumption: v + ' is defined by the ' + V().target + ' Toolkit and points to its own runtime JARs' }));
        } else if (e.kind === 'con' && /JRE_CONTAINER$/.test(e.path)) {
          out.findings.push(F({ ruleId: 'RT-JRE-CONTAINER-DEFAULT', classification: 'BEHAVIOR_CHANGED', risk: 'medium', confidence: 'high', status: 'documented', category: 'Java runtime',
            title: 'Java project uses the workspace default JRE', why: 'The JRE container has no explicit execution environment, so the project compiles against whatever JRE is the workspace default. ' + fact('V-SRC-DEFAULT-JRE').text + ' ' + fact('V-TGT-DEFAULT-JRE').text,
            action: 'Decide whether the integration servers that run this code use Java 17 (ACE 13 default) or Java 8, and set the project JRE / compliance level to match before rebuilding.', refs: factRefs(['V-SRC-DEFAULT-JRE', 'V-TGT-DEFAULT-JRE']),
            evidence: [{ text: 'classpathentry kind="con" path="' + e.path + '"', where: where, line: e.line }] }));
        } else if (e.kind === 'lib') {
          var target = e.path.charAt(0) === '/' ? e.path.slice(1) : p.name + '/' + e.path;
          if (!C.lay.files.some(function (l) { return l.outPath === target; }))
            out.findings.push(F({ ruleId: 'DEP-MISSING-LIB', classification: 'MANUAL_REVIEW', severity: 'Error', risk: 'high', confidence: 'high', category: 'Dependencies',
              title: 'Build-path library is missing', why: '.classpath lists ' + e.path + ', which is not in the input.', action: 'Restore the library or remove the entry, then rebuild.',
              evidence: [{ text: 'classpathentry kind="lib" path="' + e.path + '"', where: where, line: e.line }] }));
        }
      });
    });
    // packaged JARs
    var jarFiles = {};
    (ws.jars || []).forEach(function (jr) {
      var mf = (jr.info.manifest && jr.info.manifest.main) || {};
      var occ = jr.occurrences.map(function (o) { var l = C.lay.files.filter(function (x) { return C.byId[x.fileId] && C.byId[x.fileId].vpath === o; })[0]; return { vpath: o, outPath: l ? l.outPath : o, project: l ? l.project : null }; });
      var onBuildPath = occ.filter(function (o) {
        var p = C.lay.projects.filter(function (q) { return q.name === o.project; })[0], cp = p && p.eclipse && p.eclipse.classpath;
        return cp && cp.entries.some(function (e) { return e.kind === 'lib' && (e.path === o.outPath.slice(o.project.length + 1) || e.path === '/' + o.outPath); });
      });
      var cpRefs = String(mf['Class-Path'] || '').split(/\s+/).filter(Boolean);
      var missingCp = cpRefs.filter(function (r) { var b = util.basename(r); return !ws.files.some(function (f) { return f.name === b; }); });
      var pkgs = Object.keys(jr.info.packages || {}).filter(function (k) { return k !== '(default package)'; });
      var usedBy = usages(ws, C, pkgs, jr);
      var rec = { name: jr.name, sha256: jr.sha256, type: jr.classification.type, driver: jr.classification.driverName || null, copies: occ.length, locations: occ.map(function (o) { return o.outPath; }),
        implementationTitle: mf['Implementation-Title'] || null, implementationVersion: mf['Implementation-Version'] || null, createdBy: mf['Created-By'] || null, buildJdk: mf['Build-Jdk'] || mf['Build-Jdk-Spec'] || null,
        classVersions: Object.keys(jr.info.versions || {}).map(function (v) { return ACE.java.javaVersionOf(Number(v)); }), classPath: cpRefs, missingClassPath: missingCp,
        onBuildPath: onBuildPath.map(function (o) { return o.outPath; }), referencedBy: usedBy };
      out.jars.push(rec);
      jarFiles[jr.name] = rec;
      var where = occ.map(function (o) { return o.outPath; }).join(', ');
      var aceProduct = /App Connect|Integration Bus|WebSphere Message Broker/i.test(rec.implementationTitle || '') || jr.classification.type === 'product';
      if (aceProduct) {
        var verTxt = rec.implementationVersion ? 'Implementation-Version ' + rec.implementationVersion : 'no Implementation-Version' + (rec.createdBy ? ', Created-By ' + rec.createdBy : '');
        var isSrc = rec.implementationVersion && rec.implementationVersion.indexOf(V().sourcePrefix) === 0;
        out.findings.push(F({ ruleId: 'DEP-PRODUCT-JAR', classification: 'MANUAL_REVIEW', severity: 'Warning', risk: usedBy.length || onBuildPath.length ? 'high' : 'low', confidence: 'high', status: 'observed', category: 'Dependencies',
          title: 'IBM ACE product JAR packaged inside a project (' + jr.name + ')',
          why: jr.name + ' contains IBM product classes (' + (rec.implementationTitle || jr.classification.evidence.join('; ')) + ', ' + verTxt + '). A copy inside a project pins the code to the release it was copied from' + (isSrc ? ' (' + V().source + ')' : '') + '; at run time the integration server supplies its own product classes. Mixing a ' + (rec.implementationVersion || 'older') + ' copy with the ' + V().target + ' runtime is not a configuration IBM documents.' +
            (usedBy.length ? '' : ' No source or application class in the input references its packages' + (onBuildPath.length ? '.' : ', and it is not on any .classpath, so it is not used at compile time.')),
          action: usedBy.length ? 'Remove the packaged copy and compile against the JAR shipped with ' + V().targetLabel + ' (server/classes or the Toolkit runtime). Re-test the code that uses it: ' + usedBy.slice(0, 5).join(', ') + '.'
            : 'Remove the unused copy from the project after confirming no deployment script or BAR build relies on it; otherwise replace it with the ' + V().target + ' version from the installation.',
          evidence: [{ text: jr.name + ': ' + verTxt + '; packages ' + pkgs.slice(0, 4).map(function (x) { return x.replace(/\//g, '.').replace(/\.$/, ''); }).join(', ') + (pkgs.length > 4 ? ', …' : '') + '; ' + (usedBy.length ? 'referenced by ' + usedBy.join(', ') : 'not referenced by any source/class in the input'), where: where }],
          assumption: 'The ' + V().target + ' installation provides an equivalent JAR; locate it in the installation before removing the packaged copy.' }));
        if (pkgs.some(function (k) { return k.indexOf('com/ibm/broker/config/proxy/') === 0; }))
          out.findings.push(F({ ruleId: 'DEP-CMP-DEPRECATED', classification: 'DEPRECATED', severity: 'Warning', risk: usedBy.length ? 'medium' : 'low', confidence: 'high', status: 'documented', category: 'Dependencies',
            title: 'Deprecated CMP API (com.ibm.broker.config.proxy) packaged in ' + jr.name, why: fact('V-TGT-CMP').text,
            action: usedBy.length ? 'Move the code to com.ibm.integration.admin.proxy (IBM Integration API) or confirm that the deprecated classes still serve your use case on ' + V().target + '.' : 'Nothing uses it in the input: remove the JAR. If code is reintroduced, use com.ibm.integration.admin.proxy instead.',
            refs: factRefs(['V-TGT-CMP']), evidence: [{ text: jr.name + ' contains com.ibm.broker.config.proxy (' + (jr.info.packages['com/ibm/broker/config/proxy/'] || 0) + ' classes)', where: where }] }));
      }
      if (missingCp.length)
        out.findings.push(F({ ruleId: 'DEP-MANIFEST-CLASSPATH', classification: 'MANUAL_REVIEW', severity: 'Warning', risk: usedBy.length ? 'high' : 'low', confidence: 'high', category: 'Dependencies',
          title: jr.name + ' needs ' + missingCp.length + ' JAR(s) that are not in the input', why: 'The manifest Class-Path of ' + jr.name + ' lists JARs that are expected next to it at run time: ' + missingCp.join(', ') + '. None of them is in the input, so classes that need them fail with NoClassDefFoundError.',
          action: usedBy.length ? 'Provide these JARs from the ' + V().target + ' installation (do not copy them from ' + V().source + '), or remove ' + jr.name + '.' : 'Not referenced by the input; removing ' + jr.name + ' removes this dependency as well.',
          evidence: [{ text: 'Class-Path: ' + cpRefs.join(' '), where: where }] }));
      if (occ.length > 1)
        out.findings.push(F({ ruleId: 'DEP-DUPLICATE-JAR', classification: 'MANUAL_REVIEW', severity: 'Information', risk: 'medium', confidence: 'high', category: 'Dependencies',
          title: jr.name + ' is packaged ' + occ.length + ' times (identical content)', why: 'The same JAR (sha256 ' + jr.sha256.slice(0, 12) + '…) is copied into ' + occ.length + ' projects. Several copies on the class path of one integration server can load the same classes through different class loaders; upgrading one copy and not the others leaves mixed versions.',
          action: 'Keep one copy (for a JDBC driver, preferably none: configure it on the server through a JDBCProviders policy) and remove the others.',
          evidence: [{ text: occ.map(function (o) { return o.outPath; }).join(', '), where: where }] }));
    });
    return out;
  };
  function fileByVPath(ws, vp) { return ACE.bar.byVPath(ws, vp) || { bytes: null }; }
  function lineOf(t, needle) { var i = String(t || '').indexOf(needle); return i < 0 ? null : util.lineAt(t, i); }

  /* Which source files / application classes reference any of the packages (import, FQN or bytecode). */
  function usages(ws, C, pkgs, self) {
    // Exact package match: "pkg.ClassName" or "pkg.*" - "com.ibm.broker." must not match com.ibm.broker.plugin.MbElement.
    var res = pkgs.map(function (p) { return new RegExp('\\b' + p.replace(/\//g, '.').replace(/\./g, '\\.') + '(?:[A-Z_$][\\w$]*\\b|\\*)'); }), out = [];
    C.rows.forEach(function (r) {
      if (r.f.ext !== 'java') return;
      var code = ACE.java17.mask(text(r.f)).code;
      if (res.some(function (re) { return re.test(code); })) out.push(r.l.outPath);
    });
    (ws.jars || []).forEach(function (j) {
      if (j === self || j.classification.type !== 'application') return;
      if (j.info.classes.some(function (c) { return c.classRefs.some(function (cr) { return pkgs.some(function (p) { return cr.indexOf(p) === 0 && cr.indexOf('/', p.length) < 0; }); }); })) out.push(j.name);
    });
    return util.uniq(out);
  }

  /* ---------- 2. Java runtime requirements ---------- */
  M.runtime = function (ws, C) {
    var out = { projects: [], findings: [] };
    C.lay.projects.filter(function (p) { return p.type === 'java'; }).forEach(function (p) {
      var prefs = C.rows.filter(function (r) { return r.l.project === p.name && r.l.relPath === '.settings/org.eclipse.jdt.core.prefs'; })[0];
      var kv = {};
      if (prefs) util.lines(text(prefs.f)).forEach(function (ln) { var i = ln.indexOf('='); if (i > 0) kv[ln.slice(0, i).trim()] = ln.slice(i + 1).trim(); });
      var rec = { project: p.name, compliance: kv['org.eclipse.jdt.core.compiler.compliance'] || null, source: kv['org.eclipse.jdt.core.compiler.source'] || null, target: kv['org.eclipse.jdt.core.compiler.codegen.targetPlatform'] || null, prefsFile: prefs ? prefs.l.outPath : null };
      out.projects.push(rec);
      if (!prefs || !rec.compliance)
        out.findings.push(F({ ruleId: 'RT-COMPLIANCE-UNRECORDED', classification: 'UNKNOWN', severity: 'Information', risk: 'medium', confidence: 'high', category: 'Java runtime',
          title: 'Java compiler level of ' + p.name + ' is not recorded', why: 'The project has no .settings/org.eclipse.jdt.core.prefs (or no compliance setting), so the Java language level it was built with in ' + V().source + ' cannot be determined from the input. It inherits the workspace default of whichever Toolkit opens it.',
          action: 'Set the compiler compliance explicitly (Project > Properties > Java Compiler) to the level of the integration servers that will run it (17 for the ACE 13 default), rebuild, and fix any compile errors.',
          evidence: [{ text: prefs ? 'org.eclipse.jdt.core.prefs has no compiler.compliance' : 'no .settings/org.eclipse.jdt.core.prefs', where: p.name + '/.settings' }] }));
    });
    return out;
  };

  /* ---------- 3. artifact inventory (build files, scripts, wizard/pattern metadata, config) ---------- */
  var ART = [
    ['build', /(^|\/)(build\.xml|pom\.xml|build\.gradle(\.kts)?|settings\.gradle|gradle\.properties|Makefile|[^\/]+\.mk|Jenkinsfile|\.gitlab-ci\.yml|azure-pipelines\.ya?ml|[^\/]+\.ant)$/i],
    ['script', /\.(sh|ksh|bash|cmd|bat|ps1|py|pl)$/i],
    ['wizard-pattern', /(^|\/)(plugin\.xml|fragment\.xml|[^\/]+\.exsd|[^\/]+\.pattern|[^\/]+\.patternzip|pattern\.xml|patternplugin\.xml|wizard[^\/]*\.xml)$/i],
    ['template', /\.(template|tmpl|vm|ftl|mustache|hbs|jet|javajet)$/i],
    ['runtime-config', /(^|\/)(server\.conf\.yaml|node\.conf\.yaml|[^\/]+\.policyxml|policy\.descriptor|[^\/]+\.properties|[^\/]+\.yaml|[^\/]+\.yml|odbc\.ini|[^\/]+\.ini)$/i],
    ['eclipse-settings', /(^|\/)\.settings\/[^\/]+\.prefs$/i],
    ['eclipse-metadata', /(^|\/)(\.project|\.classpath|META-INF\/MANIFEST\.MF)$/i],
    ['ace-descriptor', /(^|\/)(application|library|restapi)\.descriptor$/i]
  ];
  var CONTENT_RULES = [
    { id: 'CFG-JSSE-DEBUG-TRUE', re: /-Djavax\.net\.debug\s*=\s*true\b/g, cls: 'UNSUPPORTED', risk: 'low', fact: 'V-TGT-JSSE', title: '-Djavax.net.debug=true is not supported on Java 17', action: 'Use -Djavax.net.debug=all (works on Java 8 and 17).', fix: 'jsse-debug-all' },
    { id: 'CFG-TMPDIR', re: /\bTMPDIR\b/g, cls: 'BEHAVIOR_CHANGED', risk: 'medium', fact: 'V-TGT-TMPDIR', title: 'TMPDIR is not observed by the Java 17 JVM', action: 'Set java.io.tmpdir through _JAVA_OPTIONS or the jvmSystemProperty setting instead of (or as well as) TMPDIR.' },
    { id: 'CFG-SOURCE-VERSION-PATH', re: /\b(?:ace-?12(?:\.0(?:\.\d+)*)?|12\.0\.5(?:\.\d+)?|IBM[\\\/]ACE[\\\/]12[\w.]*)\b/gi, cls: 'MANUAL_REVIEW', risk: 'medium', title: 'Hard-coded ACE 12 version or installation path', action: 'Replace with the ' + '13.0.8' + ' installation path / version, or parameterise it.' },
    { id: 'CFG-MQSI-COMMAND', re: /\bmqsi(?:createbar|deploy|setdbparms|changeproperties|reportproperties|profile|start|stop|createexecutiongroup|packagebar|applybaroverride)\b/g, cls: 'MANUAL_REVIEW', risk: 'low', title: 'Script uses an mqsi command', action: 'Check the command and its options against the ' + '13.0.8' + ' command reference (many tasks moved to ibmint); run the script only after review.' }
  ];
  M.artifacts = function (ws, C) {
    var out = { categories: {}, files: [], findings: [], generatedCode: [] };
    ART.forEach(function (a) { out.categories[a[0]] = []; });
    C.all.forEach(function (r) {
      var p = r.l.outPath, cat = null;
      for (var i = 0; i < ART.length; i++) if (ART[i][1].test(p)) { cat = ART[i][0]; break; }
      if (cat) { out.categories[cat].push(p); out.files.push({ path: p, category: cat, size: r.f.size }); }
      var isTextual = cat || /\.(java|esql|msgflow|subflow|xml|txt|md)$/i.test(p);
      if (!isTextual || r.f.ext === 'jar') return;
      var t = text(r.f);
      if (/\.(java|esql)$/i.test(p) && /@generated\b|\bDO NOT EDIT\b|Generated by (?!IBM ACE Migration Workbench)/i.test(t.slice(0, 2000))) out.generatedCode.push(p);
      if (!cat || cat === 'eclipse-metadata' || cat === 'ace-descriptor') return;
      CONTENT_RULES.forEach(function (cr) {
        var re = new RegExp(cr.re.source, cr.re.flags), m, hits = [];
        while ((m = re.exec(t))) hits.push({ text: m[0], where: p, line: util.lineAt(t, m.index) });
        if (!hits.length) return;
        out.findings.push(F({ ruleId: cr.id, classification: cr.cls, risk: cr.risk, confidence: cr.fact ? 'high' : 'medium', status: cr.fact ? 'documented' : 'heuristic', category: 'Configuration and scripts',
          title: cr.title, why: cr.fact ? fact(cr.fact).text : 'Pattern match in a ' + cat + ' file (heuristic). Scripts are read as data and never executed.', action: cr.action, refs: cr.fact ? factRefs([cr.fact]) : [], evidence: hits.slice(0, 20), autofixId: cr.fix || null }));
      });
    });
    out.summary = Object.keys(out.categories).map(function (k) { return { category: k, count: out.categories[k].length }; });
    var none = ['build', 'script', 'wizard-pattern', 'template', 'runtime-config'].filter(function (k) { return !out.categories[k].length; });
    out.notFound = none;
    return out;
  };

  /* ---------- 4. concurrency, synchronisation and resource lifecycle (MANUAL_REVIEW) ---------- */
  var RESOURCE_NEW = /\bnew\s+(FileInputStream|FileOutputStream|FileReader|FileWriter|RandomAccessFile|ZipFile|JarFile|ZipInputStream|ZipOutputStream|Socket|ServerSocket|PrintWriter|Scanner|ObjectInputStream|ObjectOutputStream|BufferedReader|BufferedWriter|InputStreamReader|OutputStreamWriter)\s*\(/g;
  var RESOURCE_CALL = /\b(DriverManager\.getConnection|\.getConnection|\.prepareStatement|\.prepareCall|\.createStatement|\.executeQuery|\.openStream|\.getInputStream|\.getOutputStream)\s*\(/g;
  var JCN_BASE = /\bclass\s+(\w+)\s+extends\s+(MbJavaComputeNode|MbNode|MbInputNode)\b/;
  var NON_THREADSAFE = /^(?:java\.util\.)?(HashMap|ArrayList|LinkedList|HashSet|TreeMap|TreeSet|LinkedHashMap|Hashtable|Vector|SimpleDateFormat|StringBuilder|Map|List|Set|Collection|Calendar|DecimalFormat|MessageDigest|Cipher|Mac)\b/;

  /* Fields declared directly in the first top-level class body. */
  function classFields(code) {
    var m = /\b(class|enum)\s+(\w+)[^{;]*\{/.exec(code); if (!m) return { name: null, fields: [] };
    var open = code.indexOf('{', m.index), d = 0, body = [];
    for (var i = open; i < code.length; i++) {
      var c = code[i];
      if (c === '{') { d++; if (d > 1) { body.push(' '); continue; } body.push(' '); continue; }
      if (c === '}') { d--; if (d === 0) break; body.push(d >= 1 ? ';' : ' '); continue; }
      body.push(d === 1 ? c : (c === '\n' ? '\n' : ' '));
    }
    var b = body.join(''), fields = [], re = /([^;]*);/g, r, off = open;
    while ((r = re.exec(b))) {
      var st = r[1], s = st.replace(/@\w+(\([^)]*\))?/g, ' ').trim();
      if (!s || /\(/.test(s.split('=')[0])) continue; // methods, constructors, initialisers
      var fm = /^((?:(?:public|protected|private|static|final|transient|volatile)\s+)*)([\w$.<>\[\],? ]+?)\s+(\w+)\s*(=.*)?$/.exec(s.replace(/\s+/g, ' '));
      if (!fm || /^(return|throw|package|import)$/.test(fm[2])) continue;
      var mods = fm[1] || '';
      fields.push({ name: fm[3], type: fm[2].trim(), isStatic: /\bstatic\b/.test(mods), isFinal: /\bfinal\b/.test(mods), isVolatile: /\bvolatile\b/.test(mods), init: fm[4] ? fm[4].slice(1).trim() : null, offset: off + r.index + (st.length - st.replace(/^\s+/, '').length) });
    }
    return { name: m[2], fields: fields };
  }

  M.concurrency = function (ws, C) {
    var out = { java: [], esql: [], flows: [], findings: [], instances: [] };
    var V_ = V();
    // flow instances (more instances = more threads sharing node objects and SHARED variables)
    ((ws.facts && ws.facts.nodes) || []).forEach(function (n) {
      Object.keys(n.effective || {}).forEach(function (k) { if (/^additionalInstances$/i.test(k) && Number(n.effective[k]) > 0) out.instances.push({ where: n.flowVPath + ' > ' + n.label, value: Number(n.effective[k]), override: !!n.overridden[k] }); });
    });
    ((ws.facts && ws.facts.overrides) || []).forEach(function (o) { if (/additionalInstances$/i.test(o.uri) && Number(o.value) > 0) out.instances.push({ where: o.vpath + ' (' + o.uri + ')', value: Number(o.value), override: true }); });
    var instNote = out.instances.length ? 'Additional instances are configured: ' + out.instances.map(function (x) { return x.where + ' = ' + x.value; }).join('; ') + '.'
      : 'No additionalInstances value above 0 is set in the input; deployment-time overrides or server configuration may still run the flow on several threads (not visible here).';
    function add(o) { out.findings.push(F(Object.assign({ classification: 'MANUAL_REVIEW', severity: 'Manual Review', status: 'heuristic', category: 'Concurrency and lifecycle' }, o))); }

    C.rows.forEach(function (r) {
      if (r.f.ext !== 'java') return;
      var src = text(r.f), code = ACE.java17.mask(src).code, p = r.l.outPath, rec = { file: p, items: [] };
      out.java.push(rec);
      var cf = classFields(code), jcn = JCN_BASE.exec(code);
      cf.fields.forEach(function (fd) {
        var ln = util.lineAt(src, fd.offset), ev = [{ text: (fd.isStatic ? 'static ' : '') + (fd.isFinal ? 'final ' : '') + fd.type + ' ' + fd.name + (fd.init ? ' = ' + fd.init.slice(0, 60) : ''), where: p, line: ln }];
        if (fd.isStatic && !fd.isFinal) {
          rec.items.push('static mutable field ' + fd.name);
          add({ ruleId: 'CONC-STATIC-MUTABLE', risk: 'medium', confidence: 'medium', title: 'Mutable static field ' + cf.name + '.' + fd.name,
            why: 'A static field that is not final is shared by every thread of every flow that loads this class in the integration server. Unsynchronised writes can be lost or seen late by other threads. ' + instNote,
            action: 'If the value never changes, make it "static final" (behaviour-preserving when nothing assigns it; confirm with a search across the workspace). Otherwise guard reads and writes, or use a thread-safe holder.', evidence: ev });
        } else if (fd.isStatic && NON_THREADSAFE.test(fd.type) && !/Concurrent|Collections\.(synchronized|unmodifiable)|List\.of|Map\.of|Set\.of/.test(fd.init || '')) {
          rec.items.push('static non-thread-safe object ' + fd.name);
          add({ ruleId: 'CONC-STATIC-NONTHREADSAFE', risk: 'high', confidence: 'medium', title: 'Static ' + fd.type + ' shared across threads (' + cf.name + '.' + fd.name + ')',
            why: fd.type + ' is not thread-safe. As a static field it is shared by all message-processing threads. ' + instNote, action: 'Use a concurrent type (ConcurrentHashMap, java.time.format.DateTimeFormatter, ThreadLocal) or synchronise access.', evidence: ev });
        }
        if (jcn && !fd.isStatic && !fd.isFinal) {
          rec.items.push('node instance field ' + fd.name);
          add({ ruleId: 'CONC-NODE-INSTANCE-FIELD', risk: 'high', confidence: 'low', title: 'Mutable instance field in ' + jcn[2] + ' subclass ' + cf.name + ' (' + fd.name + ')',
            why: 'Node objects are long-lived and can be used by more than one message-processing thread (assumption: not confirmed in IBM documentation by this tool). State kept in instance fields between messages is shared. ' + instNote,
            action: 'Keep per-message state in local variables; make shared configuration final and initialise it in onInitialize().', evidence: ev, assumption: 'A JavaCompute node object can be invoked concurrently by several flow instances' });
        }
      });
      // synchronisation and threading primitives (inventory)
      var prim = [], re = /\b(synchronized|volatile|new\s+Thread\s*\(|Executors\.\w+|ExecutorService|ThreadLocal|Timer\s*\(|\.wait\s*\(|\.notify(All)?\s*\(|Atomic(Integer|Long|Reference|Boolean)|ReentrantLock|CountDownLatch|Semaphore)/g, m;
      while ((m = re.exec(code))) prim.push({ text: m[0].replace(/\s+/g, ' '), where: p, line: util.lineAt(src, m.index) });
      if (prim.length) {
        rec.items.push(prim.length + ' synchronisation/threading construct(s)');
        add({ ruleId: 'CONC-PRIMITIVES', risk: /Thread|Executor|Timer/.test(prim.map(function (x) { return x.text; }).join(' ')) ? 'high' : 'medium', confidence: 'high', status: 'observed', title: 'Explicit threading or synchronisation in ' + util.basename(p),
          why: 'The code creates threads or synchronises explicitly. Threads started by application code are not managed by the integration server (shutdown, redeploy, transactions). Lock behaviour can change with the Java 17 JVM and G1 garbage collector default (ACE 13 Java 17 uses G1GC by default).',
          action: 'Review each construct; prefer flow-level parallelism (additional instances) over application threads; test under load on ' + V_.target + ' with Java 17.', evidence: prim, refs: [{ title: 'Java 8 vs Java 17 comparison in IBM ACE 13.0', url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac38109_.html' }] });
      }
      // MbGlobalMap check-then-act
      var gm = /(\w+)\s*=\s*MbGlobalMap\s*\.\s*getGlobalMap\s*\(/g, g;
      while ((g = gm.exec(code))) {
        var v = g[1], getI = code.search(new RegExp('\\b' + v + '\\s*\\.\\s*get\\s*\\(')), putI = code.search(new RegExp('\\b' + v + '\\s*\\.\\s*put\\s*\\('));
        if (getI >= 0 && putI > getI) add({ ruleId: 'CONC-GLOBALMAP-CHECK-THEN-ACT', risk: 'medium', confidence: 'medium', title: 'Global cache read-then-write is not atomic (' + util.basename(p) + ')',
          why: 'The code reads a key from MbGlobalMap and writes it later when it is missing. Two threads (or two integration servers sharing the cache) can both miss and both write. ' + fact('V-TGT-WXS').text + ' The cache implementation behind MbGlobalMap therefore changes when moving to ' + V_.target + '.',
          action: 'Accept the duplicate initialisation if it is idempotent, or use an atomic operation; test the cache path on the ' + V_.target + ' cache configuration.', refs: factRefs(['V-TGT-WXS', 'V-TGT-J17-OFF']),
          evidence: [{ text: v + '.get(...) at line ' + util.lineAt(src, getI), where: p, line: util.lineAt(src, getI) }, { text: v + '.put(...) at line ' + util.lineAt(src, putI), where: p, line: util.lineAt(src, putI) }] });
      }
      // resource lifecycle
      var fin = blocks(code, /\bfinally\s*\{/), twr = [], tr = /\btry\s*\(/g, t;
      while ((t = tr.exec(code))) { var dd = 0, k = code.indexOf('(', t.index); for (var j = k; j < code.length; j++) { if (code[j] === '(') dd++; else if (code[j] === ')') { dd--; if (!dd) { twr.push({ open: k, close: j }); break; } } } }
      [RESOURCE_NEW, RESOURCE_CALL].forEach(function (R) {
        var rr = new RegExp(R.source, 'g'), x;
        while ((x = rr.exec(code))) {
          if (inside(twr, x.index)) continue;
          var before = code.slice(Math.max(0, x.index - 200), x.index), vm = /(\w+)\s*=\s*(?:\([\w.<>]+\)\s*)?[\w.]*\s*$/.exec(before);
          if (R === RESOURCE_CALL && !vm) continue;
          var name = vm ? vm[1] : null, closes = [], cr = name ? new RegExp('\\b' + name + '\\s*\\.\\s*close\\s*\\(|closeQuietly\\s*\\(\\s*' + name + '\\b', 'g') : null, c2;
          if (cr) while ((c2 = cr.exec(code))) closes.push(c2.index);
          var inFinally = closes.some(function (ci) { return inside(fin, ci); });
          if (inFinally) continue;
          var returned = name && new RegExp('\\breturn\\s+' + name + '\\b').test(code);
          if (returned) continue;
          var ln = util.lineAt(src, x.index), kind = x[1] || x[0];
          rec.items.push('resource ' + (name || kind) + ' not closed in finally');
          add({ ruleId: 'LIFE-RESOURCE-NOT-CLOSED', risk: 'medium', confidence: closes.length ? 'high' : 'medium', status: 'observed', title: (closes.length ? 'Resource closed only on the success path' : 'Resource is never closed') + ': ' + (name || kind) + ' in ' + util.basename(p),
            why: (closes.length ? name + '.close() is called, but not in a finally block or try-with-resources, so an exception before it leaks the ' + kind.replace(/[.(]/g, '') + '.' : 'No close() for ' + (name || 'this resource') + ' was found in this file.') + ' In a long-running integration server leaked file handles and connections accumulate until the server is restarted.',
            action: 'Use try-with-resources (Java 7+, so valid for both Java 8 and 17). This changes only the error path; confirm the exception handling still matches the intended behaviour.',
            evidence: [{ text: code.slice(x.index, x.index + 60).split('\n')[0].trim(), where: p, line: ln }].concat(closes.map(function (ci) { return { text: name + '.close() outside finally', where: p, line: util.lineAt(src, ci) }; })) });
        }
      });
    });

    // ESQL SHARED variables and ATOMIC blocks
    C.rows.forEach(function (r) {
      if (r.f.ext !== 'esql') return;
      var src = text(r.f), code = ACE.esql.mask(src).code, p = r.l.outPath;
      var shared = [], dm = /\bDECLARE\s+(\w+)\s+SHARED\b/gi, m;
      while ((m = dm.exec(code))) shared.push({ name: m[1], line: util.lineAt(src, m.index) });
      if (!shared.length) return;
      // ATOMIC block ranges: BEGIN ATOMIC ... matching END; (BEGIN +1, "END;" / "END label;" -1)
      var atomic = [], tok = /\bBEGIN\b(\s+ATOMIC\b)?|\bEND\b\s*(\w+\s*)?;/gi, stack = [], t;
      while ((t = tok.exec(code))) {
        if (/^BEGIN/i.test(t[0])) stack.push({ at: t.index, atomic: !!t[1] });
        else { if (t[2] && /^(IF|WHILE|LOOP|CASE|FOR|REPEAT|MODULE)\b/i.test(t[2].trim())) continue; var b = stack.pop(); if (b && b.atomic) atomic.push({ open: b.at, close: t.index }); }
      }
      shared.forEach(function (s) {
        var writes = [], wr = new RegExp('\\b(SET|CREATE\\s+(?:FIRSTCHILD|LASTCHILD|FIELD|PREVIOUSSIBLING|NEXTSIBLING)\\s+OF|DELETE\\s+\\w+\\s+OF|DETACH)\\s+' + s.name + '\\b', 'gi'), w;
        while ((w = wr.exec(code))) writes.push({ at: w.index, atomic: inside(atomic, w.index) });
        var un = writes.filter(function (x) { return !x.atomic; });
        out.esql.push({ file: p, variable: s.name, declaredLine: s.line, writes: writes.length, writesOutsideAtomic: un.length });
        add({ ruleId: un.length ? 'CONC-ESQL-SHARED-NONATOMIC' : 'CONC-ESQL-SHARED', risk: un.length ? 'high' : 'low', confidence: 'medium', status: 'observed',
          title: 'ESQL SHARED variable ' + s.name + (un.length ? ' is modified outside a BEGIN ATOMIC block' : ' (all modifications inside BEGIN ATOMIC)'),
          why: 'SHARED variables are shared by all threads (instances) of the flow. ' + (un.length ? un.length + ' of ' + writes.length + ' modification(s) are not inside BEGIN ATOMIC, so concurrent messages can interleave updates (lexical check; the block structure was matched heuristically).' : writes.length + ' modification(s) found, all inside ATOMIC blocks.') + ' ' + instNote,
          action: un.length ? 'Wrap every read-modify-write of ' + s.name + ' in BEGIN ATOMIC ... END, or confirm the cache is only written once (e.g. on first message) and the race is harmless.' : 'No change needed for the migration; re-test cache refresh behaviour under load.',
          evidence: [{ text: 'DECLARE ' + s.name + ' SHARED', where: p, line: s.line }].concat(un.slice(0, 10).map(function (x) { return { text: 'modified outside ATOMIC', where: p, line: util.lineAt(src, x.at) }; })) });
      });
    });
    return out;
  };

  /* ---------- unify every finding ---------- */
  function classOf(f) {
    if (f.classification) return f.classification;
    if (f.ruleId === 'J17-API-REF') return /class not present/.test(f.title) ? 'REMOVED' : 'BEHAVIOR_CHANGED';
    if (M.RULE_CLASS[f.ruleId]) return M.RULE_CLASS[f.ruleId];
    return f.status === 'heuristic' ? 'MANUAL_REVIEW' : 'UNKNOWN';
  }
  function locs(f) {
    if (Array.isArray(f.evidence) && f.evidence.length && typeof f.evidence[0] === 'object') return f.evidence.filter(function (e) { return e.where || e.line; }).map(function (e) { return { file: e.where || null, line: e.line || null }; });
    var l = [{ file: f.sourceFile || f.file || null, line: f.line || null }];
    (f.sourceLines || []).forEach(function (n) { if (n !== f.line) l.push({ file: f.sourceFile || f.file, line: n }); });
    return l;
  }
  function evText(f) { return (f.evidence || []).map(function (e) { return typeof e === 'string' ? e : e.text + (e.where ? ' [' + e.where + (e.line ? ':' + e.line : '') + ']' : ''); }); }

  M.unify = function (ws) {
    var list = [], props = ws.proposals || [], outOf = {}, lay = ACE.project.layout(ws), byId = {};
    ws.files.forEach(function (x) { byId[x.id] = x; });
    lay.files.forEach(function (l) { if (byId[l.fileId]) outOf[byId[l.fileId].vpath] = l.outPath; });
    function push(f, origin) {
      // A proposal belongs to this finding by id, or (after re-analysis, when ids change) by rule + file.
      var fOut = f.sourceFile || outOf[f.file] || null;
      var cand = props.filter(function (p) { return p.findingIds.indexOf(f.id) >= 0 || (fOut && p.ruleId === f.ruleId && p.outPath === fOut); });
      var cls = classOf(f), pr = cand.filter(function (p) { return p.status === 'applied'; })[0] || cand.filter(function (p) { return p.recommended; })[0] || cand[0];
      var diff = pr && pr.after ? ACE.diff.unified(pr.before, pr.after, 'a/' + pr.outPath, 'b/' + pr.outPath) : null;
      var urls = (f.refs || []).map(function (r) { return r.url; }).filter(Boolean);
      list.push({
        id: f.id, ruleId: f.ruleId, origin: origin, classification: cls, title: f.title, category: f.category || (origin === 'java17' ? 'Java 8 to 17' : 'ACE 12 to 13'),
        severity: f.severity, risk: f.risk || RISK[f.severity] || 'medium', confidence: f.confidence || 'medium', status: f.status,
        evidenceStatus: f.status === 'verified' ? 'verified by runtime probe (ACE 13.0.2.0 Java 17)' : f.status === 'documented' ? 'IBM/Oracle documentation' : f.status === 'observed' ? 'observed in the input' : f.status === 'verified-against-reference-jars' ? 'checked against imported API JARs' : 'heuristic (not an IBM rule)',
        locations: locs(f), evidence: evText(f), why: f.why, action: f.action, docUrls: urls, refs: f.refs || [],
        autoFix: pr ? { fixId: pr.fixId, status: pr.status, proposalId: pr.id, outPath: pr.outPath, reason: pr.reason || null } : (f.autofix ? { fixId: f.autofix, status: 'no-matching-source' } : null),
        autoFixIds: pr ? [pr].concat(ACE.transforms.alternatives(ws, pr)).map(function (p) { return p.id; }) : [],
        autoFixOptions: pr ? [pr].concat(ACE.transforms.alternatives(ws, pr)).map(function (p) { return { fixId: p.fixId, title: p.title, when: p.when, recommended: p.recommended, status: p.status }; }) : [],
        diff: diff, resolvedInWorkingCopy: !!f.resolvedInWorkingCopy, note: f.note || null, assumption: f.assumption || null,
        docVerification: f.docVerification ? f.docVerification.state : null
      });
    }
    // Source findings are reported per line by the Java analyser; one unified finding per rule and file.
    var merged = {}, j17 = [];
    ((ws.java17 && ws.java17.findings) || []).forEach(function (f) {
      if (f.source !== 'source') { j17.push(f); return; }
      var k = f.ruleId + '|' + f.file + '|' + !!f.resolvedInWorkingCopy;
      if (!merged[k]) { merged[k] = Object.assign({}, f, { evidence: f.evidence.slice(), sourceLines: [] }); j17.push(merged[k]); }
      else merged[k].evidence = util.uniq(merged[k].evidence.concat(f.evidence));
      merged[k].sourceLines.push(f.line);
    });
    j17.forEach(function (f) { if (f.sourceLines && f.sourceLines.length) { f.sourceLines.sort(function (a, b) { return a - b; }); f.line = f.sourceLines[0]; f.sourceFile = f.sourceFile || outOf[f.file] || f.file; } push(f, 'java17'); });
    (ws.aceFindings || []).forEach(function (f) { push(f, 'ace-rules'); });
    ((ws.migration && ws.migration.scanFindings) || []).forEach(function (f) { push(f, 'migration-scanner'); });
    var order = { high: 0, medium: 1, low: 2 };
    list.sort(function (a, b) { return (order[a.risk] - order[b.risk]) || M.CLASSES.indexOf(a.classification) - M.CLASSES.indexOf(b.classification) || a.title.localeCompare(b.title); });
    return list;
  };

  /* Version evidence: product JAR versions in the input vs. the strict source version. */
  M.versionEvidence = function (ws, deps) {
    var V_ = V(), ev = [], findings = [];
    deps.jars.forEach(function (j) {
      if (!j.implementationVersion || !/App Connect|Integration Bus|Message Broker/i.test(j.implementationTitle || '')) return;
      var ok = j.implementationVersion.indexOf(V_.sourcePrefix) === 0;
      ev.push({ source: j.locations.join(', '), value: j.implementationTitle + ' ' + j.implementationVersion, matchesSource: ok });
      if (!ok) findings.push(F({ ruleId: 'VER-SOURCE-MISMATCH', classification: 'MANUAL_REVIEW', severity: 'Warning', risk: 'medium', confidence: 'high', category: 'Versions',
        title: 'Input contains files from a different ACE level than ' + V_.source, why: 'Strict mode expects ' + V_.sourceLabel + '. ' + j.name + ' reports ' + j.implementationTitle + ' ' + j.implementationVersion + '.',
        action: 'Confirm the source level of the workspace. Findings in this report assume ' + V_.source + '.', evidence: [{ text: j.implementationVersion, where: j.locations.join(', ') }] }));
    });
    return { evidence: ev, findings: findings, declared: { source: V_.source, target: V_.target, mode: V_.mode },
      statement: ev.length ? (ev.every(function (e) { return e.matchesSource; }) ? 'Product JAR versions in the input match ' + V_.source + '.' : 'Some product JAR versions in the input do NOT match ' + V_.source + '.') : 'The input records no product version; ' + V_.source + ' is the configured (strict) source version.' };
  };

  M.analyze = function (ws) {
    var C = ctx(ws);
    var deps = M.dependencies(ws, C), rt = M.runtime(ws, C), art = M.artifacts(ws, C), conc = M.concurrency(ws, C), ver = M.versionEvidence(ws, deps);
    var mig = { at: util.nowIso(), versions: ver, inputKind: ws.inputKind || 'bar', dependencies: deps, runtime: rt, artifacts: art, concurrency: conc,
      scanFindings: [].concat(ver.findings, deps.findings, rt.findings, art.findings, conc.findings) };
    ws.migration = mig;
    mig.findings = M.unify(ws);
    mig.counts = {}; M.CLASSES.forEach(function (c) { mig.counts[c] = mig.findings.filter(function (f) { return f.classification === c; }).length; });
    mig.unresolvedRisks = mig.findings.filter(function (f) { return f.risk === 'high' && !f.resolvedInWorkingCopy && !(f.autoFix && f.autoFix.status === 'applied'); }).map(function (f) { return { id: f.id, ruleId: f.ruleId, classification: f.classification, title: f.title, location: f.locations[0] || null }; });
    mig.unverifiedAssumptions = (V().unverified || []).slice()
      .concat(mig.findings.filter(function (f) { return f.assumption; }).map(function (f) { return f.ruleId + ': ' + f.assumption; }))
      .concat(mig.findings.filter(function (f) { return f.status === 'documented' && f.docVerification && f.docVerification !== 'matched'; }).length ? ['Documented rules were checked online on 2026-10-20/21; without imported IBM documentation they cannot be re-confirmed offline (' + mig.findings.filter(function (f) { return f.status === 'documented'; }).length + ' finding(s)).'] : [])
      .concat(mig.findings.some(function (f) { return f.status === 'heuristic'; }) ? ['Findings with status "heuristic" are engineering judgement, not IBM rules.'] : []);
    mig.unverifiedAssumptions = util.uniq(mig.unverifiedAssumptions);
    return mig;
  };
})(window.ACE);
