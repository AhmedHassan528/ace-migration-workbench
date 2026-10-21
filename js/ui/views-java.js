/* View: JAR & Class Inspector + Java Source Recovery (built-in JavaScript decompiler) +
 * Driver Exclusion Manager + Eclipse Java project export. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;
  var openJar = null, openClass = null, projNames = {}, exportedAt = {};

  function versions(info) { return Object.keys(info.versions).map(function (v) { return 'Java ' + ACE.java.javaVersionOf(Number(v)) + ' ×' + info.versions[v]; }).join(', ') || '-'; }
  function stage(ok, text) { return '<span class="sev ' + (ok === true ? 'st-pass' : ok === false ? 'st-fail' : 'st-unknown') + '">' + (ok === true ? '✓' : ok === false ? '✗' : '–') + '</span> ' + text; }

  UI.register('decompiler', {
    render: function (st) {
      var n = UI.needBar(st); if (n) return '<h1>Java Decompiler</h1>' + n;
      var ws = st.ws, jars = ws.jars || [];
      var h = '<h1>Java Source Recovery</h1><p class="lead">JARs found in the BAR are inspected class by class. Eligible application JARs are decompiled into real <code>.java</code> files by the <b>built-in JavaScript decompiler</b>, which runs in this page with no Java, Fernflower or helper program. Each stage is reported separately, and extracting a JAR is <b>not</b> counted as recovering its source. Database drivers are never decompiled by default and are kept as dependencies in <code>Lib/</code>.</p>';
      if (!jars.length) return h + '<div class="banner">The BAR contains no JAR files.</div>';
      h += '<h2>JARs (' + jars.length + ' distinct)</h2><div class="scroll"><table class="grid" id="jarTable"><tr><th>Select</th><th>JAR</th><th>Classification &amp; evidence</th><th>Pipeline stages</th><th>Override</th></tr>';
      jars.forEach(function (j) {
        var d = j.decision, c = j.classification, rec = ws.decompiled[j.sha256];
        var stages = [
          stage(true, 'JAR extracted (' + j.occurrences.length + ' location' + (j.occurrences.length > 1 ? 's' : '') + ')'),
          stage(!j.info.error, 'JAR inspected' + (j.info.error ? ': ' + esc(j.info.error) : '')),
          stage(j.info.classCount > 0 ? true : null, 'Classes detected: <b>' + j.info.classCount + '</b> (' + esc(versions(j.info)) + ')' + (j.info.parseErrors.length ? ', ' + j.info.parseErrors.length + ' unreadable' : '')),
          rec ? stage(rec.stats.complete > 0, 'Java source generated: <b>' + rec.stats.complete + ' complete</b>, ' + rec.stats.partial + ' partial, ' + rec.stats.failed + ' failed (' + esc(rec.mode === 'imported' ? 'imported by user' : (rec.stats.methods - rec.stats.methodsFailed) + '/' + rec.stats.methods + ' methods') + ')')
              : stage(null, 'Java source generated: <b>not run</b>' + (d.selected ? '' : ' (excluded)')),
          stage(exportedAt[j.sha256] ? true : null, 'Source exported' + (exportedAt[j.sha256] ? ' ' + esc(exportedAt[j.sha256]) : ': not yet'))
        ];
        h += '<tr data-sha="' + esc(j.sha256) + '"' + (openJar === j.sha256 ? ' class="sel"' : '') + '><td><input type="checkbox" class="jsel"' + (d.selected ? ' checked' : '') + (d.eligible ? '' : ' disabled') + '></td>' +
          '<td><b>' + esc(j.name) + '</b><br><span class="small muted">' + util.fmtBytes(j.size) + '</span><details class="small"><summary>locations</summary>' + j.occurrences.map(function (o) { return '<code>' + esc(o) + '</code>'; }).join('<br>') + '</details>' + (j.info.nestedJars.length ? '<div class="small sev-Warning">nested JARs: ' + esc(j.info.nestedJars.map(function (x) { return x.path; }).join(', ')) + '</div>' : '') + '</td>' +
          '<td class="small"><b>' + esc(c.type) + (c.driverName ? ': ' + c.driverName : '') + '</b><br>' + c.evidence.map(esc).join('<br>') + '<br>' + (d.selected ? '<span class="st-pass">SELECTED for decompilation</span>' : '<span class="sev-Warning">EXCLUDED</span>: ' + esc(d.reason)) + '</td>' +
          '<td class="small">' + stages.join('<br>') + '<div class="row"><button class="btn small jopen">' + (openJar === j.sha256 ? 'Hide' : 'Show') + ' classes</button></div></td>' +
          '<td class="small"><button class="btn small jinc"' + (d.eligible ? '' : ' disabled') + '>Include</button> <button class="btn small jexc">Exclude</button> <button class="btn small jclr"' + (d.override ? '' : ' disabled') + '>Reset</button></td></tr>';
      });
      h += '</table></div>';
      h += '<div class="row"><button class="btn primary" id="decRun">Decompile selected JARs</button> <button class="btn" id="exclDl">Download excluded-JAR report</button> <span class="small muted">Engine: ' + esc(ACE.decompiler.name + ' ' + ACE.decompiler.version) + '. It runs in this browser; nothing is uploaded or executed.</span></div>';
      var oj = jars.filter(function (j) { return j.sha256 === openJar; })[0];
      if (oj) h += jarDetail(ws, oj);
      return h;
    },
    bind: function (el, st) {
      if (!st.ws || st.ws.fatal) return;
      var ws = st.ws, S = ACE.settings.current;
      function rowRec(tr) { var sha = tr.getAttribute('data-sha'); return ws.jars.filter(function (j) { return j.sha256 === sha; })[0]; }
      UI.$$('#jarTable tr[data-sha]', el).forEach(function (tr) {
        var j = rowRec(tr);
        UI.$('.jopen', tr).onclick = function () { openJar = openJar === j.sha256 ? null : j.sha256; openClass = null; UI.refresh(); };
        UI.$('.jinc', tr).onclick = function () {
          function go() { S.jarOverrides[j.sha256] = 'include'; ACE.settings.save(); ACE.workflow.analyze(); UI.refresh(); }
          if (/driver/.test(j.classification.type)) UI.ask(j.name + ' is classified as a database driver (' + j.classification.driverName + ').\nDrivers are excluded from decompilation by policy.\n\nInclude it anyway?', go, { ok: 'Include' });
          else go();
        };
        UI.$('.jexc', tr).onclick = function () { S.jarOverrides[j.sha256] = 'exclude'; ACE.settings.save(); ACE.workflow.analyze(); UI.refresh(); };
        UI.$('.jclr', tr).onclick = function () { delete S.jarOverrides[j.sha256]; ACE.settings.save(); ACE.workflow.analyze(); UI.refresh(); };
        UI.$('.jsel', tr).onchange = function (e) {
          var on = e.target.checked;
          function go() { S.jarOverrides[j.sha256] = on ? 'include' : 'exclude'; ACE.settings.save(); ACE.workflow.analyze(); UI.refresh(); }
          if (on && /driver/.test(j.classification.type)) { e.target.checked = false; UI.ask('Include database driver ' + j.name + ' for decompilation?', go, { ok: 'Include' }); }
          else go();
        };
      });
      UI.$('#decRun', el).onclick = function () {
        var sel = ws.jars.filter(function (j) { return j.decision.selected && j.decision.eligible; });
        if (!sel.length) { UI.notify('No JAR is selected for decompilation.'); return; }
        UI.run('Decompile ' + sel.length + ' JAR(s)', function (cancel, progress) { return ACE.workflow.decompile(sel, cancel, progress, projNames); });
      };
      UI.$('#exclDl', el).onclick = function () { util.download(JSON.stringify(ACE.reports.exclusions(ws), null, 2), 'excluded-jars.json', 'application/json'); };
      var oj = ws.jars.filter(function (j) { return j.sha256 === openJar; })[0];
      if (oj) bindDetail(el, ws, oj);
    }
  });

  function jarDetail(ws, j) {
    var rec = ws.decompiled[j.sha256], S = ACE.settings.current;
    var plan = ACE.eclipse.plan(ws, j, { projectName: projNames[j.sha256], includeExcluded: S.project.libIncludeExcluded });
    var h = '<div class="card"><h3 style="margin-top:0">' + esc(j.name) + ': classes</h3>';
    var byName = {}; (rec ? rec.results : []).forEach(function (r) { byName[r.className] = r; });
    h += '<div class="scroll" style="max-height:40vh"><table class="grid" id="clsTable"><tr><th>Class (from bytecode)</th><th>Java</th><th>Members</th><th>Source file</th><th>Status</th></tr>';
    j.info.classes.forEach(function (c) {
      var top = c.name.indexOf('$') < 0 ? c.name : null, r = byName[c.name];
      var status = !rec ? '<span class="muted">not decompiled</span>' : r ? '<b class="' + (r.status === 'complete' ? 'st-pass' : r.status === 'partial' ? 'st-attention' : 'st-fail') + '">' + r.status.toUpperCase() + '</b>' + (r.notes.length ? '<br><span class="small">' + esc(r.notes.join('; ')) + '</span>' : '') + r.methods.filter(function (m) { return m.status !== 'ok'; }).map(function (m) { return '<br><span class="small sev-Error">' + esc(m.name + ': ' + m.reason) + '</span>'; }).join('') : (top ? '<span class="muted">-</span>' : '<span class="small muted">nested class (inside its outer class)</span>');
      h += '<tr data-cls="' + esc(c.name) + '"' + (openClass === c.name ? ' class="sel"' : '') + '><td><code>' + esc(c.name.replace(/\//g, '.')) + '</code><br><span class="small muted">bin/' + esc(c.path) + '</span></td><td>' + esc(c.javaVersion) + '</td><td class="small">' + c.fields.length + ' fields, ' + c.methods.length + ' methods</td><td class="small">' + (r && r.source ? '<code>src/' + esc(r.path) + '</code>' : '-') + '</td><td>' + status + '</td></tr>';
    });
    h += '</table></div>';
    if (openClass && byName[openClass] && byName[openClass].source) {
      var r0 = byName[openClass];
      h += '<h3>src/' + esc(r0.path) + '</h3><textarea class="editor" readonly spellcheck="false" style="min-height:40vh">' + esc(r0.source) + '</textarea>';
    }
    h += '<h3>Eclipse Java project</h3><div class="row">Project name <input type="text" id="projName" value="' + esc(plan.name) + '"> <button class="btn primary" id="projDl"' + (rec ? '' : ' disabled') + '>Download project ZIP</button> <button class="btn" id="srcDl"' + (rec ? '' : ' disabled') + '>Download src only</button></div>';
    var tree = [plan.name + '/', '  .project', '  .classpath', '  .settings/org.eclipse.jdt.core.prefs', '  src/  (' + (rec ? rec.results.filter(function (r) { return r.source; }).length + ' .java file(s)' : 'empty: decompile first') + ')', '  bin/  (' + j.info.classes.filter(function (c) { return c.bytes; }).length + ' original .class file(s))', '  Lib/'].concat(plan.deps.map(function (d) { return '    ' + d.name + (d.classification.type === 'driver' ? '   (database driver, not decompiled)' : ''); })).concat(S.project.keepOriginalJar ? ['    ' + j.name + '   (original JAR, not on the build path)'] : []);
    h += '<pre>' + esc(tree.join('\n')) + '</pre><ul class="small">' + plan.reasons.map(function (x) { return '<li>' + esc(x) + '</li>'; }).join('') + '</ul>';
    h += '<div class="row small">Already have the original source (e.g. from source control)? <label class="btn small" for="srcImp">Import .java / ZIP for this JAR…</label><input type="file" id="srcImp" multiple accept=".java,.zip" hidden> <span class="muted">Files are matched to classes by package path; they are labelled as imported, not decompiled.</span></div>';
    return h + '</div>';
  }

  function bindDetail(el, ws, j) {
    UI.$$('#clsTable tr[data-cls]', el).forEach(function (tr) { tr.onclick = function () { openClass = tr.getAttribute('data-cls'); UI.refresh(); }; });
    var pn = UI.$('#projName', el);
    pn.onchange = function () { projNames[j.sha256] = pn.value.trim(); if (ws.decompiled[j.sha256]) { ws.decompiled[j.sha256].projectName = projNames[j.sha256]; ws.decompiled[j.sha256].outputPrefix = projNames[j.sha256] + '/src/'; ws._layout = null; } UI.refresh(); };
    var dl = UI.$('#projDl', el); if (dl) dl.onclick = async function () {
      var S = ACE.settings.current;
      var r = await ACE.eclipse.zip(ws, j, { projectName: pn.value.trim(), keepOriginalJar: S.project.keepOriginalJar, includeExcluded: S.project.libIncludeExcluded, target: 'ace12' });
      util.download(r.blob, r.result.plan.name + '.zip');
      exportedAt[j.sha256] = util.nowIso().slice(0, 19).replace('T', ' ') + ' (' + r.result.srcCount + ' .java)';
      ACE.log.ok('Exported Eclipse project ' + r.result.plan.name + ': ' + r.result.srcCount + ' source file(s), ' + r.result.files.length + ' files in total');
      UI.refresh();
    };
    var sd = UI.$('#srcDl', el); if (sd) sd.onclick = async function () {
      var rec = ws.decompiled[j.sha256], w = new ACE.zip.Writer();
      rec.results.forEach(function (r) { if (r.source) w.add('src/' + r.path, r.source); });
      util.download(await w.build(), util.stripExt(j.name) + '-src.zip');
    };
    UI.$('#srcImp', el).onchange = function (e) {
      var files = Array.prototype.slice.call(e.target.files);
      UI.run('Import source for ' + j.name, async function () { var r = await ACE.workflow.importSources(j, files); if (!r.accepted) UI.notify('No imported file matched a class of ' + j.name + '.\nRejected: ' + r.rejected.join(', ')); });
    };
  }
})(window.ACE);
