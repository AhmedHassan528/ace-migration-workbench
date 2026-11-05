/* Tests: BAR vs source-code comparison (js/compare/bar-source-compare.js). Loaded after test-cases.js. */
(function () {
  'use strict';
  var test = T.test, util = ACE.util, C = ACE.cmp;
  var APP = ['com.ibm.etools.msgbroker.tooling.applicationNature', 'com.ibm.etools.msgbroker.tooling.messageBrokerProjectNature'];
  var LIB = ['com.ibm.etools.msgbroker.tooling.libraryNature', 'com.ibm.etools.msgbroker.tooling.messageBrokerProjectNature'];
  var JAVA = ['org.eclipse.jdt.core.javanature'];
  var ESQL_A = 'BROKER SCHEMA a\nCREATE COMPUTE MODULE A_Main\n  CREATE FUNCTION Main() RETURNS BOOLEAN\n  BEGIN\n    RETURN TRUE;\n  END;\nEND MODULE;\n';
  var FLOW = function (tag) { return '<?xml version="1.0" encoding="UTF-8"?>\n<ecore:EPackage nsURI="A.msgflow">\n  <nodes name="' + tag + '"/>\n</ecore:EPackage>\n'; };
  var WSDL = function (v) { return '<definitions name="S">\n  <operation name="' + v + '"/>\n</definitions>\n'; };

  function src(projects) {      // projects: [{name, natures, files:{rel:text|bytes}}] -> workspace ZIP bytes
    var entries = [];
    projects.forEach(function (p) {
      entries.push({ name: 'ws/' + p.name + '/.project', data: Fx.dotProject(p.name, [], p.natures) });
      Object.keys(p.files || {}).forEach(function (rel) { var f = p.files[rel]; entries.push(f && f.data !== undefined ? Object.assign({ name: 'ws/' + p.name + '/' + rel }, f) : { name: 'ws/' + p.name + '/' + rel, data: f, method: 8 }); });
    });
    return Fx.rawZip(entries);
  }
  async function bar(apps, extra) {     // apps: [{name, files:{path:text|{data,...}}}]
    var entries = [{ name: 'META-INF/manifest.mf', data: 'x' }];
    for (var i = 0; i < apps.length; i++) {
      var ae = [{ name: 'META-INF/manifest.mf', data: 'x' }];
      Object.keys(apps[i].files).forEach(function (rel) { var f = apps[i].files[rel]; ae.push(f && f.data !== undefined ? Object.assign({ name: rel }, f) : { name: rel, data: f, method: 8 }); });
      entries.push({ name: apps[i].name + '.appzip', data: await Fx.rawZip(ae) });
    }
    return Fx.rawZip(entries.concat(extra || []));
  }
  function F(bytes, name) { return new File([bytes], name); }
  var BADJAR = { data: 'this is not a jar', crc: 12345 };      // a CRC error would surface if anything extracted it
  async function scenario() {
    var libz = await Fx.rawZip([{ name: 'FwCommon.esql', data: 'x' }]);
    var s = await src([
      { name: 'AppA', natures: APP, files: {
        'AppA.esql': ESQL_A, 'AppA.msgflow': FLOW('one'), 'AppA.wsdl': WSDL('op1'), 'AppA.xsd': '<xs:schema/>\n', 'Missing.esql': 'x\n', 'Sub.subflow': FLOW('sub'),
        'util/Helper.esql': 'BROKER SCHEMA util\n', 'src/Util.java': 'class Util {}', 'lib/x.jar': BADJAR } },
      { name: 'AppB', natures: APP, files: { 'AppB.esql': 'x\n' } },
      { name: 'FwLib', natures: LIB, files: { 'FwCommon.esql': 'BROKER SCHEMA fw\n', 'FwOther.esql': 'BROKER SCHEMA fw\n' } },
      { name: 'JPrj', natures: JAVA, files: { 'src/X.java': 'class X {}' } }]);
    var b = await bar([
      { name: 'AppA', files: {
        'AppA.esql': ESQL_A, 'AppA.msgflow': FLOW('two'), 'AppA.wsdl': WSDL('op2'), 'AppA.xsd': '<xs:schema/>\n', 'Extra.esql': 'x\n',
        'Sub.subflow': FLOW('sub').replace(/\n/g, '\r\n'), 'Helper.esql': 'BROKER SCHEMA util\n', 'FwCommon.esql': 'BROKER SCHEMA fw\n', 'FwOther.esql': 'changed\n',
        'ibm.jar': BADJAR, 'FwLib.libzip': libz, 'META-INF/broker.xml': '<x/>' } },
      { name: 'AppC', files: { 'AppC.esql': 'x\n' } }], [{ name: 'Shared.shlibzip', data: libz }, { name: 'root.jar', data: BADJAR.data, crc: 1 }]);
    return { src: F(s, 'src.zip'), bar: F(b, 'T.bar') };
  }
  async function run(sc, opt, folder) {
    var source = await C.readSource(folder ? { files: folder } : { zip: sc.src }), brr = await C.readBar(sc.bar);
    return C.compare(source, brr, opt || {});
  }
  function find(res, app, path) { return res.files.filter(function (f) { return f.app === app && f.path === path; })[0]; }

  test('C01', 'BAR vs source: applications matched by name; statuses and severities; JARs and libraries are never read', { category: 'BAR vs source' }, async function (a) {
    var res = await run(await scenario());
    var s = res.summary;
    a.eq(s.applications.compared + '/' + s.applications.onlyInBar + '/' + s.applications.onlyInSource, '1/1/1', 'applications compared / only in BAR (AppC) / only in source (AppB)');
    a.eq(res.apps.filter(function (x) { return x.status === 'only-in-bar'; })[0].name, 'AppC', 'AppC has no source');
    a.eq(find(res, 'AppA', 'AppA.esql').status, 'identical', 'same ESQL is identical');
    var m = find(res, 'AppA', 'AppA.msgflow'); a.ok(m.status === 'modified' && m.severity === 'difference' && m.type === 'Message flow', 'modified message flow is a (non-critical) difference');
    var w = find(res, 'AppA', 'AppA.wsdl'); a.ok(w.status === 'modified' && w.severity === 'critical' && w.type === 'WSDL', 'modified WSDL is critical');
    a.eq(find(res, 'AppA', 'AppA.xsd').status, 'identical', 'same XSD identical');
    var mi = find(res, 'AppA', 'Missing.esql'); a.ok(mi.status === 'missing-in-bar' && mi.severity === 'critical' && mi.srcStatus === 'Present' && mi.barStatus === 'Missing', 'a source file that is not in the BAR is critical');
    var ex = find(res, 'AppA', 'Extra.esql'); a.ok(ex.status === 'extra-in-bar' && ex.severity === 'warning' && ex.srcStatus === 'Absent', 'a BAR file with no source is a non-critical warning');
    var sub = find(res, 'AppA', 'Sub.subflow'); a.ok(sub.status === 'identical' && sub.cosmetic, 'line endings only: identical, flagged cosmetic');
    var h = find(res, 'AppA', 'util/Helper.esql'); a.ok(h.status === 'identical' && /different folder/.test(h.note), 'a file in another folder of the BAR is paired by name and says so: ' + h.note);
    a.ok(!find(res, 'AppA', 'FwCommon.esql') && res.ignored.some(function (x) { return x.path === 'FwCommon.esql' && /FwLib/.test(x.reason); }), 'framework ESQL inside the BAR application is ignored');
    a.ok(find(res, 'AppA', 'FwOther.esql') === undefined && res.ignored.length === 2, 'both framework ESQL files ignored even when their content differs');
    a.ok(!res.files.some(function (f) { return /\.java$|\.jar$/.test(f.path); }), 'Java and JAR files are not part of the result');
    a.eq(res.files.length, 8, 'files in the result (AppA only)');
    a.eq(s.critical, 2, 'critical issues: 1 missing + 1 WSDL change'); a.eq(s.wsdlXsdChanges, 1, 'WSDL/XSD changes');
    a.ok(res.apps.filter(function (x) { return x.name === 'AppA'; })[0].severity === 'critical', 'application result is the worst file result');
    a.ok(res.source.ignoredProjects.map(function (p) { return p.name; }).sort().join(',') === 'FwLib,JPrj', 'library and Java projects of the source are ignored');
    a.ok(res.bar.libraries.length === 1 && res.apps.filter(function (x) { return x.name === 'AppA'; })[0].libs === 1, 'library archives (one shared library at the BAR root, one inside AppA) are listed, not opened');
  });

  test('C02', 'BAR vs source: options (framework files, whitespace), and a source folder as input', { category: 'BAR vs source' }, async function (a) {
    var sc = await scenario();
    var r1 = await run(sc, { ignoreFramework: false });
    a.ok(find(r1, 'AppA', 'FwCommon.esql') && find(r1, 'AppA', 'FwCommon.esql').status === 'extra-in-bar', 'with framework filtering off the framework files appear as extra BAR files');
    var r2 = await run(sc, { ignoreWhitespace: false });
    a.eq(find(r2, 'AppA', 'Sub.subflow').status, 'modified', 'with the whitespace option off a line-ending difference is a modification');
    var r3 = await run(sc, { frameworkPatterns: 'Extra*.esql' });
    a.ok(!find(r3, 'AppA', 'Extra.esql') && r3.ignored.some(function (x) { return x.path === 'Extra.esql' && /pattern/.test(x.reason); }), 'ignore patterns');
    // the same source supplied as a folder (paths from webkitRelativePath)
    var zipFiles = await (async function () {
      var arc = await ACE.zip.open(ACE.zip.bytesSource(new Uint8Array(await sc.src.arrayBuffer()))), out = [];
      for (var i = 0; i < arc.entries.length; i++) { var e = arc.entries[i]; if (e.isDir) continue; var bytes = /.jar$/.test(e.path) ? new Uint8Array(3) : await ACE.zip.extract(arc, e); var f = new File([bytes], util.basename(e.path)); Object.defineProperty(f, 'webkitRelativePath', { value: e.path }); out.push(f); }
      return out;
    })();
    var r4 = await run(sc, {}, zipFiles);
    a.eq(r4.source.kind, 'folder', 'folder input'); a.eq(r4.summary.critical, 2, 'same critical issues as with the ZIP'); a.eq(r4.files.length, 8, 'same files');
    a.eq(JSON.stringify(r4.files.map(function (f) { return f.path + ':' + f.status; })), JSON.stringify((await run(sc)).files.map(function (f) { return f.path + ':' + f.status; })), 'folder and ZIP give identical results');
  });

  test('C03', 'BAR vs source: name matching, compiled flows, no-.project sources, empty and invalid inputs', { category: 'BAR vs source' }, async function (a) {
    var s = await src([{ name: 'MyApp', natures: APP, files: { 'My.msgflow': FLOW('a'), 'Other.subflow': FLOW('b') } }]);
    var b = await bar([{ name: 'myapp', files: { 'Other.subflow': FLOW('b'), 'My.cmf': { data: new Uint8Array([1, 2, 3]) } } }]);
    var res = await C.compare(await C.readSource({ zip: F(s, 's.zip') }), await C.readBar(F(b, 'b.bar')), {});
    a.eq(res.apps[0].how, 'case-insensitive', 'application names matched ignoring case, and said so');
    var my = find(res, 'myapp', 'My.msgflow') || find(res, 'MyApp', 'My.msgflow');
    a.ok(my && my.status === 'not-comparable' && my.severity === 'warning' && /\.cmf/.test(my.barStatus), 'a source flow whose BAR copy is only a compiled .cmf is not comparable (not "missing")');
    // a source ZIP without .project files: each top-level folder is a project
    var s2 = await Fx.rawZip([{ name: 'Svc/Svc.esql', data: ESQL_A }]);
    var b2 = await bar([{ name: 'Svc', files: { 'Svc.esql': ESQL_A } }]);
    var r2 = await C.compare(await C.readSource({ zip: F(s2, 's2.zip') }), await C.readBar(F(b2, 'b2.bar')), {});
    a.ok(r2.summary.applications.compared === 1 && r2.summary.byStatus.identical === 1 && r2.source.warnings.some(function (w) { return /No \.project/.test(w); }), 'folders without .project are matched by folder name, with a warning');
    var r3 = await C.compare(await C.readSource({ zip: F(s, 's.zip') }), await C.readBar(F(await Fx.rawZip([{ name: 'x.txt', data: 'x' }]), 'e.bar')), {});
    a.ok(r3.notes.some(function (n) { return /no application archive/.test(n); }) && r3.files.length === 0, 'a BAR without applications is reported');
    var bad = false; try { await C.readBar(F(util.encodeUtf8('not a zip at all, just text'), 'bad.bar')); } catch (e) { bad = /not a ZIP|End of central/i.test(e.message); }
    a.ok(bad, 'a file that is not a ZIP is rejected with a message');
  });

  test('C04', 'BAR vs source: CRC fast path, side-by-side rows with highlighted changes, large-file diff', { category: 'BAR vs source' }, async function (a) {
    var big = []; for (var i = 0; i < 3000; i++) big.push('line ' + i + ' of the file');
    var big2 = big.slice(); big2[10] = 'line 10 CHANGED'; big2.splice(1500, 1); big2.splice(2000, 0, 'inserted line'); big2[2900] = 'tail changed';
    var s = await src([{ name: 'P', natures: APP, files: { 'Same.esql': { data: 'same\n', method: 0 }, 'Big.xsd': { data: big.join('\n') + '\n', method: 0 } } }]);
    var b = await bar([{ name: 'P', files: { 'Same.esql': { data: 'same\n', method: 0 }, 'Big.xsd': { data: big2.join('\n') + '\n', method: 0 } } }]);
    var res = await C.compare(await C.readSource({ zip: F(s, 's.zip') }), await C.readBar(F(b, 'b.bar')), {});
    a.eq(find(res, 'P', 'Same.esql').how, 'size and CRC-32 equal', 'equal size and CRC-32: identical without extracting');
    var big3 = find(res, 'P', 'Big.xsd');
    a.ok(big3.status === 'modified' && big3.severity === 'critical', 'a big XSD change is critical');
    a.eq(big3.removed + '/' + big3.added, '3/3', 'only the changed lines are counted (3 removed, 3 added) even for a 3000-line file');
    var rows = C.sideBySide(big3.srcText, big3.barText, true), chg = rows.filter(function (r) { return r.kind === 'chg'; }), del = rows.filter(function (r) { return r.kind === 'del'; }), add = rows.filter(function (r) { return r.kind === 'add'; });
    a.ok(chg.length === 2 && del.length === 1 && add.length === 1, 'side-by-side: 2 changed, 1 removed, 1 added row: ' + chg.length + '/' + del.length + '/' + add.length);
    var c10 = chg.filter(function (r) { return r.l.n === 11; })[0];
    a.ok(c10 && c10.l.text === 'line 10 of the file' && c10.r.text === 'line 10 CHANGED', 'changed row carries the source text on the left and the BAR text on the right');
    var m = c10.r.text.slice(c10.r.mark[0], c10.r.mark[1]); a.eq(m, 'CHANGED', 'the highlighted part is exactly the changed text: "' + m + '"');
    var v = C.visibleRows(rows, 3); a.eq(v.blocks.length, 4, 'four blocks of changes'); a.ok(v.keep.filter(Boolean).length < 60, 'with 3 lines of context only ' + v.keep.filter(Boolean).length + ' of ' + rows.length + ' rows are shown');
    // CSV / JSON reports
    a.ok(/^Application,File,Type,Source,BAR,Status,Severity/.test(C.reportCsv(res)) && JSON.parse(C.reportJson(res)).files.length === 2, 'CSV and JSON reports');
  });

  test('C05', 'BAR vs source: many applications and files are scanned fast, only matched applications are opened', { category: 'BAR vs source' }, async function (a) {
    var N = 150, sp = [], ba = [];
    for (var i = 0; i < N; i++) {
      var files = {}, bf = {};
      for (var k = 0; k < 8; k++) { files['f' + k + '.esql'] = 'file ' + i + '_' + k + '\n'; bf['f' + k + '.esql'] = 'file ' + i + '_' + k + (i === 8 && k === 3 ? ' x' : '') + '\n'; }
      sp.push({ name: 'App' + i, natures: APP, files: files });
      if (i % 2 === 0) ba.push({ name: 'App' + i, files: bf });
    }
    ba.push({ name: 'OnlyBar1', files: { 'a.esql': 'x\n' } });
    var t0 = Date.now(), source = await C.readSource({ zip: F(await src(sp), 's.zip') }), brr = await C.readBar(F(await bar(ba), 'b.bar'));
    var opened = 0; brr.apps.forEach(function (ap) { var o = ap.open; ap.open = function () { opened++; return o.apply(this, arguments); }; });
    var res = await C.compare(source, brr, {});
    a.eq(res.summary.applications.compared, 75, '75 matched applications'); a.eq(opened, 75, 'only matched application archives are opened (the unmatched BAR application was not): ' + opened);
    a.eq(res.files.length, 600, '600 files compared'); a.eq(res.summary.byStatus.identical + '/' + res.summary.byStatus.modified, '599/1', 'one modified file (App8/f3.esql), the others identical');
    a.ok(Date.now() - t0 < 20000, 'finished in ' + (Date.now() - t0) + ' ms');
  });

  test('C07', 'BAR vs source: a nested BAR is searched; a corrupt application archive is a critical error, not a crash', { category: 'BAR vs source' }, async function (a) {
    var s = await src([{ name: 'AppZ', natures: APP, files: { 'z.esql': 'z-content' } }, { name: 'AppY', natures: APP, files: { 'y.esql': 'y-content' } }]);
    var inner = await bar([{ name: 'AppZ', files: { 'z.esql': 'z-content' } }]);
    var outer = await Fx.rawZip([{ name: 'inner.bar', data: inner }, { name: 'AppY.appzip', data: util.encodeUtf8('this is not a zip archive, it is only text') }]);
    var res = await C.compare(await C.readSource({ zip: F(s, 's.zip') }), await C.readBar(F(outer, 'o.bar')), {});
    a.ok(res.apps.some(function (x) { return x.name === 'AppZ' && x.status === 'compared' && x.counts.identical === 1; }), 'AppZ inside the nested BAR is compared');
    var y = res.apps.filter(function (x) { return x.name === 'AppY'; })[0];
    a.ok(y && y.status === 'error' && y.severity === 'critical' && /could not be read/.test(y.note), 'unreadable application archive: critical error with a message: ' + (y && y.note));
    a.eq(res.summary.applications.error, 1, 'counted in the summary'); a.ok(res.summary.critical >= 1, 'and as a critical issue');
  });
  test('C08', 'Static libraries: each library source is compared with the BAR library of the same name, in a result of its own; only flows and ESQL; JARs never opened', { category: 'BAR vs source' }, async function (a) {
    var jarz = BADJAR;   // a JAR with a wrong CRC: it would raise an error if anything extracted it
    var libX = await Fx.rawZip([{ name: 'X.esql', data: 'x same\n' }, { name: 'X.msgflow', data: FLOW('bar-version') }, { name: 'Extra.esql', data: 'only in the BAR\n' }, { name: 'doc.wsdl', data: WSDL('bar') }, Object.assign({ name: 'lib/x.jar' }, jarz)]);
    var libY = await Fx.rawZip([{ name: 'Y.esql', data: 'y\n' }, { name: 'Y.subflow', data: FLOW('y') }]);
    var libW = await Fx.rawZip([{ name: 'W.esql', data: 'w\n' }]);
    var b = await bar([
      { name: 'AppA', files: { 'AppA.esql': ESQL_A, 'LibX.libzip': { data: libX }, 'LibY.libzip': { data: libY }, 'big.jar': jarz } },
      { name: 'AppB', files: { 'AppB.esql': ESQL_A, 'LibY.libzip': { data: libY }, 'LibW.libzip': { data: libW } } }], [{ name: 'Shared.shlibzip', data: libY }]);
    var sx = await src([{ name: 'LibX', natures: LIB, files: { 'X.esql': 'x same\n', 'X.msgflow': FLOW('source-version'), 'OnlySrc.subflow': FLOW('s'), 'doc.wsdl': WSDL('src'), 'lib/x.jar': jarz } }]);
    var sy = await src([{ name: 'LibY', natures: LIB, files: { 'Y.esql': 'y\n', 'Y.subflow': FLOW('y') } }]);
    var sz = await src([{ name: 'LibZ', natures: LIB, files: { 'Z.esql': 'z\n' } }]);
    var ls = await C.readLibrarySources([{ label: 'LibX.zip', zip: F(sx, 'LibX.zip') }, { label: 'LibY.zip', zip: F(sy, 'LibY.zip') }, { label: 'LibZ.zip', zip: F(sz, 'LibZ.zip') }]);
    a.eq(ls.libs.map(function (l) { return l.name; }).join(','), 'LibX,LibY,LibZ', 'three library sources read (one library each)');
    a.ok(ls.libs[0].files.every(function (f) { return f.ext === 'esql' || f.ext === 'msgflow' || f.ext === 'subflow'; }) && !ls.libs[0].files.some(function (f) { return /\.(wsdl|jar)$/.test(f.rel); }), 'only ESQL, message flows and subflows are taken from a library source (no WSDL, no JAR)');
    var brr = await C.readBar(F(b, 'L.bar')), res = await C.compareLibraries(ls, brr, {});
    var s = res.summary, lib = function (n) { return res.libraries.filter(function (l) { return l.name === n; }); };
    a.eq(s.libraries.compared + '/' + s.libraries.noSource + '/' + s.libraries.notInBar, '2/1/1', 'compared / BAR library without source (LibW) / source library not in the BAR (LibZ)');
    a.eq(lib('LibY').length + ':' + lib('LibY')[0].copies.length, '1:2', 'LibY is in two applications with the same content: compared once, both locations listed');
    a.ok(lib('LibY')[0].counts.identical === 2 && lib('LibY')[0].severity === 'ok', 'LibY is identical');
    var fx = function (p) { return res.files.filter(function (f) { return f.lib === 'LibX' && f.path === p; })[0]; };
    a.ok(fx('X.esql').status === 'identical', 'same ESQL: identical');
    a.ok(fx('X.msgflow').status === 'modified' && fx('X.msgflow').severity === 'difference' && fx('X.msgflow').type === 'Message flow', 'modified message flow: a difference');
    a.ok(fx('OnlySrc.subflow').status === 'missing-in-bar' && fx('OnlySrc.subflow').severity === 'critical', 'a source library file that is not in the BAR: critical');
    a.ok(fx('Extra.esql').status === 'extra-in-bar' && fx('Extra.esql').severity === 'warning', 'a BAR library file with no source: non-critical warning');
    a.ok(!fx('doc.wsdl') && !res.files.some(function (f) { return /\.(wsdl|xsd|jar)$/.test(f.path); }), 'WSDL and JAR files are not part of the library result');
    a.eq(res.files.length, 6, 'files: LibX 4 (X.esql, X.msgflow, OnlySrc.subflow, Extra.esql) + LibY 2 (compared once for both applications)');
    a.ok(lib('LibW')[0].status === 'no-source' && lib('LibZ')[0].status === 'not-in-bar', 'unmatched libraries are listed with their own status');
    a.ok(res.libraries.every(function (l) { return l.name !== 'Shared'; }), 'the shared library at the BAR root is ignored');
    a.ok(s.jarsNotOpened >= 2, 'JARs were counted, not opened (' + s.jarsNotOpened + ')');
    a.eq(s.critical, 1, 'one critical issue (the missing source file)');
    // the application result is a different structure and does not contain the libraries
    var appRes = await C.compare(await C.readSource({ zip: F(await src([{ name: 'AppA', natures: APP, files: { 'AppA.esql': ESQL_A } }]), 's.zip') }), await C.readBar(F(b, 'L.bar')), {});
    a.ok(appRes.summary.applications.compared === 1 && appRes.files.length === 1 && !appRes.libraries, 'the application comparison is unchanged and has no library data');
    a.ok(/^Library,Used by,File,Type,Source,BAR,Status,Severity/.test(C.reportLibrariesCsv(res)) && JSON.parse(C.reportLibrariesJson(res)).libraries.length === 4, 'library CSV and JSON reports');
  });
  test('C09', 'Static libraries: a library folder, a different version of the same library in two applications, a corrupt library archive', { category: 'BAR vs source' }, async function (a) {
    var lib1 = await Fx.rawZip([{ name: 'A.esql', data: 'one\n' }]), lib2 = await Fx.rawZip([{ name: 'A.esql', data: 'two\n' }]);
    var b = await bar([{ name: 'App1', files: { 'LibA.libzip': { data: lib1 } } }, { name: 'App2', files: { 'LibA.libzip': { data: lib2 } } }, { name: 'App3', files: { 'LibBad.libzip': { data: util.encodeUtf8('this is not a zip archive') } } }]);
    var sa = await src([{ name: 'LibA', natures: LIB, files: { 'A.esql': 'one\n' } }]), sbad = await src([{ name: 'LibBad', natures: LIB, files: { 'B.esql': 'b\n' } }]);
    // the library source as a folder (paths from webkitRelativePath)
    async function asFolder(bytes) { var arc = await ACE.zip.open(ACE.zip.bytesSource(new Uint8Array(await bytes.arrayBuffer ? await bytes.arrayBuffer() : bytes))), out = []; for (var i = 0; i < arc.entries.length; i++) { var e = arc.entries[i]; if (e.isDir) continue; var f = new File([await ACE.zip.extract(arc, e)], util.basename(e.path)); Object.defineProperty(f, 'webkitRelativePath', { value: e.path }); out.push(f); } return out; }
    var ls = await C.readLibrarySources([{ label: 'folder LibA', files: await asFolder(sa) }, { label: 'LibBad.zip', zip: F(sbad, 'LibBad.zip') }]);
    var res = await C.compareLibraries(ls, await C.readBar(F(b, 'V.bar')), {});
    var la = res.libraries.filter(function (l) { return l.name === 'LibA'; });
    a.eq(la.length, 2, 'two different versions of LibA in the BAR give two entries');
    a.ok(la.some(function (l) { return l.counts.identical === 1 && l.copies[0].app === 'App1'; }) && la.some(function (l) { return l.counts.modified === 1 && l.copies[0].app === 'App2'; }), 'App1 has the same version as the source, App2 a modified one');
    a.ok(la.every(function (l) { return l.variant != null; }), 'the variants are numbered');
    var bad = res.libraries.filter(function (l) { return l.name === 'LibBad'; })[0];
    a.ok(bad && bad.status === 'error' && bad.severity === 'critical' && /could not be read/.test(bad.note), 'a corrupt library archive is a critical error with a message, not a crash');
    var junk = await C.readLibrarySources([{ label: 'app.zip', zip: F(await src([{ name: 'AnApp', natures: APP, files: { 'x.esql': 'x\n' } }]), 'app.zip') }]);
    a.ok(junk.libs.length === 0 && junk.warnings.some(function (w) { return /not a static library/.test(w); }) && junk.warnings.some(function (w) { return /no static library project/.test(w); }), 'a source that is an application, not a library, is refused with a message');
  });
  test('C10', 'Static libraries: the same flow saved by another Toolkit (ids, layout, label type) is identical; a real change is found', { category: 'BAR vs source' }, async function (a) {
    var head = '<?xml version="1.0" encoding="UTF-8"?>\n<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:eflow="http://www.ibm.com/wbi/2005/eflow" xmlns:utility="http://www.ibm.com/wbi/2005/eflow_utility" nsURI="L/F.subflow">\n';
    var srcFlow = head + '  <eClassifiers xmi:type="eflow:FCMComposite" xmi:id="id1" name="F">\n    <composition>\n      <nodes xmi:type="eflow:FCMSource" xmi:id="n1" location="10,10" nodeName="In">\n        <translation xmi:type="utility:TranslatableString" key="In" bundleName="L/F" pluginId="L"/>\n      </nodes>\n      <nodes xmi:type="eflow:FCMSink" xmi:id="n2" location="90,10" nodeName="Out"/>\n    </composition>\n  </eClassifiers>\n</ecore:EPackage>\n';
    // other writer: other ids, other attribute order and indentation, constant label, an empty sticky board (positions and node order are kept: they are real content)
    var barFlow = head + '  <eClassifiers xmi:type="eflow:FCMComposite" xmi:id="zz9" name="F">\n    <composition>\n      <nodes xmi:type="eflow:FCMSource" nodeName="In" location="10,10" xmi:id="q1">\n        <translation xmi:type="utility:ConstantString" string="In"/>\n      </nodes>\n      <nodes xmi:type="eflow:FCMSink" xmi:id="q2" location="90,10" nodeName="Out"/>\n      <stickyBoard/>\n    </composition>\n  </eClassifiers>\n</ecore:EPackage>\n';
    var changed = barFlow.replace('nodeName="Out"', 'nodeName="Other"');
    async function run(barText) {
      var b = await bar([{ name: 'App1', files: { 'L.libzip': { data: await Fx.rawZip([{ name: 'F.subflow', data: barText }]) } } }]);
      var s = await src([{ name: 'L', natures: LIB, files: { 'F.subflow': srcFlow } }]);
      return C.compareLibraries(await C.readLibrarySources([{ label: 'L.zip', zip: F(s, 'L.zip') }]), await C.readBar(F(b, 'X.bar')), {});
    }
    var same = (await run(barFlow)).libraries[0], diff = (await run(changed)).libraries[0];
    a.ok(same.counts.identical === 1 && same.counts.modified === 0, 'ids, attribute order, label type and sticky board do not count as a difference');
    a.ok(diff.counts.modified === 1, 'a renamed node is a difference');
  });
  /* a small message flow written the way the Toolkit does: nodes [{id,name,type,loc,attrs,constLabel}], conns [[from,fromTerminal,to,toTerminal]] */
  function flow(nodes, conns, flowAttrs) {
    var ns = {}; nodes.forEach(function (n) { ns[n.type] = 1; });
    var h = '<?xml version="1.0" encoding="UTF-8"?>\n<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:eflow="http://www.ibm.com/wbi/2005/eflow" xmlns:utility="http://www.ibm.com/wbi/2005/eflow_utility"' + Object.keys(ns).map(function (k) { return ' xmlns:' + k + '="' + k + '"'; }).join('') + ' nsURI="F.msgflow">\n  <eClassifiers xmi:type="eflow:FCMComposite" xmi:id="FCMComposite_1" name="F"' + (flowAttrs || '') + '>\n    <composition>\n';
    nodes.forEach(function (n) {
      h += '      <nodes xmi:type="' + n.type + ':FCMComposite_1" xmi:id="' + n.id + '" location="' + n.loc + '"' + Object.keys(n.attrs || {}).map(function (k) { return ' ' + k + '="' + n.attrs[k] + '"'; }).join('') + '>\n        <translation xmi:type="utility:' + (n.constLabel ? 'ConstantString" string' : 'TranslatableString" bundleName="x" pluginId="p" key') + '="' + n.name + '"/>\n      </nodes>\n';
    });
    conns.forEach(function (c, i) { h += '      <connections xmi:type="eflow:FCMConnection" xmi:id="c' + i + '" targetNode="' + c[2] + '" sourceNode="' + c[0] + '" sourceTerminalName="OutTerminal.' + c[1] + '" targetTerminalName="InTerminal.' + c[3] + '"/>\n'; });
    return h + '    </composition>\n  </eClassifiers>\n</ecore:EPackage>\n';
  }
  var FD = ACE.flowdiff;
  var BASE = function () { return [
    { id: 'n1', name: 'In', type: 'ComIbmMQInput.msgnode', loc: '20,40', attrs: { queueName: 'Q1' } },
    { id: 'n2', name: 'Work', type: 'ComIbmCompute.msgnode', loc: '150,40', attrs: { computeExpression: 'esql://routine/#M.Main', computeMode: 'all' } },
    { id: 'n3', name: 'Out', type: 'ComIbmMQOutput.msgnode', loc: '280,40', attrs: { queueName: 'Q2' } }
  ]; };
  var CONNS = function () { return [['n1', 'out', 'n2', 'in'], ['n2', 'out', 'n3', 'in']]; };
  test('C11', 'Message flow comparison (structure): same flow written differently is identical; node, property and connection differences are found', { category: 'BAR vs source' }, async function (a) {
    var src = flow(BASE(), CONNS());
    // another Toolkit: other ids, other node order, constant labels
    var other = BASE().reverse().map(function (n, i) { n.id = 'z' + i; n.constLabel = true; return n; }), idOf = {}; other.forEach(function (n) { idOf[n.name] = n.id; });
    var same = FD.compareText(src, flow(other, [[idOf.In, 'out', idOf.Work, 'in'], [idOf.Work, 'out', idOf.Out, 'in']]));
    a.ok(!same.error && same.summary.identical && same.summary.nodes.same === 3 && same.summary.conns.same === 2, 'other ids, other order and label representation: identical structure');
    // a node missing in the BAR, a connection missing in the BAR
    var b1 = BASE().slice(0, 2), d1 = FD.compareText(src, flow(b1, [['n1', 'out', 'n2', 'in']]));
    a.ok(d1.summary.nodes.onlyA === 1 && d1.summary.conns.onlyA === 1 && d1.pairs.filter(function (p) { return p.status === 'only-a'; })[0].a.name === 'Out', 'a node and its connection that exist only in the source');
    // a node added in the BAR
    var b2 = BASE(); b2.push({ id: 'n4', name: 'Extra', type: 'ComIbmTrace.msgnode', loc: '280,120', attrs: {} });
    var d2 = FD.compareText(src, flow(b2, CONNS().concat([['n2', 'out', 'n4', 'in']])));
    a.ok(d2.summary.nodes.onlyB === 1 && d2.summary.conns.onlyB === 1, 'a node and a connection that exist only in the BAR');
    // properties: changed, missing, added
    var b3 = BASE(); b3[1].attrs.computeExpression = 'esql://routine/#M.Other'; delete b3[1].attrs.computeMode; b3[1].attrs.dataSource = 'DS'; b3[0].attrs.queueName = 'Q9';
    var d3 = FD.compareText(src, flow(b3, CONNS())), w = d3.pairs.filter(function (p) { return p.a.name === 'Work'; })[0], i1 = d3.pairs.filter(function (p) { return p.a.name === 'In'; })[0];
    a.ok(d3.summary.nodes.changed === 2 && w.diffs.some(function (d) { return d.name === 'computeExpression' && d.kind === 'changed'; }) && w.diffs.some(function (d) { return d.name === 'computeMode' && d.kind === 'only-a'; }) && w.diffs.some(function (d) { return d.name === 'dataSource' && d.kind === 'only-b'; }) && i1.diffs[0].name === 'queueName', 'changed, missing and added node properties');
    a.ok(d3.summary.conns.onlyA === 0 && d3.summary.conns.onlyB === 0, 'property changes do not affect the connections');
    // the same nodes wired to another terminal
    var d4 = FD.compareText(src, flow(BASE(), [['n1', 'out', 'n2', 'in'], ['n2', 'failure', 'n3', 'in']]));
    a.ok(d4.summary.conns.onlyA === 1 && d4.summary.conns.onlyB === 1 && d4.summary.nodes.changed === 0, 'a connection on another terminal is one removed and one added connection');
    // another node type under the same name; a moved node is not a difference
    var b5 = BASE(); b5[1].type = 'ComIbmJavaCompute.msgnode'; b5[2].loc = '500,500';
    var d5 = FD.compareText(src, flow(b5, CONNS())), moved = d5.pairs.filter(function (p) { return p.a.name === 'Out'; })[0];
    a.ok(d5.pairs.filter(function (p) { return p.a.name === 'Work'; })[0].diffs[0].name === '(node type)' && moved.status === 'same' && moved.moved, 'a different node type is reported; a moved node is only noted');
    a.ok(FD.compareText('<not xml', src).error && !FD.compareText('', src).error, 'text that is not XML gives a message; an empty side is an empty flow');
    var d6 = FD.compareText('', src); a.ok(d6.summary.nodes.onlyB === 3 && d6.summary.conns.onlyB === 2, 'a flow missing on one side: everything is only on the other side');
  });
  test('C12', 'Message flow comparison (diagram): both flows are drawn, differences are marked, and it is used for application and static library flows', { category: 'BAR vs source' }, async function (a) {
    var b3 = BASE().slice(0, 2); b3[1].attrs.computeMode = 'tree'; b3.push({ id: 'n4', name: 'Extra', type: 'ComIbmTrace.msgnode', loc: '280,120', attrs: {} });
    var diff = FD.compareText(flow(BASE(), CONNS()), flow(b3, [['n1', 'out', 'n2', 'in'], ['n2', 'out', 'n4', 'in']]));
    var host = document.createElement('div'); ACE.ui.flowDiagram(host, diff, { labelA: 'Source (master)', labelB: 'BAR' });
    var q = function (sel) { return host.querySelectorAll(sel).length; };
    a.eq(q('.fd-pane[data-side="a"] .fd-node'), 4, 'the source diagram has its 3 nodes and a ghost of the node only in the BAR');
    a.eq(q('.fd-pane[data-side="b"] .fd-node'), 4, 'the BAR diagram has its 3 nodes and a ghost of the node only in the source');
    a.eq(q('.fd-pane[data-side="a"] .fd-node.ghost') + q('.fd-pane[data-side="b"] .fd-node.ghost'), 2, 'one ghost on each side');
    a.ok(q('.fd-pane[data-side="a"] .fd-node.del') === 1 && q('.fd-pane[data-side="b"] .fd-node.add') === 1 && q('.fd-node.chg') === 2, 'removed, added and changed nodes are marked');
    a.ok(q('.fd-pane[data-side="a"] .fd-edge.del') === 1 && q('.fd-pane[data-side="b"] .fd-edge.add') === 1, 'removed and added connections are marked');
    a.eq(q('.fd-item'), diff.list.length, 'every difference is listed');
    host.querySelector('.fd-item').click();
    a.ok(/Property/.test(host.querySelector('.fd-dbody').textContent) || /Connection/.test(host.querySelector('.fd-dbody').textContent), 'selecting a difference shows the configuration on both sides');
    // the library and application results keep the real flow, which the diagram needs
    var lib1 = await Fx.rawZip([{ name: 'F.msgflow', data: flow(b3, CONNS().slice(0, 2)) }]);
    var b = await bar([{ name: 'App1', files: { 'L.libzip': { data: lib1 } } }]);
    var s = await src([{ name: 'L', natures: LIB, files: { 'F.msgflow': flow(BASE(), CONNS()) } }]);
    var res = await C.compareLibraries(await C.readLibrarySources([{ label: 'L.zip', zip: F(s, 'L.zip') }]), await C.readBar(F(b, 'X.bar')), {});
    var f = res.files.filter(function (x) { return x.status === 'modified'; })[0], d = f && FD.compareText(f.srcRaw, f.barRaw);
    a.ok(f && d && !d.error && d.summary.nodes.changed === 1 && d.summary.nodes.onlyB === 1, 'a static library flow: the diagram is built from the real flow text');
    var appBar = await bar([{ name: 'AppA', files: { 'F.msgflow': flow(b3, CONNS().slice(0, 2)) } }]);
    var appSrc = await src([{ name: 'AppA', natures: APP, files: { 'F.msgflow': flow(BASE(), CONNS()) } }]);
    var ar = await C.compare(await C.readSource({ zip: F(appSrc, 's.zip') }), await C.readBar(F(appBar, 'A.bar')), {});
    var af = ar.files.filter(function (x) { return x.status === 'modified'; })[0], ad = af && FD.compareText(af.srcText, af.barText);
    a.ok(af && ad && !ad.error && ad.summary.nodes.changed === 1, 'an application flow: the same comparison');
  });
  test('C06', 'Real BAR and real source ZIP: compared by application name, framework ignored, JARs untouched', { category: 'BAR vs source', requires: 'bar' }, async function (a, env) {
    var srcs = (env.workspaceFiles && env.workspaceFiles.length ? env.workspaceFiles : [env.workspaceFile]).filter(function (f) { return f && /\.zip$/i.test(f.name); });
    if (!srcs.length) { a.note('select a source ZIP as the workspace ZIP to run the comparison'); a.ok(true, 'skipped'); return; }
    for (var i = 0; i < srcs.length; i++) {
      var res = await C.compare(await C.readSource({ zip: srcs[i] }), await C.readBar(env.barFile), {});
      a.ok(res.summary.applications.error === 0, srcs[i].name + ': no unreadable application archive');
      a.note(srcs[i].name + ' vs ' + env.barFile.name + ': ' + res.summary.applications.compared + ' compared application(s) [' + res.apps.filter(function (x) { return x.status === 'compared'; }).map(function (x) { return x.name; }).join(', ') + '], ' + res.summary.files + ' files, byStatus ' + JSON.stringify(res.summary.byStatus) + ', critical ' + res.summary.critical + ', ignored framework files ' + res.summary.ignored + ', ' + res.summary.elapsedMs + ' ms');
      a.ok(!res.files.some(function (f) { return /\.(jar|java|class)$/i.test(f.path); }), 'only ESQL/WSDL/XSD/flows in the result');
    }
  });
})();
