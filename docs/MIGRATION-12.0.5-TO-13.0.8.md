# ACE 12.0.5 → 13.0.8 migration (strict mode)

## 1. What was extended (nothing was replaced)

| Component | Change |
|---|---|
| `config/versions.js` (new) | Fixed source 12.0.5 / target 13.0.8, the IBM facts used by the rules (with URLs), and the list of unverified assumptions. `settings.load` always applies these values. |
| `js/archive/bar-engine.js` | **Workspace mode**: a ZIP with project folders (`.project`) becomes one project per folder. The project type comes from its natures. `.project` and `.classpath` are parsed. Nested `.project` files are reported. |
| `js/project/project-builder.js` | Workspace layout keeps paths relative to each project. Declared `.project` references are used, and missing projects are flagged. No metadata is generated. Instructions use the strict versions. |
| `js/project/explorer-model.js` | Original Java projects (source folders from `.classpath`) appear under the library that references them, as in the Toolkit. |
| `js/analysis/java17-analyzer.js` | Original `.java` sources are re-analysed in the ACE 13 working copy, so applied fixes show as resolved. |
| `js/analysis/ace-rule-engine.js` | `LANGUAGE JAVA` routines also resolve to original `.java` sources, not only to JARs. |
| `js/analysis/migration-scanner.js` (new) | Dependency, runtime, artifact and concurrency/lifecycle scans, plus a unified classified finding list. |
| `js/report/reports.js`, `js/workflow.js` | `MIGRATION-REPORT.json` gains classification, dependencies, artifacts, concurrency, unresolved risks, unverified assumptions and validation. New `MIGRATION-REPORT.md`. |
| `js/ui/*` | Migration assessment in "7. ACE 13 Migration" (counts, filter, diffs, dependencies, assumptions); read-only versions in Settings; Markdown report in Reports. |
| `rules/*` | Version strings set to 12.0.5. CORBA, Java 17 default and global cache rules now cite the IBM "Limitations for JRE versions" topic. |

## 2. IBM sources (read on 2026-10-21)

Each statement is quoted or paraphrased in `config/versions.js` and in the finding that uses it.

- **ACE 12.0.5.0 download page:** <https://www.ibm.com/support/pages/node/6586502>. Java SE 8.0.7.5 + IJ37785; no Java 11 listed.
- **ACE 12.0 Limitations for JRE versions:** <https://www.ibm.com/docs/en/SSTTDS_12.0/com.ibm.etools.mft.doc/ac04551_.html>. Java 8 is the default.
- **ACE 13.0.8.0 download page:** <https://www.ibm.com/support/pages/node/7277542>. Java 17.0.19.0 and 8.0.8.65.
- **ACE 13.0 Limitations for JRE versions:** <https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac04551_.html>. It covers:
  - Java 17 is the default
  - JavaCompute is enabled on 17
  - CORBARequest, WSRR, WXS and TFIM are not enabled on 17
  - TMPDIR is not observed
  - `javax.net.debug=true` is not supported
- **ACE 13.0 Known limitations in Java 17:** <https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac38110_.html>
- **ACE 13.0 Java 8 vs Java 17 comparison:** <https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac38109_.html>. G1GC is the default.
- **ACE 13.0 IBM Integration API:** <https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/be43410_.html>. `com.ibm.broker.config.proxy` is deprecated.
- **ACE 13.0 release notes:** <https://www.ibm.com/support/pages/ibm-app-connect-enterprise-130-release-notes>

**Not found, so reported as unverified:**
- a 12.0.5-specific JRE-limitations page
- a list of Java plug-in API changes between 12.0.5 and 13.0.8
- a 13.0.8-specific "What's new" list

## 3. Classification

| Class | Meaning in this tool |
|---|---|
| COMPATIBLE | Documented or verified to work unchanged (e.g. Java 8 bytecode loads on Java 17; ACE 12.0 is a supported starting level) |
| DEPRECATED | Still present but deprecated by IBM/Oracle (e.g. `com.ibm.broker.config.proxy`) |
| REMOVED | Absent in the target (e.g. `com.ibm.misc.BASE64Encoder`, the `IBMJCE` provider on Semeru 17, verified by probe) |
| UNSUPPORTED | Exists but is not supported or enabled on the target runtime (e.g. CORBARequest on Java 17, `SSL_TLS`, `javax.net.debug=true`) |
| BEHAVIOR_CHANGED | Works but behaves differently (default JRE 8 → 17, JCEKS secret keys, TMPDIR) |
| UNKNOWN | Cannot be decided from the input (unresolved references, EVAL, compiler level not recorded) |
| MANUAL_REVIEW | Needs a human decision; all concurrency and lifecycle items, and every heuristic |

## 4. Evidence

The tool was validated on a real 5-project Toolkit workspace ZIP (private, not published): workspace mode, all findings classified, both fixes accepted, and the fixed Java sources compiled with `javac --release 17` from ACE 13.0.2.0 against `jplugin2.jar`/`javacompute.jar` (the unfixed original fails with `package com.ibm.misc does not exist`). This check ran outside the tool; the tool never claims it.

## 5. Limitations

- No ACE 12.0.5 or 13.0.8 installation was available. Probes and compilation used ACE 13.0.2.0.
- Concurrency and lifecycle detection is lexical. It analyses the first top-level class per file, and matches ESQL `BEGIN`/`END` heuristically.
- Classpath-variable and node-instance-field findings depend on assumptions that IBM documentation does not confirm; they are listed as such.
- Toolkit import, ESQL compilation, BAR build and runtime tests on 13.0.8 are **not performed** (tests X01–X04 stay EXTERNAL).
