/* The "build and download the project ZIP" card shared by the BAR Export and the ACE 13 Migration pages.
 * It only works on the controller of the page that shows it (ctl.state.ws, ctl.exportPackage), and keeps its
 * options and its last-package note in that controller's state. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc;

  UI.exportCard = function (ctl, target) {
    var st = ctl.state, ws = st.ws, lay = ACE.project.layout(ws), dec = Object.keys(ws.decompiled || {}).length, eo = st.exportOpts;
    var le = (st.lastExport || {})[target];
    return '<div class="card"><div class="kv"><div>Projects</div><div>' + lay.projects.map(function (p) { return esc(p.name) + ' <span class="muted">(' + esc(p.type) + ')</span>'; }).join(', ') + (dec ? '<br>+ ' + dec + ' decompiled Java project(s)' : '<br><span class="muted">No decompiled Java projects (no successful decompilation)</span>') + '</div>' +
      '<div>Original files</div><div>' + lay.files.length + ' project files + ' + (lay.metadata.length + lay.unassigned.length) + ' metadata/other, copied byte-for-byte</div>' +
      '<div>Working-copy changes</div><div>' + Object.keys((target === 'ace13' ? ws.ws13 : ws.ws12).overlay).length + ' file(s) differ from the original</div>' +
      '<div>Options</div><div>' + '<label class="inline"><input type="checkbox" id="optBar"' + (eo.includeOriginalBar ? ' checked' : '') + '> include the original ' + (ws.inputKind === 'bar' ? 'BAR' : 'source ZIP') + ' under _original/</label> <label class="inline"><input type="checkbox" id="optHdr"' + (eo.decompileHeader ? ' checked' : '') + '> mark decompiled files with a header comment</label></div></div>' +
      '<div class="row"><button class="btn primary" id="doExport">Build and download ' + (target === 'ace13' ? 'ACE 13' : 'ACE 12') + ' project ZIP</button> <button class="btn" id="dlManifest"' + (le ? '' : ' disabled') + '>Download MANIFEST.json</button> <button class="btn" id="dlInstr"' + (le ? '' : ' disabled') + '>Download import instructions</button></div>' +
      (le ? '<div class="banner ok">Last package: ' + esc(le.name) + ' - ' + le.manifest.files.length + ' entries, ' + util.fmtBytes(le.size) + ', ' + esc(le.at) + '. Origins: ' + Object.entries(util.groupBy(le.manifest.files, function (f) { return f.origin; })).map(function (e) { return esc(e[0]) + ' ' + e[1].length; }).join(', ') + '</div>' : '') + '</div>';
  };

  UI.bindExport = function (el, ctl, target) {
    var st = ctl.state, ws = st.ws;
    var b = UI.$('#optBar', el); if (b) b.onchange = function (e) { st.exportOpts.includeOriginalBar = e.target.checked; };
    UI.$('#optHdr', el).onchange = function (e) { st.exportOpts.decompileHeader = e.target.checked; };
    UI.$('#doExport', el).onclick = function () {
      UI.run('Build ' + target.toUpperCase() + ' package', async function (cancel, progress) {
        var r = await ctl.exportPackage(target, function (d, t) { progress('zip', d, t); }, cancel);
        var name = util.stripExt(ws.barName) + (target === 'ace13' ? '-ACE' + window.ACE_VERSIONS.target + '-migration' : '-ACE' + window.ACE_VERSIONS.source + '-source') + '.zip';
        st.lastExport = st.lastExport || {};
        st.lastExport[target] = { name: name, manifest: r.manifest, size: r.blob.size, at: util.nowIso() };
        util.download(r.blob, name);
      });
    };
    var le = (st.lastExport || {})[target];
    if (UI.$('#dlManifest', el) && le) UI.$('#dlManifest', el).onclick = function () { util.download(JSON.stringify(le.manifest, null, 2), 'MANIFEST-' + target + '.json', 'application/json'); };
    if (UI.$('#dlInstr', el) && le) UI.$('#dlInstr', el).onclick = function () {
      var lay = ACE.project.layout(ws);
      util.download(ACE.project.instructions(ws, target, lay, ACE.project.references(ws, ws.facts), Object.keys(ws.decompiled).map(function (k) { return ws.decompiled[k].projectName; }), Object.keys((target === 'ace13' ? ws.ws13 : ws.ws12).overlay)), 'IMPORT-INSTRUCTIONS-' + target + '.txt', 'text/plain');
    };
  };
})(window.ACE);
