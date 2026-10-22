# IBM ACE Migration Workbench

An offline website, written in HTML, CSS and vanilla JavaScript only, that opens IBM App Connect Enterprise **BAR files** and **Toolkit workspace ZIPs**. It:

- extracts their editable artifacts
- **decompiles application JARs into real `.java` source** with a decompiler written in JavaScript
- rebuilds a `FrameworkJPrj`-style **Eclipse Java project** (`src/`, `bin/`, `Lib/`, `.project`, `.classpath`, `.settings`)
- analyses **Java 8 → 17** and **ACE 12.0.5 → 13.0.8** compatibility (strict version mode, see `config/versions.js`), with every finding classified COMPATIBLE / DEPRECATED / REMOVED / UNSUPPORTED / BEHAVIOR_CHANGED / UNKNOWN / MANUAL_REVIEW
- exports separate **ACE 12** and **ACE 13** ZIP packages

There are no scripts, servers, bridges, helper applications, Java runtimes, external libraries or network access.

## 1. Use

1. Open **`index.html`** in Chrome or Edge, by double-clicking it or with File > Open.
2. Click **Open BAR or workspace ZIP…**. A BAR is unpacked into projects; a ZIP whose folders contain `.project` files (an exported Toolkit workspace) is opened in **workspace mode**, using the original projects, `.project`, `.classpath` and `.settings`. The file is read in the browser and is never uploaded.
3. Follow the sections in the sidebar:
   1. Dashboard
   2. BAR Inspector
   3. Source Extraction
   4. **Java Decompiler**
   5. **Project Explorer**
   6. ACE 12 Export
   7. ACE 13 Migration
   8. Pre-Migration Checks
   9. Reports
   10. Settings

The browser must support `DecompressionStream("deflate-raw")`: Chrome/Edge 103+, Firefox 113+ or Safari 16.4+. The Dashboard shows whether it does.

## 2. Java source recovery

For every JAR in the BAR, the Java Decompiler view reports each stage separately. Extracting a JAR never counts as recovering its source.

| Stage | Meaning |
|---|---|
| JAR extracted | the JAR bytes were read from the BAR and CRC-verified |
| JAR inspected | its ZIP directory, manifest and nested JARs were read |
| Classes detected | every `.class` was parsed: version, members, references |
| Java source generated | `.java` files produced: **complete**, **partial** or **failed** per class |
| Source exported | the project ZIP was downloaded |

**The decompiler** (`js/decompiler/`) is a Java bytecode decompiler written for this project in vanilla JavaScript. It is **not Fernflower**: a browser cannot execute Fernflower's JAR, and Fernflower has no JavaScript port. It rebuilds:
- **Statements and declarations:** expressions, local variables (names from debug info when present, inferred otherwise), generics from signatures, string concatenation, array initialisers, `x++`, and `static`/field initialisers.
- **Control flow:** `if`/`else`, `while`/`do`/`for`, labelled `break`/`continue`, `switch` (including string switches) and `&&`/`||`/`?:`.
- **Exceptions and locking:** `try`/`catch` (multi-catch), `finally` and `synchronized`.

**Honest failure.** When a method cannot be decompiled with certainty, its file is marked **partial**. That method gets:
- a comment stating the reason,
- the full bytecode listing,
- a body that throws `UnsupportedOperationException`.

Partial files are never counted as recovered. Known unsupported constructs are:
- lambdas and method references (`invokedynamic`)
- non-static inner and anonymous classes
- pre-Java 6 `jsr`/`ret` subroutines
- unusual `finally` shapes
- obfuscated names that are Java keywords

**Measured quality.**
- **A real application JAR from a production BAR** (not published): 3/3 classes and 10/10 methods complete. The output compiles with javac and behaves identically to the original bytecode on the tested inputs.
- **Test corpus:** compiled with and without debug info, decompiled, recompiled and run. 0 compile errors, identical program output.

