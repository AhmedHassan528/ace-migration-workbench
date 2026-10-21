/* View: Settings (local tools, exclusions, limits, documentation, rules, API reference JARs). */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;

  function validateRuleSet(o) {
    if (!o || typeof o !== 'object' || !Array.isArray(o.rules)) throw new Error('A rule file must be a JSON object with a "rules" array');
    if (!o.id) throw new Error('Rule set needs an "id"');
    o.rules.forEach(function (r, i) {
      if (!r.id || !r.severity || !r.title || !r.match) throw new Error('Rule #' + (i + 1) + ' needs id, severity, title and match');
      if (['Error', 'Warning', 'Information', 'Manual Review'].indexOf(r.severity) < 0) throw new Error('Rule ' + r.id + ': severity must be Error, Warning, Information or Manual Review');
      if (!r.status) r.status = 'heuristic'; // user rules are heuristic unless they say otherwise
      if (r.match.fact && !ACE.aceRules.FACTS[r.match.fact]) throw new Error('Rule ' + r.id + ': unknown fact "' + r.match.fact + '". Known: ' + Object.keys(ACE.aceRules.FACTS).join(', '));
      Object.keys(r.match.attrMatches || {}).forEach(function (k) { new RegExp(r.match.attrMatches[k]); });
    });
    return o;
  }

  UI.register('settings', {
    render: function (st) {
      var S = ACE.settings.current, L = S.limits;
      var h = '<h1>Settings</h1><p class="lead">Stored in this browser only. Nothing is sent anywhere. Export the settings to share them.</p>';
      h += '<h2>Versions</h2><div class="formgrid"><label>Source ACE version</label><input type="text" id="sSrc" readonly value="' + esc(S.sourceVersion) + '"><label>Target ACE version</label><input type="text" id="sTgt" readonly value="' + esc(S.targetVersion) + '"></div><p class="small muted">Strict mode: the versions are fixed in <code>config/versions.js</code> and cannot be changed here.</p>';
      h += '<h2>Java source recovery</h2><div class="formgrid">' +
        '<label>Decompiler</label><div>' + esc(ACE.decompiler.name + ' ' + ACE.decompiler.version) + ' (built in, vanilla JavaScript)</div>' +
        '<label>Original application JAR</label><label class="inline"><input type="checkbox" id="pKeep"' + (S.project.keepOriginalJar ? ' checked' : '') + '> keep it in the project Lib/ folder (not on the build path)</label>' +
        '<label>Excluded JARs</label><label class="inline"><input type="checkbox" id="pExcl"' + (S.project.libIncludeExcluded ? ' checked' : '') + '> retain every excluded JAR (drivers etc.) in Lib/</label></div>';
      h += '<h2>JAR exclusions</h2><p class="small muted">One pattern per line: file-name glob (<code>jconn*.jar</code>), <code>pkg:com.vendor.prefix</code> or <code>sha256:&lt;hash&gt;</code>. Database drivers are detected from content and excluded even when no pattern matches.</p><textarea class="plain" id="sExcl" rows="6" style="width:520px;max-width:100%">' + esc(S.exclusions.join('\n')) + '</textarea>' +
        '<p class="small">Manual overrides: ' + (Object.keys(S.jarOverrides).length ? Object.keys(S.jarOverrides).map(function (k) { return '<code>' + esc(k.slice(0, 12)) + '…=' + esc(S.jarOverrides[k]) + '</code>'; }).join(' ') + ' <button class="btn small" id="sOvClr">Clear overrides</button>' : 'none') + '</p>';
      h += '<h2>Limits</h2><div class="formgrid"><label>Max file size (MB)</label><input type="number" id="lFile" value="' + L.maxFileSizeMB + '"><label>Max total extraction (MB)</label><input type="number" id="lTot" value="' + L.maxTotalSizeMB + '"><label>Max entries per container</label><input type="number" id="lEnt" value="' + L.maxEntries + '"><label>Max nesting depth</label><input type="number" id="lDep" value="' + L.maxDepth + '"><label>ZIP-bomb ratio warning</label><input type="number" id="lRat" value="' + L.maxRatio + '"></div>';
      h += '<div class="row"><button class="btn primary" id="sSave">Save settings</button> <button class="btn" id="sExport">Export settings JSON</button> <label class="btn" for="sImport">Import settings JSON…</label><input type="file" id="sImport" accept=".json" hidden> <button class="btn danger" id="sReset">Reset to defaults</button></div>';
      h += '<h2>IBM documentation (offline)</h2><p class="small muted">Import locally saved IBM documentation pages (HTML, TXT, XML or JSON), for example the ACE 13 migration topics. Rules marked "documented" are checked against these files by keyword. Without them, those rules show as UNVERIFIED offline. The online reference URLs are listed with each rule.</p>' +
        '<div class="row"><label class="btn" for="dImport">Import documentation files…</label><input type="file" id="dImport" multiple accept=".html,.htm,.txt,.xml,.json" hidden></div>' +
        (st.docs.length ? '<table class="grid"><tr><th>Document</th><th class="num">Characters</th><th>Imported</th><th></th></tr>' + st.docs.map(function (d) { return '<tr><td>' + esc(d.name) + '</td><td class="num">' + d.text.length + '</td><td>' + esc(d.importedAt) + '</td><td><button class="btn small dDel" data-id="' + esc(d.id) + '">Remove</button></td></tr>'; }).join('') + '</table>' : '<p class="muted">No documentation imported.</p>');
      h += '<h2>Migration rules</h2><p class="small">Built in: <b>' + esc(window.ACE_ACE_RULES.id) + '</b> (' + window.ACE_ACE_RULES.rules.length + ' rules) and <b>' + esc(window.ACE_JAVA_RULES.id) + '</b> (' + window.ACE_JAVA_RULES.rules.length + ' rules). Additional ACE rule sets (JSON, same format) are evaluated as well. Imported rules count as <i>heuristic</i> unless they declare a status.</p>' +
        '<div class="row"><button class="btn" id="rExport">Export built-in ACE rules (JSON)</button> <button class="btn" id="rExportJ">Export built-in Java rules (JSON)</button> <label class="btn" for="rImport">Import ACE rule set (JSON)…</label><input type="file" id="rImport" accept=".json" hidden></div>' +
        (ACE.workflow.state.extraRules.length ? '<table class="grid"><tr><th>Rule set</th><th>Rules</th><th></th></tr>' + ACE.workflow.state.extraRules.map(function (r) { return '<tr><td>' + esc(r.id) + ' v' + esc(r.version || '?') + '</td><td>' + r.rules.length + '</td><td><button class="btn small rDel" data-id="' + esc(r.id) + '">Remove</button></td></tr>'; }).join('') + '</table>' : '');
      h += '<h2>API reference JARs (optional)</h2><p class="small muted">Import the ACE 13 runtime API JARs (for example <code>server\\classes\\jplugin2.jar</code> and <code>javacompute.jar</code> from an ACE 13.0.8 installation). Every <code>com.ibm.broker.*</code> class and method referenced by the application bytecode is then checked for existence in the browser. They are read locally and are not stored.</p><div class="row"><label class="btn" for="apiImport">Import API JARs…</label><input type="file" id="apiImport" multiple accept=".jar" hidden> ' + (ACE.workflow.state.apiIndex ? esc(ACE.workflow.state.apiIndex.sources.map(function (s) { return s.name + ' (' + s.classes + ' classes)'; }).join(', ')) + ' <button class="btn small" id="apiClr">Clear</button>' : '<span class="muted">none loaded</span>') + '</div>';
      return h;
    },
    bind: function (el, st) {
      var S = ACE.settings.current;
      function v(id) { return UI.$('#' + id, el).value; }
      UI.$('#sSave', el).onclick = function () {
                S.project = { keepOriginalJar: UI.$('#pKeep', el).checked, libIncludeExcluded: UI.$('#pExcl', el).checked };
        S.exclusions = v('sExcl').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean);
        S.limits = { maxFileSizeMB: Number(v('lFile')), maxTotalSizeMB: Number(v('lTot')), maxEntries: Number(v('lEnt')), maxDepth: Number(v('lDep')), maxRatio: Number(v('lRat')) };
        ACE.settings.save(); ACE.app.syncHeader(); ACE.workflow.analyze(); ACE.log.ok('Settings saved (limits apply to the next BAR load)'); UI.refresh();
      };
      var oc = UI.$('#sOvClr', el); if (oc) oc.onclick = function () { S.jarOverrides = {}; ACE.settings.save(); ACE.workflow.analyze(); UI.refresh(); };
      UI.$('#sExport', el).onclick = function () { util.download(JSON.stringify(S, null, 2), 'workbench-settings.json', 'application/json'); };
      UI.$('#sImport', el).onchange = async function (e) {
        try { var o = JSON.parse(util.decodeText(await util.readFileBytes(e.target.files[0])).text); Object.assign(S, o); ACE.settings.save(); ACE.log.ok('Settings imported'); } catch (x) { UI.notify('Invalid settings file: ' + x.message); }
        UI.refresh();
      };
      UI.$('#sReset', el).onclick = function () { UI.ask('Reset all settings to defaults?', function () { ACE.settings.reset(); ACE.app.syncHeader(); ACE.workflow.analyze(); UI.refresh(); }, { ok: 'Reset' }); };
      UI.$('#dImport', el).onchange = async function (e) {
        var files = Array.prototype.slice.call(e.target.files);
        for (var i = 0; i < files.length; i++) {
          var raw = util.decodeText(await util.readFileBytes(files[i])).text;
          var doc = { id: 'doc_' + files[i].name + '_' + files[i].size, name: files[i].name, text: ACE.settings.docText(files[i].name, raw), importedAt: util.nowIso() };
          await ACE.settings.putStore('docs', doc);
          ACE.log.ok('Imported documentation ' + doc.name + ' (' + doc.text.length + ' characters)');
        }
        st.docs = await ACE.settings.listStore('docs'); ACE.workflow.analyze(); UI.refresh();
      };
      UI.$$('.dDel', el).forEach(function (b) { b.onclick = async function () { await ACE.settings.deleteStore('docs', b.getAttribute('data-id')); st.docs = await ACE.settings.listStore('docs'); ACE.workflow.analyze(); UI.refresh(); }; });
      UI.$('#rExport', el).onclick = function () { util.download(JSON.stringify(window.ACE_ACE_RULES, null, 2), 'ace12-to-ace13.rules.json', 'application/json'); };
      UI.$('#rExportJ', el).onclick = function () { util.download(JSON.stringify(window.ACE_JAVA_RULES, null, 2), 'java8-to-java17.rules.json', 'application/json'); };
      UI.$('#rImport', el).onchange = async function (e) {
        try {
          var o = validateRuleSet(JSON.parse(util.decodeText(await util.readFileBytes(e.target.files[0])).text));
          if (o.id === window.ACE_ACE_RULES.id) throw new Error('This is the built-in rule set id; give imported sets their own "id"');
          st.extraRules = st.extraRules.filter(function (r) { return r.id !== o.id; }).concat([o]);
          await ACE.settings.putStore('rules', o); ACE.log.ok('Imported rule set ' + o.id + ' (' + o.rules.length + ' rules)'); ACE.workflow.analyze();
        } catch (x) { UI.notify('Rule file rejected: ' + x.message); }
        UI.refresh();
      };
      UI.$$('.rDel', el).forEach(function (b) { b.onclick = async function () { var id = b.getAttribute('data-id'); st.extraRules = st.extraRules.filter(function (r) { return r.id !== id; }); await ACE.settings.deleteStore('rules', id); ACE.workflow.analyze(); UI.refresh(); }; });
      UI.$('#apiImport', el).onchange = function (e) {
        var files = Array.prototype.slice.call(e.target.files);
        UI.run('Index API reference JARs', async function () { st.apiIndex = await ACE.java17.buildApiIndex(files); ACE.log.ok('API reference index: ' + Object.keys(st.apiIndex.classes).length + ' classes'); ACE.workflow.analyze(); });
      };
      var ac = UI.$('#apiClr', el); if (ac) ac.onclick = function () { st.apiIndex = null; ACE.workflow.analyze(); UI.refresh(); };
    }
  });

  ACE.ui.validateRuleSet = validateRuleSet;
})(window.ACE);
