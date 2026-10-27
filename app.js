/* IBM ACE Migration Workbench - application bootstrap.
 * Wires the navigation. There is no global input: every page (js/ui/views-*.js) has its own file picker and its own
 * workflow controller (js/workflow.js), so a file chosen on one page is never seen by another. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util;
  var app = ACE.app = {};

  function init() {
    ACE.settings.load();
    UI.$('#ver').textContent = 'v' + util.VERSION;
    UI.initLog();
    UI.$('#nav').onclick = function (e) { var a = e.target.closest('a[data-view]'); if (a) UI.show(a.getAttribute('data-view')); };
    // A file dropped outside a page's own picker would be ignored by the browser's default handler (it would navigate away): stop that.
    document.addEventListener('dragover', function (e) { e.preventDefault(); });
    document.addEventListener('drop', function (e) { e.preventDefault(); });
    var cap = util.capabilities();
    ACE.log.info('Workbench ' + util.VERSION + ' started from ' + cap.protocol + ' - deflate-raw: ' + cap.deflateRaw + ', CompressionStream: ' + cap.compressionStream + ', WebCrypto: ' + cap.subtleCrypto);
    if (!cap.deflateRaw) ACE.log.error('This browser lacks DecompressionStream("deflate-raw"); compressed BAR entries cannot be extracted. Use a current Chrome, Edge or Firefox.');
    UI.show((location.hash || '').slice(1));
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})(window.ACE);