**Driver JARs** are detected from content: the `java.sql.Driver` service registration, driver packages, `java.sql.Driver` implementations, manifests, and file names as weak evidence. They are excluded from decompilation by default and kept in `Lib/` as dependencies. Every JAR has Include/Exclude/Reset controls, and the excluded-JAR report lists each skipped JAR, why, and where it is preserved.

**Existing source.** If you have a JAR's original `.java` files (e.g. from source control), import them per JAR. They are matched to classes by package path and labelled *imported*, not decompiled.

## 3. Generated Eclipse Java project

```
FrameworkJPrj/
├── .project            Java nature (+ ACE JavaCompute nature when a class extends MbJavaComputeNode)
├── .classpath          src, bin, JRE from the class-file version, Lib/ dependencies, ACE API (JCN_HOME) when referenced
├── .settings/org.eclipse.jdt.core.prefs   compiler level from the class-file version (17 in the ACE 13 package)
├── src/                decompiled or imported .java files at their package paths
├── bin/                the ORIGINAL .class files from the JAR, byte-identical
├── Lib/                dependency JARs (e.g. jconn2.jar) + the original application JAR (not on the build path)
└── PROJECT-RECOVERY-NOTES.txt   stages, per-class status, and why every generated file exists
```

A `.class` file is never renamed to `.java`, and bytecode never ends up in a source file. The project name can be changed in the Java Decompiler view.

## 4. Project Explorer and ZIP export

The Project Explorer shows the reconstructed workspace the way the IBM ACE Toolkit does. The tree is built from the BAR and the recovered Java projects, never hard-coded:

```
FrameworkLIB
├── Subflows                 *.subflow
├── ESQLs                    *.esql, grouped by their BROKER SCHEMA declaration
├── Java
│   └── FrameworkJPrj        decompiled/imported Java project of a JAR deployed in this library
│       ├── (default package)          classes whose source has no package declaration
│       └── com.example.security       grouped by the actual "package" declaration
├── Included Libraries       project references (double-click / context menu to open)
└── Other Resources
    ├── FrameworkJPrj        Lib/, bin/, .classpath, .project, .settings of the Java project
    └── jconn2.jar ...       the library's own JARs and other files
```

Applications also get Message Flows, Maps, Schema Definitions and Interfaces groups when they have such files. Java projects also appear as top-level projects (`src`, `bin`, `Lib`). BAR metadata is shown separately and is never part of a project.

**Tree controls**
- **Navigate:** expand/collapse (arrow, double-click, Expand/Collapse all) and filter by name or path.
- **Select:** click; Ctrl+click toggles a file and Shift+click selects a range.
- **Context menu:** Open, Download file, Export as ZIP, Copy export path, Expand/Collapse, and Go to library.

**Files**
- **Details:** export path, origin (original / decompiled / generated), location in the BAR, SHA-256, package or schema, and decompilation status.
- **Editing:** Java, ESQL, XML and properties files are edited in the ACE 12 or ACE 13 working copy, with an unsaved-change indicator, Save (Ctrl+S), Discard and Undo. Saved edits go into every export; the BAR is never modified.
- **Read-only:** `.class` files get a bytecode preview and `.jar` files a classification and package list. They are never shown as Java source.

**Exports.** The logical grouping never changes paths: every file is written at its real path.
- **Export Project ZIP:** the complete project of the current selection (e.g. `FrameworkJPrj.zip` with `FrameworkJPrj/src`, `bin`, `Lib`, `.project`, `.classpath`, `.settings`).
- **Export Selected Folder ZIP:** everything below the selected folder, group or package.
- **Export Selected Files ZIP:** the Ctrl/Shift-selected files.

Before downloading, the workbench shows the ZIP name, file count, total uncompressed size and which working copy is used. It then builds the ZIP and **re-reads it**: every entry must be present once, CRC-correct and byte-identical to its source. Only then does it download and report success. Any failure is shown with the real error and nothing is downloaded.

