/* Configuration. The defaults come from config/default-config.js (edit that file to change them for every
 * user). There is no settings page and nothing is stored in the browser: every feature page keeps its own
 * options in its own state (see js/workflow.js), so no choice made on one page can reach another. */
(function (ACE) {
  'use strict';
  var st = ACE.settings = {};

  st.load = function () {
    st.current = ACE.util.deepClone(window.ACE_DEFAULT_CONFIG);
    // Strict version mode: the versions are fixed by config/versions.js.
    if (window.ACE_VERSIONS) { st.current.sourceVersion = window.ACE_VERSIONS.source; st.current.targetVersion = window.ACE_VERSIONS.target; }
    return st.current;
  };

  /* Limits converted to bytes for the BAR engine. */
  st.limits = function () {
    var l = st.current.limits;
    return { maxFileSize: l.maxFileSizeMB * 1048576, maxTotalSize: l.maxTotalSizeMB * 1048576, maxEntries: l.maxEntries, maxDepth: l.maxDepth, maxRatio: l.maxRatio };
  };
})(window.ACE);
