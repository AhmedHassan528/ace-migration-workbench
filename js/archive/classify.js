/* Artifact classification: what kind of file is this, and is it real editable source,
 * binary-only, deployment metadata, or a nested container?
 *
 * category values:
 *   source     - original, human-editable development artifact (preserved byte-for-byte)
 *   config     - configuration (policies, properties) - editable, environment specific
 *   binary     - compiled or binary-only artifact; the editable original is NOT in the BAR
 *   library    - Java archive (inspected separately; may be decompiled if eligible)
 *   archive    - nested deployable container (.appzip/.libzip/.shlibzip/.zip)
 *   metadata   - BAR / deployment metadata (META-INF), not part of a Toolkit project
 *   security   - key/trust material: preserved, never displayed, flagged
 *   unknown    - unrecognised; preserved unchanged */
(function (ACE) {
  'use strict';
  var util = ACE.util;

  var BY_EXT = {
    esql: ['esql', 'ESQL module', 'source'],
    msgflow: ['msgflow', 'Message flow', 'source'],
    subflow: ['subflow', 'Subflow', 'source'],
    msgnode: ['msgnode', 'User-defined node definition', 'source'],
    map: ['map', 'Graphical data map', 'source'],
    msgmap: ['msgmap', 'Message map (legacy)', 'source'],
    xsd: ['xsd', 'XML / DFDL schema', 'source'],
    wsdl: ['wsdl', 'WSDL definition', 'source'],
    xsl: ['xsl', 'XSL stylesheet', 'source'],
    xslt: ['xsl', 'XSL stylesheet', 'source'],
    xml: ['xml', 'XML document', 'source'],
    json: ['json', 'JSON document', 'source'],
    yaml: ['yaml', 'YAML document', 'source'],
    yml: ['yaml', 'YAML document', 'source'],
    properties: ['properties', 'Properties file', 'config'],
    java: ['java', 'Java source', 'source'],
    mset: ['mset', 'Message set definition', 'source'],
    mxsd: ['mxsd', 'Message set schema (MRM)', 'source'],
    descriptor: ['descriptor', 'Application / library descriptor', 'source'],
    policyxml: ['policy', 'Policy document', 'config'],
    dbm: ['dbdef', 'Database definition', 'source'],
    tblxmi: ['dbdef', 'Database table definition', 'source'],
    schxmi: ['dbdef', 'Database schema definition', 'source'],
    project: ['eclipse', 'Eclipse project file', 'source'],
    classpath: ['eclipse', 'Eclipse classpath file', 'source'],
    txt: ['text', 'Text file', 'source'],
    csv: ['text', 'CSV file', 'source'],
    sql: ['sql', 'SQL script', 'source'],
    js: ['js', 'JavaScript', 'source'],
    html: ['text', 'HTML', 'source'],
    class: ['class', 'Java class (compiled bytecode)', 'binary'],
    cmf: ['cmf', 'Compiled message flow (no source)', 'binary'],
    dictionary: ['dictionary', 'Compiled message dictionary', 'binary'],
    xsdzip: ['xsdzip', 'Compiled schema archive', 'binary'],
    lil: ['native', 'Native plug-in library (LIL)', 'binary'],
    dll: ['native', 'Native library', 'binary'],
    so: ['native', 'Native library', 'binary'],
    jar: ['jar', 'Java archive (JAR)', 'library'],
    appzip: ['appzip', 'Application archive', 'archive'],
    libzip: ['libzip', 'Library archive', 'archive'],
    shlibzip: ['shlibzip', 'Shared library archive', 'archive'],
    zip: ['zip', 'ZIP archive', 'archive'],
    bar: ['bar', 'Nested BAR archive', 'archive'],
    jks: ['keystore', 'Java keystore', 'security'],
    jceks: ['keystore', 'JCEKS keystore', 'security'],
    p12: ['keystore', 'PKCS#12 keystore', 'security'],
    pfx: ['keystore', 'PKCS#12 keystore', 'security'],
    kdb: ['keystore', 'CMS key database', 'security'],
    sth: ['keystore', 'Key database stash file', 'security'],
    pem: ['cert', 'PEM certificate/key', 'security'],
    cer: ['cert', 'Certificate', 'security'],
    crt: ['cert', 'Certificate', 'security'],
    key: ['cert', 'Private key', 'security'],
    log: ['log', 'Log file', 'metadata']
  };

  var META_FILES = {
    'meta-inf/manifest.mf': ['bar-manifest', 'BAR manifest'],
    'meta-inf/broker.xml': ['broker-xml', 'Deployment descriptor (broker.xml) with property overrides'],
    'meta-inf/service.log': ['bar-log', 'BAR build service log'],
    'meta-inf/user.log': ['bar-log', 'BAR build user log'],
    'meta-inf/bar-refresh.links': ['bar-links', 'Toolkit BAR refresh links']
  };

  /* Which containers are nested deployables we should recurse into. Java JARs are NOT recursed
   * into the project tree; they are inspected by the JAR analyser instead. */
  ACE.classify = function (path, bytes) {
    var lower = path.toLowerCase();
    var base = lower.split('/').pop();
    var ext = util.ext(lower);
    if (META_FILES[lower]) return { kind: META_FILES[lower][0], label: META_FILES[lower][1], category: 'metadata', ext: ext, textual: true };
    if (/^meta-inf\//.test(lower)) return { kind: 'meta', label: 'Container metadata', category: 'metadata', ext: ext, textual: bytes ? util.looksText(bytes) : true };
    if (base === 'application.descriptor') return { kind: 'app-descriptor', label: 'Application descriptor', category: 'source', ext: ext, textual: true };
    if (base === 'library.descriptor') return { kind: 'lib-descriptor', label: 'Library descriptor', category: 'source', ext: ext, textual: true };
    if (base === 'restapi.descriptor') return { kind: 'rest-descriptor', label: 'REST API descriptor', category: 'source', ext: ext, textual: true };
    if (base === 'policy.descriptor') return { kind: 'policy-descriptor', label: 'Policy project descriptor', category: 'config', ext: ext, textual: true };
    var t = BY_EXT[ext];
    if (t) {
      var textual = ['binary', 'library', 'archive', 'security'].indexOf(t[2]) < 0;
      if (t[2] === 'source' && bytes && !util.looksText(bytes)) {
        return { kind: t[0], label: t[1] + ' (unexpected binary content)', category: 'binary', ext: ext, textual: false, note: 'Extension suggests source but the content is binary' };
      }
      return { kind: t[0], label: t[1], category: t[2], ext: ext, textual: textual };
    }
    if (bytes && util.looksText(bytes)) return { kind: 'text', label: 'Unrecognised text file', category: 'unknown', ext: ext, textual: true };
    return { kind: 'binary', label: 'Unrecognised binary file', category: 'unknown', ext: ext, textual: false };
  };

  ACE.classify.isNestedDeployable = function (path) {
    var e = util.ext(path);
    return e === 'appzip' || e === 'libzip' || e === 'shlibzip' || e === 'bar';
  };

  ACE.classify.CATEGORY_LABELS = {
    source: 'Original source', config: 'Configuration', binary: 'Binary only', library: 'Java archive',
    archive: 'Container', metadata: 'BAR metadata', security: 'Security material', unknown: 'Unrecognised'
  };
})(window.ACE);
