/* Workbench Java decompiler (vanilla JavaScript, no external runtime).
 *
 * decompileClass(cf, {innerClasses}) -> {path, source, status, methods[], notes[]}
 *   status: 'complete' - every method body was decompiled
 *           'partial'  - at least one method could not be decompiled; it is emitted with a
 *                        comment giving the reason and its bytecode, and a body that throws
 *                        UnsupportedOperationException. The file is NOT counted as recovered.
 *           'failed'   - the class could not be processed at all (no file produced)
 *
 * This is NOT Fernflower. Its output is a reconstruction from bytecode: local names come from the
 * LocalVariableTable when present, comments and formatting of the original are lost. */
(function (ACE) {
  'use strict';
  var T = ACE.dtypes, IR = ACE.ir, BC = ACE.bytecode, TR = ACE.dtranslate, S = ACE.dstructure, PS = ACE.dpasses, A = ACE.java.ACC;
  var D = ACE.decompiler = { id: 'workbench-js', name: 'ACE Workbench JavaScript decompiler', version: '1.0.0' };

  function mods(acc, kind) {
    var r = [];
    if (acc & A.PUBLIC) r.push('public'); if (acc & A.PROTECTED) r.push('protected'); if (acc & A.PRIVATE) r.push('private');
    if (kind !== 'interface-method' && (acc & A.ABSTRACT) && kind !== 'interface') r.push('abstract');
    if (acc & A.STATIC) r.push('static'); if (acc & A.FINAL) r.push('final');
    if (kind === 'method' && (acc & A.SYNCHRONIZED)) r.push('synchronized');
    if (kind === 'method' && (acc & A.NATIVE)) r.push('native');
    if (kind === 'field' && (acc & A.TRANSIENT)) r.push('transient');
    if (kind === 'field' && (acc & A.VOLATILE)) r.push('volatile');
    if (acc & A.STRICT && kind === 'method') r.push('strictfp');
    return r.join(' ') + (r.length ? ' ' : '');
  }

  function constLit(c, desc) {
    if (!c) return null;
    if (desc === 'Z') return c.value ? 'true' : 'false';
    if (desc === 'C') return T.charLit(c.value);
    if (c.kind === 'long') return T.longLit(c.value);
    if (c.kind === 'float') return T.floatLit(c.value);
    if (c.kind === 'double') return T.doubleLit(c.value);
    if (c.kind === 'string') return T.stringLit(c.value);
    if ((desc === 'B' || desc === 'S') && c.value < 0) return '(' + T.PRIM[desc] + ')' + c.value;
    return String(c.value);
  }

  /* Decompile one method body. Returns {lines, status, reason}. */
  function methodBody(cf, m, names, ind, transform) {
    var printer = new IR.Printer(names, m.name === '<clinit>' ? { simpleStatic: cf.name } : {});
    try {
      if (m.signature && !m.genericRet) { try { m.genericRet = T.methodSig(names, m.signature).ret; } catch (e0) { m.genericRet = null; } }
      var fn = TR.translate(cf, m);
      fn.vars.forEach(function (v) { if (v.name && v.type && !v.temp && !v.stackVar && !v.param) v.lvtTyped = true; });
      var body = S.structure(fn);
      body = PS.run(fn, body, m, m.name === '<init>');
      if (transform) body = transform(body, printer);
      fn.vars.forEach(function (v) { if (v.sig) { try { v.srcType = T.fieldSig(names, v.sig); } catch (e) { /* keep erased type */ } } });
      var out = [];
      printer.stmts(body, ind, out);
      return { lines: out, status: 'ok', fn: fn };
    } catch (e) {
      var reason = e.unsupported ? e.message : ('internal decompiler error: ' + e.message);
      var lines = [ind + '// WORKBENCH DECOMPILER: this method body could NOT be decompiled (' + reason + ').',
        ind + '// The original bytecode follows. The body below is a placeholder, not recovered code.'];
      BC.disassemble(cf, m).split('\n').forEach(function (l) { lines.push(ind + '//   ' + l); });
      lines.push(ind + 'throw new UnsupportedOperationException("Method body not recovered by the ACE Workbench decompiler; see the bytecode comment above.");');
      return { lines: lines, status: 'failed', reason: reason, stack: e.unsupported ? null : e.stack };
    }
  }

  function paramInfo(cf, m, names, fn) {
    var md = T.methodDesc(m.desc), sig = null;
    if (m.signature) { try { sig = T.methodSig(names, m.signature); } catch (e) { sig = null; } }
    var types = md.params.map(function (p, i) { return T.typeName(names, p); });
    if (sig && sig.params.length === md.params.length) types = sig.params;
    var pnames = md.params.map(function (p, i) { return 'arg' + i; });
    if (fn) fn.vars.forEach(function (v) { if (v.param && !v.isThis) pnames[v.param.index] = v.name; });
    else if (m.code) {
      var slot = (m.access & A.STATIC) ? 0 : 1;
      md.params.forEach(function (p, i) { var e = m.code.lvt.filter(function (x) { return x.index === slot && x.start === 0; })[0]; if (e) pnames[i] = e.name; slot += T.isCat2(p) ? 2 : 1; });
    }
    if (m.paramNames) m.paramNames.forEach(function (p, i) { if (p.name && pnames[i] === 'arg' + i) pnames[i] = p.name; });
    var varargs = (m.access & A.VARARGS) && types.length && /\[\]$/.test(types[types.length - 1]);
    return types.map(function (t, i) { return (varargs && i === types.length - 1 ? t.replace(/\[\]$/, '...') : t) + ' ' + pnames[i]; }).join(', ');
  }

  /* Collect every class name a class mentions (for imports). */
  function allRefs(cf) {
    var s = new Set(cf.classRefs);
    if (cf.superName) s.add(cf.superName); cf.interfaces.forEach(function (i) { s.add(i); });
    [cf.signature].concat(cf.fields.map(function (f) { return f.signature; })).concat(cf.methods.map(function (m) { return m.signature; }))
      .concat(cf.methods.map(function (m) { return m.code ? m.code.lvtt.map(function (x) { return x.desc; }).join('') : ''; }))
      .forEach(function (sig) { if (sig) ACE.java.descriptorTypes(sig).forEach(function (x) { s.add(x); }); });
    cf.methods.forEach(function (m) { m.exceptions.forEach(function (x) { s.add(x); }); if (m.code) m.code.exceptions.forEach(function (x) { if (x.type) s.add(x.type); }); });
    return Array.from(s);
  }

  /* Decompile a class (and its static member classes, if supplied). */
  D.decompileClass = function (cf, opts) {
    opts = opts || {};
    var notes = [], methodsInfo = [], status = 'complete';
    var simple = cf.name.split('/').pop();
    var isInterface = (cf.access & A.INTERFACE) !== 0, isEnum = (cf.access & A.ENUM) !== 0, isAnno = (cf.access & A.ANNOTATION) !== 0;
    if (isEnum) { notes.push('enum declaration is emitted as a class-like reconstruction; enum constants are not re-sugared'); status = 'partial'; }
    if (isAnno) { notes.push('annotation type'); }
    var inner = {};
    (cf.innerClasses || []).forEach(function (ic) { if (ic.inner && ic.outer && ic.name) inner[ic.inner] = (ic.outer === cf.name ? '' : T.className({ pkg: '', imports: {}, importList: [], inner: {} }, ic.outer).split('.').pop() + '.') + ic.name; });
    var names = T.makeNames(cf, allRefs(cf).concat(opts.extraRefs || []), inner);
    // Obfuscated bytecode may use Java keywords as names (a field called "if", a method "do"). The
    // JVM accepts that; Java source cannot express it, so such a class can never be "complete".
    var badIds = new Set();
    var checkId = function (n) { if (n && n !== 'var' && n !== '<init>' && n !== '<clinit>' && (PS.RESERVED.has(n) || !/^[A-Za-z_$][\w$]*$/.test(n))) badIds.add(n); };
    cf.fields.forEach(function (f) { checkId(f.name); });
    cf.methods.forEach(function (m) { checkId(m.name); });
    cf.memberRefs.forEach(function (r) { checkId(r.name); });
    cf.classRefs.concat([cf.name]).forEach(function (c) { (c || '').split(/[\/$]/).forEach(function (p) { if (p && !/^\d+$/.test(p)) checkId(p); }); });
    if (badIds.size) { status = 'partial'; notes.push('obfuscated bytecode: identifier(s) ' + Array.from(badIds).slice(0, 8).map(function (x) { return '"' + x + '"'; }).join(', ') + ' are Java keywords or invalid names, so this class cannot be expressed as compilable Java source'); }
    var selfRefs = new Set(cf.memberRefs.filter(function (r) { return r.owner === cf.name; }).map(function (r) { return r.name + ':' + r.desc; }));
    function omittable(mem) { return (mem.access & A.BRIDGE) && !(mem.access & 0x0008) || !selfRefs.has(mem.name + ':' + mem.desc) || /^lambda\$/.test(mem.name); }
    var out = [];
    var ind = opts.indent || '';
    var body = [];

    // header
    var header = ind;
    var outerInfo = (cf.innerClasses || []).filter(function (ic) { return ic.inner === cf.name; })[0];
    var acc = outerInfo ? outerInfo.access : cf.access;
    var kind = isAnno ? '@interface' : isInterface ? 'interface' : 'class';
    header += mods(acc & ~A.SYNCHRONIZED & ~(isInterface ? A.ABSTRACT : 0) & ~(outerInfo ? 0 : A.STATIC), 'class') + kind + ' ' + (outerInfo ? outerInfo.name : simple);
    var csig = null; if (cf.signature) { try { csig = T.classSig(names, cf.signature); } catch (e) { csig = null; } }
    if (csig) header += csig.typeParams;
    var sup = csig ? csig.superType : (cf.superName ? T.className(names, cf.superName) : null);
    if (!isInterface && sup && cf.superName !== 'java/lang/Object' && !isEnum) header += ' extends ' + sup;
    if (isEnum && cf.superName) header += ' extends ' + sup + ' /* enum */';
    var ifs = csig ? csig.interfaces : cf.interfaces.map(function (i) { return T.className(names, i); });
    if (isAnno) ifs = ifs.filter(function (i) { return !/Annotation$/.test(i); });
    if (ifs.length) header += (isInterface ? ' extends ' : ' implements ') + ifs.join(', ');
    body.push(header + ' {');

    // <clinit>: leading assignments to this class's static fields, in declaration order, become
    // field initialisers (same execution order: initialisers run before the static block).
    var lifted = {}, clinitResult = null;
    var clinit = cf.methods.filter(function (m) { return m.name === '<clinit>'; })[0];
    if (clinit) {
      clinitResult = methodBody(cf, clinit, names, ind + '      ', function (body, printer) {
        var lastIdx = -1;
        while (body.length) {
          var s0 = body[0];
          if (!(s0.k === 'expr' && s0.e.k === 'assign' && !s0.e.op && s0.e.t.k === 'field' && !s0.e.t.obj && s0.e.t.owner === cf.name)) break;
          var fi = cf.fields.findIndex(function (f) { return f.name === s0.e.t.name && f.desc === s0.e.t.desc && (f.access & A.STATIC); });
          if (fi < 0 || fi <= lastIdx || lifted[s0.e.t.name] || cf.fields[fi].constantValue) break;
          var fname = s0.e.t.name, again = false;
          (function scan(list) { list.forEach(function (x) {
            [x.e, x.c, x.init].forEach(function (ex) { if (ex && IR.mentions(ex, function (y) { return y.k === 'field' && y.name === fname && y.owner === cf.name; })) again = true; });
            [x.then, x.els, x.body, x.fin].forEach(function (l) { if (l) scan(l); });
            (x.cases || []).concat(x.catches || []).forEach(function (c) { scan(c.body); });
          }); })(body.slice(1));
          if (again) break;
          lifted[s0.e.t.name] = printer.expr(s0.e.e); lastIdx = fi; body.shift();
        }
        return body;
      });
    }

    // fields
    cf.fields.forEach(function (f) {
      if ((f.synthetic || (f.access & A.SYNTHETIC)) && omittable(f)) { notes.push('synthetic field ' + f.name + ' omitted'); return; }
      var t = T.typeName(names, f.desc);
      if (f.signature) { try { t = T.fieldSig(names, f.signature); } catch (e) { /* erased */ } }
      var init = (f.access & A.STATIC) && f.constantValue ? constLit(f.constantValue, f.desc) : (lifted[f.name] != null ? lifted[f.name] : null);
      body.push(ind + '   ' + mods(f.access & (isInterface ? ~(A.PUBLIC | A.STATIC | A.FINAL) : ~0), 'field') + t + ' ' + f.name + (init != null ? ' = ' + init : '') + ';');
    });
    if (cf.fields.length) body.push('');

    // methods
    cf.methods.forEach(function (m) {
      if ((m.synthetic || (m.access & A.SYNTHETIC) || (m.access & A.BRIDGE)) && omittable(m)) { notes.push('compiler-generated method ' + m.name + m.desc + ' omitted'); return; }
      var info = { name: m.name, desc: m.desc, status: 'ok', reason: null };
      var mind = ind + '   ';
      if (m.name === '<clinit>') {
        var r0 = clinitResult;
        if (r0.status !== 'ok') { info.status = 'failed'; info.reason = r0.reason; status = 'partial'; }
        if (r0.lines.length) { body.push(mind + 'static {'); body.push.apply(body, r0.lines); body.push(mind + '}', ''); }
        methodsInfo.push(info); return;
      }
      var isCtor = m.name === '<init>';
      var md = T.methodDesc(m.desc), msig = null;
      if (m.signature) { try { msig = T.methodSig(names, m.signature); } catch (e) { msig = null; } }
      var abstractOrNative = !m.code;
      var r = abstractOrNative ? null : methodBody(cf, m, names, mind + '   ');
      if (r && r.status !== 'ok') { info.status = 'failed'; info.reason = r.reason; status = 'partial'; }
      var macc = m.access & ~A.VARARGS & ~A.BRIDGE;
      if (isInterface) macc &= ~(A.PUBLIC | A.ABSTRACT);
      var sigText = mind + mods(macc, isInterface ? 'interface-method' : 'method');
      if (isInterface && m.code && !(m.access & A.STATIC) && !(m.access & A.PRIVATE)) sigText += 'default ';
      if (msig && msig.typeParams) sigText += msig.typeParams + ' ';
      sigText += isCtor ? (outerInfo ? outerInfo.name : simple) : ((msig ? msig.ret : T.typeName(names, md.ret)) + ' ' + m.name);
      sigText += '(' + paramInfo(cf, m, names, r && r.fn) + ')';
      var thr = msig && msig.throws.length ? msig.throws : m.exceptions.map(function (x) { return T.className(names, x); });
      if (thr.length) sigText += ' throws ' + thr.join(', ');
      if (abstractOrNative) { body.push(sigText + ';', ''); methodsInfo.push(info); return; }
      var ctors = cf.methods.filter(function (x) { return x.name === '<init>'; });
      if (isCtor && r.status === 'ok' && !r.lines.length && m.desc === '()V' && ctors.length === 1 && (m.access & 7) === (acc & 7) && !m.exceptions.length) { notes.push('implicit default constructor omitted'); methodsInfo.push(info); return; }
      body.push(sigText + ' {');
      body.push.apply(body, r.lines);
      body.push(mind + '}', '');
      methodsInfo.push(info);
    });
    // static member classes supplied by the caller
    (opts.members || []).forEach(function (mem) { body.push.apply(body, mem.lines); body.push(''); if (mem.status !== 'complete') status = 'partial'; notes = notes.concat(mem.notes.map(function (n) { return mem.name + ': ' + n; })); });
    while (body.length && body[body.length - 1] === '') body.pop();
    body.push(ind + '}');

    if (!opts.indent) {
      var pkg = names.pkg ? 'package ' + names.pkg.replace(/\//g, '.') + ';\n\n' : '';
      var imps = names.importList.slice().sort().map(function (i) { return 'import ' + i.replace(/\//g, '.') + ';'; }).join('\n');
      var src = pkg + (imps ? imps + '\n\n' : '') + body.join('\n') + '\n';
      return { className: cf.name, path: cf.name + '.java', source: src, status: status, methods: methodsInfo, notes: notes };
    }
    return { className: cf.name, lines: body, status: status, methods: methodsInfo, notes: notes, name: cf.name };
  };

  /* Decompile all eligible classes of a JAR (parsed by ACE.jars.inspect). */
  D.decompileJar = function (jarInfo, opts) {
    opts = opts || {};
    var byName = {}; jarInfo.classes.forEach(function (c) { byName[c.name] = c; });
    var results = [], skipped = [];
    jarInfo.classes.forEach(function (cf) {
      if (opts.cancel) opts.cancel.check();
      if (cf.name === 'module-info' || /(^|\/)package-info$/.test(cf.name)) { skipped.push({ className: cf.name, reason: 'module/package descriptor' }); return; }
      var info = (cf.innerClasses || []).filter(function (ic) { return ic.inner === cf.name; })[0];
      if (info && info.outer && byName[info.outer]) return; // emitted inside its outer class (or reported there)
      if (info && !info.outer) {
        results.push({ className: cf.name, path: cf.name + '.java', source: null, status: 'failed', methods: [], notes: ['anonymous or local class: cannot be emitted as a separate source file; it belongs inside the method that declares it'] });
        return;
      }
      var members = [];
      (cf.innerClasses || []).forEach(function (ic) {
        if (ic.outer !== cf.name || !byName[ic.inner]) return;
        var icf = byName[ic.inner];
        if (!(ic.access & A.STATIC) && !(icf.access & A.INTERFACE)) { members.push({ name: ic.inner, status: 'partial', notes: ['inner (non-static) class ' + ic.name + ' not reconstructed: it captures the outer instance; its bytecode is reported separately'], lines: ['   // WORKBENCH DECOMPILER: inner class ' + ic.name + ' (' + ic.inner + '.class) was not reconstructed. See the decompilation report.'] }); return; }
        try { var r = D.decompileClass(icf, { indent: '   ' }); members.push({ name: ic.inner, status: r.status, notes: r.notes, lines: r.lines }); }
        catch (e) { members.push({ name: ic.inner, status: 'partial', notes: ['member class failed: ' + e.message], lines: ['   // WORKBENCH DECOMPILER: member class ' + ic.name + ' could not be decompiled: ' + e.message] }); }
      });
      try {
        var res = D.decompileClass(cf, { members: members });
        res.sourceSize = res.source.length;
        res.syntax = ACE.syntaxCheck ? ACE.syntaxCheck(res.source) : null;
        if (res.syntax && !res.syntax.ok) { res.status = res.status === 'complete' ? 'partial' : res.status; res.notes.push('lightweight syntax check failed: ' + res.syntax.errors.join('; ')); }
        results.push(res);
      } catch (e) {
        results.push({ className: cf.name, path: cf.name + '.java', source: null, status: 'failed', methods: [], notes: ['class could not be decompiled: ' + e.message] });
      }
    });
    jarInfo.parseErrors.forEach(function (p) { results.push({ className: p.path, path: p.path.replace(/\.class$/, '.java'), source: null, status: 'failed', methods: [], notes: ['class file could not be parsed: ' + p.error] }); });
    return { decompiler: D.id + ' ' + D.version, results: results, skipped: skipped };
  };
})(window.ACE);
