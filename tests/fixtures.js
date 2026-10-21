/* Test fixtures, generated in memory. No third-party binaries are redistributed.
 *   Fx.rawZip(entries)   - low-level ZIP builder that can write ANY name, method, flag or a wrong CRC
 *                          (needed for unsafe-path, duplicate, corrupt and unsupported-method tests)
 *   Fx.classFile(spec)   - minimal valid Java class file with chosen references/strings/version
 *   Fx.syntheticBar()    - small ACE-like BAR: application + static library + JARs + flows + ESQL */
(function () {
  'use strict';
  var Fx = window.Fx = {};
  var enc = function (s) { return new TextEncoder().encode(s); };

  function u16(a, v) { a.push(v & 255, (v >>> 8) & 255); }
  function u32(a, v) { a.push(v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255); }

  /* entries: [{name, data (string|Uint8Array), method: 0|8|other, storeAs: Uint8Array (raw payload override),
   *            crc: override, flags, nameBytes}] */
  Fx.rawZip = async function (entries, opts) {
    opts = opts || {};
    var out = [], cd = [], offs = [];
    for (var i = 0; i < entries.length; i++) {
      var e = entries[i];
      var data = typeof e.data === 'string' ? enc(e.data) : (e.data || new Uint8Array(0));
      var method = e.method == null ? 0 : e.method, payload = data;
      if (method === 8 && !e.storeAs) payload = new Uint8Array(await new Response(new Blob([data]).stream().pipeThrough(new CompressionStream('deflate-raw'))).arrayBuffer());
      if (e.storeAs) payload = e.storeAs;
      var name = e.nameBytes || enc(e.name), crc = e.crc != null ? e.crc : ACE.crc32(data), flags = e.flags == null ? 0x0800 : e.flags;
      offs.push(out.length);
      var lh = []; u32(lh, 0x04034b50); u16(lh, 20); u16(lh, flags); u16(lh, method); u16(lh, 0); u16(lh, 0x5421); u32(lh, crc); u32(lh, payload.length); u32(lh, data.length); u16(lh, name.length); u16(lh, 0);
      if (e.badLocalSig) lh[0] = 0x00;
      Array.prototype.push.apply(out, lh); Array.prototype.push.apply(out, Array.from(name)); Array.prototype.push.apply(out, Array.from(payload));
      var ch = []; u32(ch, 0x02014b50); u16(ch, e.madeBy || 20); u16(ch, 20); u16(ch, flags); u16(ch, method); u16(ch, 0); u16(ch, 0x5421); u32(ch, crc); u32(ch, payload.length); u32(ch, data.length); u16(ch, name.length); u16(ch, 0); u16(ch, 0); u16(ch, 0); u16(ch, 0); u32(ch, 0); u32(ch, offs[i]);
      Array.prototype.push.apply(ch, Array.from(name)); cd.push(ch);
    }
    var cdStart = out.length; cd.forEach(function (c) { Array.prototype.push.apply(out, c); });
    var eo = []; u32(eo, 0x06054b50); u16(eo, 0); u16(eo, 0); u16(eo, entries.length); u16(eo, entries.length); u32(eo, out.length - cdStart); u32(eo, cdStart); u16(eo, 0);
    Array.prototype.push.apply(out, eo);
    return new Uint8Array(out);
  };

  /* Minimal class file. spec: {name, superName, interfaces[], classRefs[], strings[], methodRefs[{owner,name,desc}], methods[{name,desc}], major} */
  Fx.classFile = function (spec) {
    var cp = [null], idx = {};
    function utf(s) { var k = 'u:' + s; if (idx[k]) return idx[k]; cp.push({ t: 1, s: s }); return (idx[k] = cp.length - 1); }
    function cls(n) { var k = 'c:' + n; if (idx[k]) return idx[k]; var u = utf(n); cp.push({ t: 7, n: u }); return (idx[k] = cp.length - 1); }
    function str(s) { var u = utf(s); cp.push({ t: 8, n: u }); return cp.length - 1; }
    function nat(n, d) { var a = utf(n), b = utf(d); cp.push({ t: 12, a: a, b: b }); return cp.length - 1; }
    function mref(o, n, d) { var c = cls(o), t = nat(n, d); cp.push({ t: 10, a: c, b: t }); return cp.length - 1; }
    var thisI = cls(spec.name), superI = cls(spec.superName || 'java/lang/Object');
    var ifc = (spec.interfaces || []).map(cls);
    (spec.classRefs || []).forEach(cls); (spec.strings || []).forEach(str);
    (spec.methodRefs || []).forEach(function (m) { mref(m.owner, m.name, m.desc); });
    var meths = (spec.methods || []).map(function (m) { return { n: utf(m.name), d: utf(m.desc) }; });
    var b = [];
    function w2(v) { b.push((v >> 8) & 255, v & 255); }
    function w4(v) { b.push((v >>> 24) & 255, (v >>> 16) & 255, (v >>> 8) & 255, v & 255); }
    w4(0xCAFEBABE); w2(0); w2(spec.major || 52); w2(cp.length);
    for (var i = 1; i < cp.length; i++) {
      var e = cp[i]; b.push(e.t);
      if (e.t === 1) { var bytes = enc(e.s); w2(bytes.length); Array.prototype.push.apply(b, Array.from(bytes)); }
      else if (e.t === 7 || e.t === 8) w2(e.n);
      else { w2(e.a); w2(e.b); }
    }
    // ACC_ABSTRACT when the class declares (body-less) methods, so the class file stays valid
    w2(meths.length ? 0x0421 : 0x0021); w2(thisI); w2(superI); w2(ifc.length); ifc.forEach(w2);
    w2(0); // fields
    w2(meths.length); meths.forEach(function (m) { w2(0x0001 | 0x0400); w2(m.n); w2(m.d); w2(0); }); // abstract-flagged: no Code attribute needed
    w2(0); // attributes
    return new Uint8Array(b);
  };

  Fx.jar = async function (files) { var w = new ACE.zip.Writer(); Object.keys(files).forEach(function (k) { w.add(k, files[k]); }); return new Uint8Array(await (await w.build()).arrayBuffer()); };

  Fx.FLOW = '<?xml version="1.0" encoding="UTF-8"?>\n<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ComIbmSOAPInput.msgnode="ComIbmSOAPInput.msgnode" xmlns:ComIbmCompute.msgnode="ComIbmCompute.msgnode" xmlns:ComIbmJavaCompute.msgnode="ComIbmJavaCompute.msgnode" xmlns:ComIbmWSRequest.msgnode="ComIbmWSRequest.msgnode" xmlns:Common.subflow="Common.subflow" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:eflow="http://www.ibm.com/wbi/2005/eflow" xmlns:utility="http://www.ibm.com/wbi/2005/eflow_utility" nsURI="Main.msgflow" nsPrefix="Main.msgflow">\n<eClassifiers xmi:type="eflow:FCMComposite" name="FCMComposite_1"><composition>\n' +
    '<nodes xmi:type="ComIbmSOAPInput.msgnode:FCMComposite_1" xmi:id="N1" location="1,1" wsdlFileName="S.wsdl" targetNamespace="http://example.org/ns" urlSelector="/svc" wsSecurityPolicyUrl="{Pol}:WSS"><translation xmi:type="utility:ConstantString" string="In"/></nodes>\n' +
    '<nodes xmi:type="ComIbmCompute.msgnode:FCMComposite_1" xmi:id="N2" location="2,2" computeExpression="esql://routine/#Main_Compute.Main" dataSource="TESTDSN"><translation xmi:type="utility:ConstantString" string="Compute"/></nodes>\n' +
    '<nodes xmi:type="ComIbmCompute.msgnode:FCMComposite_1" xmi:id="N3" location="3,3" computeExpression="esql://routine/#Missing_Module.Main"><translation xmi:type="utility:ConstantString" string="Orphan"/></nodes>\n' +
    '<nodes xmi:type="ComIbmJavaCompute.msgnode:FCMComposite_1" xmi:id="N4" location="4,4" javaClass="com.example.Legacy"><translation xmi:type="utility:ConstantString" string="JCN"/></nodes>\n' +
    '<nodes xmi:type="ComIbmWSRequest.msgnode:FCMComposite_1" xmi:id="N5" location="5,5" URLSpecifier="http://backend.example:8080/x" sslProtocol="SSL_TLSv2"><translation xmi:type="utility:ConstantString" string="HTTP Request"/></nodes>\n' +
    '<nodes xmi:type="Common.subflow:FCMComposite_1" xmi:id="N6" location="6,6"><translation xmi:type="utility:ConstantString" string="Common"/></nodes>\n' +
    '<connections xmi:type="eflow:FCMConnection" xmi:id="C1" targetNode="N2" sourceNode="N1" sourceTerminalName="OutTerminal.out" targetTerminalName="InTerminal.in"/>\n' +
    '<connections xmi:type="eflow:FCMConnection" xmi:id="C2" targetNode="N3" sourceNode="N2" sourceTerminalName="OutTerminal.out" targetTerminalName="InTerminal.in"/>\n' +
    '</composition></eClassifiers></ecore:EPackage>\n';
  Fx.SUBFLOW = '<?xml version="1.0" encoding="UTF-8"?>\n<ecore:EPackage xmi:version="2.0" xmlns:xmi="http://www.omg.org/XMI" xmlns:ComIbmTrace.msgnode="ComIbmTrace.msgnode" xmlns:ecore="http://www.eclipse.org/emf/2002/Ecore" xmlns:eflow="http://www.ibm.com/wbi/2005/eflow" xmlns:utility="http://www.ibm.com/wbi/2005/eflow_utility" nsURI="Common.subflow" nsPrefix="Common.subflow"><eClassifiers xmi:type="eflow:FCMComposite" name="FCMComposite_1"><composition><nodes xmi:type="ComIbmTrace.msgnode:FCMComposite_1" xmi:id="T1" location="1,1" filePath="C:\\logs\\trace.txt"><translation xmi:type="utility:ConstantString" string="Trace"/></nodes></composition></eClassifiers></ecore:EPackage>\n';
  Fx.ESQL = "-- comment mentioning PASSTHRU( should be ignored\nCREATE COMPUTE MODULE Main_Compute\n  CREATE FUNCTION Main() RETURNS BOOLEAN\n  BEGIN\n    SET OutputRoot = InputRoot;\n    SET Environment.X[] = PASSTHRU('SELECT 1 FROM T WHERE A = ?', 'it''s');\n    SET Environment.Y = EVAL('1+1');\n    CALL Hash(InputRoot.BLOB.BLOB);\n    RETURN TRUE;\n  END;\n  CREATE PROCEDURE Hash(IN b BLOB) RETURNS CHARACTER LANGUAGE JAVA EXTERNAL NAME \"com.example.Legacy.hash\";\nEND MODULE;\n";
  Fx.ESQL_1252 = (function () { var s = "-- Caf\u00e9 r\u00e9sum\u00e9 in windows-1252\nCREATE COMPUTE MODULE Latin1_Compute\nEND MODULE;\n"; var b = new Uint8Array(s.length); for (var i = 0; i < s.length; i++) b[i] = s.charCodeAt(i) & 255; return b; })();
  Fx.LEGACY_JAVA = 'package com.example;\n\nimport com.ibm.misc.BASE64Encoder;\nimport java.security.NoSuchProviderException;\nimport javax.crypto.Cipher;\nimport javax.crypto.NoSuchPaddingException;\nimport java.security.NoSuchAlgorithmException;\n\npublic class Legacy {\n   public static String enc(byte[] b) throws Exception {\n      Cipher c = null;\n      try {\n         c = Cipher.getInstance("AES/ECB/PKCS5Padding", "IBMJCE");\n      } catch (NoSuchProviderException | NoSuchPaddingException | NoSuchAlgorithmException e) {\n         throw e;\n      }\n      BASE64Encoder encoder = new BASE64Encoder();\n      return encoder.encode(b);\n   }\n}\n';

  Fx.legacyClass = function () {
    return Fx.classFile({ name: 'com/example/Legacy', classRefs: ['com/ibm/misc/BASE64Encoder', 'javax/xml/bind/DatatypeConverter', 'sun/misc/BASE64Decoder', 'javax/crypto/Cipher'], strings: ['IBMJCE', 'SSL_TLS', 'AES/ECB/PKCS5Padding'], methodRefs: [{ owner: 'javax/crypto/Cipher', name: 'getInstance', desc: '(Ljava/lang/String;Ljava/lang/String;)Ljavax/crypto/Cipher;' }, { owner: 'java/lang/Integer', name: '<init>', desc: '(I)V' }], methods: [{ name: 'enc', desc: '([B)Ljava/lang/String;' }], major: 52 });
  };

  /* A small but realistic BAR: app (Main.msgflow, ESQL, WSDL, descriptor, broker.xml, cmf, app jar, driver jar) + static library. */
  Fx.syntheticBar = async function (extraAppEntries) {
    var appJar = await Fx.jar({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nCreated-By: 1.8.0 (IBM Corporation)\r\n\r\n', 'com/example/Legacy.class': Fx.legacyClass() });
    var drvJar = await Fx.jar({ 'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Title: PostgreSQL JDBC Driver\r\n\r\n', 'META-INF/services/java.sql.Driver': 'org.postgresql.Driver\n', 'org/postgresql/Driver.class': Fx.classFile({ name: 'org/postgresql/Driver', interfaces: ['java/sql/Driver'], major: 52 }) });
    var lib = await Fx.rawZip([
      { name: 'META-INF/manifest.mf', data: 'srcSelected=false;' },
      { name: 'library.descriptor', data: '<?xml version="1.0"?><ns2:libDescriptor xmlns:ns2="http://com.ibm.etools.mft.descriptor.lib"><references/></ns2:libDescriptor>' },
      { name: 'Common.subflow', data: Fx.SUBFLOW, method: 8 },
      { name: 'util\\Helpers.esql', data: 'BROKER SCHEMA util\nCREATE COMPUTE MODULE Helpers_Compute\nEND MODULE;\n', method: 8 }
    ]);
    var broker = '<?xml version="1.0" encoding="UTF-8"?><Broker><CompiledMessageFlow name="Main"><ConfigurableProperty uri="Main#HTTP Request.URLSpecifier" override="https://prod.example/x"/><ConfigurableProperty uri="Main#In.securityProfileName" override="{Pol}:Profile"/></CompiledMessageFlow></Broker>';
    var appEntries = [
      { name: 'META-INF/manifest.mf', data: 'srcSelected=false;' },
      { name: 'META-INF/broker.xml', data: broker },
      { name: 'application.descriptor', data: '<?xml version="1.0"?><ns2:appDescriptor xmlns:ns2="http://com.ibm.etools.mft.descriptor.app"><references/></ns2:appDescriptor>' },
      { name: 'Main.msgflow', data: Fx.FLOW, method: 8 },
      { name: 'Main.esql', data: Fx.ESQL, method: 8 },
      { name: 'Latin1.esql', data: Fx.ESQL_1252 },
      { name: 'S.wsdl', data: '<definitions xmlns="http://schemas.xmlsoap.org/wsdl/"/>' },
      { name: 'Old.cmf', data: new Uint8Array([1, 2, 3, 4, 0, 0, 7]) },
      { name: 'legacy.jar', data: appJar },
      { name: 'postgresql-42.jar', data: drvJar },
      { name: 'CommonLIB.libzip', data: lib }
    ].concat(extraAppEntries || []);
    var app = await Fx.rawZip(appEntries);
    return Fx.rawZip([{ name: 'META-INF/manifest.mf', data: 'srcSelected=false;showSrc=true;' }, { name: 'Demo.appzip', data: app }]);
  };

  /* Toolkit workspace ZIP (wrapped in one top folder, like an exported workspace):
   *   AppA (application) -> LibB, MissingLib (not in the ZIP)
   *   LibB (library)     -> JavaP;  ESQL with SHARED variables (one written inside ATOMIC, one not)
   *   JavaP (Java)       -> .classpath with src, JRE container, JCN_HOME variable; Lib/ product JAR
   *   tools/deploy.sh    -> loose script (read as data only) */
  Fx.dotProject = function (name, refs, natures) {
    return '<?xml version="1.0" encoding="UTF-8"?>\n<projectDescription>\n\t<name>' + name + '</name>\n\t<comment></comment>\n\t<projects>\n' + refs.map(function (r) { return '\t\t<project>' + r + '</project>\n'; }).join('') + '\t</projects>\n\t<buildSpec>\n\t</buildSpec>\n\t<natures>\n' + natures.map(function (n) { return '\t\t<nature>' + n + '</nature>\n'; }).join('') + '\t</natures>\n</projectDescription>\n';
  };
  Fx.WS_JAVA = 'package p;\n\nimport java.io.FileInputStream;\nimport com.ibm.broker.plugin.MbGlobalMap;\nimport com.ibm.misc.BASE64Encoder;\n\npublic class Util {\n   public static String CHARSET = "utf-8";\n   private static final java.util.HashMap<String, String> CACHE = new java.util.HashMap<String, String>();\n   public static final int MAX = 3;\n\n   public static String enc(byte[] b) {\n      BASE64Encoder encoder = new BASE64Encoder();\n      return encoder.encode(b);\n   }\n\n   public static int leak(String f) throws Exception {\n      FileInputStream fis = new FileInputStream(f);\n      int c = fis.read();\n      fis.close();\n      return c;\n   }\n\n   public static int safe(String f) throws Exception {\n      try (FileInputStream in = new FileInputStream(f)) {\n         return in.read();\n      }\n   }\n\n   public static Object cached() throws Exception {\n      MbGlobalMap m = MbGlobalMap.getGlobalMap("M");\n      Object v = m.get("k");\n      if (v == null) { v = "x"; m.put("k", v); }\n      return v;\n   }\n}\n';
  Fx.WS_NODE = 'package p;\n\nimport com.ibm.broker.javacompute.MbJavaComputeNode;\nimport com.ibm.broker.plugin.MbMessageAssembly;\n\npublic class Node extends MbJavaComputeNode {\n   private int count;\n   private final String name = "n";\n\n   public void evaluate(MbMessageAssembly a) {\n      count++;\n   }\n}\n';
  Fx.WS_ESQL = 'DECLARE CacheA SHARED ROW;\nDECLARE CacheB SHARED ROW;\n\nCREATE COMPUTE MODULE Lib_Compute\n\tCREATE FUNCTION Main() RETURNS BOOLEAN\n\tBEGIN\n\t\tIF CacheA.T IS NULL THEN\n\t\t\tSET CacheA.T = CURRENT_TIMESTAMP;\n\t\tEND IF;\n\t\tL1: BEGIN ATOMIC\n\t\t\tSET CacheB.T = CURRENT_TIMESTAMP;\n\t\tEND L1;\n\t\t-- SET CacheB.X = 1;  (commented out: must not count)\n\t\tRETURN TRUE;\n\tEND;\nEND MODULE;\n';
  Fx.syntheticWorkspace = async function () {
    var MB = 'com.ibm.etools.msgbroker.tooling.messageBrokerProjectNature';
    var prodJar = await Fx.jar({
      'META-INF/MANIFEST.MF': 'Manifest-Version: 1.0\r\nImplementation-Title: IBM App Connect Enterprise\r\nImplementation-Version: 12.0.5.0\r\nClass-Path: jackson-core-2.13.3.jar snakeyaml-1.30.jar\r\n\r\n',
      'com/ibm/broker/config/proxy/BrokerProxy.class': Fx.classFile({ name: 'com/ibm/broker/config/proxy/BrokerProxy', major: 50 }),
      'com/ibm/broker/config/proxy/ConfigurableService.class': Fx.classFile({ name: 'com/ibm/broker/config/proxy/ConfigurableService', major: 50 }),
      // a class directly in com.ibm.broker: must not make "import com.ibm.broker.plugin.X" count as a use of this JAR
      'com/ibm/broker/Root.class': Fx.classFile({ name: 'com/ibm/broker/Root', major: 50 })
    });
    var cp = '<?xml version="1.0" encoding="UTF-8"?>\n<classpath>\n\t<classpathentry kind="src" path="src"/>\n\t<classpathentry kind="con" path="org.eclipse.jdt.launching.JRE_CONTAINER"/>\n\t<classpathentry kind="var" path="JCN_HOME/javacompute.jar"/>\n\t<classpathentry kind="output" path="bin"/>\n</classpath>\n';
    var R = 'ws/';
    return Fx.rawZip([
      { name: R + 'AppA/.project', data: Fx.dotProject('AppA', ['LibB', 'MissingLib'], ['com.ibm.etools.msgbroker.tooling.applicationNature', MB]) },
      { name: R + 'AppA/application.descriptor', data: '<?xml version="1.0"?><ns2:appDescriptor xmlns:ns2="http://com.ibm.etools.mft.descriptor.app"><references/></ns2:appDescriptor>' },
      { name: R + 'AppA/Main.esql', data: 'CREATE COMPUTE MODULE Main_Compute\nEND MODULE;\n', method: 8 },
      { name: R + 'LibB/.project', data: Fx.dotProject('LibB', ['JavaP'], ['com.ibm.etools.msgbroker.tooling.libraryNature', MB]) },
      { name: R + 'LibB/library.descriptor', data: '<?xml version="1.0"?><ns2:libDescriptor xmlns:ns2="http://com.ibm.etools.mft.descriptor.lib"><references/></ns2:libDescriptor>' },
      { name: R + 'LibB/Cache.esql', data: Fx.WS_ESQL, method: 8 },
      { name: R + 'JavaP/.project', data: Fx.dotProject('JavaP', [], ['org.eclipse.jdt.core.javanature', 'com.ibm.etools.mft.jcn.jcnnature']) },
      { name: R + 'JavaP/.classpath', data: cp },
      { name: R + 'JavaP/.settings/org.eclipse.jdt.ui.prefs', data: 'eclipse.preferences.version=1\n' },
      { name: R + 'JavaP/src/p/Util.java', data: Fx.WS_JAVA, method: 8 },
      { name: R + 'JavaP/src/p/Node.java', data: Fx.WS_NODE, method: 8 },
      { name: R + 'JavaP/Lib/IntegrationAPI.jar', data: prodJar },
      { name: R + 'tools/deploy.sh', data: '#!/bin/sh\nexport TMPDIR=/tmp/ace\n. /opt/IBM/ACE/12.0.5.0/server/bin/mqsiprofile\nmqsideploy -e default -a app.bar\nJAVA_OPTS="-Djavax.net.debug=true"\n' }
    ]);
  };
})();
