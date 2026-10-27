# IBM ACE Migration Workbench

An offline website, written in HTML, CSS and vanilla JavaScript only. Open **`index.html`** in Chrome or Edge (double-click it or File > Open). There are no scripts, servers, bridges, helper applications, Java runtimes, external libraries or network access, and nothing is uploaded or stored in the browser.

It has **five independent pages**. Each page has its own file picker and its own state: a file chosen on one page is never seen by another page, and a choice made on one page never changes another.

| # | Page | Input | Result |
|---|---|---|---|
| 1 | **BAR Export** | a BAR file | Toolkit source projects for ACE 12 (ZIP), with the application JARs decoded (decompiled) to real `.java` source |
| 2 | **ACE 13 Migration** | source code (a Toolkit workspace ZIP or folder; not a BAR, not a JAR) | classified ACE 12.0.5 → 13.0.8 and Java 8 → 17 findings, reviewed fixes, an ACE 13 project ZIP |
| 3 | **Static to Shared Libraries** | source code with its libraries (a workspace ZIP, several ZIPs, or a folder; not a BAR) | static libraries converted to shared libraries, validation, report, project ZIP |
| 4 | **BAR vs Source** | a BAR and the source code (ZIP or folder) | which files differ, are missing or are extra, with a side-by-side view |
| 5 | **Source Explorer** | a BAR or a workspace ZIP | the extraction report and a Toolkit-style explorer with file preview, editing and ZIP export |

The browser must support `DecompressionStream("deflate-raw")`: Chrome/Edge 103+, Firefox 113+ or Safari 16.4+. The log at the bottom shows if it does not.

Each page checks what it was given: the migration and library pages refuse a BAR, BAR Export refuses source code, and no page accepts a JAR.

## 1. BAR Export

Opens a BAR, verifies every entry (CRC-32), and exports it as Toolkit projects for the **ACE 12.0.5 Toolkit**: the original source byte-for-byte, the original descriptors, generated (and labelled) `.project` files, BAR metadata, `MANIFEST.json` with the provenance and SHA-256 of every file, reports and import instructions, and one Eclipse Java project per decoded JAR.

### Java decoding

For every JAR in the BAR, the page reports each stage separately. Extracting a JAR never counts as recovering its source.

| Stage | Meaning |
|---|---|
| JAR extracted | the JAR bytes were read from the BAR and CRC-verified |
| JAR inspected | its ZIP directory, manifest and nested JARs were read |
| Classes detected | every `.class` was parsed: version, members, references |
| Java source generated | `.java` files produced: **complete**, **partial** or **failed** per class |
| Source exported | the project ZIP was downloaded |

**The decompiler** (`js/decompiler/`) is a Java bytecode decompiler written for this project in vanilla JavaScript. It is **not Fernflower**: a browser cannot execute Fernflower's JAR. It rebuilds:
- **Statements and declarations:** expressions, local variables (names from debug info when present, inferred otherwise), generics from signatures, string concatenation, array initialisers, `x++`, and `static`/field initialisers.
- **Control flow:** `if`/`else`, `while`/`do`/`for`, labelled `break`/`continue`, `switch` (including string switches) and `&&`/`||`/`?:`.
- **Exceptions and locking:** `try`/`catch` (multi-catch), `finally` and `synchronized`.

**Honest failure.** When a method cannot be decompiled with certainty, its file is marked **partial**. That method gets a comment stating the reason, the full bytecode listing, and a body that throws `UnsupportedOperationException`. Partial files are never counted as recovered. Known unsupported constructs: lambdas and method references (`invokedynamic`), non-static inner and anonymous classes, pre-Java 6 `jsr`/`ret` subroutines, unusual `finally` shapes, and obfuscated names that are Java keywords.

**Measured quality:** a real application JAR from a production BAR (not published) decompiles 3/3 classes and 10/10 methods completely; the output compiles with javac and behaves identically to the original bytecode on the tested inputs. The method is in [docs/DECOMPILER-VALIDATION.md](docs/DECOMPILER-VALIDATION.md) (not published).

**Driver JARs** are detected from content (the `java.sql.Driver` service registration, driver packages, implementations, manifests; file names are weak evidence). They are excluded from decompilation by default and kept in `Lib/` as dependencies. Every JAR has Include/Exclude/Reset controls (kept on this page only), and the excluded-JAR report can be downloaded.

**Existing source.** If you have a JAR's original `.java` files (for example from source control), import them per JAR. They are matched to classes by package path and labelled *imported*, not decompiled.

### Generated Eclipse Java project

```
FrameworkJPrj/
├── .project            Java nature (+ ACE JavaCompute nature when a class extends MbJavaComputeNode)
├── .classpath          src, bin, JRE from the class-file version, Lib/ dependencies, ACE API (JCN_HOME) when referenced
├── .settings/org.eclipse.jdt.core.prefs   compiler level from the class-file version
├── src/                decompiled or imported .java files at their package paths
├── bin/                the ORIGINAL .class files from the JAR, byte-identical
├── Lib/                dependency JARs (e.g. jconn2.jar) + the original application JAR (not on the build path)
└── PROJECT-RECOVERY-NOTES.txt   stages, per-class status, and why every generated file exists
```

