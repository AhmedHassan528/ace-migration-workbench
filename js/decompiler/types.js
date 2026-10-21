/* Types for the decompiler: descriptors, generic signatures, Java literals and import resolution. */
(function (ACE) {
  'use strict';
  var T = ACE.dtypes = {};

  T.PRIM = { Z: 'boolean', B: 'byte', C: 'char', S: 'short', I: 'int', J: 'long', F: 'float', D: 'double', V: 'void' };
  T.isCat2 = function (d) { return d === 'J' || d === 'D'; };
  T.isRef = function (d) { return !!d && (d[0] === 'L' || d[0] === '[' || d === 'null'); };
  T.isIntLike = function (d) { return d === 'I' || d === 'Z' || d === 'B' || d === 'C' || d === 'S'; };
  T.sort = function (d) { return T.isIntLike(d) ? 'I' : (d === 'J' || d === 'F' || d === 'D') ? d : 'A'; };
  T.OBJECT = 'Ljava/lang/Object;';
  T.STRING = 'Ljava/lang/String;';

  /* Split a method descriptor. */
  T.methodDesc = function (desc) {
    var p = 1, params = [];
    while (desc[p] !== ')') { var e = end(desc, p); params.push(desc.slice(p, e)); p = e; }
    return { params: params, ret: desc.slice(p + 1) };
  };
  function end(d, p) {
    while (d[p] === '[') p++;
    if (d[p] === 'L') return d.indexOf(';', p) + 1;
    return p + 1;
  }
  T.elementType = function (d) { return d && d[0] === '[' ? d.slice(1) : null; };
  T.internalOf = function (d) { return d && d[0] === 'L' ? d.slice(1, -1) : null; };
  T.defaultValue = function (d) { return d === 'Z' ? 'false' : d === 'J' ? '0L' : d === 'F' ? '0.0F' : d === 'D' ? '0.0' : T.isIntLike(d) ? '0' : 'null'; };

  /* ---------- naming / imports ---------- */
  /* ctx: {pkg, thisName, nested: {internal: simpleNestedName}, imports: Map simple->internal, used: Set} */
  T.makeNames = function (cf, allRefs, innerNames) {
    var pkg = cf.name.indexOf('/') >= 0 ? cf.name.slice(0, cf.name.lastIndexOf('/')) : '';
    var ctx = { pkg: pkg, thisName: cf.name, inner: innerNames || {}, imports: {}, importList: [] };
    var bySimple = {};
    allRefs.forEach(function (n) {
      if (!n || n[0] === '[') return;
      var top = n.split('$')[0];
      var simple = top.split('/').pop();
      (bySimple[simple] = bySimple[simple] || {})[top] = true;
    });
    var thisSimple = cf.name.split('$')[0].split('/').pop();
    Object.keys(bySimple).forEach(function (s) {
      var cands = Object.keys(bySimple[s]);
      var thisTop = cf.name.split('$')[0];
      if (cands.length === 1 || cands.indexOf(thisTop) >= 0) {
        var chosen = cands.indexOf(thisTop) >= 0 ? thisTop : (cands.filter(function (c) { return c.slice(0, c.lastIndexOf('/') + 1) === pkg + '/' || (pkg === '' && c.indexOf('/') < 0); })[0] || cands.filter(function (c) { return /^java\/lang\/[^/]+$/.test(c); })[0] || cands[0]);
        if (s === thisSimple && chosen !== thisTop) return; // never shadow our own class name
        ctx.imports[s] = chosen;
      }
    });
    return ctx;
  };
  /* Source name for an internal class name; records imports actually used. */
  T.className = function (ctx, internal) {
    if (!internal) return 'Object';
    if (internal[0] === '[') return T.typeName(ctx, internal);
    if (ctx.inner[internal]) return ctx.inner[internal];
    var parts = internal.split('$'), top = parts[0], simple = top.split('/').pop();
    var rest = parts.slice(1);
    var nested = rest.length && rest.every(function (x) { return /^[A-Za-z_]/.test(x); }) ? '.' + rest.join('.') : (rest.length ? '$' + rest.join('$') : '');
    if (ctx.imports[simple] === top) {
      var pkg = top.indexOf('/') >= 0 ? top.slice(0, top.lastIndexOf('/')) : '';
      if (pkg !== ctx.pkg && pkg !== 'java/lang' && pkg !== '') { if (ctx.importList.indexOf(top) < 0) ctx.importList.push(top); }
      return simple + nested;
    }
    return top.replace(/\//g, '.') + nested;
  };
  T.typeName = function (ctx, d) {
    if (!d) return 'Object';
    if (d === 'null') return 'Object';
    if (T.PRIM[d]) return T.PRIM[d];
    if (d[0] === '[') return T.typeName(ctx, d.slice(1)) + '[]';
    if (d[0] === 'L') return T.className(ctx, d.slice(1, -1));
    return d;
  };

  /* ---------- generic signatures (JVMS 4.7.9.1) -> source text ---------- */
  function SigReader(s) { this.s = s; this.p = 0; }
  SigReader.prototype.peek = function () { return this.s[this.p]; };
  SigReader.prototype.next = function () { return this.s[this.p++]; };
  T.parseTypeSig = function (ctx, r) {
    var c = r.next();
    if (T.PRIM[c]) return T.PRIM[c];
    if (c === '[') return T.parseTypeSig(ctx, r) + '[]';
    if (c === 'T') { var e = r.s.indexOf(';', r.p); var v = r.s.slice(r.p, e); r.p = e + 1; return v; }
    if (c === 'L') {
      var name = '', out = '';
      while (true) {
        var ch = r.next();
        if (ch === '<') {
          out = T.className(ctx, name);
          var args = [];
          while (r.peek() !== '>') {
            var w = r.peek();
            if (w === '*') { r.next(); args.push('?'); }
            else if (w === '+') { r.next(); args.push('? extends ' + T.parseTypeSig(ctx, r)); }
            else if (w === '-') { r.next(); args.push('? super ' + T.parseTypeSig(ctx, r)); }
            else args.push(T.parseTypeSig(ctx, r));
          }
          r.next();
          out += '<' + args.join(', ') + '>';
          if (r.peek() === '.') { r.next(); name += '$'; var inner = ''; while (/[^<;.]/.test(r.peek())) inner += r.next(); name += inner; out += '.' + inner; continue; }
        } else if (ch === ';') { return out || T.className(ctx, name); }
        else if (ch === '.') { name += '$'; }
        else name += ch;
        if (r.p > r.s.length) throw new Error('Bad signature ' + r.s);
      }
    }
    throw new Error('Bad signature char ' + c + ' in ' + r.s);
  };
  function typeParams(ctx, r) {
    if (r.peek() !== '<') return '';
    r.next(); var ps = [];
    while (r.peek() !== '>') {
      var name = ''; while (r.peek() !== ':') name += r.next();
      var bounds = [];
      while (r.peek() === ':') { r.next(); if (r.peek() === ':') continue; if (r.peek() === '>' ) break; var b = T.parseTypeSig(ctx, r); if (b !== 'Object') bounds.push(b); }
      ps.push(name + (bounds.length ? ' extends ' + bounds.join(' & ') : ''));
    }
    r.next();
    return '<' + ps.join(', ') + '>';
  }
  T.fieldSig = function (ctx, sig) { return T.parseTypeSig(ctx, new SigReader(sig)); };
  T.methodSig = function (ctx, sig) {
    var r = new SigReader(sig), tp = typeParams(ctx, r);
    r.next(); var params = [];
    while (r.peek() !== ')') params.push(T.parseTypeSig(ctx, r));
    r.next();
    var ret = r.peek() === 'V' ? (r.next(), 'void') : T.parseTypeSig(ctx, r);
    var thr = []; while (r.peek() === '^') { r.next(); thr.push(T.parseTypeSig(ctx, r)); }
    return { typeParams: tp, params: params, ret: ret, throws: thr };
  };
  T.classSig = function (ctx, sig) {
    var r = new SigReader(sig), tp = typeParams(ctx, r);
    var sup = T.parseTypeSig(ctx, r), ifs = [];
    while (r.p < r.s.length) ifs.push(T.parseTypeSig(ctx, r));
    return { typeParams: tp, superType: sup, interfaces: ifs };
  };

  /* ---------- literals ---------- */
  T.escapeChar = function (c, quote) {
    var code = c.charCodeAt(0);
    switch (c) { case '\n': return '\\n'; case '\t': return '\\t'; case '\r': return '\\r'; case '\b': return '\\b'; case '\f': return '\\f'; case '\\': return '\\\\'; }
    if (c === quote) return '\\' + quote;
    if (code < 0x20) return '\\' + code.toString(8).padStart(3, '0');
    if (code >= 0x7f) return '\\u' + code.toString(16).padStart(4, '0');
    return c;
  };
  T.stringLit = function (s) { var o = '"'; for (var i = 0; i < s.length; i++) o += T.escapeChar(s[i], '"'); return o + '"'; };
  T.charLit = function (n) { return "'" + T.escapeChar(String.fromCharCode(n), "'") + "'"; };
  function shortestFloat(v) {
    for (var p = 1; p <= 9; p++) { var s = v.toPrecision(p); if (Math.fround(Number(s)) === v) return Number(s); }
    return v;
  }
  function javaNum(n) {
    var s = String(n);
    if (/e/.test(s)) { var m = /^(-?)(\d+)(?:\.(\d+))?e([+-]\d+)$/.exec(s); s = m[1] + m[2] + '.' + (m[3] || '0') + 'E' + Number(m[4]); }
    else if (s.indexOf('.') < 0) s += '.0';
    return s;
  }
  T.floatLit = function (v) {
    if (isNaN(v)) return '0.0F / 0.0F';
    if (v === Infinity) return '1.0F / 0.0F'; if (v === -Infinity) return '-1.0F / 0.0F';
    if (v === 0 && 1 / v < 0) return '-0.0F';
    return javaNum(shortestFloat(v)) + 'F';
  };
  T.doubleLit = function (v) {
    if (isNaN(v)) return '0.0 / 0.0';
    if (v === Infinity) return '1.0 / 0.0'; if (v === -Infinity) return '-1.0 / 0.0';
    if (v === 0 && 1 / v < 0) return '-0.0';
    return javaNum(v);
  };
  T.longLit = function (v) { return String(v) + 'L'; };
})(window.ACE);
