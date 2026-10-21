/* Test cases. Synthetic fixtures run everywhere; tests marked requires:'bar' use the real BAR the
 * user selects; external tests need the IBM Toolkit/runtime. */
(function () {
  'use strict';
  var test = T.test, util = ACE.util;
  function file(bytes, name) { return new File([bytes], name || 'test.bar'); }
  async function load(bytes, name, limitsOver) {
    var limits = Object.assign({}, ACE.bar.DEFAULT_LIMITS, limitsOver || {});
    var ws = await ACE.bar.load(file(bytes, name), { limits: limits });
    ws.decompiled = {}; ws.decompileAttempts = []; ws.ws12 = { overlay: {}, changelog: [] }; ws.ws13 = { overlay: {}, changelog: [] };
    ACE.workflow.state.ws = ws; ACE.workflow.state.file = file(bytes, name);
    if (!ws.fatal) { await ACE.jars.analyzeWorkspace(ws, ACE.settings.current, {}); ACE.workflow.analyze(); }
    return ws;
  }
  function byPath(ws, p) { return ws.files.filter(function (f) { return f.vpath === p; })[0]; }
  async function unzip(blob) { var a = await ACE.zip.open(ACE.zip.bytesSource(new Uint8Array(await blob.arrayBuffer()))); var m = {}; for (var i = 0; i < a.entries.length; i++) m[a.entries[i].path] = await ACE.zip.extract(a, a.entries[i]); return m; }
  var KNOWN_CONTENTCREATE = { files: 133, containers: 6 };

  /* ---------- 1. archive inspection ---------- */
  test('T01', 'Valid BAR inspection (synthetic BAR with nested application and library)', { category: 'BAR inspection' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    a.ok(!ws.fatal, 'opened'); a.ok(ws.complete, 'extraction complete');
    a.eq(ws.containers.length, 3, 'containers (BAR, appzip, libzip)');
    a.ok(byPath(ws, 'Demo.appzip!/CommonLIB.libzip!/util/Helpers.esql'), 'backslash name normalised and found at nested path');
    a.eq(ws.model.deployables.map(function (d) { return d.type; }).join(','), 'application,static-library', 'deployable types');
    a.ok(ws.containers[2].backslashNames, 'backslash separators recorded');
    a.eq(byPath(ws, 'Demo.appzip!/Old.cmf').cls.category, 'binary', '.cmf classified binary-only');
    a.eq(byPath(ws, 'Demo.appzip!/Main.esql').cls.category, 'source', '.esql classified source');
  });
  test('T02', 'Real BAR inspection (user-supplied ACE 12 BAR)', { category: 'BAR inspection', requires: 'bar' }, async function (a, env) {
    var ws = await load(await util.readFileBytes(env.barFile), env.barFile.name);
    a.ok(!ws.fatal, 'opened'); a.ok(ws.complete, 'complete, all CRC-32 verified'); a.eq(ws.rejected.length, 0, 'no rejected entries');
    a.ok(ws.files.length > 0, ws.files.length + ' files'); a.ok(ws.containers.length > 1, ws.containers.length + ' containers');
    a.ok(ws.files.every(function (f) { return f.extracted; }), 'every entry extracted');
    if (env.barFile.name === 'ContentCreate.bar') { a.eq(ws.files.length, KNOWN_CONTENTCREATE.files, 'ContentCreate.bar file count (independently counted with unzip)'); a.eq(ws.containers.length, KNOWN_CONTENTCREATE.containers, 'ContentCreate.bar container count'); }
    a.note('deployables: ' + ws.model.deployables.map(function (d) { return d.name + ' (' + d.type + ')'; }).join(', '));
  });

  /* ---------- 2. corrupt archives ---------- */
  test('T03', 'Corrupt BAR handling: not a ZIP, truncated, bad CRC, bad local header, corrupt deflate', { category: 'Corrupt archives' }, async function (a) {
    var ws = await load(util.encodeUtf8('this is not a zip file at all, just text'), 'x.bar');
    a.ok(ws.fatal && ws.fatal.code === 'E_NO_EOCD', 'non-ZIP rejected: ' + (ws.fatal && ws.fatal.message));
    var good = await Fx.syntheticBar();
    ws = await load(good.subarray(0, Math.floor(good.length * 0.6)), 'trunc.bar');
    a.ok(ws.fatal, 'truncated BAR rejected: ' + (ws.fatal && ws.fatal.code));
    a.eq(ws.fatal && ws.fatal.code, 'E_EOCD_NOT_AT_END', 'regression: nested archive record inside a truncated BAR is not mistaken for the BAR itself');
    ws = await load(await Fx.rawZip([{ name: 'a.esql', data: 'CREATE COMPUTE MODULE A END MODULE;', crc: 12345 }]), 'crc.bar');
    a.ok(!ws.complete && /CRC/.test(byPath(ws, 'a.esql').extractError), 'CRC mismatch detected, entry not trusted');
    ws = await load(await Fx.rawZip([{ name: 'b.xml', data: '<a/>', badLocalSig: true }]), 'lh.bar');
    a.ok(/signature/i.test(byPath(ws, 'b.xml').extractError), 'bad local header detected');
    ws = await load(await Fx.rawZip([{ name: 'c.xml', data: '<a>hello hello hello</a>', method: 8, storeAs: new Uint8Array([0xFF, 0xFF, 0xFF, 0x00, 0x13]) }]), 'deflate.bar');
    a.ok(!ws.complete && byPath(ws, 'c.xml').extractError, 'corrupt deflate stream reported: ' + byPath(ws, 'c.xml').extractError);
  });
  test('T04', 'Unsupported compression method and encrypted entries are reported, not faked', { category: 'Corrupt archives' }, async function (a) {
    var ws = await load(await Fx.rawZip([{ name: 'bz.esql', data: 'x', method: 12 }, { name: 'enc.esql', data: 'x', flags: 0x0801 }, { name: 'ok.esql', data: 'fine' }]), 'm.bar');
    a.ok(/Unsupported compression method: bzip2/.test(byPath(ws, 'bz.esql').extractError), 'bzip2 reported');
    a.ok(/encrypted/i.test(byPath(ws, 'enc.esql').extractError), 'encryption reported');
    a.ok(byPath(ws, 'ok.esql').extracted, 'other entries still extracted'); a.ok(!ws.complete, 'workspace marked incomplete');
  });

  /* ---------- 3. extraction / missing source ---------- */
  test('T05', 'Source extraction: flows, ESQL, references, overrides', { category: 'Source extraction' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar'), f = ws.facts;
    a.eq(f.flows.length, 2, 'flow + subflow parsed');
    var main = f.flows.filter(function (x) { return x.name === 'Main'; })[0];
    a.eq(main.nodes.length, 6, 'nodes in Main.msgflow');
    a.ok(main.subflowRefs[0].resolvedTo && main.subflowRefs[0].resolvedTo[0] === 'CommonLIB/Common.subflow', 'subflow resolved across projects');
    a.ok(main.esqlRefs.filter(function (r) { return r.module === 'Main_Compute'; })[0].resolvedTo, 'ESQL module resolved');
    var http = f.nodes.filter(function (n) { return n.label === 'HTTP Request'; })[0];
    a.eq(http.effective.URLSpecifier, 'https://prod.example/x', 'broker.xml override applied to effective value');
    var e = f.esql.filter(function (x) { return x.vpath === 'Demo.appzip!/Main.esql'; })[0];
    a.eq(e.passthru.length, 1, 'one PASSTHRU (commented one ignored)'); a.eq(e.javaRoutines[0].external, 'com.example.Legacy.hash', 'LANGUAGE JAVA routine');
    a.ok(!f.endpoints.some(function (x) { return x.url === 'http://example.org/ns'; }), 'targetNamespace not reported as endpoint');
    a.eq(ACE.esql.parse('BROKER SCHEMA\nCREATE COMPUTE MODULE X\nEND MODULE;', 'x.esql').schema, '', 'regression: empty BROKER SCHEMA does not swallow the next keyword');
    a.eq(ACE.esql.parse('BROKER SCHEMA eg.adib.util\nCREATE COMPUTE MODULE X\nEND MODULE;', 'x.esql').schema, 'eg.adib.util', 'dotted schema parsed');
  });
  test('T06', 'Missing source artifacts are reported (unresolved module, .cmf, binary-only Java)', { category: 'Missing source' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var ids = ws.aceFindings.map(function (f) { return f.ruleId; });
    a.ok(ws.facts.unresolved.some(function (u) { return u.ref === 'Missing_Module'; }), 'unresolved ESQL module Missing_Module');
    a.ok(ids.indexOf('ACE13-UNRESOLVED') >= 0, 'ACE13-UNRESOLVED finding'); a.ok(ids.indexOf('ACE13-CMF') >= 0, 'compiled flow without source flagged');
    a.ok(ids.indexOf('ACE13-BINARY-JAVA') >= 0, 'binary-only Java flagged');
    var lay = ACE.project.layout(ws);
    a.ok(!lay.files.some(function (l) { return /Missing_Module/.test(l.outPath); }), 'no file fabricated for the missing module');
  });

  /* ---------- 4. JARs ---------- */
  test('T07', 'Nested JAR detection', { category: 'Java archives' }, async function (a) {
    var inner = await Fx.jar({ 'x/A.class': Fx.classFile({ name: 'x/A' }) });
    var outer = await Fx.jar({ 'BOOT-INF/lib/inner.jar': inner, 'y/B.class': Fx.classFile({ name: 'y/B' }) });
    var info = await ACE.jars.inspect('outer.jar', outer);
    a.eq(info.nestedJars.length, 1, 'nested JAR found'); a.eq(info.nestedJars[0].path, 'BOOT-INF/lib/inner.jar', 'nested JAR path'); a.eq(info.classCount, 1, 'outer classes only counted');
  });
  test('T08', 'Driver JAR exclusion (content-based, not filename-only) and manual overrides', { category: 'Driver exclusion' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var drv = ws.jars.filter(function (j) { return j.name === 'postgresql-42.jar'; })[0];
    a.eq(drv.classification.type, 'driver', 'PostgreSQL detected'); a.eq(drv.classification.driverId, 'postgresql', 'driver id');
    a.ok(drv.classification.evidence.some(function (e) { return /services\/java\.sql\.Driver/.test(e); }), 'evidence includes service registration');
    a.eq(drv.decision.selected, false, 'driver NOT selected by default');
    var renamed = await ACE.jars.inspect('innocent-utils.jar', await Fx.jar({ 'META-INF/services/java.sql.Driver': 'org.postgresql.Driver\n', 'org/postgresql/Driver.class': Fx.classFile({ name: 'org/postgresql/Driver', interfaces: ['java/sql/Driver'] }) }));
    a.eq(ACE.jars.classify(renamed).type, 'driver', 'renamed driver still detected from content');
    var fake = await ACE.jars.inspect('ojdbc8.jar', await Fx.jar({ 'com/acme/App.class': Fx.classFile({ name: 'com/acme/App' }) }));
    var fc = ACE.jars.classify(fake);
    a.ok(fc.type !== 'driver', 'filename alone does not make a driver (got ' + fc.type + ')');
    var rec = { name: 'ojdbc8.jar', sha256: 'abc', info: fake, classification: fc };
    a.eq(ACE.jars.decide(rec, ACE.settings.current).excludedBy, 'user-exclusion', 'default exclusion pattern still excludes it, with reason');
    var s2 = util.deepClone(ACE.settings.current); s2.jarOverrides = { abc: 'include' };
    a.eq(ACE.jars.decide(rec, s2).selected, true, 'manual include override');
    var ex = ACE.reports.exclusions(ws);
    a.ok(ex.excluded.some(function (x) { return x.name === 'postgresql-42.jar' && x.preservedAt.length; }), 'exclusion report lists driver and where it is preserved');
  });

  /* ---------- 5. Java source recovery (built-in decompiler on real javac bytecode) ---------- */
  async function corpus(which) { return ACE.jars.inspect('corpus.jar', util.base64ToBytes(which === 'nodebug' ? FxClasses.corpusNoDebugJar : FxClasses.corpusDebugJar)); }
  function byClass(res, n) { return res.results.filter(function (r) { return r.className === n; })[0]; }
  test('T09', 'Decompile real javac 1.8 bytecode WITH debug info into Java source', { category: 'Decompilation' }, async function (a) {
    var info = await corpus('debug'), res = ACE.decompiler.decompileJar(info);
    ['corpus/Arith', 'corpus/Flow', 'corpus/Objects2'].forEach(function (n) {
      var r = byClass(res, n);
      a.eq(r && r.status, 'complete', n + ' fully decompiled');
      a.eq(r.path, n + '.java', n + ' path follows its package');
      a.ok(ACE.syntaxCheck(r.source).ok, n + ' passes the syntax check');
    });
    var flow = byClass(res, 'corpus/Flow').source;
    ['package corpus;', 'switch (', 'case 2:', 'finally {', 'synchronized (lock)', 'catch (ClassCastException | ArithmeticException e)', 'break label0;', 'j < n && j <= i', 'for (int i = 0;'].forEach(function (frag) { a.ok(flow.indexOf(frag) >= 0, 'Flow.java contains "' + frag + '"'); });
    var obj = byClass(res, 'corpus/Objects2').source;
    ['abstract static class Base implements Objects2.Shape', 'default String label()', 'super("rect");', 'this(s, s);', 'int... xs', 'Map<String, List<Integer>> group(int[] xs)'].forEach(function (frag) { a.ok(obj.indexOf(frag) >= 0, 'Objects2.java contains "' + frag + '"'); });
    a.ok(byClass(res, 'corpus/Arith').source.indexOf("'\\''") >= 0, 'char literal preserved');
    a.note('Development verification (outside the browser): these sources were recompiled with javac and printed exactly the same output as the original bytecode - see docs/DECOMPILER-VALIDATION.md');
  });
  test('T10', 'Decompile bytecode WITHOUT debug info (javac -g:none)', { category: 'Decompilation' }, async function (a) {
    var info = await corpus('nodebug'), res = ACE.decompiler.decompileJar(info);
    ['corpus/Arith', 'corpus/Flow', 'corpus/Objects2'].forEach(function (n) {
      var r = byClass(res, n);
      a.eq(r && r.status, 'complete', n + ' fully decompiled without LocalVariableTable');
      a.ok(ACE.syntaxCheck(r.source).ok, n + ' passes the syntax check');
    });
    a.ok(/boolean var\d+ = /.test(byClass(res, 'corpus/Flow').source), 'boolean locals inferred without debug info');
  });
  test('T10b', 'Unsupported constructs are labelled, never faked (lambda, inner, anonymous class)', { category: 'Decompilation' }, async function (a) {
    var info = await corpus('debug'), res = ACE.decompiler.decompileJar(info);
    var u = byClass(res, 'corpus/Unsupported');
    a.eq(u.status, 'partial', 'class with a lambda is PARTIAL, not complete');
    var m = u.methods.filter(function (x) { return x.name === 'main'; })[0];
    a.ok(m.status === 'failed' && /invokedynamic/.test(m.reason), 'main() not recovered, reason: ' + m.reason);
    a.ok(/WORKBENCH DECOMPILER: this method body could NOT be decompiled/.test(u.source) && /invokedynamic/.test(u.source), 'source carries the reason and the bytecode listing');
    a.ok(/throw new UnsupportedOperationException\("Method body not recovered/.test(u.source), 'placeholder body clearly marked');
    a.ok(/int plain\(int x\) \{\s*return x \* 2;/.test(u.source), 'the other method is still recovered');
    var anon = byClass(res, 'corpus/Unsupported$1');
    a.ok(anon && anon.status === 'failed' && !anon.source, 'anonymous class reported as failed, no file produced');
    a.ok(u.notes.some(function (n) { return /inner \(non-static\) class In not reconstructed/.test(n); }), 'inner class reported');
  });
  test('T10c', 'Corrupt class files and empty JARs are reported', { category: 'Decompilation' }, async function (a) {
    var bad = await ACE.jars.inspect('bad.jar', await Fx.jar({ 'x/Broken.class': new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE, 0, 0, 0, 52, 0, 9, 1]) }));
    a.eq(bad.parseErrors.length, 1, 'truncated class detected: ' + bad.parseErrors[0].error);
    var r = ACE.decompiler.decompileJar(bad);
    a.ok(r.results.length === 1 && r.results[0].status === 'failed' && !r.results[0].source, 'failed class produces no .java file');
    var empty = await ACE.jars.inspect('empty.jar', await Fx.jar({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\n' }));
    var cls = ACE.jars.classify(empty);
    a.eq(cls.type, 'no-classes', 'empty JAR classified as having no classes');
    a.eq(ACE.jars.decide({ name: 'empty.jar', sha256: 'e', info: empty, classification: cls }, ACE.settings.current).eligible, false, 'empty JAR not eligible for decompilation');
    a.eq(ACE.decompiler.decompileJar(empty).results.length, 0, 'no source produced for an empty JAR');
  });

  /* ---------- 6. preservation ---------- */
  test('T11', 'ESQL and XML preserved byte-for-byte in exports (incl. windows-1252 text)', { category: 'Preservation' }, async function (a) {
    var bar = await Fx.syntheticBar(), ws = await load(bar, 'Demo.bar');
    var pk = await ACE.project.buildPackage(ws, 'ace12', { facts: ws.facts });
    var z = await unzip(pk.blob);
    ['Main.esql', 'Main.msgflow', 'Latin1.esql', 'S.wsdl', 'application.descriptor'].forEach(function (n) {
      a.ok(util.bytesEqual(z['Demo/' + n], byPath(ws, 'Demo.appzip!/' + n).bytes), n + ' identical');
    });
    a.ok(util.bytesEqual(z['CommonLIB/util/Helpers.esql'], byPath(ws, 'Demo.appzip!/CommonLIB.libzip!/util/Helpers.esql').bytes), 'library ESQL identical');
    a.ok(util.bytesEqual(z['Demo/Latin1.esql'], Fx.ESQL_1252), 'non-UTF-8 bytes untouched');
    a.eq(byPath(ws, 'Demo.appzip!/Latin1.esql').encoding || (ACE.bar.text(byPath(ws, 'Demo.appzip!/Latin1.esql')), byPath(ws, 'Demo.appzip!/Latin1.esql').encoding), 'windows-1252 (not valid UTF-8)', 'encoding detected honestly');
  });

  /* ---------- 7. Java analysis ---------- */
  test('T12', 'Java 8 compatibility findings from bytecode', { category: 'Java 8 analysis' }, async function (a) {
    var cf = ACE.java.parseClass(Fx.legacyClass());
    a.eq(cf.major, 52, 'major version 52'); a.eq(cf.javaVersion, '8', 'Java 8');
    var ids = ACE.java17.analyzeClass(cf, window.ACE_JAVA_RULES.rules, { jarVPath: 'x.jar', jarName: 'x.jar', scope: 'application' }).map(function (f) { return f.ruleId; });
    ['J17-IBM-MISC', 'J17-SUN-BASE64', 'J17-JAVAEE-REMOVED', 'J17-IBM-PROVIDER', 'J17-IBM-TLS-NAMES', 'J17-BOXED-CTOR', 'J17-CLASSVERSION-OLD'].forEach(function (id) { a.ok(ids.indexOf(id) >= 0, id); });
    var newer = ACE.java.parseClass(Fx.classFile({ name: 'N', major: 65 }));
    a.ok(ACE.java17.analyzeClass(newer, window.ACE_JAVA_RULES.rules, { jarVPath: 'n', scope: 'application' }).some(function (f) { return f.ruleId === 'J17-CLASSVERSION-NEW'; }), 'Java 21 class flagged as not loadable on 17');
  });
  test('T13', 'Java 17 migration: source findings with line numbers and reviewed fixes', { category: 'Java 17 migration' }, async function (a) {
    var fs = ACE.java17.analyzeSource(Fx.LEGACY_JAVA, 'Legacy.java', window.ACE_JAVA_RULES.rules, { scope: 'application' });
    var misc = fs.filter(function (f) { return f.ruleId === 'J17-IBM-MISC'; });
    a.ok(misc.length && misc[0].line === 3, 'com.ibm.misc import found at line 3');
    a.ok(fs.some(function (f) { return f.ruleId === 'J17-IBM-PROVIDER' && f.line === 13; }), '"IBMJCE" literal at line 13');
    var r1 = ACE.transforms.FIXES['base64-legacy-encoder'].apply(Fx.LEGACY_JAVA);
    a.ok(r1.ok && !/BASE64Encoder/.test(r1.text.replace(/\/\/.*$/mg, '')) && /legacyBase64Encode\(b\)/.test(r1.text), 'BASE64Encoder replaced by helper');
    var r2 = ACE.transforms.FIXES['drop-ibm-provider'].apply(r1.text);
    a.ok(r2.ok && /getInstance\("AES\/ECB\/PKCS5Padding"\)/.test(r2.text), 'provider argument removed');
    a.ok(!/NoSuchProviderException/.test(r2.text), 'NoSuchProviderException removed from multi-catch and imports');
    var bad = ACE.transforms.FIXES['base64-legacy-encoder'].apply('class X { void f(java.io.InputStream i, java.io.OutputStream o) throws Exception { new com.ibm.misc.BASE64Encoder().encodeBuffer(i, o); } }');
    a.ok(!bad.ok, 'fix refuses unsupported usage (encodeBuffer): ' + bad.reason);
    a.ok(ACE.java17.analyzeSource('class Y { java.util.function.Function<String,String> f = _ -> "x"; }', 'Y.java', window.ACE_JAVA_RULES.rules, {}).some(function (f) { return f.ruleId === 'J17-UNDERSCORE'; }), '"_" identifier flagged');
  });
  test('T14', 'Fix workflow: proposal, diff, confirm/apply, change log, undo', { category: 'Java 17 migration' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var jr = ws.jars.filter(function (j) { return j.classification.type === 'application'; })[0];
    // genuine source supplied by the user for this JAR (labelled as imported)
    var imp = await ACE.workflow.importSources(jr, [new File([Fx.LEGACY_JAVA], 'Legacy.java')]);
    a.eq(imp.accepted, 1, 'source matched to class com.example.Legacy');
    var p = ws.proposals.filter(function (x) { return x.fixId === 'base64-legacy-encoder' && x.status === 'proposed'; })[0];
    a.ok(p && p.diff.some(function (d) { return d.op === '+'; }), 'proposal with diff');
    a.ok(!ws.ws13.overlay[p.outPath], 'nothing applied before confirmation');
    ACE.transforms.apply(ws, p); ACE.workflow.analyze();
    a.ok(ws.ws13.overlay[p.outPath] && /legacyBase64Encode/.test(ws.ws13.overlay[p.outPath].text), 'applied to ACE 13 working copy');
    a.ok(ws.ws13.changelog.some(function (c) { return c.action === 'applied' && c.unified; }), 'change log entry with unified diff');
    a.eq(ws.decompiled[jr.sha256].files[0].text, Fx.LEGACY_JAVA, 'imported original kept unchanged');
    ACE.transforms.undo(ws, 'ws13', p.outPath);
    a.ok(!ws.ws13.overlay[p.outPath], 'undo restores original');
    a.ok(ws.ws13.changelog.some(function (c) { return c.action === 'undone'; }), 'undo recorded');
    a.eq(ws.decompiled[jr.sha256].mode, 'imported', 'imported source labelled as imported, not decompiled');
  });
  test('T15', 'Real BAR: FrameworkJPrj-style Eclipse project with genuine .java files', { category: 'Java source recovery', requires: 'bar' }, async function (a, env) {
    var ws = await load(await util.readFileBytes(env.barFile), env.barFile.name);
    var sel = ws.jars.filter(function (j) { return j.decision.selected; });
    a.ok(sel.length >= 1, 'application JAR(s) selected: ' + sel.map(function (j) { return j.name; }).join(', '));
    ws.jars.filter(function (j) { return j.classification.type === 'driver'; }).forEach(function (d) { a.ok(!d.decision.selected, 'driver ' + d.name + ' excluded'); });
    await ACE.workflow.decompile(sel, new util.CancelToken());
    sel.forEach(function (j) {
      var rec = ws.decompiled[j.sha256];
      a.eq(rec.stats.complete, j.info.classes.filter(function (c) { return c.name.indexOf('$') < 0; }).length, j.name + ': every top-level class decompiled completely');
      rec.results.forEach(function (r) { a.ok(ACE.syntaxCheck(r.source).ok, r.path + ' syntax check'); });
    });
    if (env.barFile.name === 'ContentCreate.bar') {
      var fj = ws.jars.filter(function (j) { return j.name === 'FrameworkJPrj.jar'; })[0];
      var z = await ACE.eclipse.zip(ws, fj, { projectName: 'FrameworkJPrj', keepOriginalJar: true, includeExcluded: true });
      var m = await unzip(z.blob), names = Object.keys(m).sort();
      a.note('ZIP: ' + names.join(', '));
      ['FrameworkJPrj/.project', 'FrameworkJPrj/.classpath', 'FrameworkJPrj/.settings/org.eclipse.jdt.core.prefs',
        'FrameworkJPrj/src/FrameworkLib.java', 'FrameworkJPrj/src/LoadServiceConfig.java', 'FrameworkJPrj/src/eg/adib/uti/security/SecurityUtil.java',
        'FrameworkJPrj/bin/FrameworkLib.class', 'FrameworkJPrj/bin/LoadServiceConfig.class', 'FrameworkJPrj/bin/eg/adib/uti/security/SecurityUtil.class',
        'FrameworkJPrj/Lib/jconn2.jar', 'FrameworkJPrj/Lib/FrameworkJPrj.jar'].forEach(function (p) { a.ok(m[p], p); });
      var su = util.decodeText(m['FrameworkJPrj/src/eg/adib/uti/security/SecurityUtil.java']).text;
      a.ok(/^package eg\.adib\.uti\.security;/m.test(su) && /public static String hmacDigest\(byte\[\] msg, String keyString, String algo, String codeCharSet\)/.test(su), 'SecurityUtil.java has its package and real method bodies');
      a.ok(util.bytesEqual(m['FrameworkJPrj/bin/eg/adib/uti/security/SecurityUtil.class'], fj.info.classes.filter(function (c) { return c.name === 'eg/adib/uti/security/SecurityUtil'; })[0].bytes), 'bin/ class is byte-identical to the JAR entry');
      a.ok(names.every(function (n) { return !(/\.java$/.test(n) && util.bytesEqual(m[n].subarray(0, 4), new Uint8Array([0xCA, 0xFE, 0xBA, 0xBE]))); }), 'no .java file contains bytecode');
      var cp = util.decodeText(m['FrameworkJPrj/.classpath']).text;
      a.ok(/kind="src" path="src"/.test(cp) && /kind="output" path="bin"/.test(cp) && /path="Lib\/jconn2\.jar"/.test(cp) && !/path="Lib\/FrameworkJPrj\.jar"/.test(cp), '.classpath: src, bin, Lib/jconn2.jar; original JAR not on build path');
      a.ok(/javanature/.test(util.decodeText(m['FrameworkJPrj/.project']).text), '.project has the Java nature');
    }
  });

  test('T16', 'Unsafe archive paths are rejected', { category: 'Archive safety' }, async function (a) {
    var ws = await load(await Fx.rawZip([{ name: '../../outside.txt', data: 'x' }, { name: '..\\..\\win.txt', data: 'x' }, { name: '/etc/passwd', data: 'x' }, { name: 'C:\\Windows\\x.dll', data: 'x' }, { name: 'ok/../../up.txt', data: 'x' }, { name: 'safe/inside.esql', data: 'ok' }]), 'evil.bar');
    a.eq(ws.rejected.length, 5, 'five unsafe entries rejected');
    a.eq(ws.files.length, 1, 'only the safe entry extracted'); a.eq(ws.files[0].path, 'safe/inside.esql', 'safe entry path');
    ws.rejected.forEach(function (r) { a.note(r.rawName + ' -> ' + r.reason); });
    a.ok(ACE.zip.sanitizePath('a/./b//c.txt').path === 'a/b/c.txt', 'harmless "." and "//" normalised');
    var w = new ACE.zip.Writer(); var threw = false; try { w.add('../x', 'y'); } catch (e) { threw = true; } a.ok(threw, 'writer refuses unsafe output path');
  });
  test('T17', 'Duplicate filenames: never silently overwritten', { category: 'Archive safety' }, async function (a) {
    var ws = await load(await Fx.rawZip([{ name: 'App.esql', data: 'first' }, { name: 'App.esql', data: 'second' }, { name: 'app.ESQL', data: 'third' }]), 'dup.bar');
    a.eq(ws.files.length, 3, 'all three kept');
    var d = ws.files.filter(function (f) { return f.duplicate; });
    a.eq(d.length, 1, 'exact duplicate flagged'); a.eq(util.decodeText(d[0].bytes).text, 'second', 'second copy kept separately');
    a.ok(ws.files.some(function (f) { return f.issues.some(function (i) { return i.code === 'W_CASE_COLLISION'; }); }), 'case collision warned');
    var w = new ACE.zip.Writer(); w.add('A/x.txt', '1'); var threw = false; try { w.add('a/X.txt', '2'); } catch (e) { threw = true; } a.ok(threw, 'writer refuses colliding output paths');
  });

  /* ---------- 9. exports ---------- */
  test('T18', 'ACE 12 export package', { category: 'ACE 12 export' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var pk = await ACE.workflow.exportPackage('ace12'), z = await unzip(pk.blob);
    a.ok(z['Demo/.project'] && /applicationNature/.test(util.decodeText(z['Demo/.project']).text), 'application .project generated');
    a.ok(/NOT the original Toolkit metadata/.test(util.decodeText(z['Demo/.project']).text), 'generated metadata is labelled');
    a.ok(/<project>CommonLIB<\/project>/.test(util.decodeText(z['Demo/.project']).text), 'static library referenced');
    a.ok(z['CommonLIB/.project'] && /libraryNature/.test(util.decodeText(z['CommonLIB/.project']).text), 'library .project generated');
    a.ok(z['Demo/legacy.jar'] && z['Demo/postgresql-42.jar'], 'original JARs (incl. excluded driver) preserved');
    a.ok(z['_bar-metadata/Demo/META-INF/broker.xml'], 'BAR metadata preserved outside projects');
    var m = JSON.parse(util.decodeText(z['MANIFEST.json']).text);
    a.ok(m.files.every(function (f) { return f.origin; }), 'every manifest entry has an origin');
    a.ok(m.files.filter(function (f) { return f.origin === 'original'; }).every(function (f) { return !f.sha256 || f.sha256.length === 64; }), 'originals carry sha256');
    a.ok(z['_workbench/IMPORT-INSTRUCTIONS.txt'] && z['_workbench/EXTRACTION-REPORT.json'], 'instructions and extraction report included');
  });
  test('T19', 'ACE 13 export package with approved change', { category: 'ACE 13 export' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var jr = ws.jars.filter(function (j) { return j.classification.type === 'application'; })[0];
    await ACE.workflow.importSources(jr, [new File([Fx.LEGACY_JAVA], 'Legacy.java')]);
    var p = ws.proposals.filter(function (x) { return x.status === 'proposed'; })[0];
    ACE.transforms.apply(ws, p); ACE.workflow.analyze();
    var pk = await ACE.workflow.exportPackage('ace13'), z = await unzip(pk.blob);
    a.ok(z['legacy/src/com/example/Legacy.java'], 'Java project with source');
    a.ok(z['legacy/bin/com/example/Legacy.class'], 'original class in bin/');
    a.ok(/compliance=17/.test(util.decodeText(z['legacy/.settings/org.eclipse.jdt.core.prefs']).text), 'Java 17 compliance for ACE 13');
    a.ok(/JavaSE-17/.test(util.decodeText(z['legacy/.classpath']).text), 'JavaSE-17 JRE container');
    a.ok(z['_original-before-changes/legacy/src/com/example/Legacy.java'], 'unchanged copy preserved');
    ['MIGRATION-REPORT.json', 'MIGRATION-CHECKLIST.txt', 'CHANGE-LOG.txt', 'COMPATIBILITY-REPORT.json', 'IMPORT-INSTRUCTIONS.txt'].forEach(function (n) { a.ok(z['_workbench/' + n], n); });
    a.ok(/APPLIED/.test(util.decodeText(z['_workbench/CHANGE-LOG.txt']).text), 'change log lists the applied fix');
    var rep = JSON.parse(util.decodeText(z['_workbench/MIGRATION-REPORT.json']).text);
    a.ok(/cannot prove runtime compatibility/.test(rep.disclaimer), 'report states static analysis limits');
    a.ok(rep.findings.some(function (f) { return f.ruleId === 'ACE13-WSSEC-JAVA17'; }) && rep.findings.some(function (f) { return f.ruleId === 'ACE13-SSL-IBMNAMES'; }), 'ACE 13 rule findings present');
    a.ok(rep.checklist.some(function (c) { return /compile for Java 17/.test(c.title) && c.status === 'toolkit'; }), 'Java 17 compilation honestly marked as not performed');
  });
  test('T23', 'Eclipse project generator: src / bin / Lib layout and evidence-based metadata', { category: 'Project generation' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var jr = ws.jars.filter(function (j) { return j.classification.type === 'application'; })[0];
    await ACE.workflow.decompile([jr], new util.CancelToken());
    var r = ACE.eclipse.files(ws, jr, { projectName: 'LegacyPrj', includeExcluded: true });
    var paths = r.files.map(function (f) { return f.path; });
    ['LegacyPrj/.project', 'LegacyPrj/.classpath', 'LegacyPrj/.settings/org.eclipse.jdt.core.prefs', 'LegacyPrj/src/com/example/Legacy.java', 'LegacyPrj/bin/com/example/Legacy.class', 'LegacyPrj/Lib/postgresql-42.jar', 'LegacyPrj/Lib/legacy.jar'].forEach(function (p) { a.ok(paths.indexOf(p) >= 0, p); });
    a.ok(r.files.filter(function (f) { return /\.java$/.test(f.path); }).every(function (f) { return typeof f.data === 'string' && /class Legacy/.test(f.data); }), '.java files hold Java text, not bytecode');
    var cp = r.files.filter(function (f) { return /\.classpath$/.test(f.path); })[0].data;
    a.ok(/Lib\/postgresql-42\.jar/.test(cp), 'driver JAR on the build path as a dependency');
    a.ok(!/Lib\/legacy\.jar/.test(cp), 'original application JAR kept in Lib but not on the build path');
    a.ok(/1\.8/.test(r.files.filter(function (f) { return /prefs$/.test(f.path); })[0].data), 'compiler level 1.8 from class-file major 52');
    a.ok(r.plan.reasons.length === 3, 'each generated file has a recorded reason');
  });

  test('T20', 'Documentation import changes rule verification state', { category: 'Rules' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var r = window.ACE_ACE_RULES.rules.filter(function (x) { return x.id === 'ACE13-ODBC'; })[0];
    a.eq(ACE.aceRules.docVerification(r, []).state, 'unverified', 'no docs -> unverified');
    a.eq(ACE.aceRules.docVerification(r, [{ name: 'premig.html', text: 'If you use databases, create ODBC definitions for the databases' }]).state, 'matched', 'keyword found -> matched');
    a.eq(ACE.aceRules.docVerification(r, [{ name: 'other.html', text: 'unrelated' }]).state, 'not-found', 'keyword missing -> not-found');
    var bad = false; try { ACE.ui.validateRuleSet({ id: 'x', rules: [{ id: 'R', severity: 'Fatal', title: 't', match: {} }] }); } catch (e) { bad = true; } a.ok(bad, 'invalid user rule rejected');
    var rs = ACE.ui.validateRuleSet({ id: 'custom', rules: [{ id: 'C1', severity: 'Warning', title: 'Uses TESTDSN', match: { attrMatches: { dataSource: '^TESTDSN$' } } }] });
    a.eq(ACE.aceRules.evaluate(ws.facts, rs, ws, []).length, 1, 'user rule evaluated'); a.eq(rs.rules[0].status, 'heuristic', 'user rule defaults to heuristic');
  });

  /* ---------- 10. offline & large files ---------- */
  test('T21', 'Offline operation: no external resources loaded', { category: 'Offline' }, async function (a) {
    // external = another origin than this page (file://, localhost or the hosting site itself are all "own")
    function external(u) { return /^https?:/.test(u) && !/^https?:\/\/(127\.0\.0\.1|localhost)[:\/]/.test(u) && (location.protocol === 'file:' || u.indexOf(location.origin + '/') !== 0); }
    var scripts = Array.prototype.map.call(document.scripts, function (s) { return s.src; }).filter(Boolean);
    a.ok(scripts.every(function (s) { return !external(s); }), scripts.length + ' scripts, all from this site');
    var res = performance.getEntriesByType('resource').map(function (e) { return e.name; }).filter(external);
    a.eq(res.length, 0, 'no requests to external hosts');
    a.note('page protocol: ' + location.protocol + (location.protocol === 'file:' ? ' (opened directly from disk)' : ''));
    var c = util.capabilities(); a.ok(c.deflateRaw, 'native DecompressionStream("deflate-raw") available');
  });
  test('T22', 'Large files: limits enforced, ZIP-bomb ratio warned, cancellation works', { category: 'Large files' }, async function (a) {
    var big = new Uint8Array(24 * 1048576); // 24 MB of zeros, deflates to a few KB
    var bar = await Fx.rawZip([{ name: 'big.xml', data: big, method: 8 }, { name: 'small.esql', data: 'x' }]);
    a.ok(bar.length < 200000, 'fixture is ' + bar.length + ' bytes compressed');
    var ws = await load(bar, 'big.bar', { maxFileSize: 8 * 1048576, maxRatio: 100 }); // deflate tops out near 1032:1, so test the threshold below that
    a.ok(/exceeds the per-file limit/.test(byPath(ws, 'big.xml').extractError), 'per-file limit enforced');
    a.ok(byPath(ws, 'small.esql').extracted, 'other entries still processed');
    a.ok(byPath(ws, 'big.xml').issues.some(function (i) { return i.code === 'W_RATIO'; }), 'compression-ratio warning');
    ws = await load(bar, 'big.bar', { maxTotalSize: 1048576 });
    a.ok(/Total extraction limit/.test(byPath(ws, 'big.xml').extractError), 'total limit enforced');
    var tok = new util.CancelToken();
    var p = ACE.bar.load(file(await Fx.syntheticBar(), 'c.bar'), { cancel: tok, progress: function () { tok.cancel('test cancel'); } });
    await a.throwsAsync(function () { return p; }, /test cancel/, 'load cancelled cooperatively');
  });

  /* ---------- Project Explorer & ZIP export ---------- */
  function findNode(list, labels) {
    var cur = { children: list };
    for (var i = 0; i < labels.length; i++) { cur = cur.children.filter(function (c) { return c.label === labels[i]; })[0]; if (!cur) return null; }
    return cur;
  }
  test('T24', 'Project Explorer: Toolkit-style tree generated from the workspace', { category: 'Project Explorer' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var jr = ws.jars.filter(function (j) { return j.classification.type === 'application'; })[0];
    await ACE.workflow.decompile([jr], new util.CancelToken());
    var m = ACE.explorer.build(ws);
    a.ok(findNode(m.roots, ['Demo', 'Message Flows', 'Main.msgflow']), 'Demo > Message Flows > Main.msgflow');
    a.ok(findNode(m.roots, ['Demo', 'ESQLs', 'Main.esql']), 'Demo > ESQLs > Main.esql');
    a.ok(findNode(m.roots, ['CommonLIB', 'ESQLs', 'util', 'Helpers.esql']), 'ESQL grouped under its BROKER SCHEMA "util"');
    a.ok(findNode(m.roots, ['CommonLIB', 'Subflows', 'Common.subflow']), 'CommonLIB > Subflows > Common.subflow');
    a.ok(findNode(m.roots, ['Demo', 'Interfaces', 'S.wsdl']), 'WSDL under Interfaces');
    a.ok(findNode(m.roots, ['Demo', 'Java', 'legacy', 'com.example', 'Legacy.java']), 'Demo > Java > legacy > com.example > Legacy.java (package from the declaration)');
    a.ok(findNode(m.roots, ['Demo', 'Included Libraries', 'CommonLIB']), 'Included Libraries > CommonLIB');
    a.ok(findNode(m.roots, ['Demo', 'Other Resources', 'legacy', 'Lib', 'postgresql-42.jar']), 'Other Resources > legacy > Lib > driver JAR');
    a.ok(findNode(m.roots, ['Demo', 'Other Resources', 'postgresql-42.jar']), 'the library\'s own JAR under Other Resources');
    a.ok(!m.roots.some(function (r) { return r.label === 'legacy'; }), 'Java project shown inside its library/application only (no separate src root), as in the Toolkit');
    var jpOther = findNode(m.roots, ['Demo', 'Other Resources', 'legacy']);
    a.ok(jpOther.children.filter(function (c) { return c.label === 'bin' || c.label === '.settings' || c.label === '.classpath' || c.label === '.project'; }).every(function (c) { return c.hidden; }), 'bin, .settings, .classpath, .project hidden in the tree (Toolkit view)');
    var jpLeaves = m.javaProjects.filter(function (j) { return j.name === 'legacy'; })[0].leaves.map(function (l) { return l.path; });
    a.ok(jpLeaves.indexOf('legacy/bin/com/example/Legacy.class') >= 0 && jpLeaves.indexOf('legacy/.classpath') >= 0, 'hidden files are still part of the project export');
    var names = m.roots.map(function (r) { return r.label; }).filter(function (x) { return !/BAR metadata/.test(x); });
    a.eq(names.join(','), names.slice().sort(function (x, y) { return x.toLowerCase().localeCompare(y.toLowerCase()); }).join(','), 'projects listed alphabetically like the Toolkit');
    var leaf = findNode(m.roots, ['Demo', 'Java', 'legacy', 'com.example', 'Legacy.java']);
    a.eq(leaf.path, 'legacy/src/com/example/Legacy.java', 'logical grouping keeps the real export path');
    a.eq(ACE.explorer.javaPackage('// package fake.one;\n/* package fake.two; */\npackage real.pkg;\nclass X { String s = "package nope;"; }'), 'real.pkg', 'package read from the declaration, ignoring comments');
    a.eq(ACE.explorer.javaPackage('class NoPkg {}'), null, 'no declaration -> (default package)');
  });
  test('T24b', 'Project Explorer on the real BAR: FrameworkLIB layout like the Toolkit', { category: 'Project Explorer', requires: 'bar' }, async function (a, env) {
    var ws = await load(await util.readFileBytes(env.barFile), env.barFile.name);
    await ACE.workflow.decompile(ws.jars.filter(function (j) { return j.decision.selected; }), new util.CancelToken());
    if (env.barFile.name !== 'ContentCreate.bar') { a.ok(ACE.explorer.build(ws).roots.length > 0, 'tree built'); return; }
    var m = ACE.explorer.build(ws), R = m.roots;
    a.ok(findNode(R, ['FrameworkLIB', 'Subflows']) && findNode(R, ['FrameworkLIB', 'ESQLs']), 'FrameworkLIB > Subflows, ESQLs');
    a.ok(findNode(R, ['FrameworkLIB', 'Java', 'FrameworkJPrj', '(default package)', 'FrameworkLib.java']), 'Java > FrameworkJPrj > (default package) > FrameworkLib.java');
    a.ok(findNode(R, ['FrameworkLIB', 'Java', 'FrameworkJPrj', '(default package)', 'LoadServiceConfig.java']), '(default package) > LoadServiceConfig.java');
    a.ok(findNode(R, ['FrameworkLIB', 'Java', 'FrameworkJPrj', 'eg.adib.uti.security', 'SecurityUtil.java']), 'eg.adib.uti.security > SecurityUtil.java');
    a.ok(findNode(R, ['FrameworkLIB', 'Included Libraries', 'ExceptionLIB']), 'Included Libraries > ExceptionLIB');
    a.ok(findNode(R, ['FrameworkLIB', 'Other Resources', 'FrameworkJPrj', 'Lib', 'jconn2.jar']), 'Other Resources > FrameworkJPrj > Lib > jconn2.jar');
    a.ok(findNode(R, ['FrameworkLIB', 'Other Resources', 'jconn2.jar']), 'Other Resources > jconn2.jar');
    a.ok(findNode(R, ['FrameworkLIB', 'ESQLs', 'eg.adib.esb.util.esql', 'UtilProcedures.esql']), 'ESQL under its BROKER SCHEMA');
    a.ok(!findNode(R, ['FrameworkLIB', 'Java', 'FrameworkJPrj', 'src']), 'no "src" level under Java > FrameworkJPrj');
    a.ok(!R.some(function (r) { return r.label === 'FrameworkJPrj'; }), 'FrameworkJPrj only appears inside FrameworkLIB');
    var fjLeaves = m.javaProjects.filter(function (j) { return j.name === 'FrameworkJPrj'; })[0].leaves.map(function (l) { return l.path; }).sort();
    a.note('FrameworkJPrj project export: ' + fjLeaves.join(', '));
    a.ok(fjLeaves.indexOf('FrameworkJPrj/src/eg/adib/uti/security/SecurityUtil.java') >= 0 && fjLeaves.indexOf('FrameworkJPrj/Lib/jconn2.jar') >= 0 && fjLeaves.indexOf('FrameworkJPrj/.project') >= 0, 'project export keeps the Eclipse layout');
  });
  test('T25', 'Export Project / Folder / Selected Files ZIP: complete, verified, paths preserved', { category: 'Project Explorer' }, async function (a) {
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    var jr = ws.jars.filter(function (j) { return j.classification.type === 'application'; })[0];
    await ACE.workflow.decompile([jr], new util.CancelToken());
    var m = ACE.explorer.build(ws), EX = ACE.explorer;
    var r = await EX.exportZip(ws, m.javaProjects.filter(function (j) { return j.name === 'legacy'; })[0].leaves, 'ws12');
    a.ok(r.verified, 'project ZIP verified by re-reading every entry');
    ['legacy/.project', 'legacy/.classpath', 'legacy/.settings/org.eclipse.jdt.core.prefs', 'legacy/src/com/example/Legacy.java', 'legacy/bin/com/example/Legacy.class', 'legacy/Lib/postgresql-42.jar', 'legacy/Lib/legacy.jar'].forEach(function (p) { a.ok(r.paths.indexOf(p) >= 0, p); });
    var z = await unzip(r.blob);
    var drv = ws.files.filter(function (f) { return f.name === 'postgresql-42.jar'; })[0];
    a.ok(util.bytesEqual(z['legacy/Lib/postgresql-42.jar'], drv.bytes), 'dependency JAR exported byte-identical (not decompiled or modified)');
    var demo = m.roots.filter(function (x) { return x.label === 'Demo'; })[0];
    var r2 = await EX.exportZip(ws, EX.leavesUnder(demo), 'ws12');
    ['Demo/Main.msgflow', 'Demo/Main.esql', 'Demo/application.descriptor', 'Demo/.project', 'legacy/src/com/example/Legacy.java'].forEach(function (p) { a.ok(r2.paths.indexOf(p) >= 0, 'Demo project export contains ' + p); });
    a.ok(!r2.paths.some(function (p) { return /^_|META-INF|MANIFEST\.json/.test(p); }), 'no internal state, reports or BAR metadata in a project export');
    var esqlGroup = findNode(m.roots, ['CommonLIB', 'ESQLs']);
    var r3 = await EX.exportZip(ws, EX.leavesUnder(esqlGroup), 'ws12');
    a.eq(r3.paths.join(','), 'CommonLIB/util/Helpers.esql', 'logical folder export keeps the real path');
    var orig = Fx.ESQL;
    ACE.transforms.recordEdit(ws, 'ws12', 'Demo/Main.esql', orig, orig + '\n-- edited\n');
    var r4 = await EX.exportZip(ws, [m.leaves['Demo/Main.esql'], m.leaves['legacy/Lib/legacy.jar']], 'ws12');
    var z4 = await unzip(r4.blob);
    a.ok(/-- edited/.test(util.decodeText(z4['Demo/Main.esql']).text), 'saved edit included in the export');
    a.eq(r4.files, 2, 'selected-files export has exactly the selected files');
    a.ok(!/-- edited/.test(util.decodeText(ws.files.filter(function (f) { return f.vpath === 'Demo.appzip!/Main.esql'; })[0].bytes).text), 'original BAR bytes never modified');
    var bad = { kind: 'file', path: 'x/missing.bin', src: 'nowhere', label: 'missing.bin' };
    await a.throwsAsync(function () { return EX.exportZip(ws, [bad], 'ws12'); }, /Export aborted/, 'export reports a real error instead of success');
  });

  /* ---------- 11. ACE 12.0.5 -> 13.0.8 migration (workspace ZIP input) ---------- */
  function mf(ws, rule) { return ws.migration.findings.filter(function (f) { return f.ruleId === rule; }); }
  test('W01', 'Workspace ZIP: projects detected from original .project files, typed from natures, original metadata kept', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    a.eq(ws.inputKind, 'workspace', 'input recognised as a Toolkit workspace ZIP (wrapped in a top folder)');
    var lay = ACE.project.layout(ws);
    a.eq(lay.projects.map(function (p) { return p.name + ':' + p.type; }).join(','), 'AppA:application,JavaP:java,LibB:library', 'project types from natures');
    a.ok(lay.files.some(function (l) { return l.outPath === 'JavaP/src/p/Util.java'; }), 'paths are relative to the project folder (wrapper folder dropped)');
    a.ok(lay.unassigned.some(function (u) { return /tools\/deploy\.sh$/.test(u.outPath); }), 'file outside any project kept as unassigned, not dropped');
    var refs = ACE.project.references(ws, ws.facts);
    a.ok(refs.AppA.some(function (r) { return r.project === 'MissingLib' && /NOT IN THE INPUT/.test(r.reasons.join()); }), 'declared reference to a missing project is reported');
    a.ok(lay.projects.every(function (p) { return ACE.project.generatedProjectFile(ws, p, refs) === null; }), 'no .project is generated: the originals are used');
    var pkg = await ACE.workflow.exportPackage('ace13');
    var z = await unzip(pkg.blob);
    var orig = ws.files.filter(function (f) { return f.path === 'ws/JavaP/.classpath'; })[0];
    a.ok(util.bytesEqual(z['JavaP/.classpath'], orig.bytes), 'exported .classpath is byte-identical to the original');
    a.ok(z['_workbench/MIGRATION-REPORT.md'] && z['_workbench/MIGRATION-REPORT.json'], 'JSON and Markdown migration reports in the ACE 13 package');
    var ex = ACE.explorer.build(ws), lib = ex.roots.filter(function (r) { return r.label === 'LibB'; })[0];
    a.ok(lib && lib.children.some(function (g) { return g.label === 'Java' && g.children.some(function (j) { return j.label === 'JavaP' && j.children.some(function (pk) { return pk.label === 'p'; }); }); }), 'Explorer shows the referenced Java project under LibB > Java > JavaP > p');
  });
  test('W02', 'Strict version mode: source 12.0.5 / target 13.0.8 cannot be overridden by saved settings', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    a.eq(window.ACE_VERSIONS.source, '12.0.5', 'configured source'); a.eq(window.ACE_VERSIONS.target, '13.0.8', 'configured target');
    a.ok(Object.isFrozen(window.ACE_VERSIONS), 'version configuration is frozen');
    var keep = ACE.settings.current, orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function () { return JSON.stringify({ sourceVersion: '12.0.6', targetVersion: '13.0.2' }); };
    try { var s = ACE.settings.load(); a.eq(s.sourceVersion, '12.0.5', 'saved 12.0.6 ignored'); a.eq(s.targetVersion, '13.0.8', 'saved 13.0.2 ignored'); }
    finally { Storage.prototype.getItem = orig; ACE.settings.current = keep; }
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    a.ok(/12\.0\.5/.test(ws.migration.versions.statement), 'version evidence: ' + ws.migration.versions.statement);
    var r = ACE.reports.migration(ws);
    a.eq(r.versions.source + '>' + r.versions.target, '12.0.5>13.0.8', 'report header carries the strict versions');
    a.ok(!/12\.0\.6/.test(ACE.reports.migrationText(ws) + ACE.reports.checklistText(ws) + ACE.project.instructions(ws, 'ace13', ACE.project.layout(ws), {}, [], [])), 'no 12.0.6 left in reports or instructions');
  });
  test('W03', 'Dependency and Java runtime analysis (.classpath, product JAR versions, manifest Class-Path, missing projects)', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    var pj = mf(ws, 'DEP-PRODUCT-JAR')[0];
    a.ok(pj && /12\.0\.5\.0/.test(pj.evidence.join()), 'ACE 12.0.5.0 product JAR packaged in JavaP/Lib flagged');
    a.eq(pj.risk, 'low', 'unused and not on the build path -> low risk');
    var jrec = ws.migration.dependencies.jars.filter(function (j) { return j.name === 'IntegrationAPI.jar'; })[0];
    a.eq(jrec.referencedBy.length, 0, 'regression: com.ibm.broker.plugin imports are not a use of a JAR that has classes in com.ibm.broker');
    a.ok(mf(ws, 'DEP-CMP-DEPRECATED')[0].classification === 'DEPRECATED', 'com.ibm.broker.config.proxy classified DEPRECATED (IBM Integration API topic)');
    a.ok(/jackson-core-2\.13\.3\.jar/.test(mf(ws, 'DEP-MANIFEST-CLASSPATH')[0].why), 'missing manifest Class-Path JARs listed');
    a.ok(mf(ws, 'DEP-MISSING-PROJECT').some(function (f) { return /MissingLib/.test(f.why); }), 'missing referenced project');
    var v = mf(ws, 'DEP-CLASSPATH-VAR')[0];
    a.ok(v && v.locations[0].file === 'ws/JavaP/.classpath' && v.locations[0].line === 5, 'JCN_HOME variable with exact location .classpath:5');
    a.ok(v.assumption, 'classpath-variable finding records its unverified assumption');
    a.eq(mf(ws, 'RT-JRE-CONTAINER-DEFAULT')[0].classification, 'BEHAVIOR_CHANGED', 'default JRE container: Java 8 default in 12.0 vs Java 17 in 13.0');
    a.eq(mf(ws, 'RT-COMPLIANCE-UNRECORDED')[0].classification, 'UNKNOWN', 'compiler level not recorded -> UNKNOWN, not guessed');
  });
  test('W04', 'Concurrency and resource lifecycle are reported as MANUAL_REVIEW (Java and ESQL)', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    var sm = mf(ws, 'CONC-STATIC-MUTABLE');
    a.ok(sm.length === 1 && /CHARSET/.test(sm[0].title) && sm[0].locations[0].line === 8, 'mutable static field Util.CHARSET at line 8 (final MAX not flagged)');
    a.ok(mf(ws, 'CONC-STATIC-NONTHREADSAFE').some(function (f) { return /CACHE/.test(f.title); }), 'static HashMap shared across threads');
    var nf = mf(ws, 'CONC-NODE-INSTANCE-FIELD');
    a.ok(nf.length === 1 && /count/.test(nf[0].title), 'mutable instance field in a JavaCompute node (final field not flagged)');
    var lk = mf(ws, 'LIFE-RESOURCE-NOT-CLOSED');
    a.eq(lk.length, 1, 'exactly one leak: try-with-resources stream is not flagged');
    a.ok(/success path/.test(lk[0].title) && lk[0].locations[0].line === 18, 'fis closed outside finally, reported at line 18');
    a.ok(mf(ws, 'CONC-GLOBALMAP-CHECK-THEN-ACT').length === 1, 'MbGlobalMap get-then-put');
    var non = mf(ws, 'CONC-ESQL-SHARED-NONATOMIC'), atom = mf(ws, 'CONC-ESQL-SHARED');
    a.ok(non.length === 1 && /CacheA/.test(non[0].title), 'SHARED CacheA written outside BEGIN ATOMIC');
    a.ok(atom.length === 1 && /CacheB/.test(atom[0].title) && atom[0].risk === 'low', 'SHARED CacheB written only inside ATOMIC (commented write ignored)');
    a.ok(ws.migration.findings.filter(function (f) { return /^(CONC|LIFE)-/.test(f.ruleId); }).every(function (f) { return f.classification === 'MANUAL_REVIEW'; }), 'all concurrency/lifecycle items are MANUAL_REVIEW');
  });
  test('W05', 'Scripts, build files, wizard metadata and configuration are scanned as data (never executed)', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    var art = ws.migration.artifacts;
    a.ok(art.categories.script.some(function (p) { return /deploy\.sh$/.test(p); }), 'loose script inventoried');
    a.ok(art.notFound.indexOf('build') >= 0 && art.notFound.indexOf('wizard-pattern') >= 0, 'absent categories reported as not found: ' + art.notFound.join(', '));
    a.eq(mf(ws, 'CFG-JSSE-DEBUG-TRUE')[0].classification, 'UNSUPPORTED', '-Djavax.net.debug=true unsupported on Java 17 (IBM JRE limitations)');
    a.ok(mf(ws, 'CFG-JSSE-DEBUG-TRUE')[0].docUrls.some(function (u) { return /ac04551_/.test(u); }), 'with the IBM documentation URL');
    a.eq(mf(ws, 'CFG-TMPDIR')[0].classification, 'BEHAVIOR_CHANGED', 'TMPDIR not observed by the Java 17 JVM');
    a.ok(mf(ws, 'CFG-SOURCE-VERSION-PATH').length && mf(ws, 'CFG-MQSI-COMMAND').length, 'hard-coded 12.0.5 path and mqsi command flagged');
  });
  test('W06', 'Every finding is classified and carries location, risk, confidence, action; documented ones carry a doc URL', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip'), F = ws.migration.findings;
    a.ok(F.length > 15, F.length + ' findings');
    a.ok(F.every(function (f) { return ACE.migScan.CLASSES.indexOf(f.classification) >= 0; }), 'classification in the allowed set');
    a.ok(F.every(function (f) { return /^(high|medium|low)$/.test(f.risk) && f.confidence && f.action && f.why; }), 'risk, confidence, why and action present');
    a.ok(F.filter(function (f) { return f.status === 'documented'; }).every(function (f) { return f.docUrls.length > 0; }), 'every documented finding has a documentation URL');
    var b64 = F.filter(function (f) { return f.ruleId === 'J17-IBM-MISC'; })[0];
    a.ok(b64 && b64.classification === 'REMOVED' && /^--- a\/JavaP\/src\/p\/Util\.java/.test(b64.diff || ''), 'REMOVED com.ibm.misc finding carries the proposed diff');
    a.ok(ws.migration.unverifiedAssumptions.length >= 4, ws.migration.unverifiedAssumptions.length + ' unverified assumptions reported');
    a.ok(ws.migration.unresolvedRisks.length > 0, ws.migration.unresolvedRisks.length + ' unresolved high-risk items reported');
  });
  test('W07', 'Approved low-risk fix: original preserved, finding resolved in the ACE 13 copy, rollback restores it', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    var p = ws.proposals.filter(function (x) { return x.fixId === 'base64-legacy-encoder' && x.status === 'proposed'; })[0];
    a.ok(p, 'base64 fix proposed for the original source file');
    ACE.transforms.apply(ws, p); ACE.workflow.analyze();
    var f = mf(ws, 'J17-IBM-MISC')[0];
    a.ok(f && f.resolvedInWorkingCopy, 'finding marked resolved in the ACE 13 working copy');
    a.ok(!ws.migration.unresolvedRisks.some(function (r) { return r.ruleId === 'J17-IBM-MISC'; }), 'no longer an unresolved risk');
    var src = ws.files.filter(function (x) { return x.path === 'ws/JavaP/src/p/Util.java'; })[0];
    a.ok(/BASE64Encoder encoder/.test(ACE.bar.text(src)), 'original input bytes unchanged');
    var z = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
    a.ok(util.bytesEqual(z['_original-before-changes/JavaP/src/p/Util.java'], src.bytes), 'unchanged original exported under _original-before-changes/');
    a.ok(/legacyBase64Encode/.test(util.decodeText(z['JavaP/src/p/Util.java']).text), 'fixed file exported');
    a.ok(/legacyBase64Encode\(/.test(util.decodeText(z['_workbench/MIGRATION-REPORT.md']).text), 'Markdown report shows the diff');
    ACE.transforms.undo(ws, 'ws13', p.outPath); ws.proposals = ws.proposals.filter(function (x) { return x !== p; }); ACE.workflow.analyze();
    a.ok(!ws.ws13.overlay[p.outPath] && !mf(ws, 'J17-IBM-MISC')[0].resolvedInWorkingCopy, 'rollback: overlay removed and finding open again');
  });
  test('W09', 'BASE64Encoder: two suggested solutions; accepting one replaces the old code, withdraws the other, Undo restores both', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip'), path = 'JavaP/src/p/Util.java';
    var opts = ws.proposals.filter(function (p) { return p.group === 'base64' && p.outPath === path && p.status === 'proposed'; });
    a.eq(opts.map(function (p) { return p.fixId; }).sort().join(','), 'base64-basic-encoder,base64-legacy-encoder', 'both options suggested for the file');
    a.ok(opts.every(function (p) { return p.when; }) && opts.filter(function (p) { return p.recommended; }).length === 1, 'each option says when to choose it; exactly one is recommended');
    var f = mf(ws, 'J17-IBM-MISC')[0];
    a.eq(f.autoFixIds.length, 2, 'the finding lists both options');
    var basic = opts.filter(function (p) { return p.fixId === 'base64-basic-encoder'; })[0];
    ACE.transforms.apply(ws, basic); ACE.workflow.analyze();
    var txt = ws.ws13.overlay[path].text;
    a.ok(/java\.util\.Base64\.getEncoder\(\)\.encodeToString\(b\)/.test(txt), 'old encoder.encode(b) replaced by java.util.Base64.getEncoder().encodeToString(b)');
    a.ok(!/BASE64Encoder/.test(ACE.java17.mask(txt).code) && !/legacyBase64Encode/.test(txt), 'old import/variable removed; no helper added');
    a.eq(ws.proposals.filter(function (p) { return p.fixId === 'base64-legacy-encoder' && p.outPath === path; })[0].status, 'superseded', 'the other option is withdrawn');
    a.ok(mf(ws, 'J17-IBM-MISC')[0].resolvedInWorkingCopy, 'finding resolved in the ACE 13 copy');
    var z = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
    a.ok(/getEncoder\(\)\.encodeToString/.test(util.decodeText(z[path]).text) && /BASE64Encoder encoder/.test(util.decodeText(z['_original-before-changes/' + path]).text), 'export: new code in the project, old code under _original-before-changes/');
    ACE.transforms.undo(ws, 'ws13', path); ACE.workflow.analyze();
    a.ok(!ws.ws13.overlay[path], 'Undo restores the old code');
    a.eq(ws.proposals.filter(function (p) { return p.group === 'base64' && p.outPath === path && p.status === 'proposed'; }).length, 2, 'both options are suggested again after Undo');
  });
  test('W08','Real workspace ZIP (e.g. valleysoft.zip): workspace mode, classified findings, verified export', { category: 'ACE 12.0.5 -> 13.0.8', requires: 'workspace' }, async function (a, env) {
    var ws = await load(await util.readFileBytes(env.workspaceFile), env.workspaceFile.name);
    a.ok(!ws.fatal && ws.complete, 'opened, all CRC-32 verified'); a.eq(ws.inputKind, 'workspace', 'workspace mode');
    a.note('projects: ' + ACE.project.layout(ws).projects.map(function (p) { return p.name + ' (' + p.type + ')'; }).join(', '));
    a.note('counts: ' + JSON.stringify(ws.migration.counts) + '; open high-risk: ' + ws.migration.unresolvedRisks.length);
    a.ok(ws.migration.findings.every(function (f) { return ACE.migScan.CLASSES.indexOf(f.classification) >= 0; }), 'every finding classified');
    if (env.workspaceFile.name === 'valleysoft.zip') {
      a.eq(ws.files.length, 97, 'valleysoft.zip file count (independently counted with unzip)');
      a.ok(mf(ws, 'DEP-MISSING-PROJECT').some(function (f) { return /PrimeLib/.test(f.why); }), 'CardDtlsInq -> PrimeLib missing');
      a.ok(mf(ws, 'DEP-PRODUCT-JAR').some(function (f) { return /12\.0\.5\.0/.test(f.evidence.join()); }), 'IntegrationAPI.jar 12.0.5.0 packaged in FrameworkJPrj/Lib');
      a.ok(mf(ws, 'LIFE-RESOURCE-NOT-CLOSED').some(function (f) { return /SecurityUtil/.test(f.title); }), 'SecurityUtil FileInputStream closed outside finally');
      a.ok(!mf(ws, 'ACE13-UNRESOLVED').some(function (f) { return /SecurityUtil/.test(f.evidence.join()); }), 'ESQL Java routines resolve to the original SecurityUtil.java source');
    }
    var lay = ACE.project.layout(ws), ex = ACE.explorer.build(ws);
    var r = await ACE.explorer.exportZip(ws, ACE.explorer.leavesUnder({ kind: 'group', children: ex.roots }), 'orig');
    a.ok(r.verified && r.files === lay.files.length + lay.unassigned.length + lay.metadata.length, 'project backup ZIP verified: ' + r.files + ' files');
  });

  /* ---------- 12. external validation ---------- */
  test('X01', 'ACE 12.0.5 Toolkit imports the ACE 12 package and builds without errors', { category: 'IBM Toolkit validation', external: true });
  test('X02', 'ACE 13.0.8 Toolkit imports the ACE 13 package; Java project builds; BAR can be built', { category: 'IBM Toolkit validation', external: true });
  test('X03', 'BAR rebuilt in ACE 13 deploys to an ACE 13.0.8 integration server (Java 17) and passes regression tests', { category: 'IBM runtime validation', external: true });
  test('X04', 'Decompiled Java behaves like the original (functional equivalence)', { category: 'IBM runtime validation', external: true });
})();
