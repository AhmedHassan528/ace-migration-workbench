# Static-to-shared library conversion (ACE 12 and 13)

An optional step of the migration: it turns static libraries into **shared libraries**. A framework change is then deployed once instead of rebuilding and redeploying every service. To use it, open **8. Shared Libraries**, tick *enabled*, choose the target(s), press **Save and analyse**, review, then **Convert…**. When it is disabled, nothing is analysed or changed, and the packages are identical to the workflow without the feature (test L08).

## 1. What a shared library is (verified, not assumed)

Each statement comes from the product itself, from IBM documentation, or from a test on the local **ACE 13.0.2.0** installation (`ibmint` and a real integration server).

| Fact | Source |
|---|---|
| A shared library is a library project whose `.project` has `com.ibm.etools.msgbroker.tooling.sharedLibraryNature` in addition to `libraryNature` and `messageBrokerProjectNature`. | Toolkit 13.0.2.0 `NewLibraryOperation` / `ApplicationLibraryHelper` |
| An application or shared library that uses it lists it in its descriptor: `<references><sharedLibraryReference><libraryName>L</libraryName></sharedLibraryReference></references>` (namespace `http://com.ibm.etools.mft.descriptor.base`). | JAXB classes `descriptor.base.References` / `SharedLibraryReference`; BARs built by `ibmint` |
| `ibmint package` does **not** write that element. Without it, the runtime fails with **BIP2558E "Undefined function"** and the application does not start. With it, the application calls the shared ESQL. | Runtime test (App1 vs App2) |
| A shared library that calls another shared library also needs the reference in its own `library.descriptor` (BIP2558E without it). | Runtime test (X vs Y) |
| An application can call a shared library it reaches through another shared library, as long as each link has its descriptor reference. | Runtime test (Z) |
| Static libraries are packaged **inside** the application (`.libzip`). A shared library is packaged only when named with `--project`, as a separate `<name>.shlibzip`. | `ibmint package` test |
| Shared libraries cannot contain message flows: **BIP1874E**. | `ibmint package` test; IBM docs |
| ESQL in the **default** broker schema of a shared library is accepted by `ibmint package`, but the runtime **rejects** it: **BIP4129E** "cannot be deployed because it is in the default integration node schema". A successful build is not proof of validity. | Runtime test |
| Subflows must be in a non-default schema. XML, XSL and IDL files, MRM message sets, and CORBA, SCA, WebSphere Adapters and XSLTransform nodes are not supported. Shared libraries reference only shared libraries. Static libraries and integration projects cannot reference shared libraries. ESQL schemas must be unique across libraries in the same scope. All subflows of one schema must be in one container. A shared library is deployed with or before its applications. | IBM docs "Shared libraries" for 12.0 and 13.0 (identical rules); Toolkit builder messages |
| An old service with a **static** copy of library `SL` and a new service using the **shared** `SL` run side by side on one server. Services can therefore be converted one by one. | Runtime test (Mixed) |

## 2. What the conversion does

1. **Selection:** all static libraries ("auto"), or the ones you pick.
2. **Dependency closure:** a library referenced by a converted library is converted too, and a static library that references a converted library is converted too. Integration projects that reference a candidate block it.
3. **Checks per library:** message flows, ESQL or subflows in the default schema, unsupported resources and nodes, message-set references, unresolved references, cycles, duplicate names, ESQL schema collisions and subflow schema splits. A dependency-connected group converts **together or not at all**.
4. **Edits:**
   - one line in each converted `.project` (the shared nature)
   - one `<sharedLibraryReference>` per used shared library in each application or shared library descriptor (a missing descriptor is created)
   - **no other file changes** (check V6)
5. **Where the changes go:** into the ACE 12 and/or ACE 13 working copy. The input is never modified, the original is exported under `_original-before-changes/`, and **Undo** restores it. A second run changes nothing (check V7, test L09).
6. **Validation in the tool (V1–V7):**
   - natures
   - reference rules
   - descriptor references both ways
   - well-formed XML
   - supported contents
   - only the expected changes
   - repeatability

   Compilation, BAR build and runtime tests **cannot run in a browser**. The report lists the exact `ibmint` commands to run with the target installation.
7. **Report:** `LIBRARY-CONVERSION-REPORT.json` and `.md`, in the package and in the view. It contains the input, versions, enabled/disabled state, libraries found, converted or skipped (with reasons and evidence), modified files with diffs, warnings, errors, manual actions, build commands and validation results.