## 5. Packages

- **ACE 12 export:** Toolkit projects with the original files byte-for-byte, generated (and labelled) application/library `.project` files, and the Eclipse Java projects. It also has BAR metadata, `MANIFEST.json` with the provenance and SHA-256 of every file, reports and import instructions.
- **ACE 13 export:** the same, plus Java 17 compliance, reviewed fixes (diff, confirm, undo), `_original-before-changes/`, migration report, checklist and change log. The ACE 12 output is not modified.

## 6. Migration analysis

- **Java 8 → 17:** rules over bytecode (exact references) and source (line numbers). Each finding has a basis:
  - **verified:** behaviour observed on IBM Semeru 17 / IBM Java 8 during development; see [docs/VERIFIED-FACTS.md](docs/VERIFIED-FACTS.md)
  - **documented:** backed by an OpenJDK JEP or Java SE documentation
  - **heuristic:** a risk pattern for human review
- **ACE 12 → 13:** a rule engine over flows, nodes, `broker.xml` overrides, ESQL, policies, data sources, endpoints and JARs.
  - IBM-documented rules cite their URL. They are checked by keyword against IBM pages you save locally and import in Settings; without imports they show as **UNVERIFIED offline**.
  - Rules can be exported and imported as JSON (`rules/sample-custom-rules.json`).
- **What is not done:** **compilation and runtime testing.** A browser-only tool has no Java compiler. Static analysis is labelled as such everywhere and is not proof of compatibility.

## 6b. ACE 12.0.5 → 13.0.8 (strict mode)

Details, rule sources and evidence: [docs/MIGRATION-12.0.5-TO-13.0.8.md](docs/MIGRATION-12.0.5-TO-13.0.8.md).

- **Versions are fixed:** source 12.0.5, target 13.0.8 (`config/versions.js`). Settings shows them read-only, and older saved settings cannot override them.
- **Classification:** every finding from every analyser gets one class, plus location(s), risk, confidence, recommended action, documentation URL(s) and, when a reviewed fix exists, its diff.
- **Dependencies:** project references from the original `.project` files, including missing projects; `.classpath` entries (JRE container, classpath variables such as `JCN_HOME`, missing libraries); product JARs packaged in projects, with their manifest version and missing manifest `Class-Path` JARs; duplicate JARs; whether anything in the input actually uses each JAR.
- **Scans:** build files, scripts, wizard/pattern metadata, templates, extension points and runtime configuration. Scripts are read as data and never run. Categories that are absent are reported as absent.
- **Concurrency and lifecycle (always MANUAL_REVIEW):**
  - Java: mutable static fields, non-thread-safe static objects, mutable fields in JavaCompute nodes, explicit threads and locks, `MbGlobalMap` read-then-write, resources closed outside `finally`
  - ESQL: `SHARED` variables modified outside `BEGIN ATOMIC`, plus the flow's `additionalInstances` setting
- **Reports:** `MIGRATION-REPORT.json` and `MIGRATION-REPORT.md` (human-readable) include **unresolved risks**, **unverified assumptions** and a validation section that lists what was and was not performed.
- **Fixes:** only verified, deterministic fixes are suggested, each with a diff and an **Accept and replace…** button (in the findings table and under "All suggested solutions"). For `BASE64Encoder` you choose between two options: an exact equivalent that keeps the old line breaks (recommended), or the single-line `java.util.Base64` encoder. Accepting one withdraws the other. The original stays untouched, a copy is exported under `_original-before-changes/`, and Undo restores it.

## 6c. Static-to-shared library conversion (optional)

