# Verified facts (runtime probes)

Rules with status **verified** reference this file. Each fact below was observed by running a small Java
program on this machine on **2026-10-20**. The probe sources are kept as evidence in [`docs/evidence/java-probes/`](evidence/java-probes/). They are not part of the website and never run from it.

**Runtimes used**

| Role | Runtime | Location |
|---|---|---|
| Java 8 (ACE 12-like) | IBM Java 1.8.0_421 (8.0.8.30, SR8 FP30) | `C:\Program Files\IBM\ACE\13.0.2.0\common\jdk` |
| Java 17 (ACE 13) | IBM Semeru Runtime Certified Edition 17.0.13 (OpenJ9 0.48.0) | `C:\Program Files\IBM\ACE\13.0.2.0\common\java17` |

> **Caveat.** The installed ACE is **13.0.2.0**, but the migration target is **13.0.8**. A later fix pack ships a newer
> Semeru 17 build. Re-run the probes on 13.0.8 before relying on these results.

<a id="probe-1"></a>
## Probe 1: IBM/Sun internal Base64 classes (`Probe.java`)

| Class | IBM Java 8 | Semeru 17 |
|---|---|---|
| `com.ibm.misc.BASE64Encoder` | present | **`ClassNotFoundException`** |
| `sun.misc.BASE64Encoder` | present | **`ClassNotFoundException`** |

Confirmed by compilation as well. `javac --release 17` against ACE 13.0.2 `jplugin2.jar`/`javacompute.jar` fails on the
decompiled sample `SecurityUtil.java` (from a private BAR) with `error: package com.ibm.misc does not exist`.

**Replacement check (`B64.java`).** The helper inserted by the `base64-legacy-encoder` fix was compared with
`com.ibm.misc.BASE64Encoder.encode(byte[])` on IBM Java 8 for random inputs of every length 0..1200:
**1201 compared, 0 mismatches.** The original encoder emits `System.lineSeparator()` after every full 57-byte input
block, so the output is platform dependent (CRLF on Windows). The helper reproduces this exactly.

<a id="probe-2"></a>
## Probe 2: security providers and SSLContext protocol names (`Probe.java`)

| Item | IBM Java 8 | Semeru 17 |
|---|---|---|
| Provider `IBMJCE` | present | **absent** |
| Provider `IBMJCEPlus` | present | **absent** |
| Provider `IBMJSSE2` | present | **absent** |
| Provider `SunJCE` / `SunJSSE` | absent | present |
| `Cipher.getInstance("TripleDES/ECB/PKCS5Padding", "IBMJCE")` | OK | **`NoSuchProviderException: No such provider: IBMJCE`** |
| `Cipher.getInstance("TripleDES/ECB/PKCS5Padding")` | OK (IBMJCEPlus) | OK (SunJCE) |
| `SSLContext.getInstance("SSL_TLS")` | OK | **`NoSuchAlgorithmException`** |
| `SSLContext.getInstance("SSL_TLSv2")` | OK | **`NoSuchAlgorithmException`** |
| `SSLContext "TLS"` default protocols | TLSv1.2, TLSv1.3 | TLSv1.3, TLSv1.2 |
| `jdk.tls.disabledAlgorithms` includes TLSv1, TLSv1.1 | yes | yes |

<a id="probe-3"></a>
## Probe 3: JCEKS keystore interoperability (`B64.java mkks` / `load`)

A JCEKS keystore that holds a DESede **secret key** was written by IBM Java 8 (IBMJCE). On Semeru 17:

* `KeyStore.getInstance("JCEKS").load(...)` throws **`java.io.IOException: Invalid secret key format`**
* `keytool -list -storetype JCEKS` from Java 17 fails the same way.

Consequence: JCEKS keystores holding secret keys created on IBM Java 8 must be re-created for Java 17.
Keystores that hold only certificates were **not** tested.

<a id="probe-4"></a>
## Probe 4: 3DES ciphertext equality (`C3.java`)

Same raw 24-byte key, same plaintext, `TripleDES/ECB/PKCS5Padding`:

* IBM Java 8 (IBMJCEPlus): `YaukfVUqK1CuTOSs52R4HPkFKoMZ3rt/jHLoI+JUd98=`
* Semeru 17 (SunJCE): `YaukfVUqK1CuTOSs52R4HPkFKoMZ3rt/jHLoI+JUd98=`

The ciphertexts are identical. So removing the explicit `"IBMJCE"` provider argument (fix `drop-ibm-provider`)
does not change encryption results for this algorithm.

## Re-checking on ACE 13.0.8

The probes are three small Java programs (`Probe.java`, `B64.java`, `C3.java`). To re-check these facts on the exact target runtime, compile and run them with the IBM Java 8 and Java 17 runtimes shipped with ACE 13.0.8, in whatever way your organisation normally runs Java programs. The website itself does not run them.
