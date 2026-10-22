/* View: static-to-shared library conversion (optional feature; js/project/library-conversion.js). */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;
  var open = {};
  var DEC = { convert: ['pass', 'will be converted'], 'already-shared': ['info', 'already shared'], blocked: ['fail', 'cannot be converted'], 'not-selected': ['unknown', 'not selected'] };

  function cfg() { var S = ACE.settings.current; S.libraryConversion = Object.assign({}, ACE.libconv.DEFAULTS, S.libraryConversion || {}); return S.libraryConversion; }

  function configCard(st) {
    var c = cfg(), ws = st.ws, statics = [];
    if (ws && !ws.fatal) statics = ACE.libconv.state(ws, 'ws13').projects.filter(function (p) { return p.kind === 'static-library'; }).map(function (p) { return p.name; });
    var auto = c.libraries === 'auto' || !c.libraries;
    var h = '<div class="card"><div class="formgrid">' +
      '<label>Conversion</label><label class="inline"><input type="checkbox" id="lcOn"' + (c.enabled ? ' checked' : '') + '> enabled (when off, the migration works exactly as before)</label>' +
      '<label>Source version</label><div>ACE ' + esc(window.ACE_VERSIONS.source) + ' (fixed, see Settings)</div>' +
      '<label>Target(s)</label><div><label class="inline"><input type="checkbox" id="lcT12"' + (c.targets.indexOf('ace12') >= 0 ? ' checked' : '') + '> ACE ' + esc(window.ACE_VERSIONS.source) + ' (ACE 12 package)</label> &nbsp; <label class="inline"><input type="checkbox" id="lcT13"' + (c.targets.indexOf('ace13') >= 0 ? ' checked' : '') + '> ACE ' + esc(window.ACE_VERSIONS.target) + ' (ACE 13 package)</label></div>' +
      '<label>Library mode</label><div>shared</div>' +
      '<label>Strategy</label><div>' +
        '<label class="inline"><input type="radio" name="lcStrat" value="separate"' + (c.strategy !== 'in-place' && c.strategy !== 'refactor' ? ' checked' : '') + '> <b>Keep libraries separate</b> (recommended): every library keeps its name and becomes its own shared library; ESQL/subflows move into a schema named after the library; subflows that ACE cannot use across shared libraries are copied where needed; all references rewritten</label><br>' +
        '<label class="inline"><input type="radio" name="lcStrat" value="refactor"' + (c.strategy === 'refactor' ? ' checked' : '') + '> <b>Merge</b>: combine the interdependent libraries into ONE shared library (fewer copies; the library names change)</label><br>' +
        '<label class="inline"><input type="radio" name="lcStrat" value="in-place"' + (c.strategy === 'in-place' ? ' checked' : '') + '> <b>Type change only</b>: for libraries that are already valid shared libraries</label></div>' +
      '<label>Merge: shared library name</label><div><input type="text" id="lcName" placeholder="Merge strategy only - default: SharedFramework" value="' + esc(c.sharedLibraryName || '') + '"><div class="small muted">Use the same settings for every service so they all use the same shared libraries.</div></div>' +
      '<label>Merge: broker schema</label><div><input type="text" id="lcSchema" placeholder="Merge strategy only - default: the library name in lower case" value="' + esc(c.schema || '') + '"></div>' +
      '<label>Libraries to convert</label><div><label class="inline"><input type="radio" name="lcSel" value="auto"' + (auto ? ' checked' : '') + '> all static libraries</label> <label class="inline"><input type="radio" name="lcSel" value="pick"' + (auto ? '' : ' checked') + '> only these:</label> ' +
        (statics.length ? statics.map(function (n) { return '<label class="inline"><input type="checkbox" class="lcLib" value="' + esc(n) + '"' + (!auto && (c.libraries || []).indexOf(n) >= 0 ? ' checked' : '') + '> ' + esc(n) + '</label>'; }).join(' ') : '<span class="muted">(open a workspace ZIP or BAR to list its static libraries)</span>') + '</div>' +
      '<label>Known shared libraries</label><div><input type="text" class="wide" id="lcKnown" placeholder="names, comma separated" value="' + esc((c.knownSharedLibraries || []).join(', ')) + '"><div class="small muted">Libraries that are already shared libraries but are not in this input (e.g. converted earlier for another service).</div></div>' +
      '<label>Validate after conversion</label><label class="inline"><input type="checkbox" id="lcVal"' + (c.validateAfterConversion ? ' checked' : '') + '> run the structural validation (build commands are listed; they cannot run in a browser)</label>' +
      '<label>Original source</label><div>always preserved: changes go to the working copy; originals are exported under <code>_original-before-changes/</code>; Undo restores them</div>' +
      '</div><div class="row"><button class="btn primary" id="lcSave">Save and analyse</button></div></div>';
    return h;
  }

  function planHtml(t, applied) {
    var p = t.plan, h = '<h2>Target ACE ' + esc(t.version) + ' <span class="small muted">(' + (t.target === 'ace12' ? 'ACE 12 working copy / package' : 'ACE 13 working copy / package') + ')</span></h2>';
    var counts = util.groupBy(p.libraries, function (l) { return l.decision; });
    h += '<div class="cards">' + ['convert', 'already-shared', 'blocked', 'not-selected'].map(function (d) { return '<div class="stat"><div class="n">' + (counts[d] ? counts[d].length : 0) + '</div><div class="l">' + esc(DEC[d][1]) + '</div></div>'; }).join('') + '<div class="stat"><div class="n">' + p.edits.length + '</div><div class="l">file(s) ' + (applied ? 'to change' : 'to change') + '</div></div></div>';
    h += '<table class="grid"><tr><th>Library</th><th>Type now</th><th>Decision</th><th>Used by</th><th>Why</th></tr>';
    p.libraries.forEach(function (l) {
      var k = 'lib:' + t.target + ':' + l.name;
      h += '<tr><td><b>' + esc(l.name) + '</b></td><td>' + esc(l.currentType) + '</td><td><span class="sev st-' + DEC[l.decision][0] + '">' + esc(DEC[l.decision][1]) + '</span></td><td class="small">' + esc(l.referencingApplications.concat(l.referencingLibraries).join(', ') || '-') + (l.usage.length ? '<br><span class="muted">' + l.usage.length + ' use(s) of its subflows/ESQL</span>' : '') + '</td><td class="small">' +
        (l.blockers.length ? l.blockers.map(function (b) { return '<b>' + esc(b.code) + '</b>: ' + esc(b.rule) + ' <i>' + esc(b.detail) + '</i>'; }).join('<br>') + ' <button class="btn small lcMore" data-k="' + esc(k) + '">' + (open[k] ? 'Less' : 'Evidence') + '</button>' : esc(l.reasons.join('; '))) +
        (l.coordination ? '<br><span class="muted">' + esc(l.coordination) + '</span>' : '') +
        (open[k] ? '<div class="small">' + l.blockers.map(function (b) { return '<p><b>' + esc(b.code) + '</b> (' + esc(b.basis) + '): ' + esc(b.evidence) + '<br>' + (b.locations || []).slice(0, 12).map(function (x) { return '<code>' + esc(x.file + (x.line ? ':' + x.line : '')) + '</code>'; }).join(' ') + '<br>' + (b.docs || []).map(function (u) { return '<a href="' + esc(u) + '" target="_blank" rel="noopener">' + esc(u.replace(/^https:\/\/(www\.)?/, '').slice(0, 70)) + '</a>'; }).join(' ') + '</p>'; }).join('') + '</div>' : '') + '</td></tr>';
    });
    h += '</table>';
    if (p.target && p.target.sharedLibrary) {
      h += '<div class="card"><div class="kv"><div>Shared library</div><div><b>' + esc(p.target.sharedLibrary) + '</b> (merges ' + esc(p.target.group.join(', ')) + ')</div><div>Broker schema</div><div><code>' + esc(p.target.schema) + '</code>; application-local copies in <code>' + esc(p.target.localSchema) + '</code></div>' +
        '<div>Application hooks</div><div class="small">' + ((p.hooks || []).length ? p.hooks.map(function (x) { return '<code>' + esc(x.subflow) + '</code> receives ' + esc(x.properties.map(function (q) { return q.property; }).join(', ')) + ' from the application'; }).join('<br>') + '<br><span class="muted">An application ESQL module cannot run inside a shared subflow (verified: BIP4127E), so these subflows stay local to each application and use the shared framework.</span>' : 'none') + '</div></div></div>';
    }
    (p.notes || []).forEach(function (n) { h += '<p class="small">' + esc(n) + '</p>'; });
    if (p.edits.length) {
      var groups = { created: [], deleted: [], modified: [] };
      p.edits.forEach(function (e) { groups[e.created ? 'created' : e.deleted ? 'deleted' : 'modified'].push(e); });
      h += '<h3>Changes planned (' + p.edits.length + ': ' + groups.modified.length + ' modified, ' + groups.created.length + ' created, ' + groups.deleted.length + ' removed/moved)</h3>';
      [['modified', 'Modified'], ['created', 'Created (new shared library, local copies, generated files)'], ['deleted', 'Removed (moved into the shared library)']].forEach(function (g) {
        var list = groups[g[0]]; if (!list.length) return;
        var gk = 'g:' + t.target + ':' + g[0];
        h += '<details' + (g[0] === 'modified' || open[gk] ? ' open' : '') + '><summary><b>' + g[1] + '</b> (' + list.length + ')</summary>';
        list.forEach(function (e) { var k = 'e:' + t.target + ':' + e.path; h += '<div class="card"><div class="row"><code>' + esc(e.path) + '</code> <span class="small">' + esc(e.notes.join('; ')) + '</span>' + (e.after != null && !e.bytesFrom ? ' <button class="btn small lcMore" data-k="' + esc(k) + '">' + (open[k] ? 'Hide' : 'Show') + ' ' + (e.created ? 'content' : 'change') + '</button>' : '') + '</div>' + (open[k] && e.after != null ? UI.diffHtml(ACE.diff(e.before || '', e.after)) : '') + '</div>'; });
        h += '</details>';
      });
    } else h += '<p class="muted">No file needs to change for this target.</p>';
    if (p.errors.length) h += '<div class="banner err"><b>Errors</b><ul>' + p.errors.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if (p.warnings.length) h += '<div class="banner warn"><b>Warnings</b><ul>' + p.warnings.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    if (p.manualActions.length) h += '<div class="banner"><b>Manual actions required</b><ul>' + p.manualActions.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul></div>';
    h += '<h3>Build and packaging (' + esc(p.build.version) + ')</h3>' + (p.build.commands.length ? '<pre>' + esc(p.build.commands.map(function (c) { return '# ' + c.purpose + '\n' + c.command; }).join('\n\n')) + '</pre>' : '<p class="muted">No applications or shared libraries.</p>') + '<ul class="small">' + p.build.notes.map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('') + '</ul>';
    return h;
  }

  function validationHtml(run) {
    if (!run) return '';
    var h = '<h2>Last conversion (' + esc(run.at) + ')</h2>';
    run.targets.forEach(function (t) {
      h += '<h3>ACE ' + esc(t.version) + ': ' + t.applied.length + ' file(s) changed</h3>';
      if (t.validation) h += '<table class="grid"><tr><th>Check</th><th>Result</th><th>Problems</th></tr>' + t.validation.checks.map(function (c) { return '<tr><td>' + esc(c.id + ' ' + c.title) + '</td><td><span class="sev st-' + (c.status === 'PASS' ? 'pass' : 'fail') + '">' + c.status + '</span></td><td class="small">' + esc(c.problems.join('; ') || '-') + '</td></tr>'; }).join('') + '</table><p class="small muted">Not performed here: ' + esc(t.validation.notPerformed.join(' ')) + '</p>';
    });
    return h;
  }

  UI.register('libconv', {
    render: function (st) {
      var c = cfg();
      var h = '<h1>Shared Library Conversion</h1><p class="lead">Converts static libraries into ACE shared libraries so a framework change is deployed once instead of rebuilding every service. A shared library is a library whose <code>.project</code> has the <code>sharedLibraryNature</code>; every application and shared library that uses it must list it in its descriptor (<code>sharedLibraryReference</code>), and it is packaged as a separate <code>.shlibzip</code>. Libraries that IBM does not allow to be shared (message flows, ESQL or subflows in the default schema, unsupported resources) are reported, never forced.</p>';
      h += configCard(st);
      var n = UI.needBar(st); if (n) return h + n;
      var ws = st.ws;
      if (!c.enabled) return h + '<div class="banner">Conversion is <b>disabled</b>. The migration and its exports are exactly as without this feature.</div>';
      if (!c.targets.length) return h + '<div class="banner warn">Choose at least one target.</div>';
      var plan = ws.libConversion;
      if (!plan) return h + '<div class="banner">Press <b>Save and analyse</b>.</div>';
      var todo = plan.targets.reduce(function (a, t) { return a + t.plan.edits.length; }, 0), blocked = plan.targets.reduce(function (a, t) { return a + t.plan.blockedCount; }, 0), errs = plan.targets.reduce(function (a, t) { return a + t.plan.errors.length; }, 0);
      h += '<div class="row"><button class="btn primary" id="lcRun"' + (todo && !errs ? '' : ' disabled') + '>Convert…</button> <button class="btn" id="lcUndo"' + (ws.libConversionRun || hasConversion(ws) ? '' : ' disabled') + '>Undo conversion</button> <button class="btn" id="lcMd">Download report (Markdown)</button> <button class="btn" id="lcJson">Download report (JSON)</button> <span class="small muted">' + (todo ? todo + ' file change(s) planned' : 'nothing to change') + (blocked ? ', ' + blocked + ' library(ies) cannot be converted' : '') + '</span></div>';
      if (ws.libConversionRun) {
        // download the converted source right here (same package as the ACE 12 / ACE 13 export views)
        h += '<div class="card banner ok"><b>Conversion applied.</b> Download the converted projects (Toolkit workspace ZIP: shared library, updated applications, originals under <code>_original-before-changes/</code>, reports under <code>_workbench/</code>):<div class="row">' +
          ws.libConversionRun.targets.map(function (t) { return '<button class="btn primary lcDl" data-t="' + t.target + '">Download converted ' + (t.target === 'ace12' ? 'ACE ' + esc(window.ACE_VERSIONS.source) : 'ACE ' + esc(window.ACE_VERSIONS.target)) + ' project ZIP</button>'; }).join(' ') +
          '</div><div class="small muted">Import it in the Toolkit with File &gt; Import &gt; Existing Projects into Workspace &gt; Select archive file, or build it with the ibmint commands listed below.</div></div>';
      }
      h += validationHtml(ws.libConversionRun);
      plan.targets.forEach(function (t) { h += planHtml(t, false); });
      return h;
    },
    bind: function (el, st) {
      var S = ACE.settings.current, c = cfg();
      UI.$('#lcSave', el).onclick = function () {
        var pick = UI.$$('input[name=lcSel]', el).filter(function (r) { return r.checked; })[0];
        c.enabled = UI.$('#lcOn', el).checked;
        c.targets = [UI.$('#lcT12', el).checked ? 'ace12' : null, UI.$('#lcT13', el).checked ? 'ace13' : null].filter(Boolean);
        c.libraries = !pick || pick.value === 'auto' ? 'auto' : UI.$$('.lcLib', el).filter(function (x) { return x.checked; }).map(function (x) { return x.value; });
        c.knownSharedLibraries = UI.$('#lcKnown', el).value.split(',').map(function (x) { return x.trim(); }).filter(Boolean);
        c.validateAfterConversion = UI.$('#lcVal', el).checked;
        var strat = UI.$$('input[name=lcStrat]', el).filter(function (r) { return r.checked; })[0];
        c.strategy = strat ? strat.value : 'separate'; c.strategyVersion = 2;
        c.sharedLibraryName = UI.$('#lcName', el).value.trim();
        c.schema = UI.$('#lcSchema', el).value.trim();
        S.libraryConversion = c; ACE.settings.save();
        if (st.ws && !st.ws.fatal) ACE.workflow.analyze();
        ACE.log.info('Library conversion settings saved (' + (c.enabled ? 'enabled' : 'disabled') + ')');
        UI.refresh();
      };
      UI.$$('.lcMore', el).forEach(function (b) { b.onclick = function () { var k = b.getAttribute('data-k'); open[k] = !open[k]; UI.refresh(); }; });
      if (!st.ws || st.ws.fatal || !c.enabled) return;
      var ws = st.ws;
      var run = UI.$('#lcRun', el); if (run) run.onclick = function () {
        var p = ws.libConversion, libs = util.uniq([].concat.apply([], p.targets.map(function (t) { return t.plan.converted; }))), files = p.targets.reduce(function (a, t) { return a + t.plan.edits.length; }, 0);
        var tp = p.targets[0].plan, what = tp.target && tp.target.sharedLibrary ? 'Merge ' + libs.join(', ') + ' into shared library ' + tp.target.sharedLibrary + ' (schema ' + tp.target.schema + ') and update every reference' : 'Convert ' + libs.length + ' library(ies) to shared libraries: ' + libs.join(', ');
        UI.ask(what + '?\n\n' + files + ' file change(s) in the ' + c.targets.map(function (t) { return t === 'ace12' ? 'ACE 12' : 'ACE 13'; }).join(' and ') + ' working copy' + (tp.target && tp.target.sharedLibrary ? ' (moved, created and modified files are listed under "Changes planned")' : ': .project natures and descriptor references only') + '. The original files stay unchanged (exported under _original-before-changes/) and Undo restores them.', function () {
          try { var r = ACE.workflow.convertLibraries(); var bad = r.targets.filter(function (t) { return t.validation && !t.validation.passed; }); if (bad.length) UI.notify('Converted, but validation reported problems. See "Last conversion".'); }
          catch (e) { UI.notify('Conversion was not applied: ' + e.message); }
          UI.refresh();
        }, { ok: 'Convert' });
      };
      UI.$$('.lcDl', el).forEach(function (b) {
        b.onclick = function () {
          var target = b.getAttribute('data-t'), ver = target === 'ace12' ? window.ACE_VERSIONS.source : window.ACE_VERSIONS.target;
          UI.run('Build converted ' + target.toUpperCase() + ' package', async function (cancel, progress) {
            var r = await ACE.workflow.exportPackage(target, function (d, t) { progress('zip', d, t); }, cancel);
            util.download(r.blob, util.stripExt(ws.barName) + '-ACE' + ver + '-shared-libraries.zip');
          });
        };
      });
      var un = UI.$('#lcUndo', el); if (un) un.onclick =function () { UI.ask('Undo the library conversion in every working copy?', function () { var n = ACE.workflow.undoLibraryConversion(); ACE.log.info('Undid ' + n + ' conversion change(s)'); UI.refresh(); }, { ok: 'Undo' }); };
      function rep() { return ws.libConversionRun || ws.libConversion; }
      UI.$('#lcMd', el).onclick = function () { util.download(ACE.libconv.reportText(rep()), util.stripExt(ws.barName) + '-library-conversion.md', 'text/markdown'); };
      UI.$('#lcJson', el).onclick = function () { util.download(JSON.stringify(ACE.libconv.reportJson(rep()), null, 2), util.stripExt(ws.barName) + '-library-conversion.json', 'application/json'); };
    }
  });
  function hasConversion(ws) { return ['ws12', 'ws13'].some(function (c) { var o = (ws[c] && ws[c].overlay) || {}; return Object.keys(o).some(function (p) { return o[p].history.some(function (h) { return h.kind === ACE.libconv.KIND; }); }); }); }
})(window.ACE);