A `.class` file is never renamed to `.java`, and bytecode never ends up in a source file.

## 2. ACE 13 Migration

Takes **source code** and checks it for ACE 12.0.5 → 13.0.8 (strict mode, `config/versions.js`) and Java 8 → 17.

- **Java 8 → 17:** rules over bytecode of the JARs in the projects (exact references) and over Java source (line numbers). Each finding has a basis: **verified** (observed on IBM Semeru 17 / IBM Java 8, see [docs/VERIFIED-FACTS.md](docs/VERIFIED-FACTS.md)), **documented** (OpenJDK JEP or Java SE documentation) or **heuristic**.
- **ACE 12 → 13:** a rule engine over flows, nodes, ESQL, policies, data sources, endpoints and JARs. IBM-documented rules cite their URL; the IBM pages are not available offline, so they show as **UNVERIFIED offline**.
- **Classification:** every finding gets one class (COMPATIBLE, DEPRECATED, REMOVED, UNSUPPORTED, BEHAVIOR_CHANGED, UNKNOWN or MANUAL_REVIEW) with location(s), risk, confidence, recommended action and documentation URL(s). Details, rule sources and evidence: [docs/MIGRATION-12.0.5-TO-13.0.8.md](docs/MIGRATION-12.0.5-TO-13.0.8.md).
- **Dependencies:** project references from the original `.project` files (including missing projects), `.classpath` entries, product JARs packaged in projects with their manifest version, missing manifest `Class-Path` JARs, duplicate JARs.
- **Scans:** build files, scripts, wizard/pattern metadata, templates and runtime configuration. Scripts are read as data and never run.
- **Concurrency and lifecycle (always MANUAL_REVIEW):** mutable static fields, explicit threads and locks, `MbGlobalMap` read-then-write, resources closed outside `finally`; ESQL `SHARED` variables modified outside `BEGIN ATOMIC`.
- **Fixes:** only verified, deterministic fixes are suggested, each with a diff and an **Accept and replace…** button. For `BASE64Encoder` you choose between an exact equivalent that keeps the old line breaks (recommended) and the single-line `java.util.Base64` encoder; accepting one withdraws the other. The original stays untouched, a copy is exported under `_original-before-changes/`, and Undo restores it.
- **Export:** the ACE 13 project ZIP (Java 17 compliance, accepted fixes, `_original-before-changes/`, migration report, change log).
- **What is not done:** compilation and runtime testing. A browser-only tool has no Java compiler; static analysis is labelled as such and is not proof of compatibility.

## 3. Static-to-Shared Library Conversion

Converts static libraries into ACE shared libraries (ACE 12 and/or ACE 13 package), so a framework change is deployed once instead of rebuilding every service. It follows the real ACE semantics, verified with the Toolkit classes, `ibmint` and a runtime: the `sharedLibraryNature`, a `<sharedLibraryReference>` in every consuming descriptor, a separate `.shlibzip`, and the content and reference rules.

- **Input:** the workspace ZIP holding the applications and their libraries. If the libraries are in another ZIP, choose both ZIPs (or a folder): they are combined into one workspace; a file present twice is refused.
- **Strategy:** by default every library **keeps its name** and becomes its own shared library; only what the runtime requires changes (default-schema ESQL/subflows move into a schema named after the library, subflows nested across libraries, application-hooked subflows and subflows that write the message while the application validates (a shared library has no message model for the application, BIP5058E) are copied locally with the subflows they nest, cross-library calls are schema-qualified, `LANGUAGE JAVA` routines get `CLASSLOADER "{Library}"`). The **merge** strategy combines interdependent libraries into one shared library; **in-place** changes only `.project` natures and descriptors.
- It preserves the originals, can be undone, is repeatable, validates the result and writes a conversion report with `ibmint` build commands. Libraries that IBM does not allow to be shared (for example ESQL in the default schema) are reported with evidence, never forced.
- **Evidence:** [docs/LIBRARY-CONVERSION.md](docs/LIBRARY-CONVERSION.md).

## 4. BAR vs Source Comparison

Compares the applications of a BAR with the source code, which is the master. Two inputs: a BAR, and the source as a Toolkit workspace ZIP or a folder picked in the file explorer.

