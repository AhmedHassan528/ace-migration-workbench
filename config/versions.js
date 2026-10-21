/* Mandatory version configuration (strict mode).
 *
 *   Source: IBM App Connect Enterprise 12.0.5   Target: IBM App Connect Enterprise 13.0.8
 *
 * These values are fixed. Settings cannot change them, and saved settings from older versions of
 * the workbench are overridden on load. Every fact below was read on the cited IBM page on
 * 2026-10-21 ("read" = the page text was fetched and the statement located). Facts that could NOT be
 * confirmed for the exact fix pack are listed under `unverified` and are reported as such. */
window.ACE_VERSIONS = Object.freeze({
  mode: 'strict',
  source: '12.0.5',
  target: '13.0.8',
  sourceLabel: 'IBM App Connect Enterprise 12.0.5',
  targetLabel: 'IBM App Connect Enterprise 13.0.8',
  /* A version string (e.g. a JAR manifest Implementation-Version) belongs to the source or target
   * level when it starts with these prefixes. */
  sourcePrefix: '12.0.5.',
  targetPrefix: '13.0.8.',
  facts: Object.freeze([
    { id: 'V-SRC-JAVA', text: 'ACE 12.0.5.0 (released 17 June 2022) embeds Java SE Runtime Environment 8.0.7.5 + IJ37785. Java 11 is not listed among its embedded components.',
      url: 'https://www.ibm.com/support/pages/node/6586502', title: 'IBM App Connect Enterprise 12.0.5.0 download page' },
    { id: 'V-SRC-DEFAULT-JRE', text: 'ACE 12.0: "By default, integration servers use Java 8"; the JRE is selected per server with "ibmint specify jre".',
      url: 'https://www.ibm.com/docs/en/SSTTDS_12.0/com.ibm.etools.mft.doc/ac04551_.html', title: 'ACE 12.0 - Limitations for JRE versions' },
    { id: 'V-TGT-JAVA', text: 'ACE 13.0.8.0 (Fix Central 27 June 2026) embeds Java SE Runtime Environment 17.0.19.0 and 8.0.8.65.',
      url: 'https://www.ibm.com/support/pages/node/7277542', title: 'IBM App Connect Enterprise 13.0.8.0 download page' },
    { id: 'V-TGT-DEFAULT-JRE', text: 'ACE 13.0: "By default, integration servers use Java 17"; Java 8 is also supplied and can be selected per server with "ibmint specify jre".',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac04551_.html', title: 'ACE 13.0 - Limitations for JRE versions' },
    { id: 'V-TGT-JCN', text: 'ACE 13.0: the JavaCompute node is enabled on Java 17 in 13.0.1 and later; IBM says to test each node instance before production use.',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac04551_.html', title: 'ACE 13.0 - Limitations for JRE versions' },
    { id: 'V-TGT-J17-OFF', text: 'ACE 13.0: CORBARequest node, WebSphere Service Registry and Repository, WebSphere eXtreme Scale (WXS) and TFIM are not enabled on Java 17 in 13.0.1 and later.',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac04551_.html', title: 'ACE 13.0 - Limitations for JRE versions' },
    { id: 'V-TGT-TMPDIR', text: 'ACE 13.0: with Java 17 the TMPDIR environment variable is not observed by the JVM; set java.io.tmpdir instead (_JAVA_OPTIONS or jvmSystemProperty).',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac04551_.html', title: 'ACE 13.0 - Limitations for JRE versions' },
    { id: 'V-TGT-JSSE', text: 'ACE 13.0: -Djavax.net.debug=true is supported with Java 8 but not with Java 17; use -Djavax.net.debug=all.',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac04551_.html', title: 'ACE 13.0 - Limitations for JRE versions' },
    { id: 'V-TGT-CMP', text: 'ACE 13.0 IBM Integration API: the com.ibm.broker.config.proxy package is deprecated; the com.ibm.integration.admin.proxy classes (IntegrationAPI.jar) are used instead. Applications written before Version 11 can continue to use the deprecated classes.',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/be43410_.html', title: 'ACE 13.0 - IBM Integration API' },
    { id: 'V-TGT-WXS', text: 'ACE 13.0: the embedded WebSphere eXtreme Scale grid is deprecated; IBM documents migration to the embedded global cache or an external Redis global cache.',
      url: 'https://www.ibm.com/docs/en/app-connect/13.0?topic=whats-new-in-version-130', title: 'ACE 13.0 documentation contents (WXS topics marked deprecated)' },
    { id: 'V-TGT-J17-LIMITS', text: 'ACE 13.0 Java 17: CORBARequest and WSRR nodes are not available; LTPA tokens are not supported; WS-Security policies cannot select a specific certificate/key alias and use a single key or certificate.',
      url: 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/ac38110_.html', title: 'ACE 13.0 - Known limitations in Java 17' },
    { id: 'V-TGT-RELNOTES', text: 'ACE 13.0 release notes: #43330 (XPath partial SOAP encryption fails on Java 17) and #43490 (UsernameToken without password not propagated on Java 17) list a Java 8 integration server as the workaround; #42762 is fixed in 13.0.8.0.',
      url: 'https://www.ibm.com/support/pages/ibm-app-connect-enterprise-130-release-notes', title: 'IBM App Connect Enterprise 13.0 release notes' }
  ]),
  unverified: Object.freeze([
    'The ACE 12.0 JRE-limitations topic describes the latest 12.0 fix pack, not 12.0.5 specifically; the 12.0.5 statement relies on the 12.0.5.0 download page only.',
    'No IBM page was found that lists Java-API (jplugin2 / javacompute) signature changes between 12.0.5 and 13.0.8. API compatibility is checked only when ACE 13.0.8 API JARs are imported in Settings.',
    'No 13.0.8-specific "What\'s new" list was retrieved; behaviour changes introduced between 13.0.1 and 13.0.8 other than those cited are not covered.',
    'Runtime probes (docs/VERIFIED-FACTS.md) ran on ACE 13.0.2.0 Java 17, not on 13.0.8.'
  ])
});