Libraries that cannot be converted are **reported, never forced**. The most common blocker in real framework libraries is ESQL or subflows in the default schema. Fixing it means moving them into a named broker schema and updating every consumer: subflow namespaces, `esql://routine/<schema>#Module.Main`, and schema-qualified CALLs. That is a refactoring, not a type change, so the tool lists it as a manual action.

## 3. Evidence that the converted output works

These checks ran on the development machine, outside the tool:
1. A workspace with two services (`SvcA`, `SvcB`) and a static `Framework` library was converted **by the website**. It changed 3 files, and checks V1–V7 passed.
2. The exported package was built with the website's own commands using `ibmint` from ACE 13.0.2.0: `Framework.shlibzip`, `SvcA.appzip` and `SvcB.appzip`, with no framework copy inside the services.
3. The BARs were deployed to a new integration server (shared library first) and called. Both services returned `framework-v1`.
4. **Only** the framework was changed; only `shared-libraries.bar` was rebuilt and redeployed. Both services, not rebuilt, returned `framework-v2`.

On a real 5-project workspace (private) the analysis correctly blocked all three framework libraries: ESQL and subflows in the default schema. It reported the missing library through which the service reaches them, and changed nothing.

## 5. Strategies

| Strategy | What it does | When |
|---|---|---|
| **separate** (default) | Every library **keeps its name** and becomes its own shared library. Only what the runtime rules below require is changed. | Recommended. |
| merge | Merges the dependency-connected libraries into one shared library (section 5.2). | When you want one deployable framework. |
| in-place | Changes only `.project` natures and descriptors (section 2). | Libraries that already follow the shared-library rules. |

### 5.1 Separate strategy (default)

For each converted library `L` (name unchanged; R-numbers refer to the runtime table in 5.2):
1. `.project` gets the shared-library natures; every consumer's descriptor gets a `<sharedLibraryReference>` to `L`.
2. Default-schema ESQL and subflows move into broker schema `L` (folder `L/`), because R9 and the subflow rule forbid the default schema. Subflow `nsURI`, `nsPrefix` and `bundleName` are updated (R10).
3. A subflow of `L` that nests a subflow of another library `M` gets a copy of that subflow at `L/local/M/<name>.subflow` (R8 forbids nesting across shared libraries). `M` itself is unchanged and still shared.
4. In an application, a subflow that receives an application module (hook, R7) is copied to `<App>/local/<Owner>/`. Un-hooked subflows are used from the shared library (R2, R3).
5. Calls to routines of another library become schema-qualified (R5). Schema-level `CONSTANT` and `NAMESPACE` declarations used across libraries are copied next to the user (R6).
6. **Toolkit import:** a local copy in an application also copies the subflows it nests, so no promoted-property link points into a shared library (the Toolkit cannot resolve those: "Property ... promoted from node ... can not be resolved"). Subflows with JavaCompute nodes stay shared, because an application cannot load a shared library's Java classes. A node whose ESQL property is promoted gets the promoted value (its old value is never used and does not resolve in a named schema). Verified with `mqsicreatebar` (Toolkit 13.0.2.0): no problems.
7. `LANGUAGE JAVA` routines whose class is in `L`'s Java projects or JARs get `CLASSLOADER "{L}"`. Without it the routine cannot find the class in a shared library (BIP3202E/BIP2943E observed; IBM docs, CREATE PROCEDURE, example 4).
8. Project references needed at run time are added; a reference cycle between shared libraries blocks the run (RF-CYCLE).

**Build:** `ibmint package --project L1 --project L2 ...` builds each library as a `.shlibzip`. Java projects a shared library references must also be named (`--project <JavaProject>`), otherwise `ibmint` does not compile them; the conversion report's build commands include them. Deploy the shared libraries with or before the applications.

**Evidence:** on a real workspace with one application and four interdependent framework libraries, all four libraries kept their names; validation V1–V12 passed; `ibmint` built four `.shlibzip` files and the application; all four shared libraries loaded on an ACE 13.0.2.0 integration server. The only runtime errors left were also produced by the original static source (a subflow referring to a module name that does not exist in it, and an environment-dependent data source).

### 5.2 Merge strategy: converting real framework libraries

Real framework libraries usually cannot just change type. In the two real workspaces tested:
- ESQL and subflows were in the default schema;
- subflows of one library nest subflows of another;
- libraries pass their own ESQL modules into other libraries' subflows;
- applications pass **their** ESQL modules into framework subflows through promoted properties ("hooks").

Each rule below (used by both the separate and merge strategies) was observed on an ACE 13.0.2.0 integration server before the refactoring was built:

| # | Behaviour | Result |
|---|---|---|
| R1 | Shared subflow using its own modules | works |
| R2 | Application flow using a shared subflow | works |
| R3 | Application subflow nesting a shared subflow | works |
| R4 | Application compute node running a shared module (`esql://routine/<schema>#M.Main`) | works |
| R5 | Application calling a shared routine qualified (`CALL s.P()`, `SET x = s.F(1)`) | works |
| R6 | Application referencing a constant or namespace prefix of another schema (`s.CONST`) | **fails**: BIP2432E |
| R7 | Application module passed into a **shared** subflow through a promoted property, also from a named schema | **fails**: BIP4127E |
| R8 | Subflow of shared library A nesting a subflow of shared library B | **fails**: BIP1360E |
| R9 | Default-schema ESQL in a shared library | **fails**: BIP4129E |
| R10 | Subflow schema taken from the translation `bundleName` (not only the folder) | without it: BIP1369E |

What the merge strategy does:
1. **Merges** the dependency-connected static libraries into **one** shared library (default name `SharedFramework`; set your own). R8 and library-to-library hooks then become same-library references (R1).
2. **Moves** their default-schema ESQL and subflows into **one** named broker schema (default: the library name in lower case). Their mutual unqualified calls and constants keep working. Subflow `nsURI`, `nsPrefix` and `bundleName` are updated (R10).
3. **Keeps local to each application** every subflow that receives an application module (R7), plus the subflows that hook is forwarded to. The local copies are in schema `<schema>.local`; they use the shared modules (R4) and nest the shared subflows (R3). The shared library still contains the whole framework, so its content does not depend on which service is converted.
4. **Rewrites every reference:**
   - subflow namespaces, node types and nested `href`s;
   - `esql://routine` references, including the old bare form, promoted-property defaults and quoted module names such as `"X_Is?"`;
   - schema-qualified calls from applications (R5);
   - `.project` references and descriptors.
5. **Copies into each application** the schema-level `CONSTANT` and `NAMESPACE` declarations it uses (R6), as `<Library>_Constants.esql`.
6. **Blocks the whole run**, changing nothing, when something cannot be done safely:
   - an application uses a library `SHARED` or `EXTERNAL` variable;
   - library code calls application code;
   - a library contains a message flow or unsupported resources;
   - a referenced project is missing, or two libraries collide on names or paths.

**Use the same shared library name and schema for every service.** Each service then references the same deployed shared library, and its local copies and constants follow the same names.

### Evidence on a real workspace

This check ran outside the tool, on one application with four interdependent static libraries in the default schema, 15 hooks and 50+ cross-library subflow uses:
- The website produced 163 file operations: libraries merged, references rewritten, 4 hooked subflows kept local, and a constants file. Checks V1–V11 passed.
- `ibmint` (ACE 13.0.2.0) built the shared library (`.shlibzip`) and the application (no `.libzip` copies inside).
- Deployed to an integration server with the same policies as the original (policies are environment configuration, deployed for both versions only so that both could start), the **original and the converted versions start identically**. The shared library and the application load with no error or warning.

The first runs of this check found three real problems that only the runtime revealed: the schema in `bundleName`, namespace prefixes, and bare promoted-property defaults. Each is now handled by the tool and caught by its validation.

## 4. Limitations

- **Toolchain:** probes, builds and runtime tests used ACE **13.0.2.0**. Neither ACE 12.0.5 nor 13.0.8 was available. IBM's 12.0 and 13.0 shared-library documentation gives the same rules. `ibmint package` is documented for 12.0, but its availability on 12.0.5 specifically was not verified.
- **Usage evidence** (which artifacts call a library) comes from parsed subflow references and ESQL `CALL`s. Function calls inside expressions are not traced.
- **Java:** Java projects referenced by a converted library are loaded by the shared library's own class loader. Applications must not depend on those classes directly. The report asks for a test of every JavaCompute node and `LANGUAGE JAVA` routine.
- **BAR input:** BAR input has no original project metadata, so the analysis runs on the generated `.project` files. For conversion, a Toolkit workspace ZIP is the reliable input. The separate and merge strategies require a workspace ZIP.
- **Startup is not message testing:** "starts identically" means every flow, subflow and ESQL module was loaded and compiled by the runtime. Sending real messages through the services needs their back ends (MQ, databases, SOAP partners) and was not done.
- **Local copies:** hooked subflows (and, in the separate strategy, subflows nested across libraries) are copied, so a change to *those* subflows still needs the services rebuilt. Everything else in the framework is shared.