- **Matching:** applications are matched by name (the `.project` name against `<name>.appzip`; a case-only difference is matched and says so). Library, shared-library and Java projects, and the `.libzip` / `.shlibzip` archives, are ignored. Unmatched applications are listed, not compared.
- **Scope:** only ESQL, WSDL, XSD, message flows and subflows are scanned. Java and JAR files are never read or decompiled and are not opened. Extra framework ESQL files inside a BAR application are ignored (same file name as an ESQL file of a source library, a framework library folder, or your own name patterns).
- **Classification:** *missing in BAR* (a source file that is not in the BAR) and *modified WSDL/XSD* are **critical**. Modified ESQL, message flow or subflow is a **difference**. *Extra in BAR* (a BAR file with no source) is a **non-critical warning**. A source flow for which the BAR only has a compiled `.cmf` is *not comparable*. Line endings and trailing blanks are ignored by default (option).
- **Result:** a summary, a table per application, and a file table (application, file, type, source status, BAR status, status, severity, differences) with filters, paging, CSV and JSON export. Every file with differences has a button that opens a side-by-side window: changed lines and the changed characters are highlighted, with previous/next change and a context setting.
- **Speed:** only the central directories are read up front; an application archive is extracted only when a source application of the same name exists; entries with equal size and CRC-32 are identical without being extracted.

## 5. Source Explorer

Extracts the source from a BAR or a Toolkit workspace ZIP and shows it two ways.

- **Extraction report:** how the content maps onto Toolkit projects, which artifacts are real editable source and which are binary only, message flows and their nodes, ESQL files and modules, and unresolved references.
- **Explorer:** the Toolkit-style tree, built from the input and never hard-coded: Message Flows, Subflows, ESQLs (by BROKER SCHEMA), Java (by package declaration), Included Libraries and Other Resources. `.project`/`.classpath`/`.settings` and `bin` are hidden unless ticked, but they are still exported. The grouping is only a view: every file keeps its real path.
  - **Navigate and select:** expand/collapse, filter by name or path, click, Ctrl+click and Shift+click, context menu (Open, Download file, Export as ZIP, Copy export path, Go to library).
  - **Files:** details (origin, location, SHA-256, package or schema, decompilation status), editing of Java, ESQL, XML and properties files in a working copy (Save, Discard, Undo; the input is never modified), and read-only previews for `.class` and `.jar` files.
  - **Exports:** Project ZIP, Selected Folder ZIP, Selected Files ZIP. The ZIP is built and **re-read**: every entry must be present once, CRC-correct and byte-identical to its source before the download starts.

## 6. Tests

Open `tests/index.html`, optionally select the real BAR and source ZIP(s), and press **Run all tests**.
- 77 executable tests, using real `javac` bytecode embedded as fixtures: archive handling, decompilation, migration, library conversion (L, R, S), the comparison (C01–C07) and the page independence (P01–P06). Some use a real BAR or real source ZIPs if you select them; those tests report NOT RUN without them.
- 4 **EXTERNAL** tests that need the IBM Toolkit/runtime; they are never reported as passed.
- Recorded run from `file://` (headless Chrome) with a real BAR and real source ZIPs: **77 PASS, 4 EXTERNAL**. The result files are not published because they contain names from those private inputs.

## 7. Structure

```
index.html styles.css app.js
js/core/         util, settings (defaults only; nothing is stored in the browser)
js/archive/      crc32, zip-reader, zip-writer, classify, bar-engine
js/java/         classfile (full class-file parser), jar-analyzer (inspection + driver detection)
js/decompiler/   bytecode, types, ir, translate, structure, passes, syntax-check, decompiler
js/analysis/     msgflow-parser, esql-parser, java17-analyzer, ace-rule-engine, migration-scanner
js/project/      eclipse-project, explorer-model, project-builder, transforms, diff, library-conversion, library-refactor
js/compare/      bar-source-compare
js/report/       reports (JSON + standalone HTML, included in the exported packages)
js/workflow.js   one controller per page (ACE.workflow.create): own input, own state, own options
js/ui/           ui-core (page frame, input handling), export-card, and one file per page:
                 views-barexport, views-migrate, views-libconv, views-compare, views-explorer
config/          default-config, versions (fixed 12.0.5 -> 13.0.8 + IBM facts), driver-signatures
rules/ tests/ docs/
```

## 8. Limitations

- **Decompiled ≠ original.** Comments and formatting are lost, local names come from debug info or are generated, and some constructs are re-expressed equivalently. Review before use. Unsupported constructs produce *partial* files with the reason and bytecode, never invented code.
- **No compilation in the browser.** Compile and test the exported projects in the IBM ACE Toolkit.
- **Generated metadata.** `.project`/`.classpath` follow standard Eclipse/ACE Toolkit conventions. Import into the ACE 12.0.5 and 13.0.8 Toolkits has **not** been validated by this tool (the library conversion output was imported with the Toolkit 13.0.2.0 build tool). For source-code input no metadata is generated: the original is used.
- **JARs not in the BAR.** Dependency JARs that were never deployed in the BAR cannot be recovered; the ACE API is referenced through `JCN_HOME`.
- **BAR content limits.** BARs can contain binary-only artifacts (`.cmf`, compiled schemas). These are preserved and flagged, not reconstructed.
- **Runtime facts.** The verified facts came from ACE **13.0.2.0**'s Java 17, not 13.0.8. Neither ACE 12.0.5 nor 13.0.8 is installed on the development machine.
- **Concurrency analysis is lexical.** It finds patterns; it does not prove a race or its absence.
