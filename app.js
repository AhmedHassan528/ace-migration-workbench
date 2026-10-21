/* IBM ACE Migration Workbench - application bootstrap.
 * Wires the header, navigation and BAR loading to the workflow controller (js/workflow.js). */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util;
  var app = ACE.app = {};

  app.syncHeader = function () {
    var S = ACE.settings.current;
    UI.$('#srcVer').textContent = S.sourceVersion; UI.$('#tgtVer').textContent = S.targetVersion;
    UI.$('#ver').textContent = 'v' + util.VERSION;
  };

  app.openBar = function (file) {
    UI.$('#barLabel').textContent = file.name + ' (' + util.fmtBytes(file.size) + ') - processing…';
    return UI.run('Load ' + file.name, async function (cancel, progress) {
      var ws = await ACE.workflow.load(file, { cancel: cancel, progress: progress });
      UI.$('#barLabel').textContent = file.name + ' (' + util.fmtBytes(file.size) + ')' + (ws.fatal ? ' - FAILED' : ws.complete ? '' : ' - INCOMPLETE');
      UI.show(ws.fatal ? 'dashboard' : (UI.current === 'settings' ? 'dashboard' : UI.current || 'dashboard'));
    });
  };

  async function init() {
    ACE.settings.load();
    app.syncHeader();
    UI.initLog();
    var st = ACE.workflow.state;
    try { st.docs = await ACE.settings.listStore('docs'); } catch (e) { st.docs = []; }
    try { st.extraRules = (await ACE.settings.listStore('rules')) || []; } catch (e) { st.extraRules = []; }
    UI.$('#nav').onclick = function (e) { var a = e.target.closest('a[data-view]'); if (a) UI.show(a.getAttribute('data-view')); };
    UI.$('#barInput').onchange = function (e) { var f = e.target.files[0]; if (f) app.openBar(f); e.target.value = ''; };
    // Drag & drop a BAR anywhere on the page
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); var f = e.dataTransfer && e.dataTransfer.files[0]; if (f) app.openBar(f); });
    var cap = util.capabilities();
    ACE.log.info('Workbench ' + util.VERSION + ' started from ' + cap.protocol + ' - deflate-raw: ' + cap.deflateRaw + ', CompressionStream: ' + cap.compressionStream + ', WebCrypto: ' + cap.subtleCrypto + ', IndexedDB: ' + cap.indexedDB);
    if (!cap.deflateRaw) ACE.log.error('This browser lacks DecompressionStream("deflate-raw"); compressed BAR entries cannot be extracted. Use a current Chrome, Edge or Firefox.');
    UI.show((location.hash || '#dashboard').slice(1));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window.ACE);
