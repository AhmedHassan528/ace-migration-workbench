/* Java class-file parser (JVMS chapter 4), complete enough to drive a decompiler.
 * Reads: version, full constant pool (with values), access flags, super/interfaces, fields (+ConstantValue,
 * Signature), methods (+Code with exception table, LineNumberTable, LocalVariableTable,
 * LocalVariableTypeTable; Exceptions; Signature; MethodParameters), class attributes (SourceFile,
 * Signature, InnerClasses, EnclosingMethod, BootstrapMethods).
 * Also produces the summary used by the static analysers: classRefs, memberRefs, strings. */
(function (ACE) {
  'use strict';
  var java = ACE.java = ACE.java || {};

  java.MAJOR_TO_JAVA = { 45: '1.1', 46: '1.2', 47: '1.3', 48: '1.4', 49: '5', 50: '6', 51: '7', 52: '8', 53: '9', 54: '10', 55: '11', 56: '12', 57: '13', 58: '14', 59: '15', 60: '16', 61: '17', 62: '18', 63: '19', 64: '20', 65: '21', 66: '22', 67: '23', 68: '24', 69: '25' };
  java.javaVersionOf = function (major) { return java.MAJOR_TO_JAVA[major] || ('major ' + major); };

  java.ACC = { PUBLIC: 0x0001, PRIVATE: 0x0002, PROTECTED: 0x0004, STATIC: 0x0008, FINAL: 0x0010, SYNCHRONIZED: 0x0020, SUPER: 0x0020, VOLATILE: 0x0040, BRIDGE: 0x0040, TRANSIENT: 0x0080, VARARGS: 0x0080, NATIVE: 0x0100, INTERFACE: 0x0200, ABSTRACT: 0x0400, STRICT: 0x0800, SYNTHETIC: 0x1000, ANNOTATION: 0x2000, ENUM: 0x4000, MODULE: 0x8000 };

  function Reader(b, p) { this.b = b; this.p = p || 0; }
  Reader.prototype.need = function (n) { if (this.p + n > this.b.length) throw new Error('Unexpected end of class file'); };
  Reader.prototype.u1 = function () { this.need(1); return this.b[this.p++]; };
  Reader.prototype.u2 = function () { this.need(2); var v = (this.b[this.p] << 8) | this.b[this.p + 1]; this.p += 2; return v; };
  Reader.prototype.u4 = function () { this.need(4); var b = this.b, p = this.p; this.p += 4; return ((b[p] << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3]) >>> 0; };
  Reader.prototype.s4 = function () { return this.u4() | 0; };
  Reader.prototype.skip = function (n) { this.need(n); this.p += n; };
  Reader.prototype.bytes = function (n) { this.need(n); var r = this.b.subarray(this.p, this.p + n); this.p += n; return r; };

  /* Java "modified UTF-8" decoder. */
  function mutf8(b, s, e) {
    var out = '', i = s;
    while (i < e) {
      var c = b[i++];
      if (c < 0x80) out += String.fromCharCode(c);
      else if ((c & 0xE0) === 0xC0) out += String.fromCharCode(((c & 0x1F) << 6) | (b[i++] & 0x3F));
      else { var c2 = b[i++], c3 = b[i++]; out += String.fromCharCode(((c & 0x0F) << 12) | ((c2 & 0x3F) << 6) | (c3 & 0x3F)); }
    }
    return out;
  }

  /* Extract class names (internal form) from a field/method descriptor or signature. */
  java.descriptorTypes = function (desc) {
    var out = [], re = /L([^;<]+)[;<]/g, m;
    while ((m = re.exec(desc))) out.push(m[1]);
    return out;
  };

  java.parseClass = function (bytes) {
    var r = new Reader(bytes);
    if (r.u4() !== 0xCAFEBABE) throw new Error('Not a Java class file (bad magic number)');
    var minor = r.u2(), major = r.u2();
    var n = r.u2(), cp = new Array(n);
    var dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    for (var i = 1; i < n; i++) {
      var tag = r.u1();
      switch (tag) {
        case 1: { var len = r.u2(); var s = r.p; r.skip(len); cp[i] = { t: 1, v: mutf8(bytes, s, s + len) }; break; }
        case 3: cp[i] = { t: 3, v: r.s4() }; break;
        case 4: { var fp = r.p; r.skip(4); cp[i] = { t: 4, v: dv.getFloat32(fp, false) }; break; }
        case 5: { var lp = r.p; r.skip(8); cp[i] = { t: 5, v: dv.getBigInt64(lp, false) }; i++; break; }
        case 6: { var dp = r.p; r.skip(8); cp[i] = { t: 6, v: dv.getFloat64(dp, false) }; i++; break; }
        case 7: cp[i] = { t: 7, name: r.u2() }; break;
        case 8: cp[i] = { t: 8, str: r.u2() }; break;
        case 9: case 10: case 11: cp[i] = { t: tag, cls: r.u2(), nt: r.u2() }; break;
        case 12: cp[i] = { t: 12, name: r.u2(), desc: r.u2() }; break;
        case 15: cp[i] = { t: 15, kind: r.u1(), ref: r.u2() }; break;
        case 16: cp[i] = { t: 16, desc: r.u2() }; break;
        case 17: case 18: cp[i] = { t: tag, bsm: r.u2(), nt: r.u2() }; break;
        case 19: case 20: cp[i] = { t: tag, name: r.u2() }; break;
        default: throw new Error('Unknown constant-pool tag ' + tag + ' at index ' + i);
      }
    }
    function utf(idx) { var e = cp[idx]; return e && e.t === 1 ? e.v : null; }
    function className(idx) { var e = cp[idx]; return e && e.t === 7 ? utf(e.name) : null; }
    function nat(idx) { var e = cp[idx]; return e ? { name: utf(e.name), desc: utf(e.desc) } : null; }

    /* Resolved view of a constant-pool entry (used by the decompiler). */
    function constant(idx) {
      var e = cp[idx]; if (!e) return null;
      switch (e.t) {
        case 1: return { kind: 'utf8', value: e.v };
        case 3: return { kind: 'int', value: e.v };
        case 4: return { kind: 'float', value: e.v };
        case 5: return { kind: 'long', value: e.v };
        case 6: return { kind: 'double', value: e.v };
        case 7: return { kind: 'class', name: utf(e.name) };
        case 8: return { kind: 'string', value: utf(e.str) };
        case 9: case 10: case 11: { var t = nat(e.nt); return { kind: e.t === 9 ? 'field' : e.t === 10 ? 'method' : 'imethod', owner: className(e.cls), name: t.name, desc: t.desc }; }
        case 12: { var t2 = nat(idx); return { kind: 'nat', name: t2.name, desc: t2.desc }; }
        case 15: return { kind: 'mhandle', refKind: e.kind, ref: constant(e.ref) };
        case 16: return { kind: 'mtype', desc: utf(e.desc) };
        case 17: case 18: { var t3 = nat(e.nt); return { kind: e.t === 17 ? 'dynamic' : 'indy', bsm: e.bsm, name: t3.name, desc: t3.desc }; }
        default: return { kind: 'other', tag: e.t };
      }
    }

    var access = r.u2(), thisCls = className(r.u2()), superIdx = r.u2(), superCls = superIdx ? className(superIdx) : null;
    var ifc = [], ic = r.u2();
    for (i = 0; i < ic; i++) ifc.push(className(r.u2()));

    function parseCode(a) {
      var cr = new Reader(a);
      var code = { maxStack: cr.u2(), maxLocals: cr.u2() };
      var clen = cr.u4(); code.bytes = cr.bytes(clen);
      var et = cr.u2(); code.exceptions = [];
      for (var k = 0; k < et; k++) { var sp = cr.u2(), ep = cr.u2(), hp = cr.u2(), ct = cr.u2(); code.exceptions.push({ start: sp, end: ep, handler: hp, type: ct ? className(ct) : null }); }
      var ac = cr.u2(); code.lines = []; code.lvt = []; code.lvtt = [];
      for (k = 0; k < ac; k++) {
        var an = utf(cr.u2()), al = cr.u4(), st = cr.p;
        if (an === 'LineNumberTable') { var c1 = cr.u2(); for (var q = 0; q < c1; q++) code.lines.push({ pc: cr.u2(), line: cr.u2() }); }
        else if (an === 'LocalVariableTable' || an === 'LocalVariableTypeTable') {
          var c2 = cr.u2(), arr = an === 'LocalVariableTable' ? code.lvt : code.lvtt;
          for (q = 0; q < c2; q++) arr.push({ start: cr.u2(), length: cr.u2(), name: utf(cr.u2()), desc: utf(cr.u2()), index: cr.u2() });
        }
        cr.p = st + al;
      }
      return code;
    }

    function members(isMethod) {
      var list = [], c = r.u2();
      for (var k = 0; k < c; k++) {
        var m = { access: r.u2(), name: utf(r.u2()), desc: utf(r.u2()), deprecated: false, signature: null, exceptions: [], code: null, constantValue: null, paramNames: null, synthetic: false };
        var ac = r.u2();
        for (var a = 0; a < ac; a++) {
          var an = utf(r.u2()), al = r.u4(), st = r.p;
          if (an === 'Deprecated') m.deprecated = true;
          else if (an === 'Synthetic') m.synthetic = true;
          else if (an === 'Signature') m.signature = utf(r.u2());
          else if (an === 'ConstantValue') m.constantValue = constant(r.u2());
          else if (an === 'Exceptions') { var ec = r.u2(); for (var q = 0; q < ec; q++) m.exceptions.push(className(r.u2())); }
          else if (an === 'Code' && isMethod) m.code = parseCode(r.bytes(al));
          else if (an === 'MethodParameters') { var pc = r.u1(); m.paramNames = []; for (q = 0; q < pc; q++) { var ni = r.u2(); m.paramNames.push({ name: ni ? utf(ni) : null, access: r.u2() }); } }
          r.p = st + al;
        }
        list.push(m);
      }
      return list;
    }
    var fields = members(false), methods = members(true);
    var sourceFile = null, signature = null, innerClasses = [], enclosingMethod = null, bootstrap = [], attrCount = r.u2();
    for (i = 0; i < attrCount; i++) {
      var an = utf(r.u2()), al = r.u4(), st = r.p;
      if (an === 'SourceFile') sourceFile = utf(r.u2());
      else if (an === 'Signature') signature = utf(r.u2());
      else if (an === 'InnerClasses') { var icn = r.u2(); for (var q = 0; q < icn; q++) { var ii = r.u2(), oi = r.u2(), ni = r.u2(), fl = r.u2(); innerClasses.push({ inner: ii ? className(ii) : null, outer: oi ? className(oi) : null, name: ni ? utf(ni) : null, access: fl }); } }
      else if (an === 'EnclosingMethod') { var ec2 = r.u2(), mi = r.u2(); enclosingMethod = { cls: className(ec2), method: mi ? nat(mi) : null }; }
      else if (an === 'BootstrapMethods') { var bn = r.u2(); for (q = 0; q < bn; q++) { var ref = r.u2(), na = r.u2(), args = []; for (var z = 0; z < na; z++) args.push(r.u2()); bootstrap.push({ ref: ref, args: args }); } }
      r.p = st + al;
    }

    // Summary used by static analysers
    var classRefs = new Set(), memberRefs = [], strings = [];
    for (i = 1; i < n; i++) {
      var e = cp[i]; if (!e) continue;
      if (e.t === 7) { var cn = utf(e.name); if (cn) { if (cn[0] === '[') java.descriptorTypes(cn).forEach(function (x) { classRefs.add(x); }); else classRefs.add(cn); } }
      else if (e.t === 8) { var sv = utf(e.str); if (sv != null) strings.push(sv); }
      else if (e.t === 9 || e.t === 10 || e.t === 11) {
        var owner = className(e.cls), ntt = cp[e.nt];
        if (ntt) {
          var mn = utf(ntt.name), md = utf(ntt.desc);
          memberRefs.push({ kind: e.t === 9 ? 'field' : 'method', owner: owner, name: mn, desc: md });
          java.descriptorTypes(md || '').forEach(function (x) { classRefs.add(x); });
        }
      } else if (e.t === 12) { java.descriptorTypes(utf(e.desc) || '').forEach(function (x) { classRefs.add(x); }); }
    }
    fields.concat(methods).forEach(function (m) { java.descriptorTypes(m.desc || '').forEach(function (x) { classRefs.add(x); }); });
    if (thisCls) classRefs.delete(thisCls);

    return {
      major: major, minor: minor, javaVersion: java.javaVersionOf(major), access: access,
      name: thisCls, superName: superCls, interfaces: ifc, sourceFile: sourceFile, signature: signature,
      innerClasses: innerClasses, enclosingMethod: enclosingMethod, bootstrap: bootstrap,
      fields: fields, methods: methods, classRefs: Array.from(classRefs).sort(), memberRefs: memberRefs, strings: strings,
      constant: constant
    };
  };
})(window.ACE);
