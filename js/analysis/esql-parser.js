/* ESQL static analyser. This is a lexical analyser, not a full ESQL compiler: it strips comments and
 * string literals (keeping line numbers), then recognises module, routine and statement declarations.
 * Findings derived here are reported as static evidence; ESQL validity must be confirmed in the Toolkit. */
(function (ACE) {
  'use strict';
  var esql = ACE.esql = {};

  /* Replace comments and string literals with spaces (same length, newlines preserved). Returns
   * {code, strings:[{value, offset}]} */
  esql.mask = function (text) {
    var out = text.split(''), strings = [], i = 0, n = text.length;
    function blank(a, b) { for (var k = a; k < b; k++) if (out[k] !== '\n' && out[k] !== '\r') out[k] = ' '; }
    while (i < n) {
      var c = text[i], d = text[i + 1];
      if (c === '-' && d === '-') { var e = text.indexOf('\n', i); if (e < 0) e = n; blank(i, e); i = e; continue; }
      if (c === '/' && d === '*') { var e2 = text.indexOf('*/', i + 2); e2 = e2 < 0 ? n : e2 + 2; blank(i, e2); i = e2; continue; }
      if (c === "'") {
        var j = i + 1;
        while (j < n) { if (text[j] === "'" && text[j + 1] === "'") { j += 2; continue; } if (text[j] === "'") break; j++; }
        strings.push({ value: text.slice(i + 1, j).replace(/''/g, "'"), offset: i });
        blank(i + 1, j); i = j + 1; continue;
      }
      i++;
    }
    return { code: out.join(''), strings: strings };
  };

  function L(text, off) { return ACE.util.lineAt(text, off); }

  esql.parse = function (text, vpath) {
    var m = esql.mask(text), code = m.code, r;
    var res = { vpath: vpath, schema: '', path: [], modules: [], routines: [], passthru: [], dbRefs: [], javaRoutines: [], dbRoutines: [], propagates: [], evals: [], calls: [], dataSources: [], domains: [], findings: [], strings: m.strings.length };
    // The schema name must follow on the same line; never let it swallow the next statement's keyword.
    if ((r = /\bBROKER[ \t]+SCHEMA[ \t]+([A-Za-z_][\w.]*)/i.exec(code)) && !/^(CREATE|DECLARE|PATH|SET)$/i.test(r[1])) { res.schema = r[1]; res.schemaLine = L(text, r.index); }
    else if (/\bBROKER[ \t]+SCHEMA\b/i.test(code)) res.findings.push({ severity: 'Warning', text: 'BROKER SCHEMA statement without a schema name' });
    if ((r = /\bPATH\s+([A-Za-z_][\w.]*(?:\s*,\s*[A-Za-z_][\w.]*)*)\s*;/i.exec(code))) res.path = r[1].split(/\s*,\s*/);
    var re = /\bCREATE\s+(COMPUTE|FILTER|DATABASE)\s+MODULE\s+("(?:[^"]|"")*"|[A-Za-z_][\w]*)/gi;
    while ((r = re.exec(code))) {
      // module names may be quoted: names are inside the masked code only if unquoted; quotes are double-quotes (identifiers), not strings
      res.modules.push({ type: r[1].toUpperCase(), name: r[2].replace(/^"|"$/g, '').replace(/""/g, '"'), line: L(text, r.index), offset: r.index });
    }
    var reR = /\bCREATE\s+(FUNCTION|PROCEDURE)\s+([A-Za-z_]\w*)\s*\(/gi;
    while ((r = reR.exec(code))) {
      var head = code.slice(r.index, r.index + 1500);
      var endIdx = head.search(/\bBEGIN\b|;/i);
      var decl = endIdx > 0 ? head.slice(0, endIdx + 1) : head.slice(0, 400);
      var rt = { kind: r[1].toUpperCase(), name: r[2], line: L(text, r.index), offset: r.index, language: 'ESQL', external: null };
      var lang = /\bLANGUAGE\s+(JAVA|DATABASE|ESQL)\b/i.exec(decl);
      if (lang) rt.language = lang[1].toUpperCase();
      var ext = /\bEXTERNAL\s+NAME\s+"([^"]+)"/i.exec(text.slice(r.index, r.index + (endIdx > 0 ? endIdx + 200 : 600)));
      if (ext) rt.external = ext[1];
      if (rt.language === 'JAVA') res.javaRoutines.push(rt);
      else if (rt.language === 'DATABASE' || (rt.external && rt.language !== 'JAVA')) res.dbRoutines.push(rt);
      res.routines.push(rt);
    }
    var reP = /\bPASSTHRU\s*\(/gi;
    while ((r = reP.exec(code))) {
      var s = m.strings.filter(function (x) { return x.offset > r.index && x.offset < r.index + 600; })[0];
      res.passthru.push({ line: L(text, r.index), sql: s ? s.value.slice(0, 200) : null });
    }
    var reD = /\bDatabase\s*\.\s*(\{[^}]*\}|[A-Za-z_]\w*)/g;
    while ((r = reD.exec(code))) res.dbRefs.push({ line: L(text, r.index), target: r[1] });
    var reProp = /\bPROPAGATE\b(?:\s+TO\s+(TERMINAL|LABEL)\s+([^\s;]+))?/gi;
    while ((r = reProp.exec(code))) res.propagates.push({ line: L(text, r.index), kind: r[1] || null, target: r[2] || null });
    var reE = /\bEVAL\s*\(/gi;
    while ((r = reE.exec(code))) res.evals.push({ line: L(text, r.index) });
    var reC = /\bCALL\s+([A-Za-z_][\w.]*)\s*\(/gi;
    while ((r = reC.exec(code))) res.calls.push({ line: L(text, r.index), name: r[1] });
    var reDom = /\b(?:OutputRoot|InputRoot|Root)\s*\.\s*(MRM|XMLNSC|XMLNS|XML|JSON|DFDL|BLOB|SOAP|MIME|DataObject|IDOC)\b/g, seen = {};
    while ((r = reDom.exec(code))) { if (!seen[r[1]]) { seen[r[1]] = 1; res.domains.push({ domain: r[1], line: L(text, r.index) }); } }
    return res;
  };

  /* Expected BROKER SCHEMA for a file path inside its project (folders => dotted schema). */
  esql.expectedSchema = function (projectRelativePath) {
    var parts = projectRelativePath.split('/'); parts.pop();
    return parts.join('.');
  };
})(window.ACE);
