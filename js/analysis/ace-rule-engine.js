/* ACE 12 -> 13 rule engine.
 * 1. buildFacts(ws): parses every flow and ESQL file, applies broker.xml overrides to node attributes
 *    ("effective" values), resolves references across projects, collects policies/DSNs/endpoints.
 * 2. evaluate(facts, ruleSet, docs): evaluates declarative rules and records, per rule, whether its
 *    documentation keywords were found in locally imported IBM documentation. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var eng = ACE.aceRules = {};

  eng.buildFacts = function (ws) {
    var layout = ACE.project.layout(ws);
    var byFile = {}; layout.files.forEach(function (l) { byFile[l.fileId] = l; });
    var facts = { flows: [], nodes: [], esql: [], overrides: [], policyRefs: [], policyFiles: [], dataSources: [], endpoints: [], filePaths: [], unresolved: [], layout: layout };

    // broker.xml overrides from every deployable
    (ws.model.deployables || []).concat(ws.model.rootBrokerXml ? [{ name: ws.barName, brokerXml: ws.model.rootBrokerXml }] : []).forEach(function (d) {
      if (!d.brokerXml) return;
      d.brokerXml.parsed.properties.forEach(function (p) { facts.overrides.push({ deployable: d.name, vpath: d.brokerXml.vpath, uri: p.uri, value: p.override, flow: p.flow }); });
    });
    var ovIdx = {};
    facts.overrides.forEach(function (o) { if (o.value != null) ovIdx[o.uri] = o; });

    ws.files.forEach(function (f) {
      if (!f.bytes) return;
      var l = byFile[f.id];
      if (f.ext === 'msgflow' || f.ext === 'subflow') {
        var p = ACE.msgflow.parse(ACE.bar.text(f), f.vpath);
        p.project = l ? l.project : null; p.relPath = l ? l.relPath : f.path; p.fileId = f.id;
        facts.flows.push(p);
        p.nodes.forEach(function (n) {
          n.flow = p.name; n.flowVPath = f.vpath; n.project = p.project; n.relPath = p.relPath;
          n.effective = Object.assign({}, n.attrs); n.overridden = {};
          facts.overrides.forEach(function (o) {
            var pre = p.name + '#' + n.label + '.';
            if (o.value != null && o.uri.indexOf(pre) === 0) { var k = o.uri.slice(pre.length); n.effective[k] = o.value; n.overridden[k] = o.vpath; }
          });
          facts.nodes.push(n);
        });
      } else if (f.ext === 'esql') {
        var e = ACE.esql.parse(ACE.bar.text(f), f.vpath);
        e.project = l ? l.project : null; e.relPath = l ? l.relPath : f.path; e.fileId = f.id;
        e.expectedSchema = ACE.esql.expectedSchema(e.relPath);
        facts.esql.push(e);
      } else if (f.ext === 'policyxml' || (f.cls && f.cls.kind === 'policy')) {
        facts.policyFiles.push({ vpath: f.vpath, project: l ? l.project : util.dirname(f.path).split('/')[0], name: util.stripExt(f.name) });
      }
    });

    function addPolicyRef(val, where) {
      var m = /^\{([^}]*)\}:(.+)$/.exec(String(val || '').trim());
      if (m) facts.policyRefs.push({ project: m[1], name: m[2], ref: val, where: where });
    }
    facts.nodes.forEach(function (n) {
      var where = n.flowVPath + ' > ' + n.label;
      Object.keys(n.effective).forEach(function (k) {
        var v = n.effective[k];
        addPolicyRef(v, where + ' (' + k + (n.overridden[k] ? ', BAR override' : '') + ')');
        if (/^dataSource$/i.test(k) && v) facts.dataSources.push({ name: v, where: where, nodeType: n.typeLabel });
        // Namespace URIs (targetNamespace etc.) look like URLs but are identifiers, not endpoints.
        if (/^https?:\/\//i.test(v) && !/namespace|^ns$|^xmlns/i.test(k)) facts.endpoints.push({ url: v, where: where + ' (' + k + ')' });
        if (/^[A-Za-z]:\\|^\/(var|opt|home|tmp|usr|etc)\//.test(v) && /path|dir|file/i.test(k)) facts.filePaths.push({ path: v, where: where + ' (' + k + ')' });
      });
    });
    facts.overrides.forEach(function (o) {
      if (o.value == null) return;
      var nodeHit = facts.nodes.some(function (n) { return o.uri.indexOf(n.flow + '#' + n.label + '.') === 0; });
      if (nodeHit) return; // already counted through the node's effective attributes
      var where = o.vpath + ' (' + o.uri + ')';
      addPolicyRef(o.value, where);
      if (/\.dataSource$/i.test(o.uri) || /#dataSource$/.test(o.uri)) facts.dataSources.push({ name: o.value, where: where, nodeType: 'BAR override' });
      if (/^https?:\/\//i.test(o.value)) facts.endpoints.push({ url: o.value, where: where });
      if (/^[A-Za-z]:\\|^\/(var|opt|home|tmp|usr|etc)\//.test(o.value)) facts.filePaths.push({ path: o.value, where: where });
    });
    // Policy references embedded in Java bytecode strings (e.g. MbPolicy.getPolicy("UserDefined", "{Policies}:" + name))
    facts.javaPolicyHints = [];
    (ws.jars || []).forEach(function (jr) {
      if (jr.classification.type !== 'application') return;
      jr.info.classes.forEach(function (cf) {
        var usesPolicyApi = cf.classRefs.indexOf('com/ibm/broker/plugin/MbPolicy') >= 0;
        cf.strings.forEach(function (s) {
          var m = /^\{([^}]*)\}:(.*)$/.exec(s);
          if (m) {
            if (m[2]) addPolicyRef(s, jr.occurrences[0] + '!/' + cf.path);
            else {
              var others = cf.strings.filter(function (x) { return /^[A-Z][A-Za-z0-9]+$/.test(x) && x !== 'UserDefined'; });
              facts.javaPolicyHints.push({ project: m[1], where: jr.occurrences[0] + '!/' + cf.path, policyApi: usesPolicyApi, types: cf.strings.filter(function (x) { return /^(UserDefined|JDBCProviders|MQEndpoint|SecurityProfiles|SOAP|HTTP)/.test(x); }), candidateNames: others });
              facts.policyRefs.push({ project: m[1], name: '(computed at run time)', ref: s + '<name>', where: jr.occurrences[0] + '!/' + cf.path + ' builds the policy name at run time; candidate names in the class: ' + others.join(', ') });
            }
          }
        });
      });
    });
    // ESQL DSN references (Database.{DSN}... are rare; most come from node dataSource)
    facts.dataSources = dedupe(facts.dataSources, function (d) { return d.name + '|' + d.where; });

    // --- reference resolution ---
    var modIdx = {};
    facts.esql.forEach(function (e) { e.modules.forEach(function (m) { var k = (e.schema || '') + '#' + m.name; (modIdx[k] = modIdx[k] || []).push({ file: e.vpath, project: e.project }); }); });
    facts.flows.forEach(function (fl) {
      fl.esqlRefs.forEach(function (r) {
        var k = (r.schema || '') + '#' + r.module;
        if (!modIdx[k]) {
          var cin = fl.connections.filter(function (c) { return c.target === r.nodeId; }).length, cout = fl.connections.filter(function (c) { return c.source === r.nodeId; }).length;
          facts.unresolved.push({ kind: 'ESQL module', ref: (r.schema ? r.schema + '.' : '') + r.module, where: fl.vpath + ' > ' + r.nodeLabel + ' (' + r.attr + '; node has ' + cin + ' incoming / ' + cout + ' outgoing connection(s)' + (cin ? ', so it is reachable' : ', unwired') + ')', line: r.line });
        }
        else r.resolvedTo = modIdx[k][0].file;
      });
      fl.subflowRefs.forEach(function (s) {
        var hit = layout.files.filter(function (l) { return l.relPath === s.path; });
        if (!hit.length) facts.unresolved.push({ kind: 'Subflow', ref: s.path, where: fl.vpath + ' > ' + s.label, line: s.line });
        else s.resolvedTo = hit.map(function (h) { return h.project + '/' + h.relPath; });
      });
      fl.javaClasses.forEach(function (j) {
        var internal = j.className.replace(/\./g, '/');
        var inJar = (ws.jars || []).filter(function (jr) { return jr.info.classes.some(function (c) { return c.name === internal; }); });
        var inSrc = ws.files.filter(function (f) { return f.ext === 'java' && f.path.replace(/\.java$/, '').slice(-internal.length) === internal; });
        if (!inJar.length && !inSrc.length) facts.unresolved.push({ kind: 'JavaCompute class', ref: j.className, where: fl.vpath + ' > ' + j.nodeLabel, line: j.line });
        else j.resolvedTo = inJar.map(function (x) { return x.name; }).concat(inSrc.map(function (x) { return x.vpath; }));
      });
    });
    facts.esql.forEach(function (e) {
      e.javaRoutines.forEach(function (r) {
        if (!r.external) return;
        var cls = r.external.split('.').slice(0, -1).join('/');
        var found = (ws.jars || []).some(function (jr) { return jr.info.classes.some(function (c) { return c.name === cls; }); })
          || ws.files.some(function (f) { var p = f.path.replace(/\.java$/, ''); return f.ext === 'java' && (p === cls || p.slice(-(cls.length + 1)) === '/' + cls); });
        if (!found) facts.unresolved.push({ kind: 'ESQL Java routine class', ref: r.external, where: e.vpath + ' (' + r.name + ')', line: r.line });
      });
      if (e.schema !== e.expectedSchema && e.project) e.schemaMismatch = true;
    });

    var present = {}; facts.policyFiles.forEach(function (p) { present[p.project] = true; });
    facts.missingPolicyProjects = util.uniq(facts.policyRefs.map(function (p) { return p.project; })).filter(function (p) { return !present[p]; });
    facts.stats = { flows: facts.flows.length, nodes: facts.nodes.length, esqlFiles: facts.esql.length, esqlModules: facts.esql.reduce(function (a, e) { return a + e.modules.length; }, 0), overrides: facts.overrides.filter(function (o) { return o.value != null; }).length };
    return facts;
  };

  function dedupe(arr, key) { var s = {}; return arr.filter(function (x) { var k = key(x); if (s[k]) return false; s[k] = 1; return true; }); }

  /* Built-in fact checks: return [{text, where, line}] evidence. */
  eng.FACTS = {
    missingPolicies: function (f) {
      return f.policyRefs.filter(function (p) { return f.missingPolicyProjects.indexOf(p.project) >= 0; })
        .map(function (p) { return { text: 'Policy ' + p.ref + ' (project "' + p.project + '" not in BAR)', where: p.where }; });
    },
    dataSources: function (f) { return f.dataSources.map(function (d) { return { text: 'DSN ' + d.name + ' (' + d.nodeType + ')', where: d.where }; }); },
    endpoints: function (f) { return dedupe(f.endpoints, function (e) { return e.url + e.where; }).map(function (e) { return { text: e.url, where: e.where }; }); },
    filePaths: function (f) { return dedupe(f.filePaths, function (e) { return e.path + e.where; }).map(function (e) { return { text: e.path, where: e.where }; }); },
    unresolvedRefs: function (f) { return f.unresolved.map(function (u) { return { text: u.kind + ' "' + u.ref + '" not found', where: u.where, line: u.line }; }); },
    javaCodePresent: function (f, ws) {
      var ev = [];
      f.nodes.filter(function (n) { return n.type === 'ComIbmJavaCompute'; }).forEach(function (n) { ev.push({ text: 'JavaCompute node class ' + (n.attrs.javaClass || '?'), where: n.flowVPath + ' > ' + n.label }); });
      f.esql.forEach(function (e) { e.javaRoutines.forEach(function (r) { ev.push({ text: 'ESQL LANGUAGE JAVA routine ' + r.name + ' -> ' + r.external, where: e.vpath, line: r.line }); }); });
      (ws.jars || []).filter(function (j) { return j.classification.type === 'application'; }).forEach(function (j) { ev.push({ text: 'Application JAR ' + j.name + ' (' + j.info.classCount + ' classes, Java ' + Object.keys(j.info.versions).map(function (v) { return ACE.java.javaVersionOf(Number(v)); }).join('/') + ' bytecode)', where: j.occurrences.join(', ') }); });
      return ev;
    },
    packagedDrivers: function (f, ws) {
      return (ws.jars || []).filter(function (j) { return j.classification.type === 'driver' || j.classification.type === 'possible-driver'; }).map(function (j) {
        var v = j.info.minMajor ? ' - classes compiled for Java ' + ACE.java.javaVersionOf(j.info.minMajor) + (j.info.maxMajor !== j.info.minMajor ? '-' + ACE.java.javaVersionOf(j.info.maxMajor) : '') : '';
        return { text: j.name + ': ' + j.classification.driverName + v + ', packaged ' + j.occurrences.length + ' time(s)', where: j.occurrences.join(', ') };
      });
    },
    compiledFlows: function (f, ws) { return ws.files.filter(function (x) { return x.ext === 'cmf'; }).map(function (x) { return { text: x.name, where: x.vpath }; }); },
    binaryOnlyJava: function (f, ws) {
      return (ws.jars || []).filter(function (j) { return j.classification.type === 'application'; }).filter(function (j) {
        return !j.info.classes.some(function (c) { return ws.files.some(function (x) { return x.ext === 'java' && x.path.slice(-(c.name.length + 5)) === c.name + '.java'; }); });
      }).map(function (j) { return { text: j.name + ': ' + j.info.classCount + ' class(es), no .java source in the BAR' + (ws.decompiled && ws.decompiled[j.sha256] ? ' (decompiled copy available)' : ''), where: j.occurrences.join(', ') }; });
    },
    postBuildModification: function (f, ws) { return (ws.model.buildEvidence || []).filter(function (b) { return b.kind === 'post-build-modification'; }).map(function (b) { return { text: b.text, where: b.source }; }); }
  };

  function familyMatch(n, list) {
    return list.some(function (t) { return t.indexOf('family:') === 0 ? n.family === t.slice(7) : n.type === t; });
  }
  function attrVal(n, spec) { // spec "a|b|c" -> first non-empty
    var keys = spec.split('|');
    for (var i = 0; i < keys.length; i++) { var v = n.effective[keys[i]]; if (v != null && String(v).trim() !== '') return { key: keys[i], value: v }; }
    return null;
  }

  /* Evaluate a rule set. docs: [{name, text}] imported documentation. */
  eng.evaluate = function (facts, ruleSet, ws, docs) {
    var findings = [];
    (ruleSet.rules || []).forEach(function (rule) {
      var m = rule.match || {}, ev = [];
      if (m.always) ev.push({ text: 'Applies to every ACE 12 to 13 migration', where: '' });
      if (m.fact) {
        var fn = eng.FACTS[m.fact];
        if (!fn) ev = [{ text: 'Unknown fact "' + m.fact + '" in rule; rule not evaluated', where: '', error: true }];
        else ev = ev.concat(fn(facts, ws));
      }
      if (m.esql) facts.esql.forEach(function (e) {
        var LABEL = { javaRoutines: 'Java routine', dbRoutines: 'stored procedure', passthru: 'PASSTHRU', evals: 'EVAL(...)', dbRefs: 'Database reference' };
        (e[m.esql] || []).forEach(function (x) {
          var t = (x.name ? x.name + (x.external ? ' -> ' + x.external : '') : '') + (x.sql ? ' SQL: ' + x.sql : '') + (x.target ? ' ' + x.target : '');
          ev.push({ text: (LABEL[m.esql] || m.esql) + (t ? ': ' + t.trim() : ' at line ' + x.line), where: e.vpath, line: x.line });
        });
      });
      if (m.nodeTypes || m.attrPresent || m.attrMatches) {
        facts.nodes.forEach(function (n) {
          if (n.kind !== 'builtin') return;
          if (m.nodeTypes && !familyMatch(n, m.nodeTypes)) return;
          var detail = [];
          if (m.attrPresent) { var ok = m.attrPresent.every(function (a) { var v = attrVal(n, a); if (v) detail.push(v.key + '=' + v.value + (n.overridden[v.key] ? ' (BAR override)' : '')); return !!v; }); if (!ok) return; }
          if (m.attrMatches) {
            var ok2 = Object.keys(m.attrMatches).every(function (a) { var v = attrVal(n, a); if (!v || !new RegExp(m.attrMatches[a]).test(v.value)) return false; detail.push(v.key + '=' + v.value + (n.overridden[v.key] ? ' (BAR override)' : '')); return true; });
            if (!ok2) return;
          }
          ev.push({ text: n.typeLabel + ' "' + n.label + '"' + (detail.length ? ': ' + util.uniq(detail).join(', ') : ''), where: n.flowVPath, line: n.line, project: n.project });
        });
      }
      if (!ev.length) return;
      var docCheck = eng.docVerification(rule, docs);
      findings.push({
        id: util.uid('af'), ruleId: rule.id, severity: rule.severity, title: rule.title, category: rule.category || 'General', status: rule.status,
        confidence: rule.confidence || 'medium', why: rule.why, action: rule.action, refs: rule.refs || [], blocker: !!rule.blocker,
        evidence: ev, docVerification: docCheck, ruleSet: ruleSet.id
      });
    });
    return findings;
  };

  /* Does locally imported documentation contain this rule's keywords? */
  eng.docVerification = function (rule, docs) {
    if (rule.status === 'observed') return { state: 'not-applicable', text: 'Fact observed in the BAR' };
    if (rule.status === 'verified') return { state: 'probe', text: 'Verified by runtime probe (see docs/VERIFIED-FACTS.md); IBM doc references are supporting material' };
    if (rule.status === 'heuristic') return { state: 'heuristic', text: 'Heuristic - not an IBM rule' };
    if (!docs || !docs.length) return { state: 'unverified', text: 'UNVERIFIED offline: no IBM documentation imported. Reference URLs were consulted online on 2026-10-20.' };
    var kws = rule.docKeywords || [];
    if (!kws.length) return { state: 'unverified', text: 'Rule has no documentation keywords to check' };
    var hits = docs.filter(function (d) { var t = d.text.toLowerCase(); return kws.every(function (k) { return t.indexOf(k.toLowerCase()) >= 0; }); });
    if (hits.length) return { state: 'matched', text: 'Keywords [' + kws.join(', ') + '] found in imported doc(s): ' + hits.map(function (h) { return h.name; }).join(', ') + ' - confirm the wording applies', docs: hits.map(function (h) { return h.name; }) };
    return { state: 'not-found', text: 'Keywords [' + kws.join(', ') + '] NOT found in the ' + docs.length + ' imported doc(s) - treat as unverified' };
  };
})(window.ACE);
