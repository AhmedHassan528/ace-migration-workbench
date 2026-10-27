/* Java 8 -> 17 static compatibility analyser.
 * Two evidence sources:
 *   bytecode - constant-pool references from .class files (exact; no decompilation needed)
 *   source   - .java files found in the BAR or produced by the built-in decompiler (line numbers)
 * Static analysis cannot prove runtime compatibility; every report says so. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var j17 = ACE.java17 = {};

  /* Strip comments and literals from Java source; keeps offsets/newlines. Returns {code, strings[]} */
  j17.mask = function (text) {
    var out = text.split(''), strings = [], i = 0, n = text.length;
    function blank(a, b) { for (var k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; }
    while (i < n) {
      var c = text[i], d = text[i + 1];
      if (c === '/' && d === '/') { var e = text.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue; }
      if (c === '/' && d === '*') { var e2 = text.indexOf('*/', i + 2); e2 = e2 < 0 ? n : e2 + 2; blank(i, e2); i = e2; continue; }
      if (c === '"' && text.substr(i, 3) === '"""') { var e3 = text.indexOf('"""', i + 3); e3 = e3 < 0 ? n : e3 + 3; strings.push({ value: text.slice(i + 3, e3 - 3), offset: i }); blank(i + 1, e3 - 1); i = e3; continue; }
      if (c === '"' || c === "'") {
        var j = i + 1, v = '';
        while (j < n && text[j] !== c && text[j] !== '\n') { if (text[j] === '\\') { v += text[j] + (text[j + 1] || ''); j += 2; continue; } v += text[j]; j++; }
        if (c === '"') strings.push({ value: v.replace(/\\(.)/g, '$1'), offset: i });
        blank(i + 1, j); i = j + 1; continue;
      }
      i++;
    }
    return { code: out.join(''), strings: strings };
  };

  function hitPrefix(name, rule) {
    var m = rule.match;
    if (!m.classPrefix) return false;
    if (m.classExclude && m.classExclude.some(function (x) { return name.indexOf(x) === 0; })) return false;
    return m.classPrefix.some(function (p) { return name.indexOf(p) === 0; });
  }
  function strRes(rule) { return (rule.match.strings || []).map(function (s) { return new RegExp(s); }); }

  function mkFinding(rule, o) {
    return {
      id: util.uid('jf'), ruleId: rule.id, severity: rule.severity, title: rule.title, status: rule.status, confidence: rule.confidence,
      why: rule.why, action: rule.action, autofix: rule.autofix || null, autofixAvailable: !!rule.autofix, refs: rule.refs || [],
      file: o.file, line: o.line || null, className: o.className || null, evidence: o.evidence, source: o.source, scope: o.scope || 'application', jar: o.jar || null
    };
  }

  /* Analyse one parsed class. */
  j17.analyzeClass = function (cf, rules, ctx) {
    var out = [];
    rules.forEach(function (rule) {
      var m = rule.match, ev = [];
      if (m.classPrefix) cf.classRefs.forEach(function (c) { if (hitPrefix(c, rule)) ev.push('references class ' + c.replace(/\//g, '.')); });
      if (m.member) cf.memberRefs.forEach(function (r) {
        if (m.member.some(function (x) { return x.owner === r.owner && x.name === r.name && (!x.desc || x.desc === r.desc); })) ev.push('calls ' + r.owner.replace(/\//g, '.') + '.' + r.name + r.desc);
      });
      if (m.strings) { var res = strRes(rule); cf.strings.forEach(function (s) { if (res.some(function (re) { return re.test(s); })) ev.push('string constant "' + s + '"'); }); }
      if (m.declares) cf.methods.forEach(function (mm) { if (m.declares.some(function (d) { return d.name === mm.name && (!d.desc || d.desc === mm.desc); })) ev.push('declares ' + mm.name + mm.desc); });
      if (m.classVersion) {
        if (m.classVersion.minMajor && cf.major >= m.classVersion.minMajor) ev.push('class file major version ' + cf.major + ' (Java ' + cf.javaVersion + ')');
        if (m.classVersion.maxMajor && cf.major <= m.classVersion.maxMajor) ev.push('class file major version ' + cf.major + ' (Java ' + cf.javaVersion + ')');
      }
      if (ev.length) out.push(mkFinding(rule, { file: ctx.jarVPath + '!/' + cf.path, className: cf.name.replace(/\//g, '.'), evidence: util.uniq(ev), source: 'bytecode', scope: ctx.scope, jar: ctx.jarName }));
    });
    return out;
  };

  /* Analyse Java source text. Returns findings with line numbers. */
  j17.analyzeSource = function (text, file, rules, ctx) {
    var mk = j17.mask(text), code = mk.code, out = [];
    rules.forEach(function (rule) {
      var m = rule.match, hits = [];
      if (m.classPrefix) m.classPrefix.forEach(function (p) {
        var dotted = p.replace(/\//g, '.').replace(/\$/g, '\\$').replace(/\./g, '\\.');
        var re = new RegExp('\\b' + dotted + (/[\/]$/.test(p) ? '' : '\\b'), 'g'), r;
        while ((r = re.exec(code))) {
          var full = code.slice(r.index, r.index + 120).match(/^[\w.$]+/)[0];
          if (m.classExclude && m.classExclude.some(function (x) { return full.indexOf(x.replace(/\//g, '.')) === 0; })) continue;
          hits.push({ line: util.lineAt(text, r.index), ev: 'source references ' + full });
        }
      });
      if (m.strings) { var res = strRes(rule); mk.strings.forEach(function (s) { if (res.some(function (re) { return re.test(s.value); })) hits.push({ line: util.lineAt(text, s.offset), ev: 'string literal "' + s.value + '"' }); }); }
      if (m.member) m.member.forEach(function (x) {
        var simple = x.owner.split('/').pop(), re;
        if (x.name === '<init>') re = new RegExp('\\bnew\\s+(?:[\\w.]+\\.)?' + simple + '\\s*\\(', 'g');
        else re = new RegExp('\\.' + x.name.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
        var r;
        if (x.name !== '<init>' && !new RegExp('\\b' + simple + '\\b').test(code)) return; // owner type not mentioned at all
        while ((r = re.exec(code))) hits.push({ line: util.lineAt(text, r.index), ev: 'source: ' + code.slice(r.index, r.index + 60).split('\n')[0].trim() });
      });
      if (m.source) { var re2 = new RegExp(m.source, 'gm'), r2; while ((r2 = re2.exec(code))) { hits.push({ line: util.lineAt(text, r2.index), ev: 'source: ' + code.slice(r2.index, r2.index + 60).split('\n')[0].trim() }); if (r2[0] === '') re2.lastIndex++; } }
      if (hits.length) {
        var byLine = {};
        hits.forEach(function (h) { (byLine[h.line] = byLine[h.line] || []).push(h.ev); });
        Object.keys(byLine).forEach(function (ln) {
          out.push(mkFinding(rule, { file: file, line: Number(ln), evidence: util.uniq(byLine[ln]), source: 'source', scope: ctx.scope, jar: ctx.jarName || null }));
        });
      }
    });
    return out;
  };

  /* Analyse the whole workspace. */
  j17.analyzeWorkspace = function (ws, opts) {
    opts = opts || {};
    var rules = (opts.rules || window.ACE_JAVA_RULES).rules;
    var findings = [], summary = { classesAnalysed: 0, sourcesAnalysed: 0, jarsAnalysed: 0, versions: {}, applicationTargets: {} };
    (ws.jars || []).forEach(function (jr) {
      var t = jr.classification.type;
      var scope = (t === 'application') ? 'application' : 'dependency';
      if (t === 'product' || t === 'invalid' || t === 'no-classes') return;
      summary.jarsAnalysed++;
      var depByRule = {};
      jr.info.classes.forEach(function (cf) {
        summary.classesAnalysed++;
        summary.versions[cf.javaVersion] = (summary.versions[cf.javaVersion] || 0) + 1;
        if (scope === 'application') summary.applicationTargets[cf.javaVersion] = (summary.applicationTargets[cf.javaVersion] || 0) + 1;
        var ctx = { jarVPath: jr.occurrences[0], jarName: jr.name, scope: scope };
        var fs = j17.analyzeClass(cf, rules, ctx);
        if (scope === 'application') { findings = findings.concat(fs); return; }
        // Dependency JARs: one aggregated finding per rule, listing the affected classes.
        fs.forEach(function (f) { (depByRule[f.ruleId] = depByRule[f.ruleId] || []).push(f); });
      });
      Object.keys(depByRule).forEach(function (rid) {
        var list = depByRule[rid], f = Object.assign({}, list[0]);
        var classes = list.map(function (x) { return x.className; });
        var ev = util.uniq([].concat.apply([], list.map(function (x) { return x.evidence; })));
        f.id = util.uid('jf'); f.file = jr.occurrences[0]; f.className = null;
        f.evidence = [list.length + ' class(es) affected: ' + classes.slice(0, 8).join(', ') + (classes.length > 8 ? ', …' : '')].concat(ev.slice(0, 6)).concat(ev.length > 6 ? ['… ' + (ev.length - 6) + ' more distinct references'] : []);
        f.affectedClasses = classes;
        f.note = 'Found in ' + t + ' JAR ' + jr.name + ' (not application code): resolve by choosing a supported library/driver version, not by editing this project.';
        findings.push(f);
      });
    });
    // Original .java files in the BAR
    // When the ACE 13 working copy of a file was changed (approved fix or edit), the working copy is
    // analysed too: findings that no longer match are marked resolved, new matches are reported.
    var outOf = {};
    ACE.project.layout(ws).files.forEach(function (l) { outOf[l.fileId] = l.outPath; });
    ws.files.filter(function (f) { return f.ext === 'java' && f.bytes; }).forEach(function (f) {
      summary.sourcesAnalysed++;
      var orig = j17.analyzeSource(ACE.bar.text(f), f.vpath, rules, { scope: 'application' });
      var outPath = outOf[f.id], ov = outPath && ws.ws13 && ws.ws13.overlay[outPath];
      orig.forEach(function (x) { x.sourceFile = outPath || null; });
      if (ov) {
        var cur = j17.analyzeSource(ov.text, f.vpath, rules, { scope: 'application' }), curRules = {};
        cur.forEach(function (x) { curRules[x.ruleId] = true; });
        orig.forEach(function (x) { if (!curRules[x.ruleId]) { x.resolvedInWorkingCopy = true; x.note = 'Resolved in the ACE 13 working copy (' + outPath + '); the original file is unchanged (rollback: _original-before-changes/).'; } });
        var origRules = {}; orig.forEach(function (x) { origRules[x.ruleId] = true; });
        cur.forEach(function (x) { if (!origRules[x.ruleId]) { x.sourceFile = outPath; x.note = 'Introduced by a change in the ACE 13 working copy'; orig.push(x); } });
      }
      findings = findings.concat(orig);
    });
    // Decompiled sources. A source hit for a rule that already fired on the same class's bytecode is
    // merged into that finding as line numbers. Only source-only hits become separate findings.
    // The ACE 13 working copy is analysed, so applied fixes show up immediately.
    Object.keys(ws.decompiled || {}).forEach(function (sha) {
      var d = ws.decompiled[sha];
      (d.files || []).forEach(function (df) {
        summary.sourcesAnalysed++;
        var outPath = d.outputPrefix + df.path;
        var ov = ws.ws13 && ws.ws13.overlay[outPath];
        var cur = ov ? ov.text : df.text;
        var cls = df.path.replace(/\.java$/, '').replace(/\//g, '.');
        var srcF = j17.analyzeSource(cur, 'decompiled:' + d.jar + '/' + df.path, rules, { scope: d.scope || 'application', jarName: d.jar });
        var srcRules = {}; srcF.forEach(function (f) { srcRules[f.ruleId] = true; });
        // Bytecode findings for this class whose rule no longer matches the (fixed) source are resolved in the working copy.
        findings.forEach(function (bf) {
          if (bf.source !== 'bytecode' || bf.className !== cls) return;
          bf.sourceFile = outPath;
          if (ov && !srcRules[bf.ruleId] && !(rules.filter(function (r) { return r.id === bf.ruleId; })[0] || { match: {} }).match.classVersion && !(rules.filter(function (r) { return r.id === bf.ruleId; })[0] || { match: {} }).match.declares) {
            bf.resolvedInWorkingCopy = true;
            bf.note = 'Resolved in the ACE 13 working copy (' + outPath + '); the original JAR in the BAR still contains this code until the JAR is rebuilt from the fixed source.';
          }
        });
        srcF.forEach(function (sf) {
          var bf = findings.filter(function (x) { return x.source === 'bytecode' && x.className === cls && x.ruleId === sf.ruleId; })[0];
          if (bf) { bf.sourceLines = (bf.sourceLines || []).concat([sf.line]).sort(function (a, b) { return a - b; }); bf.line = bf.sourceLines[0]; return; }
          findings.push(sf);
        });
      });
    });
    findings.forEach(function (f) { if (f.sourceLines) f.evidence = f.evidence.concat(['decompiled source ' + f.sourceFile + ' lines ' + util.uniq(f.sourceLines).join(', ')]); });
    return { findings: findings, summary: summary, ruleSet: { id: (opts.rules || window.ACE_JAVA_RULES).id, version: (opts.rules || window.ACE_JAVA_RULES).version }, at: util.nowIso(),
      disclaimer: 'Static analysis only. It cannot prove runtime compatibility; test on the ACE 13.0.8 runtime with Java 17.' };
  };
})(window.ACE);
