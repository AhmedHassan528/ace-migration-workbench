/* Static-to-shared conversion with automatic refactoring (strategy "refactor").
 *
 * Used when libraries cannot simply change type. Every rule below was observed on an ACE 13.0.2.0
 * integration server (docs/LIBRARY-CONVERSION.md, section 5):
 *   R7  a compute node in a SHARED subflow cannot run an ESQL module supplied by the application through a
 *       promoted property ("hook"): BIP4127E, also when the application module is in a named schema;
 *   R8  a subflow in shared library A cannot contain a subflow of shared library B: BIP1360E;
 *   R9  ESQL in the default schema of a shared library cannot be deployed: BIP4129E;
 *   R6  an application cannot reference a constant of another schema (com.x.C): BIP2432E;
 *   OK  application -> shared subflow; application subflow -> shared subflow; application compute node ->
 *       shared module (esql://routine/<schema>#M.Main); schema-qualified CALL and function calls; nesting and
 *       hooks inside ONE shared library.
 * Therefore, for a dependency-connected group G of static libraries the refactoring:
 *   1. merges G into ONE shared library N (cross-library nesting and library-to-library hooks become
 *      same-library references);
 *   2. moves every default-schema ESQL file and subflow of G into ONE named broker schema S (folder S/...),
 *      so unqualified calls and constants between the former libraries keep working;
 *   3. keeps the subflows that receive application ESQL modules (hooks), and the subflows those hooks are
 *      forwarded to, LOCAL to each application that uses them (schema S.local), pointing at the shared
 *      modules and subflows; the shared library still contains the full framework (deterministic content);
 *   4. rewrites every reference: subflow namespaces, node types, nested-subflow hrefs, esql://routine
 *      module references (including the old bare form), schema-qualified calls from applications,
 *      .project references and descriptors.
 * Anything it cannot do safely blocks the whole run (nothing is changed) and is reported. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var LR = ACE.libref = {};

  var DOCS = ['https://www.ibm.com/docs/en/SSTTDS_13.0/com.ibm.etools.mft.doc/bc23067_.html'];
  LR.RULES = {
    'RF-MSGFLOW': 'A library in the group contains a message flow; shared libraries cannot contain message flows (BIP1874E).',
    'RF-UNSUPPORTED-RESOURCE': 'Resource type not supported in a shared library (XML, XSL, IDL, message sets).',
    'RF-UNSUPPORTED-NODE': 'Node type not supported in a shared library (CORBARequest, SCA, Adapters, XSLTransform).',
    'RF-PATH-CONFLICT': 'Two libraries of the group have a different file at the same path; merging would lose one.',
    'RF-NAME-CONFLICT': 'Two libraries of the group define the same ESQL routine/module/subflow in the default schema; after merging they would collide.',
    'RF-LIB-CALLS-APP': 'Library ESQL calls a routine that only an application defines; a shared library cannot see application code.',
    'RF-CONSTANT-USE': 'An application uses a schema-level CONSTANT/SHARED/EXTERNAL variable of the library; it cannot be referenced across schemas (BIP2432E verified).',
    'RF-MISSING-PROJECT': 'A project referenced by the input is missing; it may depend on the libraries and could not be converted with them.',
    'RF-INTEGRATION-PROJECT': 'An integration project references a library of the group; integration projects cannot reference shared libraries.',
    'RF-SCHEMA-TAKEN': 'The target broker schema is already used by ESQL or subflows elsewhere in the input.',
    'RF-NAME-TAKEN': 'The target shared library name is already used by another project in the input.',
    'RF-BAR-INPUT': 'Refactoring needs a Toolkit workspace ZIP (original project files); BAR input is analysed only.'
  };

  /* ---------- helpers ---------- */
  function mask(t) { return ACE.esql.mask(t).code; }
  function moduleRanges(code) {
    // quoted module names may contain any character but a double quote (e.g. "FlowAuditCMP_IsAuditRequired?")
    var out = [], re = /\bCREATE\s+(?:COMPUTE|FILTER|DATABASE)\s+MODULE\s+(?:"((?:[^"]|"")+)"|(\w+))/gi, m;
    while ((m = re.exec(code))) { var end = code.slice(m.index).search(/\bEND\s+MODULE\b/i); out.push({ name: m[1] != null ? m[1].replace(/""/g, '"') : m[2], start: m.index, end: end < 0 ? code.length : m.index + end }); }
    return out;
  }
  function enclosing(ranges, i) { for (var k = 0; k < ranges.length; k++) if (i > ranges[k].start && i < ranges[k].end) return ranges[k]; return null; }
  /* Symbols of an ESQL text: modules, schema-level routines and declarations, module-level routines. */
  LR.esqlSymbols = function (text) {
    var code = mask(text), mods = moduleRanges(code), schema = ((/\bBROKER[ \t]+SCHEMA[ \t]+([A-Za-z_][\w.]*)/i.exec(code)) || [])[1] || '';
    var routines = [], local = {}, decls = [], m, re = /\bCREATE\s+(FUNCTION|PROCEDURE)\s+(\w+)\s*\(/gi;
    while ((m = re.exec(code))) { var e = enclosing(mods, m.index); if (e) (local[e.name] = local[e.name] || {})[m[2].toUpperCase()] = true; else routines.push(m[2]); }
    // schema-level declarations, with the full statement text (needed to copy constants/namespaces)
    var dr = /^[ \t]*DECLARE\s+(\w+)\s+(CONSTANT|SHARED|EXTERNAL|NAMESPACE)\b[^;]*;/gim;
    while ((m = dr.exec(code))) if (!enclosing(mods, m.index)) decls.push({ name: m[1], kind: m[2].toUpperCase(), stmt: text.slice(m.index, m.index + m[0].length).trim() });
    return { schema: schema, modules: mods.map(function (x) { return x.name; }), routines: routines, decls: decls, local: local, ranges: mods, code: code };
  };
  /* Identifier call sites NAME( in ESQL that refer to schema-level routines (not member access, not definitions). */
  function callSites(sym, names) {
    var out = [], re = /([.\w]?)\b([A-Za-z_]\w*)\s*\(/g, m;
    while ((m = re.exec(sym.code))) {
      if (m[1] === '.' || /\w/.test(m[1])) continue;
      var up = m[2].toUpperCase(); if (!names[up]) continue;
      var before = sym.code.slice(Math.max(0, m.index - 40), m.index + m[1].length);
      if (/\b(FUNCTION|PROCEDURE|MODULE)\s*$/i.test(before)) continue;
      var e = enclosing(sym.ranges, m.index); if (e && sym.local[e.name] && sym.local[e.name][up]) continue;
      out.push({ index: m.index + m[1].length, name: m[2] });
    }
    return out;
  }
  function nsOf(text) { return ((/\bnsURI="([^"]+)"/.exec(text)) || [])[1] || null; }
  function prefixFor(ns) { return ns.replace(/\//g, '_'); }
  /* Rewrite subflow references in a flow/subflow text. map: oldNs -> newNs. selfNs: new nsURI of this file (subflow) or null. */
  LR.rewriteSubflowRefs = function (text, map, selfNs) {
    var t = text, notes = [];
    if (selfNs) {
      var old = nsOf(t);
      if (old && old !== selfNs) {
        t = t.replace(/\bnsURI="[^"]+"/, 'nsURI="' + selfNs + '"').replace(/\bnsPrefix="[^"]+"/, 'nsPrefix="' + prefixFor(selfNs) + '"');
        // The runtime takes the subflow's broker schema from the translation bundleName (verified on ACE 13.0.2.0:
        // without this, BIP1369E "cannot be defined within the default broker schema").
        var oldBundle = old.replace(/\.subflow$/, ''), newBundle = selfNs.replace(/\.subflow$/, '');
        t = t.split('bundleName="' + oldBundle + '"').join('bundleName="' + newBundle + '"');
        notes.push('nsURI ' + old + ' -> ' + selfNs);
      }
    }
    var decl = /xmlns:([\w.-]+)="([^"]+\.(?:subflow|msgflow))"/g, m, swaps = [];
    while ((m = decl.exec(t))) if (map[m[2]] && map[m[2]] !== m[2]) swaps.push({ prefix: m[1], from: m[2], to: map[m[2]] });
    swaps.forEach(function (s) {
      var np = prefixFor(s.to);
      t = t.split('xmlns:' + s.prefix + '="' + s.from + '"').join('xmlns:' + np + '="' + s.to + '"');
      t = t.split('xmi:type="' + s.prefix + ':').join('xmi:type="' + np + ':');
      notes.push('subflow ' + s.from + ' -> ' + s.to);
    });
    Object.keys(map).forEach(function (from) { if (map[from] !== from && t.indexOf('href="' + from + '#') >= 0) { t = t.split('href="' + from + '#').join('href="' + map[from] + '#'); notes.push('href ' + from + ' -> ' + map[from]); } });
    return { text: t, notes: util.uniq(notes) };
  };
  /* Rewrite ESQL module references in attributes. modMap: 'oldSchema#Module' -> newSchema. */
  LR.rewriteModuleRefs = function (text, modMap, esqlProps) {
    var n = 0;
    function qualify(mod) { var k = '#' + mod; return (k in modMap) ? 'esql://routine/' + modMap[k] + '#' + mod + '.Main' : null; }
    // bare defaults of ESQL-module promoted properties: <eStructuralFeatures ... defaultValueLiteral="M"> <eType ...#//EsqlModule"/>
    text = text.replace(/(<eStructuralFeatures\b[^>]*\bdefaultValueLiteral=")([A-Za-z_][^"\s.#\/:]*)("[^>]*>\s*<eType[^>]*#\/\/EsqlModule")/g, function (all, a, mod, b) { var q = qualify(mod); if (!q) return all; n++; return a + q + b; });
    // bare values of promoted ESQL properties on subflow nodes (property names known per subflow namespace)
    if (esqlProps) {
      var ns = {}, m0, d0 = /xmlns:([\w.-]+)="([^"]+\.(?:subflow|msgflow))"/g;
      while ((m0 = d0.exec(text))) ns[m0[1]] = m0[2];
      text = text.replace(/<nodes xmi:type="([\w.-]+):FCMComposite_1"[^>]*>/g, function (tag, pfx) {
        var props = esqlProps[ns[pfx]]; if (!props) return tag;
        return tag.replace(/(\s)([\w.]+)="([A-Za-z_][^"\s.#\/:]*)"/g, function (all, sp, attr, mod) { if (!props[attr]) return all; var q = qualify(mod); if (!q) return all; n++; return sp + attr + '="' + q + '"'; });
      });
    }
    var t = text.replace(/(\s)([\w.]+)="esql:\/\/routine\/([\w.]*)#([^"#]+?)\.Main"/g, function (all, sp, attr, sch, mod) {
      var k = sch + '#' + mod; if (!(k in modMap) || modMap[k] === sch) return all; n++;
      return sp + attr + '="esql://routine/' + modMap[k] + '#' + mod + '.Main"';
    }).replace(/(\s)(computeExpression|filterExpression|statement)="([A-Za-z_][^"\s.#\/:]*)"/g, function (all, sp, attr, mod) {
      var k = '#' + mod; if (!(k in modMap)) return all; n++;
      return sp + attr + '="esql://routine/' + modMap[k] + '#' + mod + '.Main"';
    });
    return { text: t, count: n };
  };
  /* ESQL modules referenced by a flow/subflow node attribute values. */
  function moduleRefs(text) {
    var out = [], re = /<nodes xmi:type="([\w.-]+):FCMComposite_1"[^>]*xmi:id="([^"]+)"([^>]*)>/g, m;
    var attrs = /(\w+)="esql:\/\/routine\/([\w.]*)#([^"#]+?)\.Main"/g, a;
    while ((m = re.exec(text))) { attrs.lastIndex = 0; var body = m[0]; while ((a = attrs.exec(body))) out.push({ nodePrefix: m[1], nodeId: m[2], attr: a[1], schema: a[2], module: a[3] }); }
    return out;
  }
  function subflowNodes(text) {
    var ns = {}, m, d = /xmlns:([\w.-]+)="([^"]+\.(?:subflow|msgflow))"/g;
    while ((m = d.exec(text))) ns[m[1]] = m[2];
    var out = [], re = /<nodes xmi:type="([\w.-]+):FCMComposite_1"([^>]*)>/g;
    while ((m = re.exec(text))) if (ns[m[1]]) out.push({ ns: ns[m[1]], id: ((/xmi:id="([^"]+)"/.exec(m[2])) || [])[1], attrs: m[2] });
    return out;
  }
  /* Promoted ESQL properties of a subflow and where they are forwarded (attributeLinks). */
  /* R11 (verified on ACE 13.0.2.0, docs/LIBRARY-CONVERSION.md): a node that WRITES the message tree to a bitstream, with message
   * validation on, needs the message model of the container it runs in. In a shared library that is the library, which has no model for
   * an application's messages: BIP5010E + BIP5058E "Validation is enabled but a message model for the shared library 'X' cannot be located".
   * IBM: validation in a shared library needs "the name of the shared library that contains the appropriate compiled model".
   * Verified for ResetContentDescriptor (no validation property, so only the container matters) and SOAPReply (also with validation "none"
   * on the node); the other output nodes have the same validateMaster property and are treated alike. A static library never had the problem
   * because its nodes ran inside the application. The cure that keeps the static behaviour: the subflow runs in the application (local copy). */
  var WRITER_NODES = { ResetContentDescriptor: 'no-property', SOAPReply: 1, SOAPRequest: 1, SOAPAsyncRequest: 1, SOAPAsyncResponse: 1, WSReply: 1, WSRequest: 1, MQOutput: 1, MQReply: 1, JMSOutput: 1, JMSReply: 1, FileOutput: 1, TCPIPClientOutput: 1, TCPIPServerOutput: 1, EmailOutput: 1, KafkaProducer: 1, Validate: 1 };
  var INPUT_NODES = { SOAPInput: true, WSInput: false, MQInput: false, JMSInput: false, FileInput: false, TCPIPServerInput: false, TCPIPClientInput: false, KafkaConsumer: false };   // value = validates by default
  function allNodes(text) {
    var ns = {}, m, d = /xmlns:([\w.-]+)="([^"]+)"/g;
    while ((m = d.exec(text))) ns[m[1]] = m[2];
    var out = [], re = /<nodes xmi:type="([\w.-]+):FCMComposite_1"([^>]*)>/g;
    while ((m = re.exec(text))) { var u = ns[m[1]] || ''; out.push({ id: ((/xmi:id="([^"]+)"/.exec(m[2])) || [])[1], attrs: m[2], ns: u, builtin: /\.msgnode$/.test(u) ? u.replace(/^ComIbm/, '').replace(/\.msgnode$/, '') : null, subflow: /\.subflow$/.test(u) ? u : null }); }
    return out;
  }
  function attrOf(attrs, name) { var m = new RegExp('\\s' + name.replace(/\./g, '\\.') + '="([^"]*)"').exec(attrs || ''); return m ? m[1] : null; }
  /* The promoted properties of a subflow that feed validateMaster of inner nodes: [{prop, nodes, def}] */
  function validateLinks(text) {
    var out = [], m, al = /<attributeLinks promotedAttribute="Property\.([\w.]+)" overriddenNodes="([^"]+)">([\s\S]*?)<\/attributeLinks>/g;
    while ((m = al.exec(text))) {
      if (!/#Property\.validateMaster"/.test(m[3])) continue;
      var d = new RegExp('xmi:id="Property\\.' + m[1].replace(/\./g, '\\.') + '"[^>]*?defaultValueLiteral="([^"]*)"').exec(text);
      out.push({ prop: m[1], nodes: m[2].split(/\s+/), def: d ? d[1] : null });
    }
    return out;
  }
  /* Does the subflow ns (instance attributes instAttrs, promoted properties applied), or a subflow nested in it, hold a writer node with validation on? */
  LR.validationBound = function (subs, ns, instAttrs, depth) {
    var s = subs[ns]; if (!s || (depth || 0) > 12) return null;
    var nodes = allNodes(s.text), val = {};
    validateLinks(s.text).forEach(function (l) { var v = attrOf(instAttrs, l.prop); if (v == null) v = l.def; l.nodes.forEach(function (id) { val[id] = v; }); });
    for (var i = 0; i < nodes.length; i++) {
      var n = nodes[i], v = Object.prototype.hasOwnProperty.call(val, n.id) ? val[n.id] : attrOf(n.attrs, 'validateMaster');
      if (n.builtin && WRITER_NODES[n.builtin]) {
        if (WRITER_NODES[n.builtin] === 'no-property' || v !== 'none') return { node: n.builtin, subflow: ns };
      } else if (n.subflow && subs[n.subflow]) {
        var inner = n.attrs + (Object.prototype.hasOwnProperty.call(val, n.id) && v != null ? ' validateMaster="' + v + '"' : ''), r = LR.validationBound(subs, n.subflow, inner, (depth || 0) + 1);
        if (r) return r;
      }
    }
    return null;
  };
  /* Does a message flow validate its messages? (its input node: SOAP Input validates by default, the others only when set) */
  LR.flowValidates = function (text) {
    return allNodes(text).some(function (n) { if (!n.builtin || !(n.builtin in INPUT_NODES)) return false; var v = attrOf(n.attrs, 'validateMaster'); return v == null ? INPUT_NODES[n.builtin] : v !== 'none'; });
  };

  LR.subflowNodes = subflowNodes;
  function promoted(text) {
    var props = {}, m, re = /<eStructuralFeatures[^>]*xmi:id="Property\.([\w.]+)"[^>]*>\s*<eType[^>]*href="[^"]*#\/\/EsqlModule"/g;
    while ((m = re.exec(text))) props[m[1]] = { forwards: [] };
    var al = /<attributeLinks promotedAttribute="Property\.([\w.]+)" overriddenNodes="([^"]+)">([\s\S]*?)<\/attributeLinks>/g;
    while ((m = al.exec(text))) {
      if (!props[m[1]]) continue;
      var hr = /href="([^"#]+)#Property\.([\w.]+)"/g, h;
      while ((h = hr.exec(m[3]))) props[m[1]].forwards.push({ nodes: m[2].split(/\s+/), target: h[1], property: h[2] });
    }
    return props;
  }

  /* ---------- plan ---------- */
  LR.analyze = function (ws, cfg, copy) {
    var LC = ACE.libconv, st = LC.state(ws, copy), P = st.byName, res = LC.emptyResult(copy), known = {};
    (cfg.knownSharedLibraries || []).forEach(function (n) { known[n] = true; });
    res.strategy = 'refactor';
    res.projects = st.projects.map(function (p) { return { name: p.name, kind: p.kind, references: p.refs.map(function (r) { return { project: r, kind: P[r] ? P[r].kind : known[r] ? 'shared-library (known)' : 'missing' }; }), referencedBy: [], metadata: p.dot.generated ? 'generated (BAR input)' : 'original' }; });
    if (ws.inputKind !== 'workspace') { res.errors.push(LR.RULES['RF-BAR-INPUT']); return finish(); }
    // group = closure as in LC (selected static libraries + dependency rules)
    var statics = st.projects.filter(function (p) { return p.kind === 'static-library'; }).map(function (p) { return p.name; });
    var sel = cfg.libraries === 'auto' || !cfg.libraries ? statics.slice() : cfg.libraries.filter(function (n) { return statics.indexOf(n) >= 0; });
    var G = {}, referencedBy = {};
    st.projects.forEach(function (p) { p.refs.forEach(function (r) { (referencedBy[r] = referencedBy[r] || []).push(p.name); }); });
    sel.forEach(function (n) { G[n] = true; });
    var grown = true;
    while (grown) { grown = false; Object.keys(G).forEach(function (n) { P[n].refs.concat(referencedBy[n] || []).forEach(function (r) { if (P[r] && P[r].kind === 'static-library' && !G[r]) { G[r] = true; grown = true; } }); }); }
    var group = Object.keys(G).sort();
    var already = st.projects.filter(function (p) { return p.kind === 'shared-library'; }).map(function (p) { return p.name; });
    if (!group.length) { res.notes.push('No static library to convert.'); return finish(); }
    var N = (cfg.sharedLibraryName || '').trim() || (group.length === 1 ? group[0] : 'SharedFramework');
    var S = (cfg.schema || '').trim() || N.toLowerCase().replace(/[^a-z0-9_]/g, '');
    var SL = S + '.local', SP = S.replace(/\./g, '/'), SLP = SL.replace(/\./g, '/');
    res.target = { sharedLibrary: N, schema: S, localSchema: SL, group: group };
    var blockers = [];
    function block(code, detail, where) { blockers.push({ code: code, rule: LR.RULES[code], detail: detail, locations: where || [] }); }
    if (!/^[A-Za-z_]\w*(\.[A-Za-z_]\w*)*$/.test(S)) block('RF-SCHEMA-TAKEN', 'schema "' + S + '" is not a valid broker schema name');
    if (P[N] && !G[N]) block('RF-NAME-TAKEN', N);

    // file inventory of the group
    var consumers = st.projects.filter(function (p) { return !G[p.name]; });
    st.projects.forEach(function (p) { p.refs.forEach(function (r) { if (!P[r] && !known[r]) block('RF-MISSING-PROJECT', p.name + ' references "' + r + '"', [{ file: p.dot.path }]); }); });
    consumers.forEach(function (c) { if (c.kind === 'integration-project' && c.refs.some(function (r) { return G[r]; })) block('RF-INTEGRATION-PROJECT', c.name, [{ file: c.dot.path }]); });
    var esqlG = [], subG = [], otherG = {}, symbolsByFile = {};
    group.forEach(function (n) {
      P[n].files.forEach(function (f) {
        var rel = f.rel, t;
        if (/^(\.project|\.classpath|library\.descriptor)$/.test(rel) || /^\.settings\//.test(rel)) return;
        if (/\.msgflow$/i.test(rel)) { block('RF-MSGFLOW', n + '/' + rel, [{ file: f.outPath }]); return; }
        if (/\.(xml|xsl|xslt|idl|mset|mxsd)$/i.test(rel) && !/^META-INF\//i.test(rel)) { block('RF-UNSUPPORTED-RESOURCE', n + '/' + rel, [{ file: f.outPath }]); return; }
        if (/\.esql$/i.test(rel)) { t = f.text(); var sy = LR.esqlSymbols(t); symbolsByFile[f.outPath] = sy; esqlG.push({ lib: n, f: f, text: t, sym: sy, rel: rel, dest: sy.schema ? rel : SP + '/' + util.basename(rel) }); return; }
        if (/\.subflow$/i.test(rel)) { t = f.text(); var ns = nsOf(t) || rel; var def = rel.indexOf('/') < 0; subG.push({ lib: n, f: f, text: t, rel: rel, oldNs: ns, dest: def ? SP + '/' + rel : rel, newNs: def ? SP + '/' + rel : ns }); return; }
        (otherG[rel] = otherG[rel] || []).push({ lib: n, f: f });
      });
    });
    ((ws.facts && ws.facts.nodes) || []).forEach(function (nd) { if (G[nd.project] && nd.kind === 'builtin' && /^ComIbm(CORBARequest|SCA\w*|XslMqsi|(SAP|Siebel|PeopleSoft|JDEdwards|JDE)(Input|Request)\w*)$/.test(nd.type)) block('RF-UNSUPPORTED-NODE', nd.project + ': ' + nd.typeLabel, [{ file: nd.flowVPath, line: nd.line }]); });
    // destination collisions
    var dests = {};
    esqlG.concat(subG).forEach(function (x) { (dests[x.dest] = dests[x.dest] || []).push(x); });
    Object.keys(dests).forEach(function (d) { if (dests[d].length > 1) block('RF-NAME-CONFLICT', d + ' from ' + dests[d].map(function (x) { return x.lib; }).join(', '), dests[d].map(function (x) { return { file: x.f.outPath }; })); });
    Object.keys(otherG).forEach(function (rel) {
      var list = otherG[rel]; if (list.length < 2) return;
      var first = list[0].f.file && list[0].f.file.bytes;
      if (!list.every(function (x) { return x.f.file && util.bytesEqual(x.f.file.bytes, first); })) block('RF-PATH-CONFLICT', rel + ' differs between ' + list.map(function (x) { return x.lib; }).join(', '), list.map(function (x) { return { file: x.f.outPath }; }));
    });
    // symbol tables: default-schema routines/modules/declarations of the group
    var gRoutines = {}, gModules = {}, gDecls = {}, modMap = {};
    esqlG.forEach(function (e) {
      var sch = e.sym.schema, ns = sch || S;
      e.sym.modules.forEach(function (m) { var k = sch + '#' + m; if (gModules[k] && gModules[k] !== e.lib) block('RF-NAME-CONFLICT', 'module ' + (sch ? sch + '.' : '') + m + ' in ' + gModules[k] + ' and ' + e.lib); gModules[k] = e.lib; modMap[k] = ns; });
      if (!sch) {
        e.sym.routines.forEach(function (r) { var u = r.toUpperCase(); if (gRoutines[u] && gRoutines[u].lib !== e.lib) block('RF-NAME-CONFLICT', 'routine ' + r + ' in ' + gRoutines[u].lib + ' and ' + e.lib); gRoutines[u] = { name: r, lib: e.lib }; });
        e.sym.decls.forEach(function (d) { gDecls[d.name.toUpperCase()] = { name: d.name, kind: d.kind, lib: e.lib, stmt: d.stmt, file: e.rel }; });
      }
    });
    var subMap = {};
    subG.forEach(function (s) { subMap[s.oldNs] = s.newNs; });
    // the target schema must be free
    st.projects.forEach(function (p) {
      if (G[p.name]) return;
      p.files.forEach(function (f) {
        if (/\.esql$/i.test(f.rel)) { var sy = LR.esqlSymbols(f.text() || ''); if (sy.schema === S || sy.schema === SL) block('RF-SCHEMA-TAKEN', p.name + '/' + f.rel + ' uses schema ' + sy.schema, [{ file: f.outPath }]); }
        if (/\.subflow$/i.test(f.rel) && (f.rel.indexOf(SP + '/') === 0)) block('RF-SCHEMA-TAKEN', p.name + '/' + f.rel, [{ file: f.outPath }]);
      });
    });
    // library ESQL calling routines that only applications define
    var appRoutines = {};
    consumers.forEach(function (c) { c.files.forEach(function (f) { if (/\.esql$/i.test(f.rel)) { var sy = LR.esqlSymbols(f.text() || ''); if (!sy.schema) sy.routines.forEach(function (r) { appRoutines[r.toUpperCase()] = c.name; }); } }); });
    esqlG.forEach(function (e) { callSites(e.sym, appRoutines).forEach(function (c) { if (!gRoutines[c.name.toUpperCase()]) block('RF-LIB-CALLS-APP', e.lib + '/' + e.rel + ' calls ' + c.name + ' (defined in ' + appRoutines[c.name.toUpperCase()] + ')', [{ file: e.f.outPath, line: util.lineAt(e.text, c.index) }]); }); });
    // Applications using schema-level declarations of the library. They cannot be referenced across schemas
    // (BIP2432E, verified for constants and namespace prefixes): CONSTANT and NAMESPACE declarations are
    // copied into the application (fixed literals); SHARED and EXTERNAL variables block (state / per-flow value).
    var declNames = Object.keys(gDecls), constUse = {};
    function usesDecl(code, d) {
      if (d.kind === 'NAMESPACE') return new RegExp('(^|[^\\w])' + d.name + '\\s*:(?!:)', 'i').exec(code) || new RegExp('(^|[^.\\w])' + d.name + '\\b(?!\\s*[(:])', 'i').exec(code);
      return new RegExp('(^|[^.\\w])' + d.name + '\\b(?!\\s*\\()', 'i').exec(code);
    }
    consumers.forEach(function (c) {
      var appDeclared = {};
      c.files.forEach(function (f) { if (/\.esql$/i.test(f.rel)) LR.esqlSymbols(f.text() || '').decls.forEach(function (d) { appDeclared[d.name.toUpperCase()] = true; }); });
      c.files.forEach(function (f) {
        if (!/\.esql$/i.test(f.rel) || !declNames.length) return;
        var t = f.text() || '', code = mask(t);
        declNames.forEach(function (u) {
          var d = gDecls[u], m;
          if (appDeclared[u] || new RegExp('\\bDECLARE\\s+' + d.name + '\\b', 'i').test(code)) return;
          if (!(m = usesDecl(code, d))) return;
          if (d.kind === 'SHARED' || d.kind === 'EXTERNAL') block('RF-CONSTANT-USE', c.name + '/' + f.rel + ' uses ' + d.kind + ' ' + d.name + ' of ' + d.lib, [{ file: f.outPath, line: util.lineAt(t, m.index) }]);
          else (constUse[c.name] = constUse[c.name] || {})[u] = true;
        });
      });
      // constants used in the initialisers of copied constants are copied as well
      var grow2 = true;
      while (constUse[c.name] && grow2) { grow2 = false; Object.keys(constUse[c.name]).forEach(function (u) { var stmtCode = mask(gDecls[u].stmt); declNames.forEach(function (v) { var d2 = gDecls[v]; if (!constUse[c.name][v] && (d2.kind === 'CONSTANT' || d2.kind === 'NAMESPACE') && !appDeclared[v] && usesDecl(stmtCode.replace(/^\s*DECLARE\s+\w+/i, ''), d2)) { constUse[c.name][v] = true; grow2 = true; } }); }); }
    });

    // hooks: subflows of the group whose promoted ESQL properties receive application modules
    var subByNs = {}; subG.forEach(function (s) { subByNs[s.oldNs] = s; s.props = promoted(s.text); });
    var hooked = {}; // oldNs -> {prop: [{consumer, module}]}
    function addHook(ns, prop, why) { var s = subByNs[ns]; if (!s) return false; var h = hooked[ns] = hooked[ns] || {}; if (h[prop]) { h[prop].push(why); return false; } h[prop] = [why]; return true; }
    consumers.forEach(function (c) {
      c.files.forEach(function (f) {
        if (!/\.(msgflow|subflow)$/i.test(f.rel)) return;
        var t = f.text() || '';
        subflowNodes(t).forEach(function (nd) {
          if (!subByNs[nd.ns]) return;
          var a, re = /(\w+)="esql:\/\/routine\/([\w.]*)#([^"#]+?)\.Main"/g;
          while ((a = re.exec(nd.attrs))) if (!((a[2] + '#' + a[3]) in gModules)) addHook(nd.ns, a[1], { consumer: c.name, file: f.outPath, module: (a[2] ? a[2] + '.' : '') + a[3] });
        });
      });
    });
    // R11: an application that validates its messages cannot run a node that writes the message inside a shared library (BIP5058E);
    // such subflows stay local to the application (recorded like a hook, property "validateMaster")
    consumers.forEach(function (c) {
      if (c.kind !== 'application' || !c.files.some(function (f) { return /\.msgflow$/i.test(f.rel) && LR.flowValidates(f.text() || ''); })) return;
      c.files.forEach(function (f) {
        if (!/\.(msgflow|subflow)$/i.test(f.rel)) return;
        subflowNodes(f.text() || '').forEach(function (nd) {
          if (!subByNs[nd.ns]) return;
          var hit = LR.validationBound(subByNs, nd.ns, nd.attrs, 0);
          if (hit) addHook(nd.ns, 'validateMaster', { consumer: c.name, file: f.outPath, module: '(message validation: the ' + hit.node + ' node writes the message; a shared library has no message model for it, BIP5058E)' });
        });
      });
    });
    // propagate along promoted-property forwarding inside the group
    var changedH = true;
    while (changedH) {
      changedH = false;
      Object.keys(hooked).forEach(function (ns) {
        var s = subByNs[ns];
        Object.keys(hooked[ns]).forEach(function (prop) {
          ((s.props[prop] || {}).forwards || []).forEach(function (fw) { if (subByNs[fw.target] && addHook(fw.target, fw.property, { forwardedFrom: ns + '#' + prop })) changedH = true; });
        });
      });
    }
    var H = Object.keys(hooked);
    // subflows nested inside hooked subflows that are themselves hooked stay local together; local copies per application
    var localNs = {}; H.forEach(function (ns) { localNs[ns] = SLP + '/' + util.basename(subByNs[ns].newNs); });
    var localsFor = {};
    consumers.forEach(function (c) {
      var need = {};
      c.files.forEach(function (f) { if (/\.(msgflow|subflow)$/i.test(f.rel)) subflowNodes(f.text() || '').forEach(function (nd) { if (hooked[nd.ns]) need[nd.ns] = true; }); });
      var grow = true;
      while (grow) { grow = false; Object.keys(need).forEach(function (ns) { subflowNodes(subByNs[ns].text).forEach(function (nd) { if (hooked[nd.ns] && !need[nd.ns]) { need[nd.ns] = true; grow = true; } }); }); }
      if (Object.keys(need).length) localsFor[c.name] = Object.keys(need).sort();
    });
    // ESQL-module promoted properties per subflow namespace (old, shared and local namespaces), for bare values
    var esqlProps = {};
    subG.forEach(function (s) { var set = {}; Object.keys(s.props).forEach(function (k) { set[k] = true; }); [s.oldNs, s.newNs, localNs[s.oldNs]].forEach(function (k) { if (k) esqlProps[k] = set; }); });
    res.hooks = H.map(function (ns) { return { subflow: ns, newNs: subMap[ns], localNs: localNs[ns], library: subByNs[ns].lib, properties: Object.keys(hooked[ns]).map(function (p) { return { property: p, setBy: hooked[ns][p] }; }) }; });

    // libraries table
    var blocked = blockers.length > 0;
    st.projects.filter(function (p) { return /library/.test(p.kind); }).forEach(function (p) {
      var rec = { name: p.name, currentType: p.kind, decision: null, reasons: [], blockers: [], referencingApplications: (referencedBy[p.name] || []).filter(function (u) { return P[u] && P[u].kind === 'application'; }), referencingLibraries: (referencedBy[p.name] || []).filter(function (u) { return P[u] && P[u].kind !== 'application'; }), usage: [], dependsOn: p.refs.map(function (r) { return { project: r, kind: P[r] ? P[r].kind : 'missing' }; }) };
      if (p.kind === 'shared-library') { rec.decision = 'already-shared'; rec.reasons.push('already a shared library'); }
      else if (!G[p.name]) { rec.decision = 'not-selected'; rec.reasons.push('not selected'); }
      else if (blocked) { rec.decision = 'blocked'; rec.blockers = blockers.map(function (b) { return { code: b.code, rule: b.rule, detail: b.detail, basis: 'refactoring', evidence: b.rule, docs: DOCS, locations: b.locations }; }); res.blockedCount++; }
      else { rec.decision = 'convert'; rec.reasons.push(group.length > 1 ? 'merged into shared library ' + N + ' (schema ' + S + ')' : 'becomes shared library ' + N + ' (schema ' + S + ')'); }
      res.libraries.push(rec);
    });
    if (blocked) { res.manualActions.push('Resolve the blocking items listed for the libraries, then analyse again. Nothing was changed.'); return finish(); }

    // ---------- edits ----------
    var E = res.edits, notes = res.notes;
    function create(path, project, text, note) { E.push({ path: path, project: project, before: '', after: text, created: true, deleted: false, notes: [note] }); }
    function del(f, project) { E.push({ path: f.outPath, project: project, before: f.text(), after: null, created: false, deleted: true, notes: ['moved into shared library ' + N] }); }
    function modify(f, project, after, ns) { var b = f.text(); if (after !== b) E.push({ path: f.outPath, project: project, before: b, after: after, created: false, deleted: false, notes: ns }); }
    // 1. the new shared library project
    var tmpl = P[group[0]].dot.text, refsN = [];
    group.forEach(function (n) { P[n].refs.forEach(function (r) { if (!G[r] && refsN.indexOf(r) < 0) refsN.push(r); }); });
    var dotN = tmpl.replace(/<name>[^<]*<\/name>/, '<name>' + util.esc(N) + '</name>').replace(/<projects>[\s\S]*?<\/projects>/, function () {
      var ind = (/\n([ \t]*)<projects>/.exec(tmpl) || [, '\t'])[1], eol = /\r\n/.test(tmpl) ? '\r\n' : '\n';
      return '<projects>' + eol + refsN.map(function (r) { return ind + '\t<project>' + util.esc(r) + '</project>' + eol; }).join('') + ind + '</projects>';
    });
    var nat = LC.addSharedNature(dotN); if (nat.error) { res.errors.push(N + '/.project: ' + nat.error); return finish(); }
    create(N + '/.project', N, nat.text, 'shared library project (natures library + sharedLibrary + messageBroker; references ' + (refsN.join(', ') || 'none') + ')');
    var descN = (group.length === 1 && N === group[0] && P[N].desc.text) || LC.newDescriptor('library');
    refsN.filter(function (r) { return (P[r] && P[r].kind === 'shared-library') || known[r]; }).forEach(function (r) { descN = LC.addDescriptorRef(descN, r).text; });
    create(N + '/library.descriptor', N, descN, 'library.descriptor');
    var settings = {};
    group.forEach(function (n) { P[n].files.forEach(function (f) { if (/^\.settings\//.test(f.rel) && !settings[f.rel]) { settings[f.rel] = true; create(N + '/' + f.rel, N, f.text(), 'Eclipse settings from ' + n); } }); });
    // 2. ESQL: relocated files get the BROKER SCHEMA line; files in named schemas move unchanged
    var groupCls = LR.libraryClasses(ws, st, group);
    esqlG.forEach(function (e) {
      var eol = /\r\n/.test(e.text) ? '\r\n' : '\n', after = e.sym.schema ? e.text : 'BROKER SCHEMA ' + S + eol + eol + e.text.replace(/^﻿/, '');
      var jc = LR.addJavaClassloader(after, N, function (c) { return !!groupCls[c]; });
      after = jc.text;
      create(N + '/' + e.dest, N, after, (e.sym.schema ? 'moved from ' + e.lib + ' (schema ' + e.sym.schema + ' unchanged)' : 'moved from ' + e.lib + '/' + e.rel + ' into broker schema ' + S) + (jc.count ? '; ' + jc.count + ' Java routine(s) get CLASSLOADER "{' + N + '}"' : ''));
      del(e.f, e.lib);
    });
    // 3. subflows of the group (all stay in the shared library)
    subG.forEach(function (s) {
      var r = LR.rewriteSubflowRefs(s.text, subMap, s.newNs), m2 = LR.rewriteModuleRefs(r.text, modMap, esqlProps);
      create(N + '/' + s.dest, N, m2.text, 'moved from ' + s.lib + '/' + s.rel + (r.notes.length ? '; ' + r.notes.length + ' subflow reference(s) updated' : '') + (m2.count ? '; ' + m2.count + ' ESQL module reference(s) qualified with ' + S : ''));
      del(s.f, s.lib);
    });
    // 4. other files (schemas, WSDL, JARs...): identical duplicates kept once
    Object.keys(otherG).sort().forEach(function (rel) {
      var list = otherG[rel];
      E.push({ path: N + '/' + rel, project: N, before: '', after: null, bytesFrom: list[0].f.file, created: true, deleted: false, notes: ['copied from ' + list.map(function (x) { return x.lib; }).join(', ') + (list.length > 1 ? ' (identical copies merged)' : '')] });
      list.forEach(function (x) { del(x.f, x.lib); });
    });
    // 5. remove the old library projects' metadata
    group.forEach(function (n) { P[n].files.forEach(function (f) { if (/^(\.project|\.classpath|library\.descriptor)$/.test(f.rel) || /^\.settings\//.test(f.rel)) del(f, n); }); });
    // 6. consumers: references, descriptors, flows, ESQL, local copies of hooked subflows
    consumers.forEach(function (c) {
      var usesG = c.refs.some(function (r) { return G[r]; });
      var locals = localsFor[c.name] || [];
      var cMap = {}; Object.keys(subMap).forEach(function (o) { cMap[o] = locals.indexOf(o) >= 0 ? localNs[o] : subMap[o]; });
      c.files.forEach(function (f) {
        var t = f.text(), ns = [];
        if (t == null) return;
        if (f.rel === '.project' && usesG) {
          var lines = t.split(/(\r?\n)/), out = [], placed = c.refs.indexOf(N) >= 0;
          for (var i = 0; i < lines.length; i += 2) {
            var line = lines[i], eol = lines[i + 1] || '', mm = /^([ \t]*)<project>([^<]+)<\/project>[ \t]*$/.exec(line);
            if (mm && mm[2] === N) { out.push(line + eol); continue; } // the shared library keeps this name
            if (mm && G[mm[2]]) { if (!placed) { out.push(mm[1] + '<project>' + util.esc(N) + '</project>' + eol); placed = true; ns.push('reference ' + mm[2] + ' -> ' + N); } else ns.push('reference ' + mm[2] + ' removed (merged into ' + N + ')'); continue; }
            out.push(line + eol);
          }
          modify(f, c.name, out.join(''), ns);
          return;
        }
        if (/\.(msgflow|subflow)$/i.test(f.rel)) {
          var r = LR.rewriteSubflowRefs(t, cMap, null), m2 = LR.rewriteModuleRefs(r.text, modMap, esqlProps);
          modify(f, c.name, m2.text, r.notes.concat(m2.count ? [m2.count + ' ESQL module reference(s) qualified with ' + S] : []));
          return;
        }
        if (/\.esql$/i.test(f.rel)) {
          var sy = LR.esqlSymbols(t), ownRoutines = {};
          sy.routines.forEach(function (x) { ownRoutines[x.toUpperCase()] = true; });
          var names = {}; Object.keys(gRoutines).forEach(function (u) { if (!ownRoutines[u] && !(sy.schema === '' && appRoutines[u] === c.name)) names[u] = true; });
          var sites = callSites(sy, names);
          if (sites.length) {
            var out2 = t; sites.slice().reverse().forEach(function (s2) { out2 = out2.slice(0, s2.index) + S + '.' + out2.slice(s2.index); });
            modify(f, c.name, out2, [sites.length + ' call(s) qualified with schema ' + S + ': ' + util.uniq(sites.map(function (s2) { return s2.name; })).join(', ')]);
          }
        }
      });
      if (usesG && (c.kind === 'application' || c.kind === 'shared-library')) {
        var dpath = c.name + '/' + (c.kind === 'application' ? 'application.descriptor' : 'library.descriptor');
        var df = c.files.filter(function (f) { return f.outPath === dpath; })[0], before = df ? df.text() : '';
        var r3 = LC.addDescriptorRef(before || LC.newDescriptor(c.kind === 'application' ? 'application' : 'library'), N);
        if (!r3.error && (r3.changed || !df)) E.push({ path: dpath, project: c.name, before: before, after: r3.text, created: !df, deleted: false, notes: ['add sharedLibraryReference ' + N] });
      }
      // copies of the library constants / namespace prefixes this application uses
      if (constUse[c.name]) {
        var used = Object.keys(constUse[c.name]).sort(function (a, b) { return (gDecls[a].file + gDecls[a].name).localeCompare(gDecls[b].file + gDecls[b].name); });
        var cf = c.name + '/' + N + '_Constants.esql';
        create(cf, c.name, ['-- Generated by IBM ACE Migration Workbench (library conversion).', '-- Copies of the schema-level CONSTANT / NAMESPACE declarations of shared library ' + N + ' (schema ' + S + ')', '-- that this application uses. ESQL cannot reference these across broker schemas (BIP2432E),', '-- so the application keeps its own copy. Keep them in sync if the framework values ever change.', ''].concat(used.map(function (u) { return gDecls[u].stmt + '   -- from ' + gDecls[u].lib + '/' + gDecls[u].file; })).join('\n') + '\n', used.length + ' constant/namespace declaration(s) copied from the framework: ' + used.map(function (u) { return gDecls[u].name; }).join(', '));
      }
      // local copies of hooked subflows (application scope; shared modules qualified)
      locals.forEach(function (ns) {
        var s = subByNs[ns], lm = {}; Object.keys(subMap).forEach(function (o) { lm[o] = locals.indexOf(o) >= 0 ? localNs[o] : subMap[o]; });
        var r4 = LR.rewriteSubflowRefs(s.text, lm, localNs[ns]), m4 = LR.rewriteModuleRefs(r4.text, modMap, esqlProps);
        create(c.name + '/' + localNs[ns], c.name, m4.text, 'local copy of ' + ns + ' (receives application ESQL modules: ' + Object.keys(hooked[ns]).join(', ') + '); uses the shared modules of ' + N);
      });
    });
    res.converted = group;
    res.sharedLibrary = N;
    res.localCopies = localsFor;
    if (H.length) notes.push(H.length + ' subflow(s) receive application ESQL modules through promoted properties and are kept local to the applications that use them (verified: such hooks fail inside a shared library, BIP4127E): ' + H.join(', '));
    notes.push('Libraries ' + group.join(', ') + ' are merged into shared library ' + N + '; default-schema ESQL and subflows move to schema ' + S + '.');
    res.manualActions.push('Every other service that uses ' + group.join(', ') + ' must be converted with the same settings (shared library name "' + N + '", schema "' + S + '") so they all use the same shared library. Services that still contain the static libraries keep working until then (verified side by side).');
    res.manualActions.push('Deploy ' + N + ' (shared-libraries.bar) before the converted services. Re-test every service: the tool validates structure; ibmint and the runtime validate the rest.');
    return finish();

    function finish() { res.build = LC.buildPlan(LC.state(ws, copy), res, (function () { var o = {}; already.forEach(function (n) { o[n] = true; }); if (res.sharedLibrary) o[res.sharedLibrary] = true; Object.keys(known).forEach(function (n) { o[n] = true; }); return o; })(), res.sharedLibrary ? { addProjects: [res.sharedLibrary], apps: st.projects.filter(function (p) { return p.kind === 'application'; }).map(function (p) { return { name: p.name, uses: p.refs.some(function (r) { return G[r]; }) ? [res.sharedLibrary] : [] }; }) } : null); return res; }
  };
  /* LANGUAGE JAVA routines in a shared library need CLASSLOADER "{Library}": without the clause the class is
   * loaded by the EGShared class loader, which does not see the shared library's Java (verified on ACE 13.0.2.0:
   * BIP3202E/BIP2943E without it, the library starts with it; IBM docs CREATE PROCEDURE, example 4).
   * hasClass(className) says whether the library (its JARs or referenced Java projects) contains the class. */
  LR.addJavaClassloader = function (text, lib, hasClass) {
    var code = mask(text), re = /\bCREATE\s+(?:FUNCTION|PROCEDURE)\s+\w+\s*\(/gi, m, inserts = [];
    while ((m = re.exec(code))) {
      var rest = code.slice(m.index), end = rest.search(/;|\bBEGIN\b/i), decl = end < 0 ? rest : rest.slice(0, end);
      if (!/\bLANGUAGE\s+JAVA\b/i.test(decl) || /\bCLASSLOADER\b/i.test(decl)) continue;
      var en = /\bEXTERNAL\s+NAME\s+"/i.exec(decl); if (!en) continue;
      var qStart = m.index + en.index + en[0].length - 1, qEnd = text.indexOf('"', qStart + 1); if (qEnd < 0) continue;
      var ext = text.slice(qStart + 1, qEnd), cls = ext.split('.').slice(0, -1).join('.');
      if (!hasClass(cls)) continue;
      inserts.push({ at: qEnd + 1, cls: cls });
    }
    var out = text; inserts.slice().reverse().forEach(function (x) { out = out.slice(0, x.at) + ' CLASSLOADER "{' + lib + '}"' + out.slice(x.at); });
    return { text: out, count: inserts.length, classes: inserts.map(function (x) { return x.cls; }) };
  };
  /* Classes available to library L: Java source in referenced Java projects and classes in JARs inside L. */
  LR.libraryClasses = function (ws, st, libs) {
    var P = st.byName, set = {};
    libs.forEach(function (L) {
      (P[L] ? P[L].refs : []).forEach(function (r) { var jp = P[r]; if (!jp || jp.kind !== 'java') return; jp.files.forEach(function (f) { var m = /^(?:src\/)?(.+)\.java$/.exec(f.rel); if (m) set[m[1].replace(/\//g, '.')] = true; }); });
      (ws.jars || []).forEach(function (j) { if (j.occurrences.some(function (o) { return o.split('/')[0] === L || o.indexOf(L + '/') === 0 || o.indexOf('/' + L + '/') >= 0; })) (j.info.classes || []).forEach(function (c) { set[c.name.replace(/\//g, '.')] = true; }); });
    });
    return set;
  };

  /* A node whose ESQL property (computeExpression, filterExpression, statement) is promoted runs the promoted value;
   * its own value is never used. Set it to the promoted property's default, so that it resolves too: in a named
   * schema the Toolkit reports an unresolvable old value ("Unable to locate URN esql://routine/..."). */
  LR.syncPromotedModules = function (text) {
    var esc = function (s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }, out = text, count = 0, m;
    var re = /<attributeLinks promotedAttribute="([^"]+)" overriddenNodes="([^"]+)">\s*<overriddenAttribute href="ComIbm(?:Compute|Filter|Database)\.msgnode#Property\.(computeExpression|filterExpression|statement)"/g;
    while ((m = re.exec(text))) {
      var def = (text.match(new RegExp('xmi:id="' + esc(m[1]) + '"[^>]*defaultValueLiteral="([^"]*)"')) || [])[1];
      if (!def || !/^esql:\/\//.test(def)) continue;
      m[2].split(/\s+/).forEach(function (id) {
        out = out.replace(new RegExp('(<nodes [^>]*xmi:id="' + esc(id) + '"[^>]*\\s' + m[3] + '=")([^"]*)(")'), function (a, p, v, s) { if (v !== def) count++; return p + def + s; });
      });
    }
    return { text: out, count: count };
  };

  /* Add <project> references to a .project text (keeps everything else; no duplicates). */
  LR.addProjectRefs = function (text, names) {
    var dp = ACE.bar.parseDotProject(text), add = names.filter(function (n) { return dp.projects.indexOf(n) < 0; });
    if (!add.length) return text;
    var eol = /\r\n/.test(text) ? '\r\n' : '\n', m = /([ \t]*)<\/projects>/.exec(text);
    if (m) { var ind = m[1] + '\t'; return text.slice(0, m.index) + add.map(function (n) { return ind + '<project>' + util.esc(n) + '</project>' + eol; }).join('') + text.slice(m.index); }
    var e = /<projects\s*\/>/.exec(text); if (!e) return text;
    return text.slice(0, e.index) + '<projects>' + eol + add.map(function (n) { return '\t\t<project>' + util.esc(n) + '</project>' + eol; }).join('') + '\t</projects>' + text.slice(e.index + e[0].length);
  };

  /* ---------- strategy "separate": every library keeps its name and stays a separate shared library ----------
   * Same runtime rules as above. Per library L:
   *   - .project gets the sharedLibraryNature; default-schema ESQL and subflows move into schema L (folder L/);
   *   - a subflow of another library nested in L is copied into L (schema L.local.<Owner>) - R8; the copy's compute
   *     nodes run the owner's modules (verified: a shared library can run a module of a shared library it references);
   *   - calls to other libraries' routines are schema-qualified; their constants/namespaces used by L are copied;
   *   - references needed at run time are added to .project and library.descriptor.
   * Applications: as in the merge strategy, but each library keeps its own name and schema. */
  LR.analyzeSeparate = function (ws, cfg, copy) {
    var LC = ACE.libconv, st = LC.state(ws, copy), P = st.byName, res = LC.emptyResult(copy), known = {};
    (cfg.knownSharedLibraries || []).forEach(function (n) { known[n] = true; });
    res.strategy = 'separate';
    res.projects = st.projects.map(function (p) { return { name: p.name, kind: p.kind, references: p.refs.map(function (r) { return { project: r, kind: P[r] ? P[r].kind : known[r] ? 'shared-library (known)' : 'missing' }; }), referencedBy: [], metadata: 'original' }; });
    var already = st.projects.filter(function (p) { return p.kind === 'shared-library'; }).map(function (p) { return p.name; });
    function finish(target) { res.build = LC.buildPlan(LC.state(ws, copy), res, (function () { var o = {}; already.concat(res.converted || []).forEach(function (n) { o[n] = true; }); Object.keys(known).forEach(function (n) { o[n] = true; }); return o; })(), target || null); return res; }
    if (ws.inputKind !== 'workspace') { res.errors.push(LR.RULES['RF-BAR-INPUT']); return finish(); }
    var statics = st.projects.filter(function (p) { return p.kind === 'static-library'; }).map(function (p) { return p.name; });
    var sel = cfg.libraries === 'auto' || !cfg.libraries ? statics.slice() : cfg.libraries.filter(function (n) { return statics.indexOf(n) >= 0; });
    var G = {}, referencedBy = {};
    st.projects.forEach(function (p) { p.refs.forEach(function (r) { (referencedBy[r] = referencedBy[r] || []).push(p.name); }); });
    sel.forEach(function (n) { G[n] = true; });
    var grown = true;
    while (grown) { grown = false; Object.keys(G).forEach(function (n) { P[n].refs.concat(referencedBy[n] || []).forEach(function (r) { if (P[r] && P[r].kind === 'static-library' && !G[r]) { G[r] = true; grown = true; } }); }); }
    var group = Object.keys(G).sort();
    if (!group.length) { res.notes.push('No static library to convert.'); return finish(); }
    function schemaOf(L) { return L; }
    function pathOf(sch) { return sch.replace(/\./g, '/'); }
    res.target = { group: group, schemas: group.map(function (L) { return L + ' -> schema ' + schemaOf(L); }) };
    var blockers = [];
    function block(code, detail, where) { blockers.push({ code: code, rule: LR.RULES[code] || code, detail: detail, locations: where || [] }); }
    var consumers = st.projects.filter(function (p) { return !G[p.name]; });
    st.projects.forEach(function (p) { p.refs.forEach(function (r) { if (!P[r] && !known[r]) block('RF-MISSING-PROJECT', p.name + ' references "' + r + '"', [{ file: p.dot.path }]); }); });
    consumers.forEach(function (c) { if (c.kind === 'integration-project' && c.refs.some(function (r) { return G[r]; })) block('RF-INTEGRATION-PROJECT', c.name, [{ file: c.dot.path }]); });
    group.forEach(function (L) { if (!/^[A-Za-z_]\w*$/.test(L)) block('RF-SCHEMA-TAKEN', 'library name "' + L + '" cannot be used as a broker schema name'); });

    // inventory and owner maps
    var subs = {}, esqls = [], modOwner = {}, routineOwner = {}, declOwner = {}, esqlProps = {};
    group.forEach(function (L) {
      P[L].files.forEach(function (f) {
        var rel = f.rel;
        if (/\.msgflow$/i.test(rel)) block('RF-MSGFLOW', L + '/' + rel, [{ file: f.outPath }]);
        else if (/\.(xml|xsl|xslt|idl|mset|mxsd)$/i.test(rel) && !/^META-INF\//i.test(rel)) block('RF-UNSUPPORTED-RESOURCE', L + '/' + rel, [{ file: f.outPath }]);
        else if (/\.esql$/i.test(rel)) {
          var t = f.text() || '', sy = LR.esqlSymbols(t);
          esqls.push({ lib: L, f: f, text: t, sym: sy, rel: rel, moved: !sy.schema, dest: sy.schema ? rel : pathOf(schemaOf(L)) + '/' + util.basename(rel) });
          sy.modules.forEach(function (m) { var k = sy.schema + '#' + m; if (modOwner[k] && modOwner[k] !== L) block('RF-NAME-CONFLICT', 'module ' + m + ' in ' + modOwner[k] + ' and ' + L); modOwner[k] = L; });
          if (!sy.schema) {
            sy.routines.forEach(function (r) { var u = r.toUpperCase(); if (routineOwner[u] && routineOwner[u] !== L) block('RF-NAME-CONFLICT', 'routine ' + r + ' in ' + routineOwner[u] + ' and ' + L); routineOwner[u] = L; });
            sy.decls.forEach(function (d) { declOwner[d.name.toUpperCase()] = { lib: L, name: d.name, kind: d.kind, stmt: d.stmt, file: rel }; });
          }
        } else if (/\.subflow$/i.test(rel)) {
          var tx = f.text() || '', ns = nsOf(tx) || rel, def = rel.indexOf('/') < 0;
          subs[ns] = { owner: L, f: f, text: tx, rel: rel, oldNs: ns, newNs: def ? pathOf(schemaOf(L)) + '/' + rel : ns, dest: def ? pathOf(schemaOf(L)) + '/' + rel : rel, props: promoted(tx) };
          var set = {}; Object.keys(subs[ns].props).forEach(function (k) { set[k] = true; }); esqlProps[ns] = set; esqlProps[subs[ns].newNs] = set;
        }
      });
    });
    var modMap = {}; Object.keys(modOwner).forEach(function (k) { if (k.charAt(0) === '#') modMap[k] = schemaOf(modOwner[k]); });
    // schema names must be free elsewhere
    consumers.forEach(function (c) { c.files.forEach(function (f) { if (/\.esql$/i.test(f.rel)) { var sy = LR.esqlSymbols(f.text() || ''); if (G[sy.schema] || group.some(function (L) { return sy.schema.indexOf(L + '.') === 0; })) block('RF-SCHEMA-TAKEN', c.name + '/' + f.rel + ' already uses schema ' + sy.schema, [{ file: f.outPath }]); } }); });
    // library code calling application routines
    var appRoutines = {};
    consumers.forEach(function (c) { c.files.forEach(function (f) { if (/\.esql$/i.test(f.rel)) { var sy = LR.esqlSymbols(f.text() || ''); if (!sy.schema) sy.routines.forEach(function (r) { appRoutines[r.toUpperCase()] = c.name; }); } }); });
    esqls.forEach(function (e) { callSites(e.sym, appRoutines).forEach(function (c) { if (!routineOwner[c.name.toUpperCase()]) block('RF-LIB-CALLS-APP', e.lib + '/' + e.rel + ' calls ' + c.name + ' (defined in ' + appRoutines[c.name.toUpperCase()] + ')', [{ file: e.f.outPath, line: util.lineAt(e.text, c.index) }]); }); });

    var needRefs = {}, created = [], edits = res.edits, localOf = {}, constCopies = {}, classesOf = {};
    function needRef(C, L) { if (C !== L && G[L]) (needRefs[C] = needRefs[C] || {})[L] = true; }
    function scopeOf(L) { var out = {}; out[L] = true; (P[L] ? P[L].refs : []).forEach(function (r) { out[r] = true; }); return out; }
    function isApp(C) { return !G[C]; }
    function localNsFor(C, T) { var s = subs[T]; return (isApp(C) ? C : pathOf(schemaOf(C))) + '/local/' + s.owner + '/' + util.basename(s.newNs); }
    function hookedFor(T, attrs) {
      var s = subs[T], sc = scopeOf(s.owner), a, re = /(\w+)="esql:\/\/routine\/([\w.]*)#([^"#]+?)\.Main"/g;
      while ((a = re.exec(attrs))) { var own = modOwner[a[2] + '#' + a[3]]; if (!own || !sc[own]) return true; }
      var props = esqlProps[T] || {}, b, br = /(\s)([\w.]+)="([A-Za-z_][^"\s.#\/:]*)"/g;
      while ((b = br.exec(attrs))) { if (!props[b[2]]) continue; var own2 = modOwner['#' + b[3]]; if (!own2 || !sc[own2]) return true; }
      return false;
    }
    function hasJavaCompute(T) { return /ComIbmJavaCompute\.msgnode:FCMComposite_1"/.test(subs[T].text); }
    var appValCache = {};
    function appValidates(C) { if (!(C in appValCache)) appValCache[C] = (P[C].files || []).some(function (f) { return /\.msgflow$/i.test(f.rel) && LR.flowValidates(f.text() || ''); }); return appValCache[C]; }
    var valWhy = {};   // key C|T -> the writer node that needs the application's message model
    function validationBoundFor(C, T, instances) {
      if (!isApp(C) || !appValidates(C)) return false;
      for (var i = 0; i < instances.length; i++) { var r = LR.validationBound(subs, T, instances[i].attrs, 0); if (r) { if (hasJavaCompute(T)) { (res.warnings = res.warnings || []).push(C + ': subflow ' + T + ' (the ' + r.node + ' node is in ' + r.subflow + ') needs the application message model (BIP5058E when validation is on), but it also contains a JavaCompute node whose Java classes an application cannot load from a shared library. Check it by hand.'); return false; } valWhy[C + '|' + T] = r; return true; } }
      return false;
    }
    /* Rewrite a flow/subflow text that belongs to container C (its own file or a local copy).
     * inLocal: the text is a local copy in an application. Its nested subflows are copied too (Toolkit 13.0.2.0:
     * an application subflow with promoted properties that nests shared-library subflows fails validation,
     * "Property ... promoted from node ... can not be resolved"), except subflows with JavaCompute nodes:
     * the application cannot load a shared library's Java classes ("Class ... is not accessible"). */
    function processFlow(C, text, selfNs, inLocal) {
      var map = {}, notes = [];
      var fileNodes = subflowNodes(text);
      var bySub = {}; fileNodes.forEach(function (nd) { if (subs[nd.ns]) (bySub[nd.ns] = bySub[nd.ns] || []).push(nd); });
      Object.keys(bySub).forEach(function (T) {
        var s = subs[T];
        if (s.owner === C) { map[T] = s.newNs; return; }
        var local = !isApp(C) || bySub[T].some(function (nd) { return hookedFor(T, nd.attrs); }) || (inLocal && !hasJavaCompute(T)) || validationBoundFor(C, T, bySub[T]);
        if (local) map[T] = localize(C, T);
        else { map[T] = s.newNs; needRef(C, s.owner); }
      });
      // module references: qualified with the owner's schema; the owner must be visible
      moduleRefs(text).forEach(function (r) { var o = modOwner[r.schema + '#' + r.module]; if (o) needRef(C, o); });
      var bare = /(\s)(computeExpression|filterExpression|statement)="([A-Za-z_][^"\s.#\/:]*)"/g, b;
      while ((b = bare.exec(text))) { var o2 = modOwner['#' + b[3]]; if (o2) needRef(C, o2); }
      var dv = /defaultValueLiteral="([A-Za-z_][^"\s.#\/:]*)"[^>]*>\s*<eType[^>]*#\/\/EsqlModule"/g, d; while ((d = dv.exec(text))) { var o3 = modOwner['#' + d[1]]; if (o3) needRef(C, o3); }
      var r1 = LR.rewriteSubflowRefs(text, map, selfNs), r2 = LR.rewriteModuleRefs(r1.text, modMap, esqlProps), r3 = LR.syncPromotedModules(r2.text);
      return { text: r3.text, notes: r1.notes.concat(r2.count ? [r2.count + ' ESQL module reference(s) schema-qualified'] : []).concat(r3.count ? [r3.count + ' node(s) with a promoted ESQL property get the promoted value (the old node value is never used and does not resolve in a named schema)'] : []) };
    }
    function localize(C, T) {
      var key = C + '|' + T; if (localOf[key]) return localOf[key];
      var ns = localNsFor(C, T); localOf[key] = ns;
      var r = processFlow(C, subs[T].text, ns, isApp(C));
      created.push({ path: C + '/' + ns, project: C, text: r.text, note: 'local copy of ' + subs[T].owner + '/' + subs[T].rel + (isApp(C) ? (valWhy[C + '|' + T] ? ' (contains a ' + valWhy[C + '|' + T].node + ' node that writes the message while validation is on; a shared library has no message model for the application messages: BIP5058E. The copy runs in the application, like a static library did)' : ' (receives application ESQL modules - not possible inside a shared library, BIP4127E - or is nested in such a copy)') : ' (a shared library cannot use a subflow of another shared library, BIP1360E)') });
      return ns;
    }
    /* ESQL text of container C: qualify calls to other libraries' routines; collect constants to copy. */
    function processEsql(C, text, schemaOfFile) {
      var sy = LR.esqlSymbols(text), own = {}, names = {};
      sy.routines.forEach(function (x) { own[x.toUpperCase()] = true; });
      Object.keys(routineOwner).forEach(function (u) { if (routineOwner[u] !== C && !own[u] && !(isApp(C) && appRoutines[u] === C)) names[u] = true; });
      var sites = callSites(sy, names), out = text;
      sites.slice().reverse().forEach(function (s2) { var o = routineOwner[s2.name.toUpperCase()]; needRef(C, o); out = out.slice(0, s2.index) + schemaOf(o) + '.' + out.slice(s2.index); });
      var code = mask(text);
      Object.keys(declOwner).forEach(function (u) {
        var d = declOwner[u]; if (d.lib === C || schemaOfFile) return;
        if (new RegExp('\\bDECLARE\\s+' + d.name + '\\b', 'i').test(code)) return;
        var used = d.kind === 'NAMESPACE' ? (new RegExp('(^|[^\\w])' + d.name + '\\s*:(?!:)', 'i').test(code) || new RegExp('(^|[^.\\w])' + d.name + '\\b(?!\\s*[(:])', 'i').test(code)) : new RegExp('(^|[^.\\w])' + d.name + '\\b(?!\\s*\\()', 'i').test(code);
        if (!used) return;
        if (d.kind === 'SHARED' || d.kind === 'EXTERNAL') block('RF-CONSTANT-USE', C + ' uses ' + d.kind + ' ' + d.name + ' of ' + d.lib); else (constCopies[C] = constCopies[C] || {})[u] = true;
      });
      return { text: out, notes: sites.length ? [sites.length + ' call(s) schema-qualified: ' + util.uniq(sites.map(function (s2) { return s2.name; })).join(', ')] : [] };
    }

    // libraries
    group.forEach(function (L) {
      P[L].files.forEach(function (f) {
        if (/\.esql$/i.test(f.rel)) {
          var e = esqls.filter(function (x) { return x.f === f; })[0], r = processEsql(L, e.text, e.sym.schema);
          var eol = /\r\n/.test(e.text) ? '\r\n' : '\n', after = e.moved ? 'BROKER SCHEMA ' + schemaOf(L) + eol + eol + r.text.replace(/^﻿/, '') : r.text;
          var libCls = classesOf[L] = classesOf[L] || LR.libraryClasses(ws, st, [L]);
          var jc = LR.addJavaClassloader(after, L, function (c) { return !!libCls[c]; });
          if (jc.count) { after = jc.text; r.notes.push(jc.count + ' Java routine(s) get CLASSLOADER "{' + L + '}" (class ' + util.uniq(jc.classes).join(', ') + ' is in the shared library)'); }
          if (e.moved) { edits.push({ path: L + '/' + e.dest, project: L, before: '', after: after, created: true, deleted: false, notes: ['moved into broker schema ' + schemaOf(L)].concat(r.notes) }); edits.push({ path: f.outPath, project: L, before: e.text, after: null, created: false, deleted: true, notes: ['moved to ' + L + '/' + e.dest] }); }
          else if (after !== e.text) edits.push({ path: f.outPath, project: L, before: e.text, after: after, created: false, deleted: false, notes: r.notes });
        } else if (/\.subflow$/i.test(f.rel)) {
          var s = subs[nsOf(f.text() || '') || f.rel], r2 = processFlow(L, s.text, s.newNs);
          if (s.dest !== s.rel) { edits.push({ path: L + '/' + s.dest, project: L, before: '', after: r2.text, created: true, deleted: false, notes: ['moved into broker schema ' + schemaOf(L)].concat(r2.notes) }); edits.push({ path: f.outPath, project: L, before: s.text, after: null, created: false, deleted: true, notes: ['moved to ' + L + '/' + s.dest] }); }
          else if (r2.text !== s.text) edits.push({ path: f.outPath, project: L, before: s.text, after: r2.text, created: false, deleted: false, notes: r2.notes });
        }
      });
    });
    // consumers (applications and other projects that use the libraries)
    consumers.forEach(function (c) {
      if (!c.refs.some(function (r) { return G[r]; })) return;
      c.files.forEach(function (f) {
        var t = f.text(); if (t == null) return;
        if (/\.(msgflow|subflow)$/i.test(f.rel)) { var r = processFlow(c.name, t, null); if (r.text !== t) edits.push({ path: f.outPath, project: c.name, before: t, after: r.text, created: false, deleted: false, notes: r.notes }); }
        else if (/\.esql$/i.test(f.rel)) { var sy = LR.esqlSymbols(t); var r2 = processEsql(c.name, t, sy.schema); if (r2.text !== t) edits.push({ path: f.outPath, project: c.name, before: t, after: r2.text, created: false, deleted: false, notes: r2.notes }); }
      });
    });
    created.forEach(function (x) { edits.push({ path: x.path, project: x.project, before: '', after: x.text, created: true, deleted: false, notes: [x.note] }); });
    // constants copies
    Object.keys(constCopies).forEach(function (C) {
      var used = Object.keys(constCopies[C]).sort(), byOwner = {};
      used.forEach(function (u) { (byOwner[declOwner[u].lib] = byOwner[declOwner[u].lib] || []).push(u); });
      Object.keys(byOwner).forEach(function (O) {
        var app = isApp(C), path = C + '/' + (app ? '' : pathOf(schemaOf(C)) + '/') + O + '_Constants.esql';
        var lines = (app ? [] : ['BROKER SCHEMA ' + schemaOf(C), '']).concat(['-- Generated by IBM ACE Migration Workbench (library conversion).', '-- Copies of schema-level CONSTANT / NAMESPACE declarations of shared library ' + O + ' (schema ' + schemaOf(O) + ')', '-- used here. ESQL cannot reference these across broker schemas (BIP2432E), so ' + C + ' keeps its own copy.', '']).concat(byOwner[O].map(function (u) { return declOwner[u].stmt + '   -- from ' + O + '/' + declOwner[u].file; }));
        edits.push({ path: path, project: C, before: '', after: lines.join('\n') + '\n', created: true, deleted: false, notes: [byOwner[O].length + ' constant/namespace declaration(s) copied from ' + O + ': ' + byOwner[O].map(function (u) { return declOwner[u].name; }).join(', ')] });
      });
    });
    // references (.project + descriptor) and shared nature; cycle check
    var finalRefs = {};
    st.projects.forEach(function (p) { finalRefs[p.name] = p.refs.concat(Object.keys(needRefs[p.name] || {})).filter(function (r, i, a) { return a.indexOf(r) === i; }); });
    var visiting = {}, doneC = {};
    function dfs(n, stack) { if (doneC[n] || !G[n]) return; if (visiting[n]) { block('RF-CYCLE', stack.slice(stack.indexOf(n)).concat([n]).join(' -> ')); return; } visiting[n] = true; stack.push(n); finalRefs[n].forEach(function (r) { if (G[r]) dfs(r, stack); }); stack.pop(); visiting[n] = false; doneC[n] = true; }
    group.forEach(function (L) { dfs(L, []); });
    LR.RULES['RF-CYCLE'] = LR.RULES['RF-CYCLE'] || 'Libraries would reference each other in a cycle; shared libraries cannot (if A references B, B cannot reference A).';
    // libraries table
    var blocked = blockers.length > 0;
    st.projects.filter(function (p) { return /library/.test(p.kind); }).forEach(function (p) {
      var rec = { name: p.name, currentType: p.kind, decision: null, reasons: [], blockers: [], referencingApplications: (referencedBy[p.name] || []).filter(function (u) { return P[u] && P[u].kind === 'application'; }), referencingLibraries: (referencedBy[p.name] || []).filter(function (u) { return P[u] && P[u].kind !== 'application'; }), usage: [], dependsOn: p.refs.map(function (r) { return { project: r, kind: P[r] ? P[r].kind : 'missing' }; }) };
      if (p.kind === 'shared-library') { rec.decision = 'already-shared'; rec.reasons.push('already a shared library'); }
      else if (!G[p.name]) { rec.decision = 'not-selected'; rec.reasons.push('not selected'); }
      else if (blocked) { rec.decision = 'blocked'; rec.blockers = blockers.map(function (b) { return { code: b.code, rule: b.rule, detail: b.detail, basis: 'refactoring', evidence: b.rule, docs: DOCS, locations: b.locations }; }); res.blockedCount++; }
      else { rec.decision = 'convert'; rec.reasons.push('stays "' + p.name + '" - becomes a shared library (schema ' + schemaOf(p.name) + ')'); }
      res.libraries.push(rec);
    });
    if (blocked) { res.edits = []; res.manualActions.push('Resolve the blocking items listed for the libraries, then analyse again. Nothing was changed.'); return finish(); }
    group.forEach(function (L) {
      var t = P[L].dot.text, n1 = LC.addSharedNature(t); if (n1.error) { res.errors.push(L + ': ' + n1.error); return; }
      var add = Object.keys(needRefs[L] || {}), after = LR.addProjectRefs(n1.text, add);
      edits.push({ path: P[L].dot.path, project: L, before: t, after: after, created: false, deleted: false, notes: ['add sharedLibraryNature'].concat(add.length ? ['add reference(s) ' + add.join(', ') + ' (used at run time)'] : []) });
    });
    st.projects.forEach(function (p) {
      if (!G[p.name] && !p.refs.some(function (r) { return G[r]; })) return;
      if (!G[p.name] && p.kind !== 'application') return;
      if (!G[p.name]) { var add2 = Object.keys(needRefs[p.name] || {}); if (add2.length) { var t2 = p.dot.text, a2 = LR.addProjectRefs(t2, add2); if (a2 !== t2) edits.push({ path: p.dot.path, project: p.name, before: t2, after: a2, created: false, deleted: false, notes: ['add reference(s) ' + add2.join(', ')] }); } }
      var refsShared = finalRefs[p.name].filter(function (r) { return G[r] || already.indexOf(r) >= 0 || known[r]; });
      if (!refsShared.length || !p.desc.path) return;
      var before = p.desc.text || '', txt = before || LC.newDescriptor(p.kind === 'application' ? 'application' : 'library'), notes = [];
      refsShared.forEach(function (r) { var x = LC.addDescriptorRef(txt, r); if (x.error) res.errors.push(p.name + ': ' + x.error); else if (x.changed) { txt = x.text; notes.push('add sharedLibraryReference ' + r); } });
      if (notes.length || !before) edits.push({ path: p.desc.path, project: p.name, before: before, after: txt, created: !before, deleted: false, notes: notes });
    });
    res.converted = group;
    res.localCopies = {}; Object.keys(localOf).forEach(function (k) { var c = k.split('|')[0]; (res.localCopies[c] = res.localCopies[c] || []).push(k.split('|')[1] + ' -> ' + localOf[k]); });
    res.hooks = [];
    res.notes.push('Libraries keep their names and stay separate: ' + group.map(function (L) { return L + ' (schema ' + schemaOf(L) + ')'; }).join(', ') + '.');
    var nLocal = Object.keys(localOf).length;
    if (nLocal) res.notes.push(nLocal + ' local subflow cop(ies): ' + Object.keys(res.localCopies).map(function (c) { return c + ' ' + res.localCopies[c].length; }).join(', ') + '. Verified on ACE 13.0.2.0: a shared library cannot use a subflow of another shared library (BIP1360E) and a shared subflow cannot run an application module (BIP4127E); the copies run the owners\' shared modules.');
    res.manualActions.push('Deploy the shared libraries before the services (deploy order: the libraries that others reference first). Convert every other service with the same strategy so they use the same libraries.');
    return finish({ addProjects: [], apps: st.projects.filter(function (p) { return p.kind === 'application'; }).map(function (p) { return { name: p.name, uses: finalRefs[p.name].filter(function (r) { return G[r] || already.indexOf(r) >= 0; }) }; }) });
  };
})(window.ACE);
