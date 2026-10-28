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
    ['MIGRATION-REPORT.json', 'CHANGE-LOG.txt', 'COMPATIBILITY-REPORT.json', 'IMPORT-INSTRUCTIONS.txt'].forEach(function (n) { a.ok(z['_workbench/' + n], n); });
    a.ok(/APPLIED/.test(util.decodeText(z['_workbench/CHANGE-LOG.txt']).text), 'change log lists the applied fix');
    var rep = JSON.parse(util.decodeText(z['_workbench/MIGRATION-REPORT.json']).text);
    a.ok(/cannot prove runtime compatibility/.test(rep.disclaimer), 'report states static analysis limits');
    a.ok(rep.findings.some(function (f) { return f.ruleId === 'ACE13-WSSEC-JAVA17'; }) && rep.findings.some(function (f) { return f.ruleId === 'ACE13-SSL-IBMNAMES'; }), 'ACE 13 rule findings present');
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

  test('T20', 'Rules that IBM documents are marked UNVERIFIED offline (no IBM documentation is available)', { category: 'Rules' }, async function (a) {
    var r = window.ACE_ACE_RULES.rules.filter(function (x) { return x.id === 'ACE13-ODBC'; })[0];
    a.eq(ACE.aceRules.docVerification(r, []).state, 'unverified', 'no docs -> unverified');
    var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
    a.ok(ws.aceFindings.length > 0 && ws.aceFindings.every(function (f) { return !f.docVerification || ['unverified', 'not-applicable', 'probe', 'heuristic'].indexOf(f.docVerification.state) >= 0; }), 'no finding claims to be matched against IBM documentation');
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
  test('W02', 'Strict version mode: source 12.0.5 / target 13.0.8 are fixed and nothing is stored in the browser', { category: 'ACE 12.0.5 -> 13.0.8' }, async function (a) {
    a.eq(window.ACE_VERSIONS.source, '12.0.5', 'configured source'); a.eq(window.ACE_VERSIONS.target, '13.0.8', 'configured target');
    a.ok(Object.isFrozen(window.ACE_VERSIONS), 'version configuration is frozen');
    var keep = ACE.settings.current, orig = Storage.prototype.getItem;
    Storage.prototype.getItem = function () { return JSON.stringify({ sourceVersion: '12.0.6', targetVersion: '13.0.2' }); };
    try { var s = ACE.settings.load(); a.eq(s.sourceVersion, '12.0.5', 'a stored 12.0.6 is ignored'); a.eq(s.targetVersion, '13.0.8', 'a stored 13.0.2 is ignored'); }
    finally { Storage.prototype.getItem = orig; ACE.settings.current = keep; }
    var ws = await load(await Fx.syntheticWorkspace(), 'ws.zip');
    a.ok(/12\.0\.5/.test(ws.migration.versions.statement), 'version evidence: ' + ws.migration.versions.statement);
    var r = ACE.reports.migration(ws);
    a.eq(r.versions.source + '>' + r.versions.target, '12.0.5>13.0.8', 'report header carries the strict versions');
    a.ok(!/12\.0\.6/.test(ACE.reports.migrationText(ws) + ACE.project.instructions(ws, 'ace13', ACE.project.layout(ws), {}, [], [])), 'no 12.0.6 left in reports or instructions');
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

  /* ---------- 12. static-to-shared library conversion ---------- */
  async function withLC(cfg, fn) {
    var keep = ACE.settings.current.libraryConversion;
    ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, { strategy: "in-place" }, cfg);
    try { return await fn(); } finally { ACE.settings.current.libraryConversion = keep; }
  }
  async function lcLoad(spec, cfg, wrap) {
    ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, { strategy: "in-place" }, cfg);
    return load(await Fx.libWorkspace(spec, wrap), 'lc.zip');
  }
  function lib(run, t, name) { return run.targets.filter(function (x) { return x.target === t; })[0].plan.libraries.filter(function (l) { return l.name === name; })[0]; }
  function ovText(ws, copy, p) { var o = ws[copy].overlay[p]; return o ? o.text : null; }
  function origText(ws, rel) { var f = ws.files.filter(function (x) { return x.path === 'ws/' + rel; })[0]; return f ? ACE.bar.text(f) : null; }
  var SHARED_NATURE = '<nature>com.ibm.etools.msgbroker.tooling.sharedLibraryNature</nature>';

  test('L01', 'Single application + one static library: converted; only .project nature and descriptor reference change; validation passes', { category: 'Library conversion' }, async function (a) {
    await withLC({ enabled: true }, async function () {
      var ws = await lcLoad([{ name: 'App1', kind: 'app', refs: ['Lib1'] }, { name: 'Lib1', kind: 'static' }], { enabled: true });
      var plan = ws.libConversion; a.eq(lib(plan, 'ace13', 'Lib1').decision, 'convert', 'Lib1 planned for conversion');
      a.eq(plan.targets[0].plan.edits.map(function (e) { return e.path; }).join(','), 'App1/application.descriptor,Lib1/.project', 'exactly two files planned');
      var run = ACE.workflow.convertLibraries(), t = run.targets[0];
      a.ok(t.validation.passed, 'validation: ' + t.validation.checks.map(function (c) { return c.id + ' ' + c.status; }).join(', '));
      var dp = ACE.bar.parseDotProject(ovText(ws, 'ws13', 'Lib1/.project'));
      a.eq(dp.natures.join(','), 'com.ibm.etools.msgbroker.tooling.libraryNature,com.ibm.etools.msgbroker.tooling.sharedLibraryNature,com.ibm.etools.msgbroker.tooling.messageBrokerProjectNature', 'natures as the ACE Toolkit creates a shared library');
      a.eq(ACE.libconv.descriptorRefs(ovText(ws, 'ws13', 'App1/application.descriptor')).join(','), 'Lib1', 'application.descriptor has <sharedLibraryReference> Lib1');
      a.ok(/<references><sharedLibraryReference><libraryName>Lib1<\/libraryName><\/sharedLibraryReference><\/references>/.test(ovText(ws, 'ws13', 'App1/application.descriptor')), 'descriptor XML exactly as ibmint/Toolkit BARs contain it');
      var z = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
      var others = Object.keys(z).filter(function (p) { return /^(App1|Lib1)\//.test(p) && !/(\.project|application\.descriptor)$/.test(p); });
      a.ok(others.length >= 3 && others.every(function (p) { var o = ws.files.filter(function (f) { return f.path === 'ws/' + p; })[0]; return o && util.bytesEqual(o.bytes, z[p]); }), others.length + ' other files byte-identical to the input');
      a.ok(util.bytesEqual(z['_original-before-changes/Lib1/.project'], ws.files.filter(function (f) { return f.path === 'ws/Lib1/.project'; })[0].bytes), 'original .project preserved under _original-before-changes/');
      a.ok(z['_workbench/LIBRARY-CONVERSION-REPORT.json'] && /Lib1/.test(util.decodeText(z['_workbench/LIBRARY-CONVERSION-REPORT.md']).text), 'conversion report (JSON + Markdown) in the package');
      a.ok(/--project Lib1/.test(t.state.build.commands.map(function (c) { return c.command; }).join('\n')), 'build plan packages the shared library with its own --project');
    });
  });
  test('L02', 'Application using several libraries; dependency rules pull in referenced and referencing static libraries', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      // App -> A -> B (static chain), App -> C; X (static) -> A. Selecting only A must also convert B (A shared -> B shared) and X (X static cannot reference shared A).
      var ws = await lcLoad([{ name: 'App', kind: 'app', refs: ['A', 'C'] }, { name: 'A', kind: 'static', refs: ['B'] }, { name: 'B', kind: 'static' }, { name: 'C', kind: 'static' }, { name: 'X', kind: 'static', refs: ['A'] }], { enabled: true, libraries: ['A'] });
      var p = ws.libConversion;
      a.eq(lib(p, 'ace13', 'A').decision, 'convert', 'A selected'); a.ok(/shared library can only reference shared/.test(lib(p, 'ace13', 'B').reasons.join()), 'B added: ' + lib(p, 'ace13', 'B').reasons);
      a.ok(/static library cannot reference a shared/.test(lib(p, 'ace13', 'X').reasons.join()), 'X added: ' + lib(p, 'ace13', 'X').reasons);
      a.eq(lib(p, 'ace13', 'C').decision, 'not-selected', 'C not selected and not required');
      ACE.workflow.convertLibraries();
      a.eq(ACE.libconv.descriptorRefs(ovText(ws, 'ws13', 'A/library.descriptor')).join(','), 'B', 'shared A lists shared B in its library.descriptor (runtime needs it: BIP2558E otherwise)');
      a.eq(ACE.libconv.descriptorRefs(ovText(ws, 'ws13', 'X/library.descriptor')).join(','), 'A', 'X lists A');
      a.eq(ACE.libconv.descriptorRefs(ovText(ws, 'ws13', 'App/application.descriptor')).join(','), 'A', 'App lists only the shared library it references (C stays static)');
      a.ok(ws.libConversionRun.targets[0].validation.passed, 'validation passed');
    });
  });
  test('L03', 'Several applications referencing a common library are updated together; coordination reported', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var ws = await lcLoad([{ name: 'SvcA', kind: 'app', refs: ['Framework'] }, { name: 'SvcB', kind: 'app', refs: ['Framework'] }, { name: 'SvcC', kind: 'app', refs: ['Framework'] }, { name: 'Framework', kind: 'static' }], { enabled: true });
      var l = lib(ws.libConversion, 'ace13', 'Framework');
      a.eq(l.referencingApplications.join(','), 'SvcA,SvcB,SvcC', 'all referencing applications identified');
      a.ok(/static copy keep working/.test(l.coordination), 'coordination note: ' + l.coordination.slice(0, 90));
      a.ok(l.usage.filter(function (u) { return u.kind === 'esql-call'; }).length === 3, 'ESQL calls into the library found in each service');
      ACE.workflow.convertLibraries();
      a.ok(['SvcA', 'SvcB', 'SvcC'].every(function (s) { return ACE.libconv.descriptorRefs(ovText(ws, 'ws13', s + '/application.descriptor')).join() === 'Framework'; }), 'every application descriptor references Framework');
    });
  });
  test('L04', 'Mixed shared and static libraries: already-shared library is not converted again; a missing descriptor reference to it is repaired', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var ws = await lcLoad([{ name: 'App', kind: 'app', refs: ['Sh', 'St'] }, { name: 'Sh', kind: 'shared' }, { name: 'St', kind: 'static' }], { enabled: true });
      a.eq(lib(ws.libConversion, 'ace13', 'Sh').decision, 'already-shared', 'Sh already shared');
      var e = ws.libConversion.targets[0].plan.edits;
      a.ok(!e.some(function (x) { return x.path === 'Sh/.project'; }), 'Sh/.project not touched');
      a.eq(e.filter(function (x) { return x.path === 'App/application.descriptor'; })[0].notes.length, 2, 'App descriptor gets Sh (repair) and St');
      ACE.workflow.convertLibraries();
      a.eq(ACE.libconv.descriptorRefs(ovText(ws, 'ws13', 'App/application.descriptor')).sort().join(','), 'Sh,St', 'both shared libraries referenced');
    });
  });
  test('L05', 'Missing / unresolved library references block conversion; a "known shared library" resolves them', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var spec = [{ name: 'App', kind: 'app', refs: ['L'] }, { name: 'L', kind: 'static', refs: ['Base'] }];
      var ws = await lcLoad(spec, { enabled: true });
      var l = lib(ws.libConversion, 'ace13', 'L');
      a.eq(l.decision, 'blocked', 'L blocked'); a.eq(l.blockers[0].code, 'LC-UNRESOLVED-REF', 'reason: unresolved reference to Base');
      a.eq(ws.libConversion.targets[0].plan.edits.length, 0, 'nothing planned');
      ws = await lcLoad(spec, { enabled: true, knownSharedLibraries: ['Base'] });
      a.eq(lib(ws.libConversion, 'ace13', 'L').decision, 'convert', 'with Base listed as a known shared library, L converts');
      ACE.workflow.convertLibraries();
      a.eq(ACE.libconv.descriptorRefs(ovText(ws, 'ws13', 'L/library.descriptor')).join(','), 'Base', 'L references the known shared library Base in its descriptor');
      a.ok(ws.libConversionRun.targets[0].validation.passed, 'validation passed');
    });
  });
  test('L06', 'Unsupported configurations are reported with evidence, never converted', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var ws = await lcLoad([
        { name: 'App', kind: 'app', refs: ['Flows', 'DefEsql', 'DefSub', 'XmlLib', 'Dep'] },
        { name: 'Flows', kind: 'static', files: { 'com/f/Main.msgflow': Fx.libSubflow('com/f/Main.msgflow'), 'com/f/U.esql': 'BROKER SCHEMA com.f\nCREATE PROCEDURE F() BEGIN END;\n' } },
        { name: 'DefEsql', kind: 'static', files: { 'Util.esql': 'CREATE PROCEDURE D() BEGIN END;\n' } },
        { name: 'DefSub', kind: 'static', files: { 'Root.subflow': Fx.libSubflow('Root.subflow') } },
        { name: 'XmlLib', kind: 'static', files: { 'com/x/config.xml': '<a/>' } },
        { name: 'Dep', kind: 'static', refs: ['DefEsql'] },
        { name: 'Legacy', kind: 'integration', refs: ['IntUsed'] }, { name: 'IntUsed', kind: 'static' },
        { name: 'Cyc1', kind: 'static', refs: ['Cyc2'] }, { name: 'Cyc2', kind: 'static', refs: ['Cyc1'] },
        { name: 'S1', kind: 'static', files: { 'com/same/A.esql': 'BROKER SCHEMA com.same\nCREATE PROCEDURE A() BEGIN END;\n' } },
        { name: 'S2', kind: 'static', files: { 'com/same/B.esql': 'BROKER SCHEMA com.same\nCREATE PROCEDURE B() BEGIN END;\n' } }
      ], { enabled: true });
      var p = ws.libConversion;
      function codes(n) { return lib(p, 'ace13', n).blockers.map(function (b) { return b.code; }); }
      a.ok(codes('Flows').indexOf('LC-MSGFLOW') >= 0 && lib(p, 'ace13', 'Flows').blockers[0].basis === 'verified', 'message flow -> LC-MSGFLOW (verified: ibmint BIP1874E)');
      a.ok(codes('DefEsql').indexOf('LC-ESQL-DEFAULT-SCHEMA') >= 0 && /BIP4129E/.test(lib(p, 'ace13', 'DefEsql').blockers[0].evidence), 'default-schema ESQL -> blocked with runtime evidence BIP4129E');
      a.ok(codes('DefSub').indexOf('LC-SUBFLOW-DEFAULT-SCHEMA') >= 0, 'subflow in default schema');
      a.ok(codes('XmlLib').indexOf('LC-UNSUPPORTED-RESOURCE') >= 0, 'XML file unsupported in a shared library');
      a.ok(codes('Dep').indexOf('LC-DEPENDENT-BLOCKED') >= 0, 'library that depends on a blocked library is blocked too (they convert together or not at all)');
      a.ok(codes('IntUsed').indexOf('LC-INTEGRATION-PROJECT-REF') >= 0, 'library referenced by an integration project');
      a.ok(codes('Cyc1').indexOf('LC-CYCLE') >= 0 && codes('Cyc2').indexOf('LC-CYCLE') >= 0, 'reference cycle');
      a.ok(codes('S1').indexOf('LC-ESQL-SCHEMA-COLLISION') >= 0 && codes('S2').indexOf('LC-ESQL-SCHEMA-COLLISION') >= 0, 'two shared libraries with ESQL in the same schema');
      var planned = p.targets[0].plan.edits.map(function (e) { return e.path; });
      a.ok(!planned.some(function (x) { return /^(Flows|DefEsql|DefSub|XmlLib|Dep|IntUsed|Cyc1|Cyc2|S1|S2)\/\.project$/.test(x); }), 'no blocked library is changed');
      a.ok(p.targets[0].plan.manualActions.some(function (m) { return /named broker schema/.test(m); }), 'manual action explains the schema refactoring');
    });
  });
  test('L07', 'Targets: ACE 12.0.5 only, ACE 13.0.8 only, and both; each package carries its own conversion', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var spec = [{ name: 'App', kind: 'app', refs: ['L'] }, { name: 'L', kind: 'static' }];
      var ws = await lcLoad(spec, { enabled: true, targets: ['ace12'] });
      ACE.workflow.convertLibraries();
      a.ok(ovText(ws, 'ws12', 'L/.project') && !ws.ws13.overlay['L/.project'], 'ace12 target: only the ACE 12 working copy is converted');
      var z12 = await unzip((await ACE.workflow.exportPackage('ace12')).blob), z13 = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
      a.ok(util.decodeText(z12['L/.project']).text.indexOf(SHARED_NATURE) >= 0 && util.decodeText(z13['L/.project']).text.indexOf(SHARED_NATURE) < 0, 'ACE 12 package converted, ACE 13 package unchanged');
      ws = await lcLoad(spec, { enabled: true, targets: ['ace12', 'ace13'] });
      var run = ACE.workflow.convertLibraries();
      a.eq(run.targets.map(function (t) { return t.target + ':' + t.applied.length; }).join(','), 'ace12:2,ace13:2', 'both working copies converted');
      a.ok(run.targets.every(function (t) { return t.validation.passed; }), 'both validated');
      a.ok(/ACE 12\.0\.5/.test(run.targets[0].state.build.version) && /ACE 13\.0\.8/.test(run.targets[1].state.build.version), 'version-specific build plans');
    });
  });
  test('L08', 'Disabled: nothing analysed or changed; packages identical to the workflow without the feature', { category: 'Library conversion' }, async function (a) {
    var spec = [{ name: 'App', kind: 'app', refs: ['L'] }, { name: 'L', kind: 'static' }];
    var ws = await lcLoad(spec, { enabled: false });
    a.eq(ws.libConversion, null, 'no conversion analysis when disabled');
    await a.throwsAsync(async function () { ACE.workflow.convertLibraries(); }, /disabled/, 'conversion refuses to run when disabled');
    var z = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
    a.ok(!Object.keys(z).some(function (p) { return /LIBRARY-CONVERSION|_original-before-changes/.test(p); }), 'no conversion report, no changed files in the package');
    a.ok(util.decodeText(z['L/.project']).text.indexOf(SHARED_NATURE) < 0 && util.bytesEqual(z['App/application.descriptor'], ws.files.filter(function (f) { return f.path === 'ws/App/application.descriptor'; })[0].bytes), 'project files exported unchanged');
    // the same input with the feature never enabled gives the same project files
    ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS);
    var z2 = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
    a.ok(Object.keys(z).filter(function (p) { return /^(App|L)\//.test(p); }).every(function (p) { return util.bytesEqual(z[p], z2[p]); }), 'regression: identical project files with the feature disabled');
  });
  test('L09', 'Repeated runs are idempotent: no duplicate natures or references; second run changes nothing', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var ws = await lcLoad([{ name: 'App', kind: 'app', refs: ['L'] }, { name: 'L', kind: 'static' }], { enabled: true });
      ACE.workflow.convertLibraries(); var first = ovText(ws, 'ws13', 'App/application.descriptor'), firstP = ovText(ws, 'ws13', 'L/.project');
      var r2 = ACE.workflow.convertLibraries();
      a.eq(r2.targets[0].applied.length, 0, 'second run applies nothing');
      a.eq(ovText(ws, 'ws13', 'App/application.descriptor'), first, 'descriptor unchanged'); a.eq(ovText(ws, 'ws13', 'L/.project'), firstP, '.project unchanged');
      a.eq((firstP.match(/sharedLibraryNature/g) || []).length, 1, 'sharedLibraryNature appears once');
      a.eq(ACE.libconv.descriptorRefs(first).length, 1, 'one reference');
      a.eq(lib(ws.libConversion, 'ace13', 'L').decision, 'already-shared', 'after conversion the library is recognised as shared');
      a.eq(ws.ws13.changelog.filter(function (e) { return e.action === 'converted'; }).length, 2, 'change log has the two changes once');
    });
  });
  test('L10', 'Undo restores the original project files', { category: 'Library conversion' }, async function (a) {
    await withLC({}, async function () {
      var ws = await lcLoad([{ name: 'App', kind: 'app', refs: ['L'] }, { name: 'L', kind: 'static' }], { enabled: true });
      ACE.workflow.convertLibraries();
      a.ok(ws.ws13.overlay['L/.project'], 'converted');
      var n = ACE.workflow.undoLibraryConversion();
      a.eq(n, 2, 'two changes undone'); a.ok(!ws.ws13.overlay['L/.project'] && !ws.ws13.overlay['App/application.descriptor'], 'working copy back to the original');
      a.eq(lib(ws.libConversion, 'ace13', 'L').decision, 'convert', 'library is static again and can be converted again');
    });
  });
  test('L11', 'Descriptor edits: missing descriptor is created; prefixed namespace and existing references are handled', { category: 'Library conversion' }, async function (a) {
    var pre = '<?xml version="1.0"?><x:appDescriptor xmlns:x="http://com.ibm.etools.mft.descriptor.app" xmlns:b="http://com.ibm.etools.mft.descriptor.base"><b:references><b:sharedLibraryReference><b:libraryName>Old</b:libraryName></b:sharedLibraryReference></b:references></x:appDescriptor>';
    var r = ACE.libconv.addDescriptorRef(pre, 'New');
    a.eq(ACE.libconv.descriptorRefs(r.text).join(','), 'Old,New', 'reference appended using the existing b: prefix');
    a.eq(ACE.libconv.addDescriptorRef(r.text, 'New').changed, false, 'adding the same reference again is a no-op');
    a.ok(ACE.libconv.addDescriptorRef('<not xml', 'X').error, 'malformed descriptor reported, not rewritten');
    await withLC({}, async function () {
      var ws = await lcLoad([{ name: 'App', kind: 'app', refs: ['L'], noDescriptor: true }, { name: 'L', kind: 'static' }], { enabled: true });
      var e = ws.libConversion.targets[0].plan.edits.filter(function (x) { return x.path === 'App/application.descriptor'; })[0];
      a.ok(e && e.created, 'missing application.descriptor is created');
      ACE.workflow.convertLibraries();
      var z = await unzip((await ACE.workflow.exportPackage('ace13')).blob);
      a.eq(ACE.libconv.descriptorRefs(util.decodeText(z['App/application.descriptor']).text).join(','), 'L', 'created descriptor exported with the reference');
    });
  });
  test('L12', 'BAR input: libraries inside the application archive are analysed with the same rules', { category: 'Library conversion' }, async function (a) {
    await withLC({ enabled: true, strategy: "in-place" }, async function () {
      var ws = await load(await Fx.syntheticBar(), 'Demo.bar');
      var l = lib(ws.libConversion, 'ace13', 'CommonLIB');
      a.eq(l.currentType, 'static-library', 'CommonLIB (libzip inside the appzip) recognised as a static library');
      a.ok(l.decision === 'blocked' && l.blockers.some(function (b) { return b.code === 'LC-SUBFLOW-DEFAULT-SCHEMA'; }), 'Common.subflow in the default schema blocks it: ' + l.blockers.map(function (b) { return b.code; }).join(', '));
    });
  });
  test('L13', 'Real workspace ZIP: conversion analysis reports what blocks the framework libraries; nothing is changed', { category: 'Library conversion', requires: 'workspace' }, async function (a, env) {
    await withLC({ enabled: true, strategy: "in-place" }, async function () {
      var ws = await load(await util.readFileBytes(env.workspaceFile), env.workspaceFile.name);
      var p = ws.libConversion.targets[0].plan;
      p.libraries.forEach(function (l) { a.note(l.name + ': ' + l.decision + (l.blockers.length ? ' - ' + util.uniq(l.blockers.map(function (b) { return b.code; })).join(', ') : '')); });
      a.ok(p.libraries.length > 0, p.libraries.length + ' libraries analysed');
      if (env.workspaceFile.name === 'valleysoft.zip') {
        ['AuditLIB', 'ExceptionLIB', 'FrameworkLIB'].forEach(function (n) { var l = lib(ws.libConversion, 'ace13', n); a.ok(l.decision === 'blocked' && l.blockers.some(function (b) { return b.code === 'LC-ESQL-DEFAULT-SCHEMA'; }), n + ' blocked: ESQL in the default schema (BIP4129E)'); });
        a.ok(p.warnings.some(function (w) { return /PrimeLib/.test(w); }), 'missing PrimeLib reported');
        a.eq(p.edits.length, 0, 'no file is planned to change');
      }
    });
  });

  /* ---------- 13. static-to-shared conversion with refactoring ---------- */
  var RF = { enabled: true, strategy: 'refactor', sharedLibraryName: 'Fw', schema: 'fw' };
  async function rfLoad(spec, cfg) { ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, RF, cfg || {}); return load(await Fx.libWorkspace(spec), 'fw.zip'); }
  function plan13(ws) { return ws.libConversion.targets[0].plan; }
  function cur(ws, p) { var o = ws.ws13.overlay[p]; return o && !o.deleted ? o.text : null; }

  test('R01', 'Refactor plan: interdependent libraries merged into one shared library; application-hooked subflow kept local', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      var ws = await rfLoad(Fx.frameworkSpec()), p = plan13(ws);
      a.eq(p.strategy, 'refactor', 'refactor strategy');
      a.eq(p.target.group.join(','), 'AuditL,FwL', 'AuditL and FwL form one dependency group');
      a.eq(p.target.sharedLibrary + ' / ' + p.target.schema, 'Fw / fw', 'target shared library and schema');
      a.eq(p.hooks.map(function (h) { return h.subflow; }).join(','), 'FwSub.subflow', 'only FwSub receives an application module (AppHook); the AuditSub hook comes from the library itself and stays shared');
      a.eq(JSON.stringify(p.localCopies), '{"App":["FwSub.subflow"]}', 'App gets a local copy of FwSub');
      a.ok(p.libraries.every(function (l) { return l.decision === 'convert'; }), 'both libraries convert');
      a.eq(p.errors.length + p.blockedCount, 0, 'no errors or blockers');
    });
  });
  test('R02', 'Refactor apply: references, module names (bare, quoted, promoted defaults), schema, bundleName, calls and constants rewritten; validation passes', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      var ws = await rfLoad(Fx.frameworkSpec());
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(v.passed, 'validation: ' + v.checks.map(function (c) { return c.id + ' ' + c.status + (c.problems.length ? ' ' + c.problems.slice(0, 2).join(' | ') : ''); }).join('; '));
      var dp = ACE.bar.parseDotProject(cur(ws, 'Fw/.project'));
      a.ok(dp.natures.indexOf('com.ibm.etools.msgbroker.tooling.sharedLibraryNature') >= 0 && dp.name === 'Fw', 'Fw is a shared library project');
      a.ok(/^BROKER SCHEMA fw\r?\n/.test(cur(ws, 'Fw/fw/Audit.esql')) && /^BROKER SCHEMA fw\r?\n/.test(cur(ws, 'Fw/fw/Common.esql')), 'default-schema ESQL moved into schema fw (folder fw/)');
      var au = cur(ws, 'Fw/fw/AuditSub.subflow');
      a.ok(/nsURI="fw\/AuditSub\.subflow"/.test(au) && /bundleName="fw\/AuditSub"/.test(au), 'subflow nsURI and translation bundleName carry the schema (runtime takes the schema from bundleName)');
      a.ok(/computeExpression="esql:\/\/routine\/fw#Audit_Mod\.Main"/.test(au), 'bare computeExpression qualified');
      a.ok(/filterExpression="esql:\/\/routine\/fw#Audit_Is\?\.Main"/.test(au), 'quoted module name with "?" qualified');
      a.ok(/defaultValueLiteral="esql:\/\/routine\/fw#Audit_Mod\.Main"/.test(au), 'bare promoted-property default qualified');
      var fs = cur(ws, 'Fw/fw/FwSub.subflow');
      a.ok(/xmlns:fw_AuditSub\.subflow="fw\/AuditSub\.subflow"/.test(fs) && /xmi:type="fw_AuditSub\.subflow:FCMComposite_1"/.test(fs), 'nested subflow namespace and node type rewritten');
      a.ok(/Hook="esql:\/\/routine\/fw#Fw_AuditHook\.Main"/.test(fs), 'library-to-library hook now points at the shared module');
      var loc = cur(ws, 'App/fw/local/FwSub.subflow');
      a.ok(loc && /nsURI="fw\/local\/FwSub\.subflow"/.test(loc) && /xmlns:fw_AuditSub\.subflow="fw\/AuditSub\.subflow"/.test(loc), 'local copy in the application nests the SHARED AuditSub');
      var flow = cur(ws, 'App/App.msgflow');
      a.ok(/"fw\/local\/FwSub\.subflow"/.test(flow) && /"fw\/FwPlain\.subflow"/.test(flow) && /AppHook="esql:\/\/routine\/#App_Hook\.Main"/.test(flow), 'application flow: hooked subflow -> local copy, other subflow -> shared, application hook unchanged');
      var esql = cur(ws, 'App/App.esql');
      a.ok(/CALL fw\.FwProc\(C1\)/.test(esql) && /PROCEDURE CopyEntireMessage\(\)/.test(esql), 'framework call qualified; module-local routine untouched');
      var cst = cur(ws, 'App/Fw_Constants.esql');
      a.ok(/DECLARE xsi NAMESPACE/.test(cst) && /DECLARE C1 CONSTANT/.test(cst) && !/Cache/.test(cst), 'namespace and constant used by the application copied (SHARED variable not copied)');
      a.ok(ACE.libconv.descriptorRefs(cur(ws, 'App/application.descriptor')).join() === 'Fw', 'application descriptor references Fw');
      var ap = ACE.bar.parseDotProject(cur(ws, 'App/.project'));
      a.eq(ap.projects.join(','), 'Fw', '.project: FwL -> Fw, AuditL removed');
      a.ok(ws.ws13.overlay['FwL/.project'].deleted && ws.ws13.overlay['AuditL/Audit.esql'].deleted, 'old library files removed from the working copy');
    });
  });
  test('R03', 'Refactor export: new shared library and local copies in the package, old libraries only under _original-before-changes/', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      var ws = await rfLoad(Fx.frameworkSpec()); ACE.workflow.convertLibraries();
      var z = await unzip((await ACE.workflow.exportPackage('ace13')).blob), names = Object.keys(z);
      a.ok(names.indexOf('Fw/.project') >= 0 && names.indexOf('Fw/fw/AuditSub.subflow') >= 0 && names.indexOf('App/fw/local/FwSub.subflow') >= 0 && names.indexOf('App/Fw_Constants.esql') >= 0, 'new files exported');
      a.ok(!names.some(function (n) { return /^(AuditL|FwL)\//.test(n); }), 'old library projects not exported as projects');
      a.ok(names.indexOf('_original-before-changes/FwL/.project') >= 0 && names.indexOf('_original-before-changes/AuditL/AuditSub.subflow') >= 0, 'originals kept for rollback');
      a.eq(names.filter(function (n) { return /^Fw\/jconn2\.jar$/.test(n); }).length, 1, 'identical jconn2.jar copies merged into one');
      a.eq(util.decodeText(z['Fw/jconn2.jar']).text, 'JAR-BYTES', 'binary file copied byte-for-byte');
      a.ok(z['_workbench/LIBRARY-CONVERSION-REPORT.md'] && /Refactoring/.test(util.decodeText(z['_workbench/LIBRARY-CONVERSION-REPORT.md']).text), 'report describes the refactoring');
    });
  });
  test('R04', 'Refactor is repeatable and reversible: a second run changes nothing; Undo restores the original workspace', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      var ws = await rfLoad(Fx.frameworkSpec()); ACE.workflow.convertLibraries();
      var n1 = Object.keys(ws.ws13.overlay).length;
      var r2 = ACE.workflow.convertLibraries();
      a.eq(r2.targets[0].applied.length, 0, 'second run applies nothing');
      a.eq(Object.keys(ws.ws13.overlay).length, n1, 'working copy unchanged');
      a.ok(r2.targets[0].validation.passed, 'still valid after the second run');
      ACE.workflow.undoLibraryConversion();
      a.eq(Object.keys(ws.ws13.overlay).length, 0, 'Undo removes every created, modified and removed-file entry');
      a.eq(plan13(ws).target.group.join(','), 'AuditL,FwL', 'the original static libraries are back and can be converted again');
    });
  });
  test('R05', 'Refactor blockers: SHARED variable used by the application, library calling application code, message flow in a library, missing project', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      function codes(ws) { var l = plan13(ws).libraries.filter(function (x) { return x.decision === 'blocked'; })[0]; return l ? l.blockers.map(function (b) { return b.code; }) : []; }
      var ws = await rfLoad(Fx.frameworkSpec(function (s) { s[2].files['App.esql'] += '\nCREATE PROCEDURE UseCache() BEGIN SET Cache.x = 1; END;\n'; return s; }));
      a.ok(codes(ws).indexOf('RF-CONSTANT-USE') >= 0 && plan13(ws).edits.length === 0, 'application using a library SHARED variable blocks (cannot be shared across schemas)');
      ws = await rfLoad(Fx.frameworkSpec(function (s) { s[2].files['App.esql'] += '\nCREATE PROCEDURE AppOnly() BEGIN END;\n'; s[1].files['Common.esql'] += '\nCREATE PROCEDURE CallsApp() BEGIN CALL AppOnly(); END;\n'; return s; }));
      a.ok(codes(ws).indexOf('RF-LIB-CALLS-APP') >= 0, 'library calling an application routine blocks');
      ws = await rfLoad(Fx.frameworkSpec(function (s) { s[0].files['Main.msgflow'] = Fx.flowXml('Main.msgflow', {}); return s; }));
      a.ok(codes(ws).indexOf('RF-MSGFLOW') >= 0, 'message flow inside a library blocks');
      ws = await rfLoad(Fx.frameworkSpec(function (s) { s[1].refs = s[1].refs.concat(['PrimeLib']); return s; }));
      a.ok(codes(ws).indexOf('RF-MISSING-PROJECT') >= 0 && plan13(ws).edits.length === 0, 'a library that has to convert references a project that is not in the input: blocks the whole run');
      ws = await rfLoad(Fx.frameworkSpec(function (s) { s[2].refs = s[2].refs.concat(['PrimeLib']); return s; }));
      a.ok(plan13(ws).blockedCount === 0 && plan13(ws).edits.length > 0 && plan13(ws).warnings.some(function (w) { return /PrimeLib/.test(w) && /STATIC/.test(w); }), 'an application that uses a library outside the input does not block: PrimeLib is assumed static and stays as it is (warning)');
      ws = await rfLoad(Fx.frameworkSpec(function (s) { s[2].refs = s[2].refs.concat(['PrimeLib']); return s; }), { knownStaticLibraries: ['PrimeLib'] });
      a.ok(plan13(ws).blockedCount === 0 && !plan13(ws).warnings.some(function (w) { return /PrimeLib/.test(w); }), 'listed under "Static libraries not in the input": no warning');
    });
  });
  test('R06', 'Single library keeps its name: refactor reduces to the minimal change when nothing needs to move', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, { enabled: true, strategy: 'refactor' });
      var ws = await load(await Fx.libWorkspace([{ name: 'App1', kind: 'app', refs: ['Lib1'] }, { name: 'Lib1', kind: 'static' }]), 'one.zip');
      var e = plan13(ws).edits.map(function (x) { return x.path; }).sort().join(',');
      a.eq(e, 'App1/application.descriptor,Lib1/.project', 'only the shared nature and the descriptor reference change (same as the type-change strategy)');
    });
  });
  test('R07', 'Real workspace ZIP(s): refactor plan; ContentCreate converts; valleysoft converts and reports its PrimeLib (not in the input)', { category: 'Library conversion (refactor)', requires: 'workspace' }, async function (a, env) {
    var files = env.workspaceFiles && env.workspaceFiles.length ? env.workspaceFiles : [env.workspaceFile];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      await withLC({ enabled: true, strategy: 'refactor', sharedLibraryName: 'ADIBFramework', schema: 'adib.framework' }, async function () {
        var ws = await load(await util.readFileBytes(f), f.name), p = plan13(ws);
        a.note(f.name + ': ' + p.libraries.map(function (l) { return l.name + '=' + l.decision; }).join(', ') + '; hooks ' + (p.hooks || []).map(function (h) { return h.subflow; }).join(', ') + '; edits ' + p.edits.length);
        if (/ContentCreate/i.test(f.name)) {
          a.ok(p.blockedCount === 0 && p.edits.length > 100, 'ContentCreate: all four libraries merge into ADIBFramework (' + p.edits.length + ' file operations)');
          var run = ACE.workflow.convertLibraries();
          a.ok(run.targets[0].validation.passed, 'ContentCreate: validation ' + run.targets[0].validation.checks.map(function (c) { return c.id + ' ' + c.status; }).join(', '));
        } else if (/valleysoft/i.test(f.name)) {
          a.ok(p.blockedCount === 0 && p.warnings.some(function (w) { return /PrimeLib/.test(w) && /STATIC/.test(w); }), 'valleysoft: converts; PrimeLib (not in the input) is assumed static and reported, not a blocker');
        } else a.ok(true, 'analysed');
      });
    }
  });

  /* ---------- 14. static-to-shared conversion keeping the libraries separate (default) ---------- */
  var SEP = { enabled: true, strategy: 'separate' };
  async function sepLoad(spec) { ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, SEP); return load(await Fx.libWorkspace(spec), 'sep.zip'); }

  test('S01', 'Separate strategy: every library keeps its name; nested subflows of another library copied into the library; application hook copied into the application', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC(SEP, async function () {
      a.eq(ACE.libconv.DEFAULTS.strategy, 'separate', 'separate is the default strategy');
      var ws = await sepLoad(Fx.frameworkSpec()), p = plan13(ws);
      a.eq(p.strategy, 'separate', 'strategy'); a.eq(p.converted.join(','), 'AuditL,FwL', 'both libraries convert');
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(v.passed, 'validation: ' + v.checks.map(function (c) { return c.id + ' ' + c.status + (c.problems.length ? ' ' + c.problems.slice(0, 2).join(' | ') : ''); }).join('; '));
      a.ok(!Object.keys(ws.ws13.overlay).some(function (k) { return /^(Fw|SharedFramework)\//.test(k); }), 'no merged library is created');
      a.ok(ACE.bar.parseDotProject(cur(ws, 'AuditL/.project')).natures.indexOf('com.ibm.etools.msgbroker.tooling.sharedLibraryNature') >= 0 && ACE.bar.parseDotProject(cur(ws, 'FwL/.project')).natures.indexOf('com.ibm.etools.msgbroker.tooling.sharedLibraryNature') >= 0, 'AuditL and FwL keep their names and become shared libraries');
      a.ok(/^BROKER SCHEMA AuditL\r?\n/.test(cur(ws, 'AuditL/AuditL/Audit.esql')) && /^BROKER SCHEMA FwL\r?\n/.test(cur(ws, 'FwL/FwL/Common.esql')), 'each library uses a schema named after itself');
      var nested = cur(ws, 'FwL/FwL/local/AuditL/AuditSub.subflow');
      a.ok(nested && /nsURI="FwL\/local\/AuditL\/AuditSub\.subflow"/.test(nested) && /computeExpression="esql:\/\/routine\/AuditL#Audit_Mod\.Main"/.test(nested), 'FwL holds its own copy of AuditSub that runs AuditL\'s module');
      var fs = cur(ws, 'FwL/FwL/FwSub.subflow');
      a.ok(/xmlns:FwL_local_AuditL_AuditSub\.subflow="FwL\/local\/AuditL\/AuditSub\.subflow"/.test(fs) && /Hook="esql:\/\/routine\/FwL#Fw_AuditHook\.Main"/.test(fs), 'FwSub nests the local copy and its library-to-library hook resolves inside FwL');
      a.ok(/CALL AuditL\.AuditLog\(v\)/.test(cur(ws, 'FwL/FwL/Common.esql')), 'call into the other library schema-qualified');
      a.ok(cur(ws, 'App/App/local/FwL/FwSub.subflow') && /"App\/local\/FwL\/FwSub\.subflow"/.test(cur(ws, 'App/App.msgflow')) && /"FwL\/FwPlain\.subflow"/.test(cur(ws, 'App/App.msgflow')), 'application: hooked subflow local, other subflow shared');
      a.ok(/CALL FwL\.FwProc\(C1\)/.test(cur(ws, 'App/App.esql')) && /DECLARE xsi NAMESPACE/.test(cur(ws, 'App/FwL_Constants.esql')), 'application call qualified; namespace/constant copied');
      a.eq(ACE.libconv.descriptorRefs(cur(ws, 'App/application.descriptor')).sort().join(','), 'AuditL,FwL', 'application descriptor lists both shared libraries');
      a.eq(ACE.libconv.descriptorRefs(cur(ws, 'FwL/library.descriptor')).join(','), 'AuditL', 'FwL descriptor lists AuditL');
      var r2 = ACE.workflow.convertLibraries(); a.eq(r2.targets[0].applied.length, 0, 'repeat run changes nothing');
      ACE.workflow.undoLibraryConversion(); a.eq(Object.keys(ws.ws13.overlay).length, 0, 'Undo restores everything');
    });
  });
  test('S02', 'Java routines in a shared library get CLASSLOADER "{Library}"; build commands name the Java project', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC(SEP, async function () {
      var ws = await sepLoad([
        { name: 'App', kind: 'app', refs: ['JLib'], files: { 'App.esql': 'CREATE COMPUTE MODULE App_C\nEND MODULE;\n' } },
        { name: 'JLib', kind: 'static', refs: ['JPrj'], files: { 'com/j/Util.esql': 'BROKER SCHEMA com.j\n\nCREATE FUNCTION enc(IN s CHARACTER) RETURNS CHARACTER\nLANGUAGE JAVA\nEXTERNAL NAME "p.Sec.enc";\n\nCREATE FUNCTION other(IN s CHARACTER) RETURNS CHARACTER\nLANGUAGE JAVA\nEXTERNAL NAME "q.Elsewhere.run";\n' } },
        { name: 'JPrj', kind: 'java', files: { 'src/p/Sec.java': 'package p; public class Sec { public static String enc(String s) { return s; } }\n' } }]);
      var run = ACE.workflow.convertLibraries(), t = cur(ws, 'JLib/com/j/Util.esql');
      a.ok(/EXTERNAL NAME "p\.Sec\.enc" CLASSLOADER "\{JLib\}";/.test(t), 'class from the referenced Java project -> CLASSLOADER "{JLib}"');
      a.ok(/EXTERNAL NAME "q\.Elsewhere\.run";/.test(t), 'class not in the library -> unchanged');
      a.ok(run.targets[0].validation.checks.filter(function (c) { return c.id === 'V12'; })[0].status === 'PASS', 'V12 passes');
      a.ok(/--project JLib .*--project JPrj/.test(run.targets[0].state.build.commands[0].command), 'build command names the Java project so ibmint compiles it');
    });
  });
  test('S04', 'Toolkit import: an application copy also copies the subflows it nests (except JavaCompute ones); promoted nodes get the promoted ESQL value', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC(SEP, async function () {
      var ws = await sepLoad(Fx.frameworkSpec(function (spec) {
        var fw = spec[1].files;
        fw['JSub.subflow'] = Fx.flowXml('JSub.subflow', { nodes: [{ type: 'ComIbmJavaCompute.msgnode', attrs: { javaClass: 'p.Load' } }] });
        fw['FwSub.subflow'] = Fx.flowXml('FwSub.subflow', { uses: [{ prefix: 'AuditSub.subflow', ns: 'AuditSub.subflow' }, { prefix: 'JSub.subflow', ns: 'JSub.subflow' }], props: [{ name: 'AppHook', def: 'esql://routine/#Fw_Default.Main' }], nodes: [{ type: 'ComIbmCompute.msgnode', attrs: { computeExpression: 'Stale_Old_Name' } }, { type: 'AuditSub.subflow', attrs: { Hook: 'esql://routine/#Fw_AuditHook.Main' } }, { type: 'JSub.subflow', attrs: {} }], links: [{ prop: 'AppHook', node: 1, href: 'ComIbmCompute.msgnode#Property.computeExpression' }] });
        return spec;
      }));
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(v.passed, 'validation: ' + v.checks.filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return c.id + ' ' + c.problems.slice(0, 2).join(' | '); }).join('; '));
      var loc = cur(ws, 'App/App/local/FwL/FwSub.subflow') || '';
      a.ok(cur(ws, 'App/App/local/AuditL/AuditSub.subflow') && /"App\/local\/AuditL\/AuditSub\.subflow"/.test(loc) && !/"AuditL\/AuditSub\.subflow"/.test(loc), 'the hooked copy nests its own copy of AuditSub (no promoted-property link into a shared library)');
      a.ok(/"FwL\/JSub\.subflow"/.test(loc) && !cur(ws, 'App/App/local/FwL/JSub.subflow'), 'JSub (JavaCompute) stays in the shared library: its class is not accessible to the application');
      a.ok(/computeExpression="esql:\/\/routine\/FwL#Fw_Default\.Main"/.test(loc) && !/Stale_Old_Name/.test(loc), 'promoted Compute node gets the promoted value');
      a.ok(/computeExpression="esql:\/\/routine\/FwL#Fw_Default\.Main"/.test(cur(ws, 'FwL/FwL/FwSub.subflow')), 'same in the shared library');
      ACE.workflow.undoLibraryConversion();
    });
  });
  /* R11 (verified on ACE 13.0.2.0): a node that writes the message, with validation on, cannot find the application's message model inside a shared library (BIP5058E). */
  function valSpec(subDir) {
    var D = subDir ? 'fv/' : '', B = function (n) { return { prefix: n + '.msgnode', ns: n + '.msgnode' }; }, RESET = 'ComIbmResetContentDescriptor', REPLY = 'ComIbmSOAPReply';
    function sf(name, o) { return Fx.flowXml(D + name + '.subflow', o); }
    var files = {};
    files[D + 'Wr.subflow'] = sf('Wr', { uses: [B(RESET)], nodes: [{ type: RESET + '.msgnode', attrs: { resetMessageDomain: 'true' } }] });
    files[D + 'RepNone.subflow'] = sf('RepNone', { uses: [B(REPLY)], nodes: [{ type: REPLY + '.msgnode', attrs: { validateMaster: 'none' } }] });
    files[D + 'RepDef.subflow'] = sf('RepDef', { uses: [B(REPLY)], nodes: [{ type: REPLY + '.msgnode', attrs: {} }] });
    files[D + 'RepProm.subflow'] = sf('RepProm', { uses: [B(REPLY)], props: [{ name: 'validateMaster', def: 'none' }], nodes: [{ type: REPLY + '.msgnode', attrs: {} }], links: [{ prop: 'validateMaster', node: 1, href: REPLY + '.msgnode#Property.validateMaster' }] });
    files[D + 'Plain.subflow'] = sf('Plain', { nodes: [{ type: 'ComIbmCompute.msgnode', attrs: {} }] });
    files[D + 'Outer.subflow'] = sf('Outer', { uses: [{ prefix: 'Wr.subflow', ns: D + 'Wr.subflow' }], nodes: [{ type: 'Wr.subflow', attrs: {} }] });
    return files;
  }
  function valApp(name, input, ns) {
    var D = ns ? 'fv/' : '', U = function (n) { return { prefix: n + '.subflow', ns: D + n + '.subflow' }; };
    var nodes = [{ type: input + '.msgnode', attrs: {} }], uses = [{ prefix: input + '.msgnode', ns: input + '.msgnode' }];
    ['Wr', 'RepNone', 'RepDef', 'RepProm', 'Plain', 'Outer'].forEach(function (n) { uses.push(U(n)); nodes.push({ type: n + '.subflow', attrs: {} }); });
    uses.push(U('RepProm')); nodes.push({ type: 'RepProm.subflow', attrs: { validateMaster: 'contentAndValue' } });
    var f = {}; f[name + '.msgflow'] = Fx.flowXml(name + '.msgflow', { uses: uses.filter(function (u, i, a) { return a.findIndex(function (x) { return x.prefix === u.prefix; }) === i; }), nodes: nodes });
    return f;
  }
  test('R08', 'Validation (BIP5058E): the merge strategy also keeps subflows that write the message local to an application that validates', { category: 'Library conversion (refactor)' }, async function (a) {
    await withLC(RF, async function () {
      var ws = await rfLoad([
        { name: 'FwV', kind: 'static', files: valSpec(false) },
        { name: 'AppS', kind: 'app', refs: ['FwV'], files: valApp('AppS', 'ComIbmSOAPInput', false) },
        { name: 'AppM', kind: 'app', refs: ['FwV'], files: valApp('AppM', 'ComIbmMQInput', false) }]), p = plan13(ws);
      var names = p.hooks.map(function (h) { return h.subflow; }).sort().join(',');
      a.eq(names, 'Outer.subflow,RepDef.subflow,RepProm.subflow,Wr.subflow', 'the writer subflows (and the one that nests one) are kept local; RepNone and Plain stay shared: ' + names);
      a.ok(p.hooks.every(function (h) { return h.properties.some(function (q) { return q.property === 'validateMaster'; }); }), 'recorded with the reason (message validation)');
      a.ok(!!p.localCopies.AppS, 'the application that validates gets the local copies (the merge strategy records them for every application that uses these subflows, as it does for hooks)');
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(v.passed && v.checks.filter(function (c) { return c.id === 'V13'; })[0].status === 'PASS', 'validation (V13) passes: ' + v.checks.filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return c.id + ' ' + c.problems.slice(0, 1).join(''); }).join('; '));
      ACE.workflow.undoLibraryConversion();
    });
  });
  test('S05', 'Validation (BIP5058E): subflows that write the message stay local to an application that validates; others stay shared', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC(SEP, async function () {
      var ws = await sepLoad([
        { name: 'FwV', kind: 'static', files: valSpec(true) },
        { name: 'AppS', kind: 'app', refs: ['FwV'], files: valApp('AppS', 'ComIbmSOAPInput', true) },
        { name: 'AppM', kind: 'app', refs: ['FwV'], files: valApp('AppM', 'ComIbmMQInput', true) }]);
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(v.passed, 'validation: ' + v.checks.filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return c.id + ' ' + c.problems.slice(0, 2).join(' | '); }).join('; '));
      a.ok(v.checks.filter(function (c) { return c.id === 'V13'; })[0].status === 'PASS', 'V13 passes');
      var flow = cur(ws, 'AppS/AppS.msgflow'), loc = function (n) { return cur(ws, 'AppS/AppS/local/FwV/' + n + '.subflow'); };
      a.ok(loc('Wr') && /ResetContentDescriptor/.test(loc('Wr')), 'ResetContentDescriptor (no validation property): local copy in the application that validates (SOAP Input validates by default)');
      a.ok(loc('RepDef'), 'SOAP Reply with default validation: local');
      a.ok(loc('Outer'), 'a subflow that nests such a subflow: local');
      a.ok(loc('RepProm'), 'promoted validateMaster set to contentAndValue on the instance: local');
      a.ok(!loc('RepNone'), 'SOAP Reply with validateMaster none: stays shared');
      a.ok(!loc('Plain'), 'a Compute-only subflow: stays shared');
      a.ok(/"fv\/RepNone\.subflow"/.test(flow) && /"fv\/Plain\.subflow"/.test(flow) && /"AppS\/local\/FwV\/Wr\.subflow"/.test(flow), 'the application flow points at the local copies and at the shared subflows');
      var m = cur(ws, 'AppM/AppM.msgflow');
      a.ok(!cur(ws, 'AppM/AppM/local/FwV/Wr.subflow') && /"fv\/Wr\.subflow"/.test(m), 'an application whose input does not validate (MQ Input) keeps using the shared subflows');
      var note = ws.ws13.overlay['AppS/AppS/local/FwV/Wr.subflow'];
      a.ok(note && /BIP5058E/.test(JSON.stringify(note.history || note)), 'the change log of the copy names the reason (BIP5058E)');
      ACE.workflow.undoLibraryConversion();
    });
  });
  test('S06', 'Validation (BIP5058E): the type-change-only strategy cannot keep the subflow local, so validation reports it; a JavaCompute subflow is only warned about', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC({ enabled: true, strategy: 'in-place' }, async function () {
      var ws = await lcLoad([
        { name: 'FwV', kind: 'static', files: valSpec(true) },
        { name: 'AppS', kind: 'app', refs: ['FwV'], files: valApp('AppS', 'ComIbmSOAPInput', true) }], { enabled: true });
      var run = ACE.workflow.convertLibraries(), c = run.targets[0].validation.checks.filter(function (x) { return x.id === 'V13'; })[0];
      a.eq(c.status, 'FAIL', 'V13 fails for the in-place conversion');
      a.ok(c.problems.some(function (p) { return /BIP5058E/.test(p) && /Keep libraries separate/.test(p); }), 'and tells what to do: ' + c.problems[0].slice(0, 160));
      ACE.workflow.undoLibraryConversion();
    });
    await withLC(SEP, async function () {
      var jfiles = valSpec(true); jfiles['fv/Jv.subflow'] = Fx.flowXml('fv/Jv.subflow', { uses: [{ prefix: 'ComIbmJavaCompute.msgnode', ns: 'ComIbmJavaCompute.msgnode' }, { prefix: 'ComIbmResetContentDescriptor.msgnode', ns: 'ComIbmResetContentDescriptor.msgnode' }], nodes: [{ type: 'ComIbmJavaCompute.msgnode', attrs: { javaClass: 'p.Load' } }, { type: 'ComIbmResetContentDescriptor.msgnode', attrs: {} }] });
      var app = valApp('AppS', 'ComIbmSOAPInput', true), flow = app['AppS.msgflow'];
      app['AppS.msgflow'] = flow.replace('xmlns:Plain.subflow=', 'xmlns:Jv.subflow="fv/Jv.subflow" xmlns:Plain.subflow=').replace('<composition>', '<composition><nodes xmi:type="Jv.subflow:FCMComposite_1" xmi:id="FCMComposite_1_99" location="0,0"><translation xmi:type="utility:ConstantString" string="Jv"/></nodes>');
      var ws = await sepLoad([{ name: 'FwV', kind: 'static', files: jfiles }, { name: 'AppS', kind: 'app', refs: ['FwV'], files: app }]), p = plan13(ws);
      a.ok(!cur(ws, 'AppS/AppS/local/FwV/Jv.subflow'), 'the Java-compute subflow is not copied into the application');
      a.ok((p.warnings || []).some(function (w) { return /Jv\.subflow|fv\/Jv/.test(w) && /JavaCompute/.test(w) && /BIP5058E/.test(w); }), 'a subflow that needs the model but holds a JavaCompute node is not moved; a warning says so');
    });
  });

  /* Which libraries convert: connected libraries convert together (Toolkit: a static library cannot reference a shared one, a shared one cannot reference a static one) */
  function groupSpec() { return Fx.frameworkSpec(function (s) { s.push({ name: 'Solo', kind: 'static', files: { 'Solo.esql': 'CREATE PROCEDURE SoloP() BEGIN END;\n' } }); s[2].refs = s[2].refs.concat(['Solo']); return s; }); }
  async function groupLoad(libraries) { ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, SEP, libraries ? { libraries: libraries } : {}); return load(await Fx.libWorkspace(groupSpec()), 'grp.zip'); }
  test('G01', 'Partial conversion: an unconnected static library stays static and the application keeps referencing it; connected libraries convert together with the reason', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC(SEP, async function () {
      var ws = await groupLoad(['AuditL', 'FwL']), p = plan13(ws), dec = {};
      p.libraries.forEach(function (l) { dec[l.name] = l.decision; });
      a.eq(JSON.stringify(dec), JSON.stringify({ AuditL: 'convert', FwL: 'convert', Solo: 'not-selected' }), 'AuditL and FwL convert; Solo (not connected to them) stays static: ' + JSON.stringify(dec));
      a.ok(p.libraries.filter(function (l) { return l.name === 'Solo'; })[0].reasons.join(' ').indexOf('stays a static library') >= 0, 'the table says why Solo stays static');
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(v.passed, 'validation passes: ' + v.checks.filter(function (c) { return c.status === 'FAIL'; }).map(function (c) { return c.id + ' ' + c.problems.slice(0, 1).join(''); }).join('; '));
      a.ok(!cur(ws, 'Solo/.project') && !cur(ws, 'Solo/Solo.esql'), 'the static library Solo is not touched');
      var ap = cur(ws, 'App/.project') || '', refs = ACE.libconv.descriptorRefs(cur(ws, 'App/application.descriptor'));
      a.ok(/<project>Solo<\/project>/.test(ap) || !ap, 'the application still references Solo (project reference unchanged)');
      a.eq(refs.sort().join(','), 'AuditL,FwL', 'the application descriptor lists only the shared libraries');
      a.ok(!/sharedLibraryNature/.test(ACE.workflow.state.ws.files.filter(function (f) { return /Solo\/\.project$/.test(f.path); }).map(function (f) { return ACE.bar.text(f); }).join('')), 'Solo has no shared nature');
      ACE.workflow.undoLibraryConversion();
      // all static libraries
      ws = await groupLoad(null); p = plan13(ws);
      a.ok(p.libraries.every(function (l) { return l.decision === 'convert'; }), 'with "all static libraries" Solo converts as well');
    });
  });
  test('G02', 'Partial conversion: a library left static but connected to a converted one is explained and blocks until you decide', { category: 'Library conversion (separate)' }, async function (a) {
    await withLC(SEP, async function () {
      var ws = await groupLoad(['AuditL']), p = plan13(ws), fl = p.libraries.filter(function (l) { return l.name === 'FwL'; })[0];
      a.ok(p.blockedCount > 0 && p.edits.length === 0, 'nothing is changed');
      a.ok(fl.blockers.some(function (b) { return b.code === 'RF-STATIC-CONFLICT' && /FwL cannot stay static/.test(b.detail) && /static library cannot reference a shared library/.test(b.detail); }), 'FwL cannot stay static: ' + (fl.blockers[0] && fl.blockers[0].detail));
      a.eq(p.target.forced.join(','), 'FwL', 'the plan names the libraries that must convert too');
      // ticking them resolves it
      ws = await groupLoad(['AuditL'].concat(p.target.forced)); p = plan13(ws);
      a.ok(p.blockedCount === 0 && p.converted.join(',') === 'AuditL,FwL', 'with them ticked the conversion is planned: ' + p.converted.join(','));
      // the merge strategy applies the same rule
      ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, RF, { libraries: ['AuditL'] });
      ws = await load(await Fx.libWorkspace(groupSpec()), 'grpm.zip'); p = plan13(ws);
      a.ok(p.blockedCount > 0 && p.target.forced.join(',') === 'FwL', 'merge strategy: same conflict');
    });
  });
  test('G03', 'Validation: a subflow with a JavaCompute node that reaches a node writing the message stays shared; that node gets validation switched off in the library copy', { category: 'Library conversion (separate)' }, async function (a) {
    function build(inner) {
      var U = function (p, n) { return { prefix: p, ns: n }; }, files = {};
      files['fv/Rep.subflow'] = Fx.flowXml('fv/Rep.subflow', { uses: [U('ComIbmSOAPReply.msgnode', 'ComIbmSOAPReply.msgnode'), U('ComIbmResetContentDescriptor.msgnode', 'ComIbmResetContentDescriptor.msgnode')], nodes: [{ type: inner + '.msgnode', attrs: {} }] });
      files['fv/Jv.subflow'] = Fx.flowXml('fv/Jv.subflow', { uses: [U('ComIbmJavaCompute.msgnode', 'ComIbmJavaCompute.msgnode'), U('Rep.subflow', 'fv/Rep.subflow')], nodes: [{ type: 'ComIbmJavaCompute.msgnode', attrs: { javaClass: 'p.Load' } }, { type: 'Rep.subflow', attrs: {} }] });
      var app = {}; app['AppS.msgflow'] = Fx.flowXml('AppS.msgflow', { uses: [U('ComIbmSOAPInput.msgnode', 'ComIbmSOAPInput.msgnode'), U('Jv.subflow', 'fv/Jv.subflow')], nodes: [{ type: 'ComIbmSOAPInput.msgnode', attrs: {} }, { type: 'Jv.subflow', attrs: {} }] });
      return [{ name: 'FwV', kind: 'static', files: files }, { name: 'AppS', kind: 'app', refs: ['FwV'], files: app }];
    }
    await withLC(SEP, async function () {
      var ws = await sepLoad(build('ComIbmSOAPReply')), p = plan13(ws);
      a.ok(!cur(ws, 'AppS/AppS/local/FwV/Jv.subflow'), 'the Java subflow is not copied into the application');
      a.ok(p.notes.some(function (n) { return /Validation switched off/.test(n) && /Rep\.subflow/.test(n); }), 'a note says which nodes were switched off and why');
      var run = ACE.workflow.convertLibraries(), v = run.targets[0].validation;
      a.ok(/<nodes xmi:type="ComIbmSOAPReply.msgnode:FCMComposite_1"[^>]*validateMaster="none"/.test(cur(ws, 'FwV/fv/Rep.subflow') || ''), 'the SOAP Reply node in the library copy has validateMaster="none"');
      a.ok(v.passed && v.checks.filter(function (c) { return c.id === 'V13'; })[0].status === 'PASS' && !v.checks.some(function (c) { return c.id === 'V13b'; }), 'V13 passes and nothing is left to check by hand');
      ACE.workflow.undoLibraryConversion();
      // a node without a validation property (Reset Content Descriptor) cannot be switched off: reported
      ws = await sepLoad(build('ComIbmResetContentDescriptor')); p = plan13(ws);
      a.ok(p.warnings.some(function (w) { return /ResetContentDescriptor/.test(w) && /JavaCompute/.test(w) && /BIP5058E/.test(w); }), 'Reset Content Descriptor next to a JavaCompute node: warning, check by hand');
      run = ACE.workflow.convertLibraries();
      a.ok(run.targets[0].validation.checks.some(function (c) { return c.id === 'V13b' && c.status === 'WARN'; }), 'and validation shows warning V13b');
      ACE.workflow.undoLibraryConversion();
    });
  });
  test('S03', 'Real workspace ZIP(s): the separate strategy keeps all library names; ContentCreate converts and validates', { category: 'Library conversion (separate)', requires: 'workspace' }, async function (a, env) {
    var files = env.workspaceFiles && env.workspaceFiles.length ? env.workspaceFiles : [env.workspaceFile];
    for (var i = 0; i < files.length; i++) {
      var f = files[i];
      if (!/ContentCreate/i.test(f.name)) continue;
      await withLC(SEP, async function () {
        ACE.settings.current.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, SEP);
        var ws = await load(await util.readFileBytes(f), f.name), p = plan13(ws);
        a.ok(p.blockedCount === 0 && p.converted.length === 4, f.name + ': 4 libraries convert, names kept: ' + p.converted.join(', '));
        var run = ACE.workflow.convertLibraries();
        a.ok(run.targets[0].validation.passed, f.name + ': validation ' + run.targets[0].validation.checks.map(function (c) { return c.id + ' ' + c.status; }).join(', '));
        ACE.workflow.undoLibraryConversion();
      });
    }
    a.ok(true, 'done');
  });

  /* ---------- 15. external validation ---------- */
  test('X01', 'ACE 12.0.5 Toolkit imports the ACE 12 package and builds without errors', { category: 'IBM Toolkit validation', external: true });
  test('X02', 'ACE 13.0.8 Toolkit imports the ACE 13 package; Java project builds; BAR can be built', { category: 'IBM Toolkit validation', external: true });
  test('X03', 'BAR rebuilt in ACE 13 deploys to an ACE 13.0.8 integration server (Java 17) and passes regression tests', { category: 'IBM runtime validation', external: true });
  test('X04', 'Decompiled Java behaves like the original (functional equivalence)', { category: 'IBM runtime validation', external: true });
})();
