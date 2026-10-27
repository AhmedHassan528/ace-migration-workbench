/* Tests: the five feature pages are independent (own input, own state), take only the input they are meant for, and the
 * removed features are gone. They drive the real page code (js/ui/*) on a hidden copy of the page frame (tests/index.html). */
(function () {
  'use strict';
  var test = T.test, util = ACE.util, UI = ACE.ui;
  var WITH_INPUT = ['barexport', 'migrate13', 'libconv', 'explorer'];
  function F(bytes, name) { return new File([bytes], name); }
  function view(n) { return UI.views[n]; }
  function st(n) { return view(n).ctl.state; }
  function reset() { WITH_INPUT.forEach(function (n) { view(n).ctl.clear(); view(n).error = null; view(n).loadedName = null; }); UI.current = null; }
  async function bar() { return F(await Fx.syntheticBar(), 'Demo.bar'); }
  async function src(spec, wrap, name) { return F(await Fx.libWorkspace(spec || Fx.frameworkSpec(), wrap), name || 'src.zip'); }
  function shown(n) { UI.show(n); return document.getElementById('view').innerHTML; }

  test('P01', 'Five pages; each page that takes a file has its own controller and state; the comparison keeps its own', { category: 'Independent pages' }, async function (a) {
    a.eq(Object.keys(UI.views).sort().join(','), 'barexport,compare,explorer,libconv,migrate13', 'exactly the five pages are registered');
    var ctls = WITH_INPUT.map(function (n) { return view(n).ctl; });
    a.ok(ctls.every(Boolean) && new Set(ctls).size === 4, 'four different controllers');
    a.ok(new Set(ctls.map(function (c) { return c.state; })).size === 4, 'four different states');
    a.ok(ctls.every(function (c) { return c !== ACE.workflow; }), 'none of them is the default controller');
    a.ok(new Set(ctls.map(function (c) { return c.state.jarOverrides; })).size === 4 && new Set(ctls.map(function (c) { return c.state.exportOpts; })).size === 4, 'JAR overrides and export options are separate objects');
    a.ok(!view('compare').ctl && !view('compare').input, 'the comparison page has no shared controller or input: it keeps its two inputs itself');
    a.ok(typeof ACE.premigration === 'undefined' && !view('dashboard') && !view('settings') && !view('reports') && !view('checks') && !view('inspector') && !view('decompiler') && !view('export12') && !view('extraction'), 'the removed features are gone (dashboard, inspector, decompiler page, checks, reports, settings)');
  });

  test('P02', 'A file loaded on one page is never seen by another page', { category: 'Independent pages' }, async function (a) {
    reset(); UI.show('libconv');
    var b = await bar(), s = await src();
    await UI.loadInput(view('barexport'), { zips: [b] });
    var bws = st('barexport').ws;
    a.ok(bws && !bws.fatal && bws.inputKind === 'bar', 'BAR Export has its BAR');
    a.ok(['migrate13', 'libconv', 'explorer'].every(function (n) { return !st(n).ws; }), 'the other pages have no input');
    await UI.loadInput(view('migrate13'), { zips: [s] });
    a.ok(st('barexport').ws === bws && st('barexport').ws.inputKind === 'bar', 'loading source code on the migration page did not touch the BAR Export page');
    a.ok(st('migrate13').ws.inputKind === 'workspace' && !st('libconv').ws && !st('explorer').ws, 'only the migration page has the source code');
    await UI.loadInput(view('libconv'), { zips: [s] });
    a.ok(st('libconv').ws !== st('migrate13').ws, 'the library page loaded its own workspace object from its own input');
    a.ok(!!st('libconv').ws.libConversion && st('migrate13').ws.libConversion === null && bws.libConversion === null, 'the library conversion plan exists only on the library page');
    // changing options on one page does not change another page
    st('barexport').jarOverrides.someJar = 'exclude'; st('barexport').exportOpts.includeOriginalBar = false;
    a.eq(Object.keys(st('migrate13').jarOverrides).length, 0, 'JAR overrides stay on their page');
    a.eq(st('migrate13').exportOpts.includeOriginalBar, true, 'export options stay on their page');
    st('libconv').libconv.strategy = 'refactor';
    a.eq(ACE.settings.current.libraryConversion.strategy, 'separate', 'the library page configuration is not written to the global settings');
    st('libconv').libconv.strategy = 'separate';
    // converting on one page does not touch another page's copy of the same source
    view('libconv').ctl.convertLibraries();
    a.ok(Object.keys(st('libconv').ws.ws13.overlay).length > 0 && Object.keys(st('migrate13').ws.ws13.overlay).length === 0, 'converting libraries changed only the library page working copy');
    reset();
  });

  test('P03', 'Each page takes only its own kind of input', { category: 'Independent pages' }, async function (a) {
    reset();
    var b = await bar(), s = await src(), hidden = F(await Fx.syntheticBar(), 'renamed.zip');   // a BAR with another name is found out by its content
    await UI.loadInput(view('migrate13'), { zips: [hidden] });
    a.ok(!st('migrate13').ws && /source code/.test(view('migrate13').error) && /BAR file/.test(view('migrate13').error), 'migration: a BAR is refused by its content: ' + view('migrate13').error);
    await UI.loadInput(view('libconv'), { zips: [hidden] });
    a.ok(!st('libconv').ws && /BAR file/.test(view('libconv').error), 'library conversion: a BAR is refused by its content');
    await UI.loadInput(view('migrate13'), { zips: [b] });
    a.ok(!st('migrate13').ws && /not accepted/.test(view('migrate13').error), 'migration: a file named .bar is refused by its name: ' + view('migrate13').error);
    await UI.loadInput(view('barexport'), { zips: [s] });
    a.ok(!st('barexport').ws && /takes a BAR/.test(view('barexport').error), 'BAR export: source code is refused: ' + view('barexport').error);
    ['migrate13', 'libconv'].forEach(function (n) { view(n).error = null; });
    await UI.loadInput(view('migrate13'), { zips: [F(new Uint8Array([80, 75]), 'x.jar')] });
    a.ok(!st('migrate13').ws && /not accepted/.test(view('migrate13').error) && /JAR/.test(view('migrate13').error), 'migration: a JAR is refused by name');
    await UI.loadInput(view('libconv'), { zips: [F(new Uint8Array([80, 75]), 'a.bar')] });
    a.ok(!st('libconv').ws && /not accepted/.test(view('libconv').error), 'library conversion: a .bar file is refused by name');
    await UI.loadInput(view('barexport'), { zips: [F(new Uint8Array([80, 75]), 'x.jar')] });
    a.ok(!st('barexport').ws && /not accepted/.test(view('barexport').error), 'BAR export: a JAR is refused');
    await UI.loadInput(view('barexport'), { zips: [F(util.encodeUtf8('this is not a BAR, only text in a file'), 'bad.bar')] });
    a.ok(!st('barexport').ws && /could not be opened/.test(view('barexport').error), 'a corrupt file is reported, no half-loaded input stays: ' + view('barexport').error);
    await UI.loadInput(view('explorer'), { zips: [b] });
    a.ok(st('explorer').ws && st('explorer').ws.inputKind === 'bar', 'explorer accepts a BAR');
    await UI.loadInput(view('explorer'), { zips: [s] });
    a.ok(st('explorer').ws && st('explorer').ws.inputKind === 'workspace', 'explorer accepts source code too');
    await UI.loadInput(view('migrate13'), { zips: [s] });
    a.ok(st('migrate13').ws && !view('migrate13').error, 'migration accepts a workspace ZIP');
    reset();
  });

  test('P04', 'Source code and its libraries in several ZIPs (or a folder) are combined; overlapping files are refused', { category: 'Independent pages' }, async function (a) {
    reset();
    var apps = await src([{ name: 'App', kind: 'app', refs: ['FwL'] }], false, 'apps.zip'), libs = await src([{ name: 'FwL', kind: 'static' }], false, 'libs.zip');
    await UI.loadInput(view('libconv'), { zips: [apps] });
    var alone = st('libconv').ws.libConversion.targets[0].plan;
    a.ok(alone.blockedCount > 0 || alone.libraries.length === 0, 'the application ZIP alone cannot be converted (the library is missing)');
    await UI.loadInput(view('libconv'), { zips: [apps, libs] });
    var ws = st('libconv').ws;
    a.eq(ws.model.deployables.map(function (d) { return d.name; }).sort().join(','), 'App,FwL', 'both ZIPs are one workspace');
    a.ok(ws.libConversion.targets[0].plan.converted.indexOf('FwL') >= 0, 'the library from the second ZIP is converted');
    view('libconv').error = null;
    await UI.loadInput(view('libconv'), { zips: [apps, apps] });
    a.ok(/more than one/.test(view('libconv').error) && !st('libconv').ws, 'the same file in two ZIPs is refused: ' + view('libconv').error);
    // a folder from the file explorer
    var dir = [{ p: 'Src/App/.project', d: Fx.dotProject('App', [], ['com.ibm.etools.msgbroker.tooling.applicationNature', 'com.ibm.etools.msgbroker.tooling.messageBrokerProjectNature']) }, { p: 'Src/App/App.esql', d: 'CREATE COMPUTE MODULE M\nEND MODULE;\n' }].map(function (x) { var f = new File([x.d], util.basename(x.p)); Object.defineProperty(f, 'webkitRelativePath', { value: x.p }); return f; });
    await UI.loadInput(view('migrate13'), { folder: dir });
    a.ok(st('migrate13').ws && st('migrate13').ws.inputKind === 'workspace' && st('migrate13').ws.model.deployables[0].name === 'App', 'a folder is accepted as source code');
    reset();
  });

  test('P05', 'Every page renders (empty and with its input) and shows its own file picker', { category: 'Independent pages' }, async function (a) {
    reset();
    var heads = { barexport: 'BAR Export', migrate13: 'IBM App Connect 13 Migration', libconv: 'Static-to-Shared Library Conversion', compare: 'BAR vs Source Comparison', explorer: 'Source Code Explorer' };
    Object.keys(heads).forEach(function (n) {
      var h = shown(n);
      a.ok(h.indexOf(heads[n]) >= 0 && h.indexOf('View failed to render') < 0, n + ': empty page renders with its heading');
      a.ok(/Choose/.test(h), n + ': has its own picker');
    });
    await UI.loadInput(view('barexport'), { zips: [await bar()] });
    var s = await src();
    await UI.loadInput(view('migrate13'), { zips: [s] }); await UI.loadInput(view('libconv'), { zips: [s] }); await UI.loadInput(view('explorer'), { zips: [s] });
    var must = { barexport: ['Java decoding', 'Build and download ACE 12 project ZIP'], migrate13: ['Migration assessment', 'Build and download ACE 13 project ZIP'], libconv: ['Strategy', 'Convert'], explorer: ['Explorer', 'Extraction report'] };
    WITH_INPUT.forEach(function (n) {
      var h = shown(n);
      a.ok(h.indexOf('View failed to render') < 0, n + ': renders with input');
      a.ok(must[n].every(function (t) { return h.indexOf(t) >= 0; }), n + ': shows ' + must[n].join(' / '));
    });
    view('explorer').tab = 'extract'; var ex = shown('explorer'); view('explorer').tab = 'explorer';
    a.ok(/Projects/.test(ex) && ex.indexOf('View failed to render') < 0, 'the explorer extraction report renders');
    reset();
  });

  test('P06', 'Each page works end to end on its own controller: BAR export with Java decoding, migration export, library conversion', { category: 'Independent pages' }, async function (a) {
    reset();
    await UI.loadInput(view('barexport'), { zips: [await bar()] });
    var c = view('barexport').ctl, ws = c.state.ws, jars = ws.jars.filter(function (j) { return j.decision.selected && j.decision.eligible; });
    a.ok(jars.length >= 1, 'an application JAR is selected for decoding');
    await c.decompile(jars, null, null, {});
    a.ok(Object.keys(ws.decompiled).length >= 1, 'the Java decoding (decompiler) ran on the BAR Export page');
    a.ok(Object.keys(st('migrate13').ws ? st('migrate13').ws.decompiled : {}).length === 0, 'and only there');
    var pk = await c.exportPackage('ace12');
    a.ok(pk.manifest.files.length > 5 && pk.blob.size > 0, 'ACE 12 project ZIP built from the BAR: ' + pk.manifest.files.length + ' entries');
    // migration on source code
    await UI.loadInput(view('migrate13'), { zips: [await F(await Fx.syntheticWorkspace(), 'ws.zip')] });
    var m = view('migrate13').ctl, mws = m.state.ws;
    a.ok(mws.migration && mws.java17 && mws.proposals, 'the migration analysis ran on the source code');
    var p13 = await m.exportPackage('ace13');
    a.ok(p13.manifest.files.length > 0, 'ACE 13 project ZIP built from the source code: ' + p13.manifest.files.length + ' entries');
    // library conversion
    UI.show('libconv');
    await UI.loadInput(view('libconv'), { zips: [await src()] });
    var l = view('libconv').ctl, run = l.convertLibraries();
    a.ok(run.targets[0].validation.passed, 'library conversion validated');
    var pl = await l.exportPackage('ace13');
    a.ok(pl.manifest.files.some(function (f) { return /^_workbench\/LIBRARY-CONVERSION-REPORT/.test(f.path); }), 'the converted package carries the conversion report');
    a.ok(!(st('barexport').ws.ws13 && Object.keys(st('barexport').ws.ws13.overlay).length), 'the BAR Export page working copy is untouched');
    reset();
  });
})();
