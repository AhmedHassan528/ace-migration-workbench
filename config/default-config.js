/* Default configuration. Values changed in Settings are stored in this browser (localStorage) and
 * can be exported/imported as JSON. Edit this file to change the defaults for every user. */
window.ACE_DEFAULT_CONFIG = {
  sourceVersion: '12.0.5',     // fixed: see config/versions.js (strict mode; Settings cannot change it)
  targetVersion: '13.0.8',     // fixed: see config/versions.js
  limits: {
    maxFileSizeMB: 256,      // largest single extracted entry
    maxTotalSizeMB: 2048,    // total bytes extracted from one BAR (all nesting levels)
    maxEntries: 200000,      // entries per container
    maxDepth: 6,             // nesting depth of .appzip/.libzip/.bar containers
    maxRatio: 1000           // compression ratio that triggers a ZIP-bomb warning
  },
  // JAR exclusion patterns: file-name globs (jconn*.jar), "pkg:com.vendor" or "sha256:<hash>".
  exclusions: ['ojdbc*.jar', 'db2jcc*.jar', 'mssql-jdbc*.jar', 'sqljdbc*.jar', 'mysql-connector*.jar', 'postgresql*.jar', 'jconn*.jar'],
  jarOverrides: {},          // sha256 -> 'include' | 'exclude' (set from the Java Decompiler view)
  decompiler: { engine: 'workbench-js' },     // built-in vanilla JavaScript decompiler (no external runtime)
  project: { keepOriginalJar: true, libIncludeExcluded: true },
  export: { includeOriginalBar: true, decompileHeader: true },
  // Optional static-to-shared library conversion (js/project/library-conversion.js). Disabled = no change
  // to the migration workflow. targets: ace12 and/or ace13 working copy; libraries: "auto" (all static
  // libraries) or a list of names; knownSharedLibraries: libraries that are already shared elsewhere.
  // The original source is always preserved (changes go to the working copy, originals are exported).
  // strategy: "separate" (default: each library keeps its name and becomes a shared library; ESQL/subflows move into a
  // schema named after the library; nested/hooked subflows are copied where ACE requires it), "refactor" (merge the
  // libraries into one shared library) or "in-place" (type change only, for libraries that are already valid).
  libraryConversion: { enabled: false, targets: ["ace13"], strategy: "separate", sharedLibraryName: "", schema: "", libraries: "auto", knownSharedLibraries: [], validateAfterConversion: true },
};