**8. Shared Libraries** converts static libraries into ACE shared libraries for ACE 12 and/or 13, so a framework change is deployed once instead of rebuilding every service. It is off by default; when off, nothing changes. It follows the real ACE semantics, verified with the Toolkit classes, `ibmint` and a runtime: the `sharedLibraryNature`, a `<sharedLibraryReference>` in every consuming descriptor, a separate `.shlibzip`, and the content and reference rules. By default (**separate** strategy) every library **keeps its name** and becomes its own shared library; only what the runtime requires changes: default-schema ESQL/subflows move into a schema named after the library, subflows nested across libraries and application-hooked subflows are copied locally, cross-library calls are schema-qualified, and `LANGUAGE JAVA` routines get `CLASSLOADER "{Library}"` - every rule verified on the ACE runtime. The **merge** strategy combines interdependent libraries into one shared library; the **in-place** strategy changes only `.project` natures and descriptors. It preserves the originals, can be undone, is repeatable, validates the result and writes a conversion report with `ibmint` build commands. Libraries that IBM does not allow to be shared (e.g. ESQL in the default schema) are reported with evidence, never forced. Details and evidence: [docs/LIBRARY-CONVERSION.md](docs/LIBRARY-CONVERSION.md).

## 7. Tests

Open `tests/index.html`, optionally select the real BAR, and press **Run all tests**.
- 61 executable tests, using real `javac` bytecode embedded as fixtures. W01–W07, W09, L01–L12, R01–R06 and S01, S02 and S04 use synthetic workspace ZIPs; W08, L13, R07 and S03 use real ones (optional, like the real BAR).
- 4 **EXTERNAL** tests that need the IBM Toolkit/runtime; they are never reported as passed.
- Recorded run from `file://` (headless Chrome) with a real BAR and a real workspace ZIP: **61 PASS, 4 EXTERNAL**. The result files are not published because they contain names from those private inputs.

## 8. Structure

```
index.html styles.css app.js
js/core/         util, settings (localStorage + IndexedDB)
js/archive/      crc32, zip-reader, zip-writer, classify, bar-engine
js/java/         classfile (full class-file parser), jar-analyzer (inspection + driver detection)
js/decompiler/   bytecode, types, ir, translate, structure, passes, syntax-check, decompiler
js/analysis/     msgflow-parser, esql-parser, java17-analyzer, ace-rule-engine, premigration, migration-scanner
js/project/      eclipse-project, explorer-model, project-builder, transforms, diff, library-conversion
js/report/       reports (JSON + standalone HTML)
js/workflow.js   pipeline shared by UI and tests
js/ui/           views
config/          default-config, versions (fixed 12.0.5 -> 13.0.8 + IBM facts), driver-signatures
rules/ tests/ docs/
```

## 9. Limitations

- **Decompiled ≠ original.** Comments and formatting are lost, local names come from debug info or are generated, and some constructs are re-expressed equivalently (e.g. a `continue outer` folded into a loop condition). Review before use.
- **Unsupported Java constructs** (see section 2) produce *partial* files with the reason and bytecode, never invented code.
- **No compilation in the browser.** Compile and test the exported projects in the IBM ACE Toolkit.
- **Generated metadata.** `.project`/`.classpath` follow standard Eclipse/ACE Toolkit conventions. Import into the ACE 12.0.5 and 13.0.8 Toolkits has **not** been validated by this tool. In workspace mode no metadata is generated.
- **JARs not in the BAR.** Dependency JARs that were never deployed in the BAR (e.g. `ConfigManagerProxy.jar`, `IntegrationAPI.jar` in a developer workspace) cannot be recovered; the ACE API is referenced through `JCN_HOME`.
- **BAR content limits.** BARs can contain binary-only artifacts (`.cmf`, compiled schemas). These are preserved and flagged, not reconstructed.
- **Runtime facts.** The verified facts came from ACE **13.0.2.0**'s Java 17, not 13.0.8. Neither ACE 12.0.5 nor 13.0.8 is installed on the development machine.
- **Concurrency analysis is lexical.** It finds patterns; it does not prove a race or its absence.
- **Browsers.** Tested in Chrome 155 (headless, `file://`) and a Chromium-based browser; Firefox/Safari were not tested.
