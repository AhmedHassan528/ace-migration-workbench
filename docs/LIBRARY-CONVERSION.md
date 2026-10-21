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

## 4. Limitations

- **Toolchain:** probes, builds and runtime tests used ACE **13.0.2.0**. Neither ACE 12.0.5 nor 13.0.8 was available. IBM's 12.0 and 13.0 shared-library documentation gives the same rules. `ibmint package` is documented for 12.0, but its availability on 12.0.5 specifically was not verified.
- **Usage evidence** (which artifacts call a library) comes from parsed subflow references and ESQL `CALL`s. Function calls inside expressions are not traced.
- **Java:** Java projects referenced by a converted library are loaded by the shared library's own class loader. Applications must not depend on those classes directly. The report asks for a test of every JavaCompute node and `LANGUAGE JAVA` routine.
- **BAR input:** BAR input has no original project metadata, so the analysis runs on the generated `.project` files. For conversion, a Toolkit workspace ZIP is the reliable input.
