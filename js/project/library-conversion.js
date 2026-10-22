/* Static-to-shared library conversion (optional; Settings > Library conversion).
 *
 * What a shared library IS in ACE 12/13 (verified, see docs/LIBRARY-CONVERSION.md):
 *   - a library project whose .project has the nature com.ibm.etools.msgbroker.tooling.sharedLibraryNature
 *     in addition to libraryNature and messageBrokerProjectNature (ACE 13.0.2 Toolkit NewLibraryOperation);
 *   - every application or shared library that uses it lists it in its descriptor:
 *       <references><sharedLibraryReference><libraryName>L</libraryName></sharedLibraryReference></references>
 *     ibmint does NOT add this element; without it the runtime fails (BIP2558E "Undefined function").
 *   - it is packaged as L.shlibzip, NOT inside the application (ibmint needs --project L).
 * Rules enforced (IBM docs "Shared libraries" 12.0/13.0, Toolkit builder messages, runtime/ibmint probes):
 *   no message flows (BIP1874E), ESQL and subflows only in a non-default broker schema (BIP4129E),
 *   no XML/XSL/IDL files, message sets, CORBA/SCA/Adapter/XSLTransform nodes; shared -> shared only;
 *   static libraries and integration projects cannot reference shared libraries; ESQL schemas unique
 *   across shared libraries; subflows of one schema in one container.
 *
 * The conversion only edits .project natures and descriptors; every other file stays byte-identical.
 * It works on the ACE 12 and/or ACE 13 working copy (overlay): the input is never modified, the
 * original is exported under _original-before-changes/, and Undo restores it. It is idempotent. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var LC = ACE.libconv = {};

  var NAT = {
    lib: 'com.ibm.etools.msgbroker.tooling.libraryNature',
    shared: 'com.ibm.etools.msgbroker.tooling.sharedLibraryNature',
    mb: 'com.ibm.etools.msgbroker.tooling.messageBrokerProjectNature',
    mset: 'com.ibm.etools.msg.validation.msetnature'
  };
  var BASE_NS = 'http://com.ibm.etools.mft.descriptor.base';
  LC.KIND = 'library-conversion';
  LC.DEFAULTS = { enabled: false, targets: ['ace13'], strategy: 'separate', sharedLibraryName: '', schema: '', libraries: 'auto', knownSharedLibraries: [], validateAfterConversion: true };

  /* Evidence behind each rule. basis: verified (probe on ACE 13.0.2.0), documented (IBM docs), toolkit (Toolkit builder rule text). */
  var DOC12 = 'https://www.ibm.com/docs/en/SSTTDS_12.0/com.ibm.etools.mft.doc/bc23067_.html', DOC13 = 'https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/bc23067_.html';
  LC.RULES = {
    'LC-MSGFLOW': { basis: 'verified', text: 'Shared libraries cannot contain message flows.', evidence: 'ibmint package (ACE 13.0.2.0): BIP1874E "Shared libraries cannot contain message flows"; IBM docs list message flows as unsupported.', docs: [DOC12, DOC13] },
    'LC-ESQL-DEFAULT-SCHEMA': { basis: 'verified', text: 'ESQL in a shared library must be in a non-default broker schema.', evidence: 'ACE 13.0.2.0 runtime: BIP4129E "The ESQL file ... in shared library ... cannot be deployed because it is in the default integration node schema" (ibmint package accepted the file - packaging success is not proof).', docs: [DOC12, DOC13] },
    'LC-SUBFLOW-DEFAULT-SCHEMA': { basis: 'documented', text: 'Subflows in a shared library must be in a non-default broker schema (a folder).', evidence: 'IBM docs "Shared libraries" (12.0 and 13.0).', docs: [DOC12, DOC13] },
    'LC-UNSUPPORTED-RESOURCE': { basis: 'documented', text: 'Resource type not supported in a shared library (XML, XSL, IDL files, MRM message sets).', evidence: 'IBM docs "Shared libraries"; Toolkit: "This type of resource is not supported in a shared library."', docs: [DOC12, DOC13] },
    'LC-UNSUPPORTED-NODE': { basis: 'documented', text: 'Node type not supported in a shared library (CORBARequest, SCA, WebSphere Adapters, XSLTransform).', evidence: 'IBM docs "Shared libraries".', docs: [DOC12, DOC13] },
    'LC-MSET-REF': { basis: 'toolkit', text: 'A shared library cannot reference a message set project.', evidence: 'Toolkit 13.0.2.0 builder: "Message Set project ... can not be referenced by a shared library."', docs: [DOC12, DOC13] },
    'LC-INTEGRATION-PROJECT-REF': { basis: 'documented', text: 'Integration projects cannot reference shared libraries.', evidence: 'IBM docs; Toolkit: "A message broker project can not reference a shared library."', docs: [DOC12, DOC13] },
    'LC-UNRESOLVED-REF': { basis: 'observed', text: 'The library references a project that is not in the input, so it cannot be checked or converted consistently.', evidence: 'Project reference in .project.', docs: [] },
    'LC-CYCLE': { basis: 'documented', text: 'Library references form a cycle (if A references B, B cannot reference A).', evidence: 'IBM docs "Shared libraries".', docs: [DOC12, DOC13] },
    'LC-DUPLICATE-NAME': { basis: 'observed', text: 'Two projects in the input have the same name.', evidence: 'Project names.', docs: [] },
    'LC-ESQL-SCHEMA-COLLISION': { basis: 'documented', text: 'Two shared libraries contain ESQL in the same broker schema.', evidence: 'IBM docs: "no two libraries in the same scope can have ESQL files in the same schema"; Toolkit: ESQL files in shared library must be in unique broker schema.', docs: [DOC12, DOC13] },
    'LC-SUBFLOW-SCHEMA-SPLIT': { basis: 'documented', text: 'Subflows of one broker schema would be split across containers (application/library and a shared library).', evidence: 'IBM docs: all subflows for a broker schema must be in a single container.', docs: [DOC12, DOC13] },
    'LC-DEPENDENT-BLOCKED': { basis: 'derived', text: 'Must be converted together with a library that cannot be converted.', evidence: 'Shared libraries can reference only shared libraries; static libraries cannot reference shared libraries.', docs: [DOC12, DOC13] },
    'LC-NO-LIBRARY-NATURE': { basis: 'observed', text: 'The .project has no libraryNature line to extend.', evidence: '.project natures.', docs: [] }
  };
  var BAD_NODES = /^ComIbm(CORBARequest|SCA\w*|XslMqsi|(SAP|Siebel|PeopleSoft|JDEdwards|JDE)(Input|Request)\w*)$/;

  /* ---------- reading the current state of a working copy ---------- */
  function lay(ws) { return ACE.project.layout(ws); }
  function overlayOf(ws, copy) { return (ws[copy] && ws[copy].overlay) || {}; }
  function fileById(ws) { var m = {}; ws.files.forEach(function (f) { m[f.id] = f; }); return m; }

  /* Snapshot of every project in a copy: kind, refs, descriptor refs, files (current text). */
  LC.state = function (ws, copy) {
    var L = lay(ws), ov = overlayOf(ws, copy), byId = fileById(ws), refsInferred = ACE.project.references(ws, ws.facts), seen = {}, dup = [];
    // projects that exist only in the working copy (created by a refactoring conversion)
    var layoutNames = {}; L.projects.forEach(function (p) { layoutNames[p.name] = true; });
    var created = {};
    Object.keys(ov).forEach(function (path) {
      var o = ov[path], top = path.split('/')[0];
      if (o.deleted || !o.history.length || !o.history[0].created) return;
      (created[top] = created[top] || []).push({ rel: path.slice(top.length + 1), outPath: path, file: null, text: (function (x) { return function () { return x.text; }; })(o), changed: true, bytes: o.bytes || null });
    });
    var extra = Object.keys(created).filter(function (n) { return !layoutNames[n] && created[n].some(function (f) { return f.rel === '.project'; }); }).sort().map(function (n) { return { name: n, type: 'workspace-created', created: true }; });
    var projects = L.projects.concat(extra).map(function (p) {
      if (seen[p.name]) dup.push(p.name); seen[p.name] = true;
      var files = L.files.filter(function (l) { return l.project === p.name; }).map(function (l) {
        var f = byId[l.fileId], o = ov[l.outPath];
        return { rel: l.relPath, outPath: l.outPath, file: f, text: function () { return o ? o.text : (f && f.bytes ? ACE.bar.text(f) : null); }, changed: !!o, deleted: !!(o && o.deleted) };
      }).filter(function (x) { return !x.deleted; }).concat((created[p.name] || []).filter(function (c) { return !L.files.some(function (l) { return l.outPath === c.outPath; }); }));
      var dotFile = files.filter(function (x) { return x.rel === '.project'; })[0], dotPath = p.name + '/.project', dotText, generated = false;
      if (dotFile) dotText = dotFile.text();
      else if (ov[dotPath] && !ov[dotPath].deleted) dotText = ov[dotPath].text;
      else if (ws.inputKind !== 'workspace' && !p.created) { var g = ACE.project.generatedProjectFile(ws, p, refsInferred); if (g && g.text) { dotText = g.text; generated = true; } }
      if (!dotText && ws.inputKind === 'workspace') return null; // project removed in this working copy
      var dp = dotText ? ACE.bar.parseDotProject(dotText) : null;
      var kind = dp && dp.natures.length ? kindFromNatures(dp.natures) : kindFromLayout(p.type);
      var descName = kind === 'application' ? 'application.descriptor' : /library/.test(kind) ? 'library.descriptor' : null;
      var descFile = descName ? files.filter(function (x) { return x.rel === descName; })[0] : null;
      var descPath = descName ? p.name + '/' + descName : null;
      var descText = descFile ? descFile.text() : (descPath && ov[descPath] && !ov[descPath].deleted ? ov[descPath].text : null);
      return { name: p.name, layoutType: p.type, kind: kind, files: files, dot: { path: dotPath, text: dotText, generated: generated, parsed: dp }, desc: { path: descPath, name: descName, text: descText, exists: !!descText, refs: descText ? descriptorRefs(descText) : [] },
        refs: dp ? dp.projects.slice() : (refsInferred[p.name] || []).map(function (r) { return r.project; }), natures: dp ? dp.natures : [] };
    }).filter(Boolean);
    var byName = {}; projects.forEach(function (p) { byName[p.name] = p; });
    return { copy: copy, projects: projects, byName: byName, duplicates: util.uniq(dup) };
  };
  function kindFromNatures(n) {
    var s = ' ' + n.join(' ') + ' ';
    if (s.indexOf(' ' + NAT.shared + ' ') >= 0) return 'shared-library';
    if (s.indexOf(' ' + NAT.lib + ' ') >= 0) return 'static-library';
    if (/applicationNature|restApiNature|integrationServiceNature|serviceApplicationNature/.test(s)) return 'application';
    if (/javanature/.test(s)) return 'java';
    if (s.indexOf(' ' + NAT.mset + ' ') >= 0) return 'message-set';
    if (/policy/i.test(s)) return 'policy';
    if (s.indexOf(' ' + NAT.mb + ' ') >= 0) return 'integration-project';
    return 'other';
  }
  function kindFromLayout(t) { return t === 'application' ? 'application' : t === 'shared-library' ? 'shared-library' : /library/.test(t) ? 'static-library' : t || 'other'; }

  /* sharedLibraryReference names in a descriptor (namespace-aware). */
  function descriptorRefs(text) {
    try {
      var d = new DOMParser().parseFromString(text, 'application/xml');
      if (d.getElementsByTagName('parsererror').length) return [];
      return Array.prototype.map.call(d.getElementsByTagNameNS(BASE_NS, 'sharedLibraryReference'), function (e) {
        var n = e.getElementsByTagNameNS(BASE_NS, 'libraryName')[0]; return n ? n.textContent.trim() : '';
      }).filter(Boolean);
    } catch (e) { return []; }
  }
  LC.descriptorRefs = descriptorRefs;

  /* ---------- text edits (minimal, verified by re-parsing) ---------- */
  LC.addSharedNature = function (text) {
    if (text.indexOf('<nature>' + NAT.shared + '</nature>') >= 0) return { text: text, changed: false };
    var re = new RegExp('^([ \\t]*)<nature>' + NAT.lib.replace(/\./g, '\\.') + '</nature>[ \\t]*(\\r?\\n)', 'm'), m = re.exec(text);
    if (!m) return { error: 'no <nature>' + NAT.lib + '</nature> line found' };
    var ins = m[1] + '<nature>' + NAT.shared + '</nature>' + m[2];
    var out = text.slice(0, m.index + m[0].length) + ins + text.slice(m.index + m[0].length);
    var dp = ACE.bar.parseDotProject(out);
    if (dp.parseError || dp.natures.indexOf(NAT.shared) < 0) return { error: '.project is not valid XML after the edit' };
    return { text: out, changed: true };
  };
  LC.addDescriptorRef = function (text, lib) {
    if (descriptorRefs(text).indexOf(lib) >= 0) return { text: text, changed: false };
    var d;
    try { d = new DOMParser().parseFromString(text, 'application/xml'); } catch (e) { return { error: 'descriptor is not XML' }; }
    if (d.getElementsByTagName('parsererror').length) return { error: 'descriptor is not well-formed XML' };
    var refsEl = d.getElementsByTagNameNS(BASE_NS, 'references')[0], prefix = refsEl ? (refsEl.prefix ? refsEl.prefix + ':' : '') : null;
    if (prefix === null) {
      // no <references> element: use the default namespace prefix the root declares for the base namespace
      var root = d.documentElement, pfx = null;
      if (root.lookupNamespaceURI(null) === BASE_NS) pfx = '';
      else { var p2 = root.lookupPrefix(BASE_NS); if (p2) pfx = p2 + ':'; }
      if (pfx === null) return { error: 'descriptor does not declare the namespace ' + BASE_NS };
      prefix = pfx;
    }
    var item = '<' + prefix + 'sharedLibraryReference><' + prefix + 'libraryName>' + util.esc(lib) + '</' + prefix + 'libraryName></' + prefix + 'sharedLibraryReference>', out;
    var selfClose = new RegExp('<' + prefix.replace(/[.:]/g, '\\$&') + 'references\\s*/>'), close = '</' + prefix + 'references>';
    if (refsEl && selfClose.test(text)) out = text.replace(selfClose, '<' + prefix + 'references>' + item + close);
    else if (refsEl && text.indexOf(close) >= 0) { var i = text.lastIndexOf(close); out = text.slice(0, i) + item + text.slice(i); }
    else if (!refsEl) { var rm = /<([\w.-]+:)?(appDescriptor|libDescriptor)\b[^>]*>/.exec(text); if (!rm) return { error: 'descriptor root element not found' }; var at = rm.index + rm[0].length; out = text.slice(0, at) + '<' + prefix + 'references>' + item + close + text.slice(at); }
    else return { error: 'could not locate the references element' };
    if (descriptorRefs(out).indexOf(lib) < 0) return { error: 'descriptor did not parse with the new reference' };
    return { text: out, changed: true };
  };
  LC.newDescriptor = function (kind) {
    return kind === 'application'
      ? '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:appDescriptor xmlns="http://com.ibm.etools.mft.descriptor.base" xmlns:ns2="http://com.ibm.etools.mft.descriptor.app"><references/></ns2:appDescriptor>'
      : '<?xml version="1.0" encoding="UTF-8" standalone="yes"?><ns2:libDescriptor xmlns="http://com.ibm.etools.mft.descriptor.base" xmlns:ns2="http://com.ibm.etools.mft.descriptor.lib"><references/></ns2:libDescriptor>';
  };

  /* ---------- content checks for a library that would become shared ---------- */
  function contentBlockers(ws, P) {
    var out = [];
    function add(code, detail, ev) { out.push({ code: code, detail: detail, evidence: ev || [] }); }
    var flows = P.files.filter(function (f) { return /\.msgflow$/i.test(f.rel); });
    if (flows.length) add('LC-MSGFLOW', flows.length + ' message flow(s)', flows.map(function (f) { return { file: f.outPath }; }));
    var defEsql = [], schemas = {};
    P.files.filter(function (f) { return /\.esql$/i.test(f.rel); }).forEach(function (f) {
      var t = f.text(); if (t == null) return;
      var e = ACE.esql.parse(t, f.outPath);
      if (!e.schema) defEsql.push({ file: f.outPath, line: 1 });
      else (schemas[e.schema] = schemas[e.schema] || []).push(f.outPath);
    });
    if (defEsql.length) add('LC-ESQL-DEFAULT-SCHEMA', defEsql.length + ' ESQL file(s) without BROKER SCHEMA', defEsql);
    var defSub = P.files.filter(function (f) { return /\.subflow$/i.test(f.rel) && f.rel.indexOf('/') < 0; });
    if (defSub.length) add('LC-SUBFLOW-DEFAULT-SCHEMA', defSub.length + ' subflow(s) in the project root (default schema)', defSub.map(function (f) { return { file: f.outPath }; }));
    var bad = P.files.filter(function (f) { return /\.(xml|xsl|xslt|idl|mset|mxsd)$/i.test(f.rel) && !/^META-INF\//i.test(f.rel); });
    if (bad.length) add('LC-UNSUPPORTED-RESOURCE', bad.map(function (f) { return f.rel; }).join(', '), bad.map(function (f) { return { file: f.outPath }; }));
    var nodes = ((ws.facts && ws.facts.nodes) || []).filter(function (n) { return n.project === P.name && n.kind === 'builtin' && BAD_NODES.test(n.type); });
    if (nodes.length) add('LC-UNSUPPORTED-NODE', util.uniq(nodes.map(function (n) { return n.typeLabel; })).join(', '), nodes.map(function (n) { return { file: n.flowVPath, line: n.line, text: n.label }; }));
    return { blockers: out, esqlSchemas: schemas, subflowSchemas: util.uniq(P.files.filter(function (f) { return /\.subflow$/i.test(f.rel) && f.rel.indexOf('/') >= 0; }).map(function (f) { return f.rel.split('/').slice(0, -1).join('.'); })) };
  }

  /* Which artifacts of other projects use resources of library L (evidence for the report). */
  function usages(ws, L, all) {
    var out = [];
    ((ws.facts && ws.facts.flows) || []).forEach(function (fl) {
      if (fl.project === L.name) return;
      fl.subflowRefs.forEach(function (s) { (s.resolvedTo || []).forEach(function (r) { if (r.split('/')[0] === L.name) out.push({ project: fl.project, kind: 'subflow', ref: s.path, file: fl.vpath, line: s.line }); }); });
    });
    var defined = {};
    ((ws.facts && ws.facts.esql) || []).filter(function (e) { return e.project === L.name; }).forEach(function (e) { e.routines.forEach(function (r) { defined[(e.schema ? e.schema + '.' : '') + r.name] = true; if (!e.schema) defined[r.name] = true; }); });
    ((ws.facts && ws.facts.esql) || []).forEach(function (e) {
      if (e.project === L.name) return;
      e.calls.forEach(function (c) { if (defined[c.name]) out.push({ project: e.project, kind: 'esql-call', ref: c.name, file: e.vpath, line: c.line }); });
    });
    return out;
  }

  LC.emptyResult = function (copy) { return { copy: copy, target: copy === 'ws12' ? 'ace12' : 'ace13', strategy: 'in-place', libraries: [], projects: [], edits: [], warnings: [], errors: [], manualActions: [], notes: [], blockedCount: 0, converted: [] }; };

  /* Edits touching the same path (e.g. delete + create when a project keeps its name) become one edit. */
  LC.consolidate = function (edits) {
    var by = {}, order = [];
    edits.forEach(function (e) {
      var cur = by[e.path];
      if (!cur) { by[e.path] = e; order.push(e.path); return; }
      // a delete and a create of the same path (any order) is a modification of that file
      var del = cur.deleted ? cur : e.deleted ? e : null, cre = cur.created ? cur : e.created ? e : null;
      if (del && cre) { by[e.path] = { path: e.path, project: cre.project, before: del.before, after: cre.after, bytesFrom: cre.bytesFrom, created: false, deleted: false, notes: cre.notes }; return; }
      by[e.path] = { path: e.path, project: e.project, before: cur.before, after: e.after, bytesFrom: e.bytesFrom, created: cur.created, deleted: !!e.deleted, notes: cur.notes.concat(e.notes) };
    });
    return order.map(function (p) { return by[p]; }).filter(function (e) {
      if (e.deleted || e.created) return true;
      if (e.bytesFrom) return false; // binary file rewritten with itself
      return e.after !== e.before;
    }).map(function (e) { if (!e.diff && e.after != null && !e.bytesFrom) e.diff = ACE.diff.unified(e.before || '', e.after, 'a/' + e.path, 'b/' + e.path); else if (!e.diff) e.diff = e.deleted ? '(file removed: moved into the shared library)' : '(binary file)'; return e; });
  };

  /* ---------- analysis / plan ---------- */
  LC.analyze = function (ws, cfg, copy) {
    cfg = Object.assign({}, LC.DEFAULTS, cfg || {});
    copy = copy || 'ws13';
    if (cfg.strategy === 'refactor' || cfg.strategy === 'separate') { var rr = cfg.strategy === 'separate' ? ACE.libref.analyzeSeparate(ws, cfg, copy) : ACE.libref.analyze(ws, cfg, copy); rr.edits = LC.consolidate(rr.edits); return rr; }
    var st = LC.state(ws, copy), known = {};
    (cfg.knownSharedLibraries || []).forEach(function (n) { if (n) known[n] = true; });
    var res = LC.emptyResult(copy);
    var P = st.byName;
    function kindOfName(n) { return P[n] ? P[n].kind : known[n] ? 'shared-library (known, not in input)' : 'missing'; }
    var referencedBy = {};
    st.projects.forEach(function (p) { p.refs.forEach(function (r) { (referencedBy[r] = referencedBy[r] || []).push(p.name); }); });
    res.projects = st.projects.map(function (p) { return { name: p.name, kind: p.kind, references: p.refs.map(function (r) { return { project: r, kind: kindOfName(r) }; }), descriptorSharedRefs: p.desc.refs, referencedBy: referencedBy[p.name] || [], metadata: p.dot.generated ? 'generated (BAR input)' : p.dot.text ? 'original' : 'none' }; });
    st.duplicates.forEach(function (n) { res.errors.push('Two projects are named "' + n + '" (LC-DUPLICATE-NAME); conversion of "' + n + '" is not attempted.'); });

    // 1. selection
    var statics = st.projects.filter(function (p) { return p.kind === 'static-library'; }).map(function (p) { return p.name; });
    var selected = cfg.libraries === 'auto' || !cfg.libraries ? statics.slice() : (cfg.libraries || []).filter(function (n) { return statics.indexOf(n) >= 0; });
    (cfg.libraries !== 'auto' ? cfg.libraries || [] : []).forEach(function (n) {
      if (statics.indexOf(n) < 0) res.warnings.push('Selected library "' + n + '" is ' + (P[n] ? 'a ' + P[n].kind + ', not a static library' : 'not in the input') + '; ignored.');
    });
    var S = {}, why = {};
    selected.forEach(function (n) { S[n] = true; why[n] = ['selected']; });
    // 2. dependency closure: shared -> shared only (down); static -> static only (up)
    var changed = true;
    while (changed) {
      changed = false;
      Object.keys(S).forEach(function (n) {
        P[n].refs.forEach(function (r) { if (P[r] && P[r].kind === 'static-library' && !S[r]) { S[r] = true; why[r] = ['referenced by ' + n + ' (a shared library can only reference shared libraries)']; changed = true; } });
        (referencedBy[n] || []).forEach(function (u) { if (P[u] && P[u].kind === 'static-library' && !S[u]) { S[u] = true; why[u] = ['references ' + n + ' (a static library cannot reference a shared library)']; changed = true; } });
      });
    }
    // 3. per-library checks
    var info = {};
    Object.keys(S).sort().forEach(function (n) {
      var p = P[n], c = contentBlockers(ws, p), bl = c.blockers.slice();
      if (st.duplicates.indexOf(n) >= 0) bl.push({ code: 'LC-DUPLICATE-NAME', detail: n, evidence: [] });
      p.refs.forEach(function (r) {
        if (!P[r] && !known[r]) bl.push({ code: 'LC-UNRESOLVED-REF', detail: n + ' references "' + r + '"', evidence: [{ file: p.dot.path }] });
        else if (P[r] && P[r].kind === 'message-set') bl.push({ code: 'LC-MSET-REF', detail: r, evidence: [{ file: p.dot.path }] });
      });
      (referencedBy[n] || []).forEach(function (u) { if (P[u] && P[u].kind === 'integration-project') bl.push({ code: 'LC-INTEGRATION-PROJECT-REF', detail: u + ' references ' + n, evidence: [{ file: P[u].dot.path }] }); });
      if (!p.dot.text || !/<nature>com\.ibm\.etools\.msgbroker\.tooling\.libraryNature<\/nature>/.test(p.dot.text)) bl.push({ code: 'LC-NO-LIBRARY-NATURE', detail: p.dot.path, evidence: [] });
      info[n] = { blockers: bl, esqlSchemas: c.esqlSchemas, subflowSchemas: c.subflowSchemas };
    });
    // cycles among libraries in S
    var visiting = {}, done = {};
    function dfs(n, stack) {
      if (done[n]) return; if (visiting[n]) { var cyc = stack.slice(stack.indexOf(n)).concat([n]); cyc.forEach(function (x) { if (info[x]) info[x].blockers.push({ code: 'LC-CYCLE', detail: cyc.join(' -> '), evidence: [] }); }); return; }
      visiting[n] = true; stack.push(n);
      P[n].refs.forEach(function (r) { if (S[r]) dfs(r, stack); });
      stack.pop(); visiting[n] = false; done[n] = true;
    }
    Object.keys(S).forEach(function (n) { dfs(n, []); });
    // ESQL schema uniqueness and subflow schema split, against everything that will be shared
    var sharedSet = {}; Object.keys(S).forEach(function (n) { sharedSet[n] = true; }); st.projects.forEach(function (p) { if (p.kind === 'shared-library') sharedSet[p.name] = true; });
    var schemaOwners = {};
    Object.keys(sharedSet).forEach(function (n) {
      var sch = info[n] ? info[n].esqlSchemas : contentBlockers(ws, P[n]).esqlSchemas;
      Object.keys(sch).forEach(function (s) { (schemaOwners[s] = schemaOwners[s] || []).push(n); });
    });
    Object.keys(schemaOwners).forEach(function (s) { if (schemaOwners[s].length > 1) schemaOwners[s].forEach(function (n) { if (info[n]) info[n].blockers.push({ code: 'LC-ESQL-SCHEMA-COLLISION', detail: 'schema "' + s + '" in ' + schemaOwners[s].join(', '), evidence: [] }); }); });
    st.projects.forEach(function (c) {
      // containers that will reference shared libraries: their subflow schemas vs. those of the shared libraries they reference
      var mine = contentBlockers(ws, c).subflowSchemas, refs = c.refs.filter(function (r) { return sharedSet[r]; });
      var seen = {}; mine.forEach(function (s) { seen[s] = [c.name]; });
      refs.forEach(function (r) { (info[r] ? info[r].subflowSchemas : contentBlockers(ws, P[r]).subflowSchemas).forEach(function (s) { (seen[s] = seen[s] || []).push(r); }); });
      Object.keys(seen).forEach(function (s) { if (seen[s].length > 1) seen[s].forEach(function (n) { if (info[n] && S[n]) info[n].blockers.push({ code: 'LC-SUBFLOW-SCHEMA-SPLIT', detail: 'subflow schema "' + s + '" in ' + seen[s].join(', '), evidence: [] }); }); });
    });
    // 4. components: a dependency-connected group converts together or not at all
    var parent = {}; Object.keys(S).forEach(function (n) { parent[n] = n; });
    function find(x) { while (parent[x] !== x) x = parent[x] = parent[parent[x]]; return x; }
    Object.keys(S).forEach(function (n) { P[n].refs.forEach(function (r) { if (S[r]) parent[find(r)] = find(n); }); });
    var groups = {}; Object.keys(S).forEach(function (n) { (groups[find(n)] = groups[find(n)] || []).push(n); });
    Object.keys(groups).forEach(function (g) {
      var mem = groups[g], blocked = mem.filter(function (n) { return info[n].blockers.length; });
      if (blocked.length) mem.forEach(function (n) { if (!info[n].blockers.length) info[n].blockers.push({ code: 'LC-DEPENDENT-BLOCKED', detail: 'converted together with ' + blocked.join(', '), evidence: [] }); });
    });
    // 5. libraries table
    st.projects.filter(function (p) { return /library/.test(p.kind); }).forEach(function (p) {
      var n = p.name, rec = { name: n, currentType: p.kind, decision: null, reasons: [], blockers: [], referencingApplications: [], referencingLibraries: [], usage: usages(ws, p, st), dependsOn: p.refs.map(function (r) { return { project: r, kind: kindOfName(r) }; }) };
      (referencedBy[n] || []).forEach(function (u) { if (P[u] && P[u].kind === 'application') rec.referencingApplications.push(u); else rec.referencingLibraries.push(u); });
      if (p.kind === 'shared-library') { rec.decision = 'already-shared'; rec.reasons.push('already a shared library (sharedLibraryNature); not converted again'); }
      else if (!S[n]) { rec.decision = 'not-selected'; rec.reasons.push('not selected for conversion'); }
      else if (info[n].blockers.length) {
        rec.decision = 'blocked'; rec.reasons = why[n];
        rec.blockers = info[n].blockers.map(function (b) { var R = LC.RULES[b.code] || {}; return { code: b.code, rule: R.text, detail: b.detail, basis: R.basis, evidence: R.evidence, docs: R.docs || [], locations: b.evidence }; });
        res.blockedCount++;
      } else { rec.decision = 'convert'; rec.reasons = why[n]; }
      if (rec.referencingApplications.length > 1) rec.coordination = 'Referenced by ' + rec.referencingApplications.length + ' applications in this input (' + rec.referencingApplications.join(', ') + '). All of them are updated together. Applications outside this input that still contain a static copy keep working next to the shared library (verified on ACE 13.0.2.0) and can be converted later.';
      res.libraries.push(rec);
    });
    // 6. edits for the convertible libraries and every consumer of a shared library
    var conv = res.libraries.filter(function (l) { return l.decision === 'convert'; }).map(function (l) { return l.name; });
    var willBeShared = {}; conv.forEach(function (n) { willBeShared[n] = true; }); st.projects.forEach(function (p) { if (p.kind === 'shared-library') willBeShared[p.name] = true; }); Object.keys(known).forEach(function (n) { willBeShared[n] = true; });
    var pending = {}; // path -> {project, before, after, notes[], created}
    function edit(path, project, before, fn, note, created) {
      var cur = pending[path] ? pending[path].after : before, r = fn(cur);
      if (r.error) { res.errors.push(project + ': ' + r.error + ' (' + path + ')'); return; }
      if (!r.changed) return;
      pending[path] = pending[path] || { path: path, project: project, before: before, notes: [], created: !!created };
      pending[path].after = r.text; pending[path].notes.push(note);
    }
    conv.forEach(function (n) { edit(P[n].dot.path, n, P[n].dot.text, LC.addSharedNature, 'add sharedLibraryNature (library becomes a shared library)'); });
    st.projects.forEach(function (c) {
      if (c.kind !== 'application' && !(willBeShared[c.name] && P[c.name])) return;
      if (c.kind === 'integration-project') return;
      var targets = c.refs.filter(function (r) { return willBeShared[r] && (res.libraries.some(function (l) { return l.name === r && (l.decision === 'convert' || l.decision === 'already-shared'); }) || known[r]); });
      if (!targets.length) return;
      var kind = c.kind === 'application' ? 'application' : 'library', before = c.desc.text, created = false;
      if (!c.desc.path) return;
      if (before == null) { before = ''; created = true; }
      targets.forEach(function (r) {
        edit(c.desc.path, c.name, before, function (t) { return LC.addDescriptorRef(t || LC.newDescriptor(kind), r); },'add sharedLibraryReference ' + r + (willBeShared[r] && !P[r] ? ' (known shared library, not in input)' : ''), created);
      });
    });
    res.edits = Object.keys(pending).sort().map(function (k) { var e = pending[k]; return { path: e.path, project: e.project, notes: e.notes, created: e.created, before: e.before, after: e.after, diff: ACE.diff.unified(e.before, e.after, 'a/' + e.path, 'b/' + e.path) }; });
    res.converted = conv;
    // 7. warnings and manual actions
    st.projects.forEach(function (c) { c.refs.forEach(function (r) { if (!P[r] && !known[r]) res.warnings.push(c.name + ' references project "' + r + '", which is not in the input. If "' + r + '" is a static library that references a converted library, it must be converted too (a static library cannot reference a shared library); add it to the input, or list it under "known shared libraries" if it is already shared.'); }); });
    res.libraries.filter(function (l) { return l.decision === 'convert'; }).forEach(function (l) {
      var javaRefs = l.dependsOn.filter(function (d) { return d.kind === 'java'; }).map(function (d) { return d.project; });
      if (javaRefs.length) res.manualActions.push(l.name + ' references Java project(s) ' + javaRefs.join(', ') + ': in a shared library they are loaded by the shared library\'s own class loader. Java classes in shared libraries are not visible to applications or static libraries; ESQL in other containers must use the CLASSLOADER clause to call them (IBM docs). Test every JavaCompute node and LANGUAGE JAVA routine.');
    });
    res.libraries.filter(function (l) { return l.decision === 'blocked'; }).forEach(function (l) {
      l.blockers.forEach(function (b) {
        if (b.code === 'LC-ESQL-DEFAULT-SCHEMA' || b.code === 'LC-SUBFLOW-DEFAULT-SCHEMA') res.manualActions.push(l.name + ': move its ESQL and subflows into a named broker schema (e.g. a folder such as com/company/' + l.name.toLowerCase() + '/ with a matching BROKER SCHEMA line), then update every reference in the consuming flows and ESQL (subflow namespaces, esql://routine/<schema>#Module.Main, schema-qualified CALLs). This is a refactoring of the library and its consumers, not a type change, so the tool does not do it automatically.');
        if (b.code === 'LC-MSGFLOW') res.manualActions.push(l.name + ': move its message flows into an application (shared libraries cannot contain message flows).');
        if (b.code === 'LC-UNRESOLVED-REF') res.manualActions.push(l.name + ': ' + b.detail + ' - add that project to the input (or list it as a known shared library) and run the analysis again.');
      });
    });
    res.manualActions = util.uniq(res.manualActions);
    res.build = LC.buildPlan(st, res, willBeShared);
    return res;
  };

  /* Build and packaging commands for the converted workspace (run outside the browser). */
  LC.buildPlan = function (st, res, willBeShared, override) {
    var shared = st.projects.filter(function (p) { return willBeShared[p.name]; }).map(function (p) { return p.name; });
    var apps = st.projects.filter(function (p) { return p.kind === 'application'; });
    if (override) {
      (override.addProjects || []).forEach(function (n) { if (shared.indexOf(n) < 0) shared.push(n); });
      var uses = {}; (override.apps || []).forEach(function (a) { uses[a.name] = a.uses; });
      apps = apps.map(function (a) { return { name: a.name, refs: uses[a.name] || a.refs.filter(function (r) { return willBeShared[r]; }) }; });
    }
    var lines = [], ver = res.target === 'ace12' ? window.ACE_VERSIONS.source : window.ACE_VERSIONS.target;
    // Java projects referenced by the shared libraries must be named too: ibmint compiles a Java project only when
    // it is listed with --project (verified on ACE 13.0.2.0; otherwise the library starts without its classes).
    var javaProjects = util.uniq([].concat.apply([], shared.map(function (n) { var p = st.byName[n]; return p ? p.refs.filter(function (r) { return st.byName[r] && st.byName[r].kind === 'java'; }) : []; })));
    (res.converted || []).forEach(function (n) { var p = st.byName[n]; if (p) p.refs.forEach(function (r) { if (st.byName[r] && st.byName[r].kind === 'java' && javaProjects.indexOf(r) < 0) javaProjects.push(r); }); });
    if (shared.length) lines.push({ purpose: 'Shared libraries (deploy first, once per integration server)' + (javaProjects.length ? '; Java project(s) ' + javaProjects.join(', ') + ' named so that ibmint compiles them into the libraries' : ''), command: 'ibmint package --input-path <workspace> --output-bar-file shared-libraries.bar ' + shared.concat(javaProjects).map(function (n) { return '--project ' + n; }).join(' ') });
    apps.forEach(function (a) {
      var uses = a.refs.filter(function (r) { return willBeShared[r]; });
      lines.push({ purpose: 'Application ' + a.name + (uses.length ? ' (uses shared ' + uses.join(', ') + '; deploy shared-libraries.bar first)' : ''), command: 'ibmint package --input-path <workspace> --output-bar-file ' + a.name + '.bar --project ' + a.name });
      if (uses.length) lines.push({ purpose: 'Alternative: self-contained BAR for ' + a.name + ' (redeploying it also redeploys the shared libraries for every application)', command: 'ibmint package --input-path <workspace> --output-bar-file ' + a.name + '-with-shared.bar --project ' + a.name + ' ' + closure(st, uses).map(function (n) { return '--project ' + n; }).join(' ') });
    });
    return { version: 'ACE ' + ver, commands: lines, notes: [
      'Verified with ibmint (ACE 13.0.2.0): static libraries are packaged inside the application automatically; a shared library is only packaged when named with --project, as <name>.shlibzip.',
      'ibmint does not write <sharedLibraryReference> into descriptors; this conversion does, because the runtime needs it (BIP2558E without it, verified).',
      'ibmint package is documented for ACE 12.0 (command cheat sheet); its availability on 12.0.5 specifically was not verified. In the Toolkit, build the same BAR contents with the BAR editor.',
      'A shared library must be deployed with or before every application that references it, and cannot be removed while deployed applications reference it (IBM docs).',
      'These commands are NOT run by this browser-only tool.'] };
  };
  function closure(st, names) {
    var out = [], seen = {};
    // shared libraries an application needs, including the shared libraries they reference
    (function walk(list) { list.forEach(function (n) { if (seen[n]) return; seen[n] = true; out.push(n); var p = st.byName[n]; if (p) walk(p.refs.filter(function (r) { return st.byName[r] && /library/.test(st.byName[r].kind); })); }); })(names);
    return out.filter(function (n) { return st.byName[n]; });
  }

  /* ---------- apply / undo / validate ---------- */
  LC.apply = function (ws, plan) {
    var copy = plan.copy, wc = ws[copy] = ws[copy] || { overlay: {}, changelog: [] }, applied = [];
    plan.edits.forEach(function (e) {
      var cur = wc.overlay[e.path], curText = cur ? (cur.deleted ? null : cur.text) : (e.created ? '' : e.before);
      if (!e.created && !e.bytesFrom && curText !== e.before) throw new Error(e.path + ' changed since the plan was made; analyse again.');
      var entry = { t: util.nowIso(), kind: LC.KIND, title: 'Library conversion: ' + e.notes.join('; '), notes: e.notes, before: e.before, after: e.after, created: e.created, deleted: !!e.deleted, unified: e.diff };
      var o = { text: e.deleted ? null : e.after, deleted: !!e.deleted, origin: e.deleted ? 'deleted' : e.created ? 'generated' : 'transformed', history: (cur ? cur.history : []).concat([entry]) };
      if (e.bytesFrom) { o.bytes = e.bytesFrom.bytes; o.text = null; }
      wc.overlay[e.path] = o;
      wc.changelog.push(Object.assign({ path: e.path, action: e.deleted ? 'removed' : e.created ? 'created' : 'converted' }, entry));
      applied.push(e.path);
    });
    ACE.log.ok('Library conversion applied to the ' + (copy === 'ws12' ? 'ACE 12' : 'ACE 13') + ' working copy: ' + plan.converted.length + ' library(ies), ' + applied.length + ' file(s) changed');
    return applied;
  };
  LC.undo = function (ws, copy) {
    var wc = ws[copy]; if (!wc) return 0; var n = 0;
    Object.keys(wc.overlay).forEach(function (p) {
      while (wc.overlay[p] && wc.overlay[p].history.length && wc.overlay[p].history[wc.overlay[p].history.length - 1].kind === LC.KIND) { ACE.transforms.undo(ws, copy, p); n++; }
    });
    if (n) ACE.log.info('Library conversion undone in the ' + (copy === 'ws12' ? 'ACE 12' : 'ACE 13') + ' working copy (' + n + ' change(s))');
    return n;
  };

  /* Structural validation of a working copy after conversion. Build/compile is NOT performed here. */
  LC.validate = function (ws, copy, cfg) {
    var st = LC.state(ws, copy), known = {}, checks = [];
    ((cfg && cfg.knownSharedLibraries) || []).forEach(function (n) { known[n] = true; });
    function check(id, title, problems) { checks.push({ id: id, title: title, status: problems.length ? 'FAIL' : 'PASS', problems: problems }); }
    var P = st.byName, shared = st.projects.filter(function (p) { return p.kind === 'shared-library'; });
    check('V1', 'Shared libraries have the library, sharedLibrary and messageBroker natures', shared.filter(function (p) { return [NAT.lib, NAT.shared, NAT.mb].some(function (n) { return p.natures.indexOf(n) < 0; }); }).map(function (p) { return p.name + ': natures ' + p.natures.join(', '); }));
    var refProblems = [];
    st.projects.forEach(function (p) {
      p.refs.forEach(function (r) {
        var k = P[r] ? P[r].kind : known[r] ? 'shared-library' : null; if (!k) return;
        if (p.kind === 'shared-library' && k === 'static-library') refProblems.push('shared library ' + p.name + ' references static library ' + r);
        if (p.kind === 'static-library' && k === 'shared-library') refProblems.push('static library ' + p.name + ' references shared library ' + r);
        if (p.kind === 'integration-project' && k === 'shared-library') refProblems.push('integration project ' + p.name + ' references shared library ' + r);
      });
    });
    check('V2', 'Reference rules (shared -> shared only; static and integration projects -> no shared)', refProblems);
    var descProblems = [];
    st.projects.forEach(function (p) {
      if (p.kind !== 'application' && p.kind !== 'shared-library') return;
      p.refs.forEach(function (r) { var k = P[r] ? P[r].kind : known[r] ? 'shared-library' : null; if (k === 'shared-library' && p.desc.refs.indexOf(r) < 0) descProblems.push(p.name + ' references shared library ' + r + ' in .project but not in ' + (p.desc.name || 'its descriptor') + ' (runtime BIP2558E)'); });
      p.desc.refs.forEach(function (r) { if (!P[r] && !known[r]) descProblems.push(p.name + ' descriptor references unknown shared library ' + r); else if (P[r] && P[r].kind !== 'shared-library') descProblems.push(p.name + ' descriptor references ' + r + ', which is a ' + P[r].kind); });
      var dupRefs = p.desc.refs.filter(function (r, i) { return p.desc.refs.indexOf(r) !== i; }); if (dupRefs.length) descProblems.push(p.name + ' descriptor lists ' + util.uniq(dupRefs).join(', ') + ' more than once');
    });
    check('V3', 'Every shared-library reference is in the descriptor, and every descriptor reference resolves', descProblems);
    var xmlProblems = [];
    st.projects.forEach(function (p) {
      if (p.dot.text && ACE.bar.parseDotProject(p.dot.text).parseError) xmlProblems.push(p.dot.path + ' is not well-formed');
      if (p.desc.text) { try { var d = new DOMParser().parseFromString(p.desc.text, 'application/xml'); if (d.getElementsByTagName('parsererror').length) xmlProblems.push(p.desc.path + ' is not well-formed'); } catch (e) { xmlProblems.push(p.desc.path + ': ' + e.message); } }
    });
    check('V4', 'Project metadata and descriptors are well-formed XML', xmlProblems);
    var content = [];
    shared.forEach(function (p) { contentBlockers(ws, p).blockers.forEach(function (b) { content.push(p.name + ': ' + b.code + ' ' + b.detail); }); });
    check('V5', 'Shared library contents are supported (no flows, no default-schema ESQL/subflows, no unsupported resources/nodes)', content);
    var ov = overlayOf(ws, copy);
    var convPaths = Object.keys(ov).filter(function (p) { return ov[p].history.some(function (h) { return h.kind === LC.KIND; }); });
    var stray = convPaths.filter(function (p) { return !/(\/\.project|\/application\.descriptor|\/library\.descriptor)$/.test(p); });
    // every converted .project must differ from its original only by the added nature line
    convPaths.filter(function (p) { return /\/\.project$/.test(p); }).forEach(function (p) {
      var first = ov[p].history.filter(function (h) { return h.kind === LC.KIND; })[0], d = ACE.diff(first.before, first.after);
      var del = d.filter(function (x) { return x.op === '-'; }).length, add = d.filter(function (x) { return x.op === '+'; });
      if (del || add.length !== 1 || add[0].text.trim() !== '<nature>' + NAT.shared + '</nature>') stray.push(p + ' (unexpected change besides the shared nature)');
    });
    if ((cfg && cfg.strategy) === 'in-place') check('V6', 'Only .project natures and descriptor references were changed; every other file is unchanged', stray);
    else check('V6', 'Refactoring touched only library files and the references to them (no unrelated file changed)', convPaths.filter(function (p) { return !/\.(project|descriptor|esql|subflow|msgflow)$/.test(p) && !ov[p].history.some(function (h) { return h.created || h.deleted; }); }));
    // V8-V11: resolution rules observed on the ACE 13.0.2.0 runtime (docs/LIBRARY-CONVERSION.md section 5)
    var defs = {}; // project -> {subflows: {ns:1}, modules: {schema#M:1}, routines: {SCHEMA.NAME:1}}
    st.projects.forEach(function (p) {
      var d = defs[p.name] = { subflows: {}, modules: {}, routines: {} };
      p.files.forEach(function (f) {
        if (/\.subflow$/i.test(f.rel)) { var t = f.text() || ''; var ns = (/\bnsURI="([^"]+)"/.exec(t) || [])[1]; if (ns) d.subflows[ns] = true; }
        if (/\.esql$/i.test(f.rel)) { var sy = ACE.libref.esqlSymbols(f.text() || ''); sy.modules.forEach(function (m) { d.modules[sy.schema + '#' + m] = true; }); sy.routines.forEach(function (r) { d.routines[(sy.schema ? sy.schema + '.' : '') + r.toUpperCase()] = true; }); }
      });
    });
    function scope(p) { // containers whose resources p can use
      var out = [p.name], seenS = {}; seenS[p.name] = true;
      (function walk(n) { var q = P[n]; if (!q) return; q.refs.forEach(function (r) { if (seenS[r] || !P[r]) return; var k = P[r].kind; if (k === 'shared-library' || (k === 'static-library' && p.kind !== 'shared-library')) { seenS[r] = true; out.push(r); walk(r); } }); })(p.name);
      return out;
    }
    var v8 = [], v9 = [], v10 = [], v11 = [], preexisting = [];
    // references that resolve nowhere in the input were already broken before the conversion: reported, not counted
    var anySub = {}, anyMod = {};
    Object.keys(defs).forEach(function (n) { Object.keys(defs[n].subflows).forEach(function (k) { anySub[k] = true; }); Object.keys(defs[n].modules).forEach(function (k) { anyMod[k] = true; anyMod['#' + k.split('#')[1]] = anyMod['#' + k.split('#')[1]] || false; }); });
    var origDefs = LC.state(ws, '__original__');
    origDefs.projects.forEach(function (p) { p.files.forEach(function (f) {
      if (/\.subflow$/i.test(f.rel)) { var ns0 = (/\bnsURI="([^"]+)"/.exec(f.text() || '') || [])[1]; if (ns0) anySub['@orig:' + ns0] = true; }
      if (/\.esql$/i.test(f.rel)) ACE.libref.esqlSymbols(f.text() || '').modules.forEach(function (m) { anyMod['@orig:' + m] = true; });
    }); });
    function existedBefore(kind, key) { return kind === 'module' ? !!anyMod['@orig:' + key.split('#')[1]] : !!anySub['@orig:' + util.basename(key)] || Object.keys(anySub).some(function (k) { return k.indexOf('@orig:') === 0 && util.basename(k.slice(6)) === util.basename(key); }); }
    st.projects.forEach(function (p) {
      if (!/application|library/.test(p.kind)) return;
      var sc = scope(p), isShared = p.kind === 'shared-library';
      p.files.forEach(function (f) {
        if (/\.(msgflow|subflow)$/i.test(f.rel)) {
          var t = f.text() || '', ns = {}, m, d = /xmlns:([\w.-]+)="([^"]+\.(?:subflow|msgflow))"/g;
          while ((m = d.exec(t))) ns[m[1]] = m[2];
          var re = /<nodes xmi:type="([\w.-]+):FCMComposite_1"([^>]*)>/g;
          while ((m = re.exec(t))) {
            var target = ns[m[1]]; if (!target) continue;
            var owner = sc.filter(function (c) { return defs[c] && defs[c].subflows[target]; })[0];
            if (!owner) {
              if (!existedBefore('subflow', target)) { preexisting.push(f.outPath + ': subflow ' + target + ' (missing in the input before the conversion)'); continue; }
              v8.push(f.outPath + ': subflow ' + target + ' not found in ' + (isShared ? 'this shared library (a shared library cannot use subflows of another shared library, BIP1360E)' : sc.join(', '))); continue;
            }
            if (isShared && owner !== p.name) v8.push(f.outPath + ': uses subflow ' + target + ' of shared library ' + owner + ' (BIP1360E)');
            if (P[owner] && P[owner].kind === 'shared-library' && owner !== p.name) {
              var a, ar = /(\w+)="esql:\/\/routine\/([\w.]*)#([^"#]+?)\.Main"/g;
              while ((a = ar.exec(m[2]))) { var key = a[2] + '#' + a[3], ownerScope = scope(P[owner]); if (!ownerScope.some(function (c) { return defs[c] && defs[c].modules[key]; })) v9.push(f.outPath + ': passes module ' + key + ' (' + a[1] + ') into shared subflow ' + target + ' - not visible inside the shared library (BIP4127E)'); }
            }
          }
          if (isShared) {
            // bare defaults of ESQL-module promoted properties also resolve in the default schema
            var dv = /<eStructuralFeatures\b[^>]*\bdefaultValueLiteral="([A-Za-z_][^"\s.#\/:]*)"[^>]*>\s*<eType[^>]*#\/\/EsqlModule"/g, dm;
            while ((dm = dv.exec(t))) { if (existedBefore('module', '#' + dm[1])) v10.push(f.outPath + ': promoted property default "' + dm[1] + '" refers to a default-schema module'); }
          }
          var mr = /(\s)(computeExpression|filterExpression|statement)="([^"]*)"/g;
          while ((m = mr.exec(t))) {
            var v = m[3], mm = /^esql:\/\/routine\/([\w.]*)#([^"#]+?)\.Main$/.exec(v), bareRe = /^[A-Za-z_][^"\s.#\/:]*$/;
            var bare = false;
            if (!mm) { if (!bareRe.test(v)) continue; mm = [null, '', v]; bare = true; }
            var k2 = mm[1] + '#' + mm[2];
            if (!existedBefore('module', k2)) { preexisting.push(f.outPath + ': module ' + mm[2] + ' (' + m[2] + ') is not defined anywhere in the input (also before the conversion)'); continue; }
            if (bare && isShared) v10.push(f.outPath + ': ' + m[2] + '="' + v + '" refers to a default-schema module');
            if (!sc.some(function (c) { return defs[c] && defs[c].modules[k2]; })) v9.push(f.outPath + ': module ' + k2 + ' (' + m[2] + ') not found in ' + sc.join(', '));
          }
        }
        if (/\.esql$/i.test(f.rel) && !isShared) {
          var sy = ACE.libref.esqlSymbols(f.text() || ''), sharedRoutines = {};
          sc.filter(function (c) { return P[c] && P[c].kind === 'shared-library'; }).forEach(function (c) { Object.keys(defs[c].routines).forEach(function (k) { var nm = k.split('.').pop(); if (k.indexOf('.') > 0) sharedRoutines[nm] = k; }); });
          var own = {}; sc.filter(function (c) { return !P[c] || P[c].kind !== 'shared-library'; }).forEach(function (c) { Object.keys(defs[c] ? defs[c].routines : {}).forEach(function (k) { own[k.split('.').pop()] = true; }); });
          var re2 = /([.\w]?)\b([A-Za-z_]\w*)\s*\(/g, c2;
          while ((c2 = re2.exec(sy.code))) { var up = c2[2].toUpperCase(); if (c2[1] === '.' || /\w/.test(c2[1]) || !sharedRoutines[up] || own[up]) continue; if (/\b(FUNCTION|PROCEDURE)\s*$/i.test(sy.code.slice(Math.max(0, c2.index - 20), c2.index + 1))) continue; v11.push(f.outPath + ':' + util.lineAt(f.text(), c2.index) + ' calls ' + c2[2] + ' without its schema (' + sharedRoutines[up].split('.').slice(0, -1).join('.') + ')'); }
        }
      });
    });
    check('V8', 'Every subflow reference resolves; no shared library uses a subflow of another shared library', v8);
    check('V9', 'Every ESQL module reference resolves; no application module is passed into a shared subflow', v9);
    check('V10', 'No default-schema (bare) module references inside shared libraries', v10);
    check('V11', 'Calls from applications to shared-library routines are schema-qualified', v11);
    var v12 = [];
    shared.forEach(function (p) {
      var cls = ACE.libref.libraryClasses(ws, st, [p.name]);
      p.files.forEach(function (f) {
        if (!/\.esql$/i.test(f.rel)) return;
        var probe = ACE.libref.addJavaClassloader(f.text() || '', p.name, function (c) { return !!cls[c]; });
        if (probe.count) v12.push(f.outPath + ': LANGUAGE JAVA routine(s) for ' + util.uniq(probe.classes).join(', ') + ' without CLASSLOADER "{' + p.name + '}" (BIP3202E/BIP2943E at run time)');
      });
    });
    check('V12', 'Java routines in shared libraries load their classes from the shared library (CLASSLOADER clause)', v12);
    if (preexisting.length) checks.push({ id: 'V0', title: 'References that were already unresolved in the input (not caused by the conversion; fix them in the source)', status: 'WARN', problems: util.uniq(preexisting) });
    var again = LC.analyze(ws, cfg, copy);
    check('V7', 'Repeatable: analysing the converted copy again plans no further changes', again.edits.map(function (e) { return 'would change ' + e.path + ': ' + e.notes.join('; '); }));
    return { copy: copy, at: util.nowIso(), checks: checks, passed: checks.every(function (c) { return c.status !== 'FAIL'; }), changedFiles: convPaths,
      notPerformed: ['Compilation and BAR build (run the ibmint commands in the report with the ' + (copy === 'ws12' ? 'ACE ' + window.ACE_VERSIONS.source : 'ACE ' + window.ACE_VERSIONS.target) + ' installation)', 'Deployment and runtime tests: build success is not proof of runtime behaviour (e.g. ibmint packages default-schema ESQL that the runtime then rejects)'] };
  };

  /* ---------- run (one call per execution; used by the UI and the export) ---------- */
  LC.run = function (ws, cfg, opts) {
    cfg = Object.assign({}, LC.DEFAULTS, cfg || {}); opts = opts || {};
    var out = { tool: 'IBM ACE Migration Workbench ' + util.VERSION, at: util.nowIso(), input: { name: ws.barName, kind: ws.inputKind || 'bar', sha256: ws.barSha256 }, versions: { source: window.ACE_VERSIONS.source, target: window.ACE_VERSIONS.target }, enabled: !!cfg.enabled, config: cfg, targets: [] };
    if (!cfg.enabled) { out.note = 'Library conversion is disabled: nothing was analysed or changed.'; return out; }
    (cfg.targets || []).forEach(function (t) {
      var copy = t === 'ace12' ? 'ws12' : 'ws13', plan = LC.analyze(ws, cfg, copy), applied = [];
      if (opts.apply && plan.edits.length && !plan.errors.length) applied = LC.apply(ws, plan);
      var after = opts.apply ? LC.analyze(ws, cfg, copy) : plan;
      var val = (opts.apply && cfg.validateAfterConversion) ? LC.validate(ws, copy, cfg) : null;
      out.targets.push({ target: t, version: t === 'ace12' ? window.ACE_VERSIONS.source : window.ACE_VERSIONS.target, plan: plan, applied: applied, state: after, validation: val });
    });
    return out;
  };

  /* ---------- reports ---------- */
  LC.reportJson = function (run) {
    function slim(plan) { return plan && { strategy: plan.strategy, target: plan.target || null, hooks: plan.hooks || [], localCopies: plan.localCopies || {}, notes: plan.notes || [], libraries: plan.libraries, projects: plan.projects, converted: plan.converted, edits: plan.edits.map(function (e) { return { path: e.path, project: e.project, change: e.created ? 'created' : e.deleted ? 'removed' : 'modified', notes: e.notes, diff: e.created || e.deleted ? undefined : e.diff }; }), warnings: plan.warnings, errors: plan.errors, manualActions: plan.manualActions, build: plan.build }; }
    return Object.assign({}, run, { report: 'library-conversion', rules: LC.RULES, targets: run.targets.map(function (t) { return { target: t.target, version: t.version, plan: slim(t.plan), modifiedFiles: t.applied, validation: t.validation }; }) });
  };
  LC.reportText = function (run) {
    var L = ['# Static-to-shared library conversion report', '', '- Input: `' + run.input.name + '` (' + run.input.kind + ')', '- Versions: source ACE ' + run.versions.source + ', target(s): ' + (run.config.targets || []).map(function (t) { return t === 'ace12' ? 'ACE ' + run.versions.source : 'ACE ' + run.versions.target; }).join(', '), '- Conversion: **' + (run.enabled ? 'ENABLED' : 'DISABLED') + '**', '- Generated: ' + run.at, ''];
    if (!run.enabled) { L.push(run.note || ''); return L.join('\n') + '\n'; }
    run.targets.forEach(function (t) {
      var p = t.plan;
      L.push('## Target ACE ' + t.version + ' (' + (t.target === 'ace12' ? 'ACE 12 package' : 'ACE 13 package') + ')', '');
      L.push('### Libraries', '', '| Library | Current type | Decision | Referencing applications | Reason |', '|---|---|---|---|---|');
      p.libraries.forEach(function (l) { L.push('| ' + l.name + ' | ' + l.currentType + ' | **' + l.decision + '** | ' + (l.referencingApplications.join(', ') || '-') + ' | ' + (l.blockers.length ? l.blockers.map(function (b) { return b.code + ': ' + b.detail; }).join('; ') : l.reasons.join('; ')) + ' |'); });
      p.libraries.filter(function (l) { return l.blockers.length; }).forEach(function (l) {
        L.push('', '#### ' + l.name + ' cannot be converted');
        l.blockers.forEach(function (b) { L.push('- **' + b.code + '** (' + b.basis + '): ' + b.rule + ' ' + b.detail + '. Evidence: ' + b.evidence + (b.locations && b.locations.length ? ' Files: ' + b.locations.slice(0, 6).map(function (x) { return '`' + x.file + (x.line ? ':' + x.line : '') + '`'; }).join(', ') + (b.locations.length > 6 ? ' ...' : '') : '')); });
      });
      p.libraries.filter(function (l) { return l.coordination; }).forEach(function (l) { L.push('', '- ' + l.name + ': ' + l.coordination); });
      if (p.target && p.target.sharedLibrary) {
        L.push('', '### Refactoring', '', '- Strategy: **refactor** - libraries ' + p.target.group.join(', ') + ' merged into shared library **' + p.target.sharedLibrary + '**, default-schema ESQL and subflows moved to schema `' + p.target.schema + '`.');
        (p.hooks || []).forEach(function (h) { L.push('- Kept local to the applications (receives application ESQL modules: ' + h.properties.map(function (x) { return x.property; }).join(', ') + '; such hooks fail inside a shared library, BIP4127E verified): `' + h.subflow + '` -> `' + h.localNs + '`'); });
        (p.notes || []).forEach(function (n) { L.push('- ' + n); });
      }
      L.push('', '### Files and references ' + (t.applied.length ? 'changed' : 'that would change') + ' (' + p.edits.length + ')', '');
      if (!p.edits.length) L.push('None.');
      p.edits.filter(function (e) { return !e.created && !e.deleted; }).forEach(function (e) { L.push('- `' + e.path + '`: ' + e.notes.join('; '), '', '```diff', e.diff, '```', ''); });
      var cr = p.edits.filter(function (e) { return e.created; }), dl = p.edits.filter(function (e) { return e.deleted; });
      if (cr.length) { L.push('Created (' + cr.length + '):', ''); cr.forEach(function (e) { L.push('- `' + e.path + '`: ' + e.notes.join('; ')); }); L.push(''); }
      if (dl.length) { L.push('Removed - moved into the shared library (' + dl.length + '):', ''); dl.forEach(function (e) { L.push('- `' + e.path + '`'); }); L.push(''); }
      if (p.warnings.length) { L.push('### Warnings', ''); p.warnings.forEach(function (w) { L.push('- ' + w); }); L.push(''); }
      if (p.errors.length) { L.push('### Errors', ''); p.errors.forEach(function (w) { L.push('- ' + w); }); L.push(''); }
      if (p.manualActions.length) { L.push('### Manual actions required', ''); p.manualActions.forEach(function (w) { L.push('- ' + w); }); L.push(''); }
      L.push('### Build and packaging (' + p.build.version + ')', '');
      p.build.commands.forEach(function (c) { L.push('- ' + c.purpose + ':', '  `' + c.command + '`'); });
      p.build.notes.forEach(function (n) { L.push('- ' + n); });
      if (t.validation) {
        L.push('', '### Validation of the converted project (in the tool)', '', '| Check | Result | Problems |', '|---|---|---|');
        t.validation.checks.forEach(function (c) { L.push('| ' + c.id + ' ' + c.title + ' | **' + c.status + '** | ' + (c.problems.join('; ') || '-') + ' |'); });
        L.push('', 'Not performed by this tool:'); t.validation.notPerformed.forEach(function (n) { L.push('- ' + n); });
      }
      L.push('');
    });
    return L.join('\n') + '\n';
  };
})(window.ACE);
