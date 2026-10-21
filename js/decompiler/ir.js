/* Decompiler IR (expressions + statements) and the Java source printer.
 * Expression kinds:
 *   const{v,type} null this local{v} field{obj,owner,name,desc} aget{a,i} alen{a}
 *   invoke{kind,obj,owner,name,desc,args,isSuper} newobj{cls,desc,args} newarr{elem,dims,init}
 *   bin{op,l,r} un{op,e} not{e} cast{to,e} inst{e,cls} tern{c,a,b} assign{t,op,e} inc{t,op,post}
 *   caught{type} uninit{cls,id} concat{parts} classlit{type} cmp{op,l,r} (transient)
 * Statement kinds:
 *   expr{e} ret{e} throw{e} if{c,then,els} while{c,body,label} dowhile{c,body,label}
 *   for{init,c,upd,body,label} break{label} cont{label} switch{e,cases[{keys,dflt,body}],label}
 *   try{body,catches[{types,v,body}]} decl{v,init} block{body} comment{text} raw{text} */
(function (ACE) {
  'use strict';
  var T = ACE.dtypes;
  var IR = ACE.ir = {};

  /* ---------- typing helpers ---------- */
  IR.typeOf = function (e) { return e.type || 'Ljava/lang/Object;'; };
  IR.isTrivial = function (e) { return e.k === 'const' || e.k === 'null' || e.k === 'this' || e.k === 'local' || e.k === 'uninit' || e.k === 'classlit' || e.k === 'caught'; };
  IR.mentions = function (e, pred) {
    var hit = false;
    IR.walk(e, function (x) { if (pred(x)) hit = true; });
    return hit;
  };
  IR.walk = function (e, fn) {
    if (!e || typeof e !== 'object') return;
    fn(e);
    switch (e.k) {
      case 'field': IR.walk(e.obj, fn); break;
      case 'aget': IR.walk(e.a, fn); IR.walk(e.i, fn); break;
      case 'alen': case 'un': case 'not': case 'cast': case 'inst': IR.walk(e.e || e.a, fn); break;
      case 'invoke': IR.walk(e.obj, fn); e.args.forEach(function (a) { IR.walk(a, fn); }); break;
      case 'newobj': e.args.forEach(function (a) { IR.walk(a, fn); }); break;
      case 'newarr': (e.dims || []).forEach(function (a) { IR.walk(a, fn); }); (e.init || []).forEach(function (a) { IR.walk(a, fn); }); break;
      case 'bin': case 'cmp': IR.walk(e.l, fn); IR.walk(e.r, fn); break;
      case 'tern': IR.walk(e.c, fn); IR.walk(e.a, fn); IR.walk(e.b, fn); break;
      case 'assign': IR.walk(e.t, fn); IR.walk(e.e, fn); break;
      case 'inc': IR.walk(e.t, fn); break;
      case 'concat': e.parts.forEach(function (a) { IR.walk(a, fn); }); break;
    }
  };
  /* Replace sub-expressions: fn(x) returns a replacement or undefined. Returns new root. */
  IR.map = function (e, fn) {
    if (!e || typeof e !== 'object') return e;
    var r = fn(e); if (r !== undefined) return r;
    var c = Object.assign({}, e);
    switch (e.k) {
      case 'field': c.obj = IR.map(e.obj, fn); break;
      case 'aget': c.a = IR.map(e.a, fn); c.i = IR.map(e.i, fn); break;
      case 'alen': c.a = IR.map(e.a, fn); break;
      case 'un': case 'not': case 'cast': case 'inst': c.e = IR.map(e.e, fn); break;
      case 'invoke': c.obj = IR.map(e.obj, fn); c.args = e.args.map(function (a) { return IR.map(a, fn); }); break;
      case 'newobj': c.args = e.args.map(function (a) { return IR.map(a, fn); }); break;
      case 'newarr': c.dims = (e.dims || []).map(function (a) { return IR.map(a, fn); }); if (e.init) c.init = e.init.map(function (a) { return IR.map(a, fn); }); break;
      case 'bin': case 'cmp': c.l = IR.map(e.l, fn); c.r = IR.map(e.r, fn); break;
      case 'tern': c.c = IR.map(e.c, fn); c.a = IR.map(e.a, fn); c.b = IR.map(e.b, fn); break;
      case 'assign': c.t = IR.map(e.t, fn); c.e = IR.map(e.e, fn); break;
      case 'inc': c.t = IR.map(e.t, fn); break;
      case 'concat': c.parts = e.parts.map(function (a) { return IR.map(a, fn); }); break;
    }
    return c;
  };
  IR.hasSideEffects = function (e) {
    return IR.mentions(e, function (x) { return x.k === 'invoke' || x.k === 'newobj' || x.k === 'assign' || x.k === 'inc' || x.k === 'newarr' || (x.k === 'bin' && (x.op === '/' || x.op === '%') && T.isIntLike(x.type)); });
  };
  IR.readsMemory = function (e) { return IR.mentions(e, function (x) { return x.k === 'field' || x.k === 'aget' || x.k === 'alen' || x.k === 'invoke'; }); };

  /* ---------- condition negation (exact, NaN-safe) ---------- */
  var FLIP = { '==': '!=', '!=': '==', '<': '>=', '>=': '<', '>': '<=', '<=': '>' };
  IR.negate = function (c) {
    if (c.k === 'not') return c.e;
    if (c.k === 'bin' && FLIP[c.op]) {
      var ft = c.l.type === 'F' || c.l.type === 'D' || c.r.type === 'F' || c.r.type === 'D';
      if (ft && c.op !== '==' && c.op !== '!=') return { k: 'not', e: c, type: 'Z' };
      return { k: 'bin', op: FLIP[c.op], l: c.l, r: c.r, type: 'Z' };
    }
    if (c.k === 'bin' && (c.op === '&&' || c.op === '||')) return { k: 'bin', op: c.op === '&&' ? '||' : '&&', l: IR.negate(c.l), r: IR.negate(c.r), type: 'Z' };
    if (c.k === 'const' && c.type === 'Z') return { k: 'const', v: !c.v, type: 'Z' };
    return { k: 'not', e: c, type: 'Z' };
  };

  /* ---------- printer ---------- */
  var PREC = { '=': 1, '?': 2, '||': 3, '&&': 4, '|': 5, '^': 6, '&': 7, '==': 8, '!=': 8, '<': 9, '>': 9, '<=': 9, '>=': 9, 'instanceof': 9, '<<': 10, '>>': 10, '>>>': 10, '+': 11, '-': 11, '*': 12, '/': 12, '%': 12 };
  function prec(e) {
    switch (e.k) {
      case 'assign': return 1;
      case 'tern': return 2;
      case 'bin': return PREC[e.op];
      case 'inst': return 9;
      case 'concat': return 11;
      case 'un': case 'not': case 'cast': return 13;
      case 'inc': return e.post ? 14 : 13;
      case 'const': return (typeof e.v === 'number' && (e.v < 0 || (e.v === 0 && 1 / e.v < 0))) || (typeof e.v === 'bigint' && e.v < 0n) ? 13 : 15;
      default: return 15;
    }
  }
  IR.Printer = function (names, opts) { this.n = names; this.opts = opts || {}; };
  var P = IR.Printer.prototype;
  P.type = function (d) { return T.typeName(this.n, d); };
  P.wrap = function (e, min) { var s = this.expr(e); return prec(e) < min ? '(' + s + ')' : s; };
  P.lit = function (e) {
    var t = e.type, v = e.v;
    if (t === 'Z') return v ? 'true' : 'false';
    if (t === 'C' && typeof v === 'number') return T.charLit(v);
    if (t === 'J') return T.longLit(v);
    if (t === 'F') return T.floatLit(v);
    if (t === 'D') return T.doubleLit(v);
    if (t === T.STRING) return T.stringLit(v);
    return String(v);
  };
  P.expr = function (e) {
    var self = this;
    switch (e.k) {
      case 'const': return this.lit(e);
      case 'null': return 'null';
      case 'this': return 'this';
      case 'local': return e.v.name;
      case 'caught': return '/* exception */';
      case 'classlit': return this.type(e.ref) + '.class';
      case 'field': {
        // inside <clinit> a static final field of the class must be assigned by its simple name
        if (!e.obj && this.opts.simpleStatic === e.owner) return e.name;
        var obj = e.obj ? this.wrap(e.obj, 15) : this.type('L' + e.owner + ';');
        if (e.obj && e.obj.k === 'this' && !this.opts.qualifyThis && !e.shadowed) return 'this.' + e.name;
        return obj + '.' + e.name;
      }
      case 'aget': return this.wrap(e.a, 15) + '[' + this.expr(e.i) + ']';
      case 'alen': return this.wrap(e.a, 15) + '.length';
      case 'invoke': {
        var args = '(' + e.args.map(function (a) { return self.expr(a); }).join(', ') + ')';
        if (e.isSuper) return 'super.' + e.name + args;
        if (!e.obj) return (e.sameClass ? '' : this.type('L' + e.owner + ';') + '.') + e.name + args;
        if (e.obj.k === 'this') return 'this.' + e.name + args;
        return this.wrap(e.obj, 15) + '.' + e.name + args;
      }
      case 'ctorcall': return (e.isSuper ? 'super' : 'this') + '(' + e.args.map(function (a) { return self.expr(a); }).join(', ') + ')';
      case 'newobj': return 'new ' + this.type('L' + e.cls + ';') + '(' + e.args.map(function (a) { return self.expr(a); }).join(', ') + ')';
      case 'newarr': {
        var base = e.elem, extra = 0; while (base[0] === '[') { base = base.slice(1); extra++; }
        if (e.init) return 'new ' + this.type(e.elem) + '[]{' + e.init.map(function (a) { return self.expr(a); }).join(', ') + '}';
        return 'new ' + this.type(base) + e.dims.map(function (d) { return '[' + self.expr(d) + ']'; }).join('') + '[]'.repeat(extra - (e.dims.length - 1));
      }
      case 'bin': {
        var p = PREC[e.op];
        return this.wrap(e.l, p) + ' ' + e.op + ' ' + this.wrap(e.r, p + 1);
      }
      case 'concat': {
        var parts = e.parts.map(function (x, i) { return i === 0 ? self.wrap(x, 11) : self.wrap(x, 12); });
        return parts.join(' + ');
      }
      case 'un': return e.op + (e.e.k === 'un' || (e.e.k === 'const' && prec(e.e) === 13) ? '(' + this.expr(e.e) + ')' : this.wrap(e.e, 13));
      case 'not': return '!' + this.wrap(e.e, 13);
      case 'cast': {
        var inner = this.wrap(e.e, 13);
        if (!T.PRIM[e.to] && (e.e.k === 'un' || prec(e.e) === 13 && e.e.k === 'const')) inner = '(' + this.expr(e.e) + ')';
        return '(' + (e.srcTo || this.type(e.to)) + ')' + inner;
      }
      case 'inst': return this.wrap(e.e, 9) + ' instanceof ' + this.type(e.cls[0] === '[' ? e.cls : 'L' + e.cls + ';');
      case 'tern': return this.wrap(e.c, 3) + ' ? ' + this.wrap(e.a, 3) + ' : ' + this.wrap(e.b, 2);
      case 'assign': return this.wrap(e.t, 14) + ' ' + (e.op || '') + '= ' + (!e.op && e.t.k === 'local' ? this.genericInit(e.t.v, e.e) : this.wrap(e.e, 1));
      case 'inc': return e.post ? this.wrap(e.t, 14) + e.op : e.op + this.wrap(e.t, 13);
      case 'cmp': return '/*' + e.op + '*/(' + this.expr(e.l) + ', ' + this.expr(e.r) + ')';
      case 'uninit': return '/* uninitialized ' + e.cls + ' */';
      case 'raw': return e.text;
    }
    throw new Error('Cannot print expression kind ' + e.k);
  };

  /* A variable with a generic type assigned from a cast to its erasure: cast to the generic type,
   * e.g. "T x = (T)it.next();" - "(Comparable)" would not compile. */
  P.genericInit = function (v, e) {
    if (v && v.srcType && e.k === 'cast' && e.to === v.type && v.srcType !== this.type(v.type)) return '(' + v.srcType + ')' + this.wrap(e.e, 13);
    return this.wrap(e, 1);
  };
  P.stmts = function (list, ind, out) {
    for (var i = 0; i < list.length; i++) this.stmt(list[i], ind, out);
  };
  P.block = function (body, ind, out) { this.stmts(body, ind + '   ', out); };
  P.stmt = function (s, ind, out) {
    var self = this;
    switch (s.k) {
      case 'expr': out.push(ind + this.expr(s.e) + ';'); return;
      case 'decl': out.push(ind + (s.final ? 'final ' : '') + (s.v.srcType || this.type(s.v.type)) + ' ' + s.v.name + (s.init ? ' = ' + this.genericInit(s.v, s.init) : '') + ';'); return;
      case 'ret': out.push(ind + 'return' + (s.e ? ' ' + this.expr(s.e) : '') + ';'); return;
      case 'throw': out.push(ind + 'throw ' + this.expr(s.e) + ';'); return;
      case 'break': out.push(ind + 'break' + (s.label ? ' ' + s.label : '') + ';'); return;
      case 'cont': out.push(ind + 'continue' + (s.label ? ' ' + s.label : '') + ';'); return;
      case 'comment': s.text.split('\n').forEach(function (l) { out.push(ind + '// ' + l); }); return;
      case 'raw': s.text.split('\n').forEach(function (l) { out.push(ind + l); }); return;
      case 'block': out.push(ind + '{'); this.block(s.body, ind, out); out.push(ind + '}'); return;
      case 'if': {
        out.push(ind + 'if (' + this.expr(s.c) + ') {');
        this.block(s.then, ind, out);
        var els = s.els;
        while (els && els.length === 1 && els[0].k === 'if') {
          out.push(ind + '} else if (' + this.expr(els[0].c) + ') {');
          this.block(els[0].then, ind, out);
          els = els[0].els;
        }
        if (els && els.length) { out.push(ind + '} else {'); this.block(els, ind, out); }
        out.push(ind + '}');
        return;
      }
      case 'while': out.push(ind + (s.label ? s.label + ': ' : '') + 'while (' + this.expr(s.c) + ') {'); this.block(s.body, ind, out); out.push(ind + '}'); return;
      case 'dowhile': out.push(ind + (s.label ? s.label + ': ' : '') + 'do {'); this.block(s.body, ind, out); out.push(ind + '} while (' + this.expr(s.c) + ');'); return;
      case 'for': {
        var init = s.init ? (s.init.k === 'decl' ? (s.init.v.srcType || this.type(s.init.v.type)) + ' ' + s.init.v.name + ' = ' + this.expr(s.init.init) : this.expr(s.init.e)) : '';
        out.push(ind + (s.label ? s.label + ': ' : '') + 'for (' + init + '; ' + (s.c ? this.expr(s.c) : '') + '; ' + (s.upd ? s.upd.map(function (u) { return self.expr(u.e); }).join(', ') : '') + ') {');
        this.block(s.body, ind, out); out.push(ind + '}'); return;
      }
      case 'switch': {
        out.push(ind + (s.label ? s.label + ': ' : '') + 'switch (' + this.expr(s.e) + ') {');
        s.cases.forEach(function (c) {
          c.keys.forEach(function (k) { out.push(ind + '   case ' + (s.keyType === 'C' ? T.charLit(k) : k) + ':'); });
          if (c.dflt) out.push(ind + '   default:');
          self.stmts(c.body, ind + '      ', out);
        });
        out.push(ind + '}');
        return;
      }
      case 'try': {
        out.push(ind + 'try {'); this.block(s.body, ind, out);
        s.catches.forEach(function (c) {
          out.push(ind + '} catch (' + c.types.map(function (t) { return self.type('L' + (t || 'java/lang/Throwable') + ';'); }).join(' | ') + ' ' + c.v.name + ') {');
          self.block(c.body, ind, out);
        });
        if (s.fin) { out.push(ind + '} finally {'); this.block(s.fin, ind, out); }
        out.push(ind + '}');
        return;
      }
      case 'sync': out.push(ind + 'synchronized (' + this.expr(s.e) + ') {'); this.block(s.body, ind, out); out.push(ind + '}'); return;
      case 'monitor': { var err = new Error('monitorenter/monitorexit that does not form a synchronized block'); err.unsupported = true; throw err; }
    }
    throw new Error('Cannot print statement kind ' + s.k);
  };
})(window.ACE);
