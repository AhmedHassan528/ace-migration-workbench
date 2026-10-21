/* Clean-up passes over structured IR. Every pass preserves Java semantics:
 * inlining only moves an expression when no evaluation-order change is possible. */
(function (ACE) {
  'use strict';
  var IR = ACE.ir, T = ACE.dtypes;
  var PS = ACE.dpasses = {};

  /* ---------- generic tree helpers ---------- */
  function lists(s) { // child statement lists of a statement
    var r = [];
    if (s.then) r.push(s.then); if (s.els) r.push(s.els); if (s.body) r.push(s.body); if (s.fin) r.push(s.fin);
    if (s.cases) s.cases.forEach(function (c) { r.push(c.body); });
    if (s.catches) s.catches.forEach(function (c) { r.push(c.body); });
    return r;
  }
  function exprsOf(s) { // expressions directly owned by a statement (evaluation order)
    var r = [];
    if (s.k === 'for') { if (s.init) r.push(s.init.init || s.init.e); if (s.c) r.push(s.c); (s.upd || []).forEach(function (u) { r.push(u.e); }); return r; }
    if (s.k === 'decl') { if (s.init) r.push(s.init); return r; }
    if (s.e) r.push(s.e); if (s.c) r.push(s.c);
    return r;
  }
  function eachList(body, fn) { fn(body); body.forEach(function (s) { lists(s).forEach(function (l) { eachList(l, fn); }); }); }
  function eachStmt(body, fn) { body.forEach(function (s) { fn(s); lists(s).forEach(function (l) { eachStmt(l, fn); }); }); }
  function mapExprs(body, fn) {
    eachStmt(body, function (s) {
      if (s.e) s.e = fn(s.e, s); if (s.c) s.c = fn(s.c, s);
      if (s.k === 'decl' && s.init) s.init = fn(s.init, s);
      if (s.k === 'for') { if (s.init) { if (s.init.init) s.init.init = fn(s.init.init, s); if (s.init.e) s.init.e = fn(s.init.e, s); } (s.upd || []).forEach(function (u) { u.e = fn(u.e, s); }); }
    });
  }
  function countUses(body, v) {
    var n = 0;
    eachStmt(body, function (s) { exprsOf(s).forEach(function (e) { IR.walk(e, function (x) { if (x.k === 'local' && x.v === v) n++; }); }); });
    return n;
  }
  function isAssignTo(s, v) { return s.k === 'expr' && s.e.k === 'assign' && !s.e.op && s.e.t.k === 'local' && s.e.t.v === v; }
  function endsWithJump(b) { var l = b[b.length - 1]; return !!l && (l.k === 'ret' || l.k === 'throw' || l.k === 'break' || l.k === 'cont'); }

  /* ---------- types of variables without debug info ---------- */
  PS.finalizeTypes = function (fn, body, m) {
    var values = new Map();
    eachStmt(body, function (s) { if (s.k === 'expr' && s.e.k === 'assign' && s.e.t.k === 'local' && !s.e.op) { var v = s.e.t.v; (values.get(v) || values.set(v, []).get(v)).push(s.e.e); } });
    var boolCtx = new Set();
    var retT = T.methodDesc(m.desc).ret;
    eachStmt(body, function (s) {
      if (s.k === 'ret' && retT === 'Z' && s.e && s.e.k === 'local') boolCtx.add(s.e.v);
      exprsOf(s).forEach(function (e) { IR.walk(e, function (x) {
        if ((x.k === 'invoke' || x.k === 'newobj' || x.k === 'ctorcall') && x.desc) { var p = T.methodDesc(x.desc).params; x.args.forEach(function (a, i) { if (p[i] === 'Z' && a.k === 'local') boolCtx.add(a.v); }); }
        if (x.k === 'assign' && x.t.k === 'field' && x.t.desc === 'Z' && x.e.k === 'local') boolCtx.add(x.e.v);
        if ((x.k === 'not' || (x.k === 'bin' && (x.op === '&&' || x.op === '||'))) ) [x.e, x.l, x.r].forEach(function (y) { if (y && y.k === 'local') boolCtx.add(y.v); });
      }); });
    });
    fn.vars.forEach(function (v) {
      if (v.param || v.isThis || v.fromLvt) return;
      var vals = values.get(v) || [];
      if (v.name && v.type && v.lvtTyped) return;
      var ts = vals.map(function (e) { return e.type; }).concat(v.storeTypes || []).filter(function (t) { return t && t !== 'null'; });
      if (!ts.length) { if (!v.type || v.type === 'null') v.type = T.OBJECT; return; }
      if (ts.every(function (t) { return T.isIntLike(t); })) {
        var allBoolish = vals.length && vals.every(function (e) { return e.type === 'Z' || (e.k === 'const' && (e.v === 0 || e.v === 1)); });
        if (allBoolish && (vals.some(function (e) { return e.type === 'Z'; }) || boolCtx.has(v))) v.type = 'Z';
        else if (ts.every(function (t) { return t === 'C'; })) v.type = 'C';
        else if (ts.every(function (t) { return t === 'B'; })) v.type = 'B';
        else if (ts.every(function (t) { return t === 'S'; })) v.type = 'S';
        else v.type = 'I';
        return;
      }
      if (!v.type || v.type === 'null' || !T.isRef(v.type)) v.type = ts[0];
      var refs = ts.filter(T.isRef);
      // Several unrelated reference types flow into one variable (no debug info): declare it as
      // Object; receivers/arguments get casts in coerce().
      if (refs.length && refs.some(function (t) { return t !== refs[0]; })) { v.mixedRefTypes = refs; v.type = T.OBJECT; }
    });
    // refresh the type recorded on local references
    mapExprs(body, function (e) { return IR.map(e, function (x) { if (x.k === 'local') return { k: 'local', v: x.v, type: x.v.type }; }); });
  };

  /* ---------- literal coercion (booleans, chars, narrow constants) ---------- */
  function coerce(e, t, argCtx) {
    if (!e || !t) return e;
    // The JVM treats boolean as int; Java does not.
    if (t !== 'Z' && T.isIntLike(t) && e.type === 'Z' && e.k !== 'const') return { k: 'tern', c: e, a: { k: 'const', v: 1, type: 'I' }, b: { k: 'const', v: 0, type: 'I' }, type: 'I' };
    if (t === 'Z' && T.isIntLike(e.type) && e.type !== 'Z' && e.k !== 'const' && e.k !== 'tern') return { k: 'bin', op: '!=', l: e, r: { k: 'const', v: 0, type: 'I' }, type: 'Z' };
    // int value stored into byte/short/char (putfield/bastore narrow implicitly): explicit cast,
    // except plain constants which Java narrows by itself in assignment context.
    if ((t === 'B' || t === 'S' || t === 'C') && e.type === 'I' && e.k !== 'const' && !argCtx) return { k: 'cast', to: t, e: e, type: t };
    if (t === 'Z') {
      if (e.k === 'const' && (e.v === 0 || e.v === 1) && e.type !== 'Z') return { k: 'const', v: e.v === 1, type: 'Z' };
      if (e.k === 'tern') return { k: 'tern', c: e.c, a: coerce(e.a, 'Z'), b: coerce(e.b, 'Z'), type: 'Z' };
      return e;
    }
    if (t === 'C' && e.k === 'const' && typeof e.v === 'number' && e.type === 'I' && e.v >= 0 && e.v <= 0xFFFF) return { k: 'const', v: e.v, type: 'C' };
    if ((t === 'B' || t === 'S') && argCtx && e.k === 'const' && e.type === 'I') return { k: 'cast', to: t, e: e, type: t };
    if (T.isRef(t) && t !== T.OBJECT && e.k === 'local' && e.v.type === T.OBJECT && argCtx) return { k: 'cast', to: t, e: e, type: t };
    return e;
  }
  PS.coerce = function (body, m) {
    var retT = T.methodDesc(m.desc).ret;
    function fixCalls(e) {
      return IR.map(e, function (x) {
        if ((x.k === 'invoke' || x.k === 'newobj' || x.k === 'ctorcall') && x.desc) {
          var p = T.methodDesc(x.desc).params, c = Object.assign({}, x);
          c.args = x.args.map(function (a, i) { return coerce(fixCalls(a), p[i], true); });
          if (x.obj) {
            c.obj = fixCalls(x.obj);
            if (c.obj.k === 'local' && c.obj.v.type === T.OBJECT && x.owner !== 'java/lang/Object') c.obj = { k: 'cast', to: 'L' + x.owner + ';', e: c.obj, type: 'L' + x.owner + ';' };
          }
          return c;
        }
        if (x.k === 'assign') { var c2 = Object.assign({}, x); c2.t = fixCalls(x.t); c2.e = coerce(fixCalls(x.e), x.t.type || x.type, false); if (x.t.k === 'local' && x.t.v.type === 'Z' && c2.e.k === 'const' && typeof c2.e.v === 'number') c2.e = { k: 'const', v: c2.e.v === 1, type: 'Z' }; return c2; }
        if (x.k === 'bin' && (x.op === '==' || x.op === '!=')) {
          var l = fixCalls(x.l), r = fixCalls(x.r);
          if (l.type === 'Z' && r.k === 'const' && typeof r.v === 'number') { var truth = (r.v === 1) === (x.op === '=='); return truth ? l : IR.negate(l); }
          if (l.type === 'C' && r.k === 'const' && r.type === 'I') r = coerce(r, 'C');
          if (r.type === 'C' && l.k === 'const' && l.type === 'I') l = coerce(l, 'C');
          return { k: 'bin', op: x.op, l: l, r: r, type: 'Z' };
        }
        if (x.k === 'newarr' && x.init) { var c3 = Object.assign({}, x); c3.init = x.init.map(function (a) { return coerce(fixCalls(a), x.elem, false); }); return c3; }
        if (x.k === 'tern' && (x.a.type === 'Z' || x.b.type === 'Z')) return { k: 'tern', c: fixCalls(x.c), a: coerce(fixCalls(x.a), 'Z'), b: coerce(fixCalls(x.b), 'Z'), type: 'Z' };
      });
    }
    mapExprs(body, function (e, s) {
      var r = fixCalls(e);
      if (s.k === 'ret' && s.e === e) {
        r = coerce(r, retT, false);
        // value typed Object (no debug info) returned from a method with a specific (possibly generic) return type
        if (T.isRef(retT) && retT !== T.OBJECT && r.type === T.OBJECT && r.k !== 'null') r = { k: 'cast', to: retT, srcTo: m.genericRet || null, e: r, type: retT };
      }
      return r;
    });
    eachStmt(body, function (s) { if (s.k === 'decl' && s.init) s.init = coerce(s.init, s.v.type, false); });
  };

  /* ---------- ternary folding of stack variables ---------- */
  PS.foldTernaries = function (body) {
    var changed = false;
    eachList(body, function (list) {
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.k !== 'if' || !s.els || s.then.length !== 1 || s.els.length !== 1) continue;
        var a = s.then[0], b = s.els[0];
        if (!(a.k === 'expr' && b.k === 'expr' && a.e.k === 'assign' && b.e.k === 'assign' && !a.e.op && !b.e.op && a.e.t.k === 'local' && b.e.t.k === 'local' && a.e.t.v === b.e.t.v && (a.e.t.v.stackVar || a.e.t.v.temp))) continue;
        var v = a.e.t.v, x = a.e.e, y = b.e.e, e;
        if (x.k === 'const' && y.k === 'const' && (x.v === 1 || x.v === true) && (y.v === 0 || y.v === false) && x.type !== 'J') e = Object.assign({}, s.c);
        else if (x.k === 'const' && y.k === 'const' && (x.v === 0 || x.v === false) && (y.v === 1 || y.v === true) && x.type !== 'J') e = IR.negate(s.c);
        else e = { k: 'tern', c: s.c, a: x, b: y, type: x.type === 'null' ? y.type : x.type };
        if (e.k !== 'tern') { e.type = 'Z'; v.type = 'Z'; v.storeTypes = ['Z']; }
        list[i] = { k: 'expr', e: { k: 'assign', t: a.e.t, e: e, type: e.type } };
        changed = true;
      }
    });
    return changed;
  };

  /* ---------- inlining of single-use temporaries / stack variables ---------- */
  // Expressions evaluated before `target` inside `root`, in Java's left-to-right order.
  function evaluatedBefore(root, target) {
    var before = [], found = false;
    (function visit(e) {
      if (found || !e || typeof e !== 'object') return;
      if (e === target) { found = true; return; }
      var kids = [];
      switch (e.k) {
        case 'field': kids = [e.obj]; break;
        case 'aget': kids = [e.a, e.i]; break;
        case 'alen': kids = [e.a]; break;
        case 'un': case 'not': case 'cast': case 'inst': kids = [e.e]; break;
        case 'invoke': kids = [e.obj].concat(e.args); break;
        case 'newobj': case 'ctorcall': kids = e.args; break;
        case 'newarr': kids = (e.dims || []).concat(e.init || []); break;
        case 'bin': case 'cmp': kids = [e.l, e.r]; break;
        case 'tern': kids = [e.c, e.a, e.b]; break;
        case 'assign': kids = e.t.k === 'local' ? [e.e] : [e.t.obj, e.t.a, e.t.i, e.e]; break;
        case 'inc': kids = [e.t]; break;
        case 'concat': kids = e.parts; break;
      }
      for (var i = 0; i < kids.length && !found; i++) {
        var k = kids[i]; if (!k) continue;
        var containsTarget = false; IR.walk(k, function (x) { if (x === target) containsTarget = true; });
        if (containsTarget) { visit(k); }
        else before.push(k);
        // conditional evaluation: inlining into the second operand of && / || or a ternary branch changes when it runs
        if (containsTarget && ((e.k === 'bin' && (e.op === '&&' || e.op === '||') && i === 1) || (e.k === 'tern' && i > 0))) before.push({ k: 'raw', conditional: true });
      }
      if (!found && e.k !== 'local') before.push(e);
    })(root);
    return found ? before : null;
  }
  PS.inlineTemps = function (body, fnVars) {
    var changed = false;
    eachList(body, function (list) {
      for (var i = 0; i + 1 < list.length; i++) {
        var s = list[i];
        if (!(s.k === 'expr' && s.e.k === 'assign' && !s.e.op && s.e.t.k === 'local' && (s.e.t.v.temp || s.e.t.v.stackVar))) continue;
        var v = s.e.t.v, val = s.e.e;
        var defs = 0; eachStmt(body, function (x) { if (isAssignTo(x, v)) defs++; });
        if (defs !== 1) continue;
        if (countUses(body, v) - defs !== 1) continue; // exactly one read (countUses also counts the assignment target)
        var nx = list[i + 1];
        if (nx.k === 'while' || nx.k === 'dowhile' || nx.k === 'for' || nx.k === 'try' || nx.k === 'block') continue;
        var roots = exprsOf(nx);
        var use = null, root = null;
        roots.forEach(function (r) { IR.walk(r, function (x) { if (x.k === 'local' && x.v === v) { use = x; root = r; } }); });
        if (!use) continue;
        var before = evaluatedBefore(root, use);
        if (!before) continue;
        var valEffects = IR.hasSideEffects(val), valReads = IR.readsMemory(val) || IR.mentions(val, function (x) { return x.k === 'local'; });
        var conflict = before.some(function (b) {
          if (b.conditional) return valEffects || IR.readsMemory(val);
          var bEff = IR.hasSideEffects(b);
          if (bEff && (valEffects || valReads)) return true;
          if (valEffects && IR.readsMemory(b)) return true;
          return false;
        });
        if (conflict) continue;
        var replaced = IR.map(root, function (x) { if (x === use) return val; });
        if (nx.e === root) nx.e = replaced; else if (nx.c === root) nx.c = replaced; else if (nx.k === 'decl' && nx.init === root) nx.init = replaced; else continue;
        list.splice(i, 1); i = Math.max(-1, i - 2); changed = true;
      }
    });
    return changed;
  };

  /* ---------- x++ / x-- recovery and iinc printing ---------- */
  PS.increments = function (body) {
    eachList(body, function (list) {
      for (var i = 0; i + 2 < list.length; i++) {
        var a = list[i], b = list[i + 1];
        // tmp = x; x += 1;  (use tmp once in next statement)  =>  x++
        if (a.k === 'expr' && a.e.k === 'assign' && !a.e.op && a.e.t.k === 'local' && a.e.t.v.temp && a.e.e.k === 'local' &&
            b.k === 'expr' && b.e.k === 'assign' && b.e.iinc && b.e.t.v === a.e.e.v && b.e.e.v === 1 && countUses(body, a.e.t.v) === 2) {
          var tmp = a.e.t.v, x = a.e.e, op = b.e.op === '+' ? '++' : '--', nx = list[i + 2], done = false;
          ['e', 'c'].forEach(function (k) { if (!done && nx[k] && IR.mentions(nx[k], function (y) { return y.k === 'local' && y.v === tmp; })) { nx[k] = IR.map(nx[k], function (y) { if (y.k === 'local' && y.v === tmp) return { k: 'inc', t: x, op: op, post: true, type: x.type }; }); done = true; } });
          if (done) { list.splice(i, 2); i--; }
        }
      }
    });
    eachStmt(body, function (s) {
      if (s.k === 'expr' && s.e.k === 'assign' && s.e.iinc) {
        if (s.e.e.v === 1) s.e = { k: 'inc', t: s.e.t, op: s.e.op === '+' ? '++' : '--', post: true, type: s.e.type };
      }
    });
  };

  /* ---------- StringBuilder chains -> string concatenation ---------- */
  PS.stringConcat = function (body) {
    mapExprs(body, function (e) {
      return IR.map(e, function rec(x) {
        if (x.k === 'invoke' && x.name === 'toString' && x.args.length === 0 && /^java\/lang\/StringBu(ilder|ffer)$/.test(x.owner)) {
          var parts = [], cur = x.obj;
          while (cur && cur.k === 'invoke' && cur.name === 'append' && cur.owner === x.owner && cur.args.length === 1) {
            if (/^\(\[C\)/.test(cur.desc)) return undefined;
            // append(char)/append(boolean): keep the literal's type ('\'' not 39, true not 1)
            parts.unshift(coerce(cur.args[0], T.methodDesc(cur.desc).params[0], false)); cur = cur.obj;
          }
          if (!cur || cur.k !== 'newobj' || cur.cls !== x.owner) return undefined;
          if (cur.args.length === 1) {
            var first = cur.args[0];
            if (first.type === 'I') return undefined; // capacity argument
            if (first.k === 'invoke' && first.name === 'valueOf' && first.owner === 'java/lang/String' && first.args.length === 1) first = first.args[0];
            parts.unshift(first);
          } else if (cur.args.length > 1) return undefined;
          parts = parts.map(function (p) { return IR.map(p, rec); });
          return ACE.dtranslate.makeConcat(parts);
        }
      });
    });
  };

  /* ---------- array initialisers ---------- */
  PS.arrayInit = function (body) {
    eachList(body, function (list) {
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (!(s.k === 'expr' && s.e.k === 'assign' && !s.e.op && s.e.t.k === 'local' && s.e.t.v.temp && s.e.e.k === 'newarr' && s.e.e.dims.length === 1 && s.e.e.dims[0].k === 'const' && !s.e.e.init)) continue;
        var v = s.e.t.v, n = s.e.e.dims[0].v, elems = [];
        if (typeof n !== 'number' || n > 2000) continue;
        var j = i + 1;
        while (j < list.length && elems.length < n) {
          var st = list[j];
          if (st.k === 'expr' && st.e.k === 'assign' && !st.e.op && st.e.t.k === 'aget' && st.e.t.a.k === 'local' && st.e.t.a.v === v && st.e.t.i.k === 'const' && st.e.t.i.v === elems.length && !IR.mentions(st.e.e, function (y) { return y.k === 'local' && y.v === v; })) { elems.push(st.e.e); j++; }
          else break;
        }
        if (elems.length !== n) continue;
        if (countUses(body, v) !== n + 2) continue; // the definition, n element stores, one use
        var init = { k: 'newarr', elem: s.e.e.elem, dims: [], init: elems, type: s.e.e.type };
        list.splice(i, n + 1, { k: 'expr', e: { k: 'assign', t: s.e.t, e: init, type: init.type } });
      }
    });
  };

  /* ---------- structural clean-ups ---------- */
  function refsLoop(stmts, B, kinds) {
    var hit = false;
    eachStmt(stmts, function (s) { if (kinds.indexOf(s.k) >= 0 && (s.ref === B || (B.label && s.label === B.label) || (!s.label && !s.ref && s.k === 'cont'))) hit = true; });
    return hit;
  }
  PS.structural = function (body, isVoid, isCtor) {
    // if-cleanups
    eachList(body, function (list) {
      for (var i = 0; i < list.length; i++) {
        var s = list[i];
        if (s.k !== 'if') continue;
        if (s.els && !s.els.length) s.els = null;
        if (s.els && endsWithJump(s.then)) { var rest = s.els; s.els = null; list.splice.apply(list, [i + 1, 0].concat(rest)); }
        else if (s.els && endsWithJump(s.els) && !endsWithJump(s.then) && s.els.length <= s.then.length) { var r2 = s.then; s.then = s.els; s.els = null; s.c = IR.negate(s.c); list.splice.apply(list, [i + 1, 0].concat(r2)); }
      }
    });
    // loops
    eachStmt(body, function (s) {
      if (s.k !== 'while' || s.c.k !== 'const') return;
      var B = s.brk, b = s.body;
      // trailing continue
      function dropTailContinue(lst) {
        var l = lst[lst.length - 1];
        if (l && l.k === 'cont' && (!l.label || l.label === B.label)) { lst.pop(); return; }
        if (l && l.k === 'if') { dropTailContinue(l.then); if (l.els) dropTailContinue(l.els); }
      }
      dropTailContinue(b);
      var f = b[0];
      if (f && f.k === 'if' && !f.els && f.then.length === 1 && f.then[0].k === 'break' && f.then[0].ref === B) {
        s.c = IR.negate(f.c); b.shift(); return;
      }
      var l = b[b.length - 1];
      if (l && l.k === 'if' && !l.els && l.then.length === 1 && l.then[0].k === 'break' && l.then[0].ref === B && !refsLoop(b.slice(0, -1), B, ['cont'])) {
        s.k = 'dowhile'; s.c = IR.negate(l.c); b.pop();
      }
    });
    // labels: drop labels that are not referenced
    eachStmt(body, function (s) {
      if (s.brk) {
        var used = false; var lbl = s.brk.label;
        if (lbl) eachStmt(s.body || [].concat.apply([], (s.cases || []).map(function (c) { return c.body; })), function (x) { if ((x.k === 'break' || x.k === 'cont') && x.label === lbl) used = true; });
        s.label = used ? lbl : null;
      }
    });
    // last case of a switch: drop trailing break
    eachStmt(body, function (s) {
      if (s.k === 'switch' && s.cases.length) { var lc = s.cases[s.cases.length - 1].body; var l2 = lc[lc.length - 1]; if (l2 && l2.k === 'break' && !l2.label) lc.pop(); }
    });
    if (isVoid) { var last = body[body.length - 1]; if (last && last.k === 'ret' && !last.e) body.pop(); }
    if (isCtor && body[0] && body[0].k === 'expr' && body[0].e.k === 'ctorcall' && body[0].e.isSuper && !body[0].e.args.length) body.shift();
  };

  /* ---------- declarations ---------- */
  PS.declarations = function (body, fn) {
    var locals = fn.vars.filter(function (v) { return !v.param && !v.isThis && !v.catchParam; });
    // path of statement lists down to each reference
    var paths = new Map();
    (function walk(list, path) {
      list.forEach(function (s, idx) {
        var here = path.concat([{ list: list, idx: idx, stmt: s }]);
        exprsOf(s).forEach(function (e) { IR.walk(e, function (x) { if (x.k === 'local') { var p = paths.get(x.v); if (!p) paths.set(x.v, [here]); else p.push(here); } }); });
        lists(s).forEach(function (l) { walk(l, here); });
      });
    })(body, []);
    var plan = [];
    locals.forEach(function (v) {
      var ps = paths.get(v); if (!ps) return;
      // deepest common list
      var common = ps[0].length, k;
      ps.forEach(function (p) { for (k = 0; k < Math.min(common, p.length); k++) if (p[k].list !== ps[0][k].list) break; common = Math.min(common, k + (k < Math.min(common, p.length) ? 0 : 0)); });
      // recompute precisely: largest depth d such that all paths share the same list at d
      var d = 0;
      while (true) {
        var L = ps[0][d] && ps[0][d].list;
        if (!L || !ps.every(function (p) { return p[d] && p[d].list === L; })) break;
        d++;
      }
      d--;
      if (d < 0) d = 0;
      var list = ps[0][d].list;
      var firstIdx = Math.min.apply(null, ps.map(function (p) { return p[d].idx; }));
      plan.push({ v: v, list: list, idx: firstIdx, stmt: list[firstIdx] });
    });
    // apply: convert first assignment, else insert a declaration with a default value
    plan.forEach(function (p) {
      var idx = p.list.indexOf(p.stmt);
      var s = p.list[idx];
      if (isAssignTo(s, p.v) && !IR.mentions(s.e.e, function (x) { return x.k === 'local' && x.v === p.v; })) {
        p.list[idx] = { k: 'decl', v: p.v, init: s.e.e };
      } else {
        p.list.splice(idx, 0, { k: 'decl', v: p.v, init: { k: 'raw', text: T.defaultValue(p.v.type), type: p.v.type } });
      }
    });
  };

  /* ---------- for loops ---------- */
  PS.forLoops = function (body) {
    eachList(body, function (list) {
      for (var i = 1; i < list.length; i++) {
        var w = list[i], init = list[i - 1];
        if (w.k !== 'while' || !w.body.length) continue;
        var v = init.k === 'decl' ? init.v : (init.k === 'expr' && init.e.k === 'assign' && init.e.t.k === 'local' ? init.e.t.v : null);
        if (!v || !init.init && init.k === 'decl') continue;
        if (!IR.mentions(w.c, function (x) { return x.k === 'local' && x.v === v; })) continue;
        var upd = w.body[w.body.length - 1];
        if (!(upd.k === 'expr' && (upd.e.k === 'inc' || upd.e.k === 'assign') && upd.e.t.k === 'local' && upd.e.t.v === v)) continue;
        var hasCont = false; eachStmt(w.body, function (s) { if (s.k === 'cont') hasCont = true; });
        if (hasCont) continue;
        // the update moves into the for header: it must not use variables declared in the body
        var bodyDecls = new Set(); eachStmt(w.body, function (s) { if (s.k === 'decl') bodyDecls.add(s.v); });
        if (IR.mentions(upd.e, function (x) { return x.k === 'local' && bodyDecls.has(x.v); })) continue;
        if (init.k === 'decl') {
          var usedAfter = false;
          list.slice(i + 1).forEach(function (s) { exprsOf(s).forEach(function (e) { if (IR.mentions(e, function (x) { return x.k === 'local' && x.v === v; })) usedAfter = true; }); lists(s).forEach(function (l) { eachStmt(l, function (q) { exprsOf(q).forEach(function (e) { if (IR.mentions(e, function (x) { return x.k === 'local' && x.v === v; })) usedAfter = true; }); }); }); });
          if (usedAfter) continue;
        }
        list.splice(i - 1, 2, { k: 'for', init: init, c: w.c, upd: [w.body.pop()], body: w.body, label: w.label, brk: w.brk });
        i--;
      }
    });
  };

  /* ---------- unique names ---------- */
  /* Java scoping: a local may not redeclare a name visible from an enclosing scope, but sibling
   * scopes may reuse names (e.g. "e" in several catch clauses). Names are checked against the
   * names declared so far in the current scope chain; anything visible gets a numeric suffix. */
  PS.names = function (body, fn) {
    var params = new Set();
    fn.vars.forEach(function (v) { if (v.param && !v.isThis) params.add(v.name); });
    var seen = new Set();
    function legal(base) { if (!/^[A-Za-z_$][\w$]*$/.test(base) || RESERVED.has(base)) return 'v_' + String(base).replace(/\W/g, '_'); return base; }
    function claim(v, chain) {
      if (seen.has(v)) return; seen.add(v);
      var base = legal(v.name || ('var' + (v.slot != null ? v.slot : v.id)));
      var visible = function (n) { return params.has(n) || chain.some(function (sc) { return sc.has(n); }); };
      var n = base, k = 2;
      while (visible(n)) n = base + (k++);
      v.name = n; chain[chain.length - 1].add(n);
    }
    function walkList(list, chain, shared) {
      var scope = shared || new Set(), c2 = shared ? chain : chain.concat([scope]);
      list.forEach(function (s) {
        if (s.k === 'decl') claim(s.v, c2);
        if (s.k === 'for') { var fs = new Set(), c3 = c2.concat([fs]); if (s.init && s.init.k === 'decl') claim(s.init.v, c3); walkList(s.body, c3); return; }
        if (s.k === 'try') { walkList(s.body, c2); s.catches.forEach(function (c) { var cs = new Set(), c4 = c2.concat([cs]); claim(c.v, c4); walkList(c.body, c4); }); return; }
        if (s.k === 'switch') { var sw = new Set(), csw = c2.concat([sw]); s.cases.forEach(function (c) { walkList(c.body, csw, sw); }); return; }
        lists(s).forEach(function (l) { walkList(l, c2); });
      });
    }
    walkList(body, []);
  };
  var RESERVED = new Set('abstract assert boolean break byte case catch char class const continue default do double else enum extends final finally float for goto if implements import instanceof int interface long native new package private protected public return short static strictfp super switch synchronized this throw throws transient try void volatile while true false null var _'.split(' '));
  PS.RESERVED = RESERVED;

  /* "m = lock; monitorenter(lock); try { B } finally { monitorexit(m); }" -> "synchronized (lock) { B }"
   * (javac's code for synchronized blocks). The monitorexit(m) on each normal exit path inside B
   * is part of the same construct and is removed. Anything that does not match stays unconverted
   * and makes the method fail honestly when printed. */
  PS.synchronizedBlocks = function (body) {
    eachList(body, function (list) {
      for (var i = 0; i < list.length; i++) {
        var t = list[i];
        if (!(t.k === 'try' && !t.catches.length && t.fin && t.fin.length === 1 && t.fin[0].k === 'monitor' && !t.fin[0].enter && t.fin[0].e.k === 'local')) continue;
        var m = t.fin[0].e.v, enter = list[i - 1], asg = list[i - 2];
        if (!(enter && enter.k === 'monitor' && enter.enter)) continue;
        if (!(asg && isAssignTo(asg, m))) continue;
        var lock = asg.e.e, removeFrom = i - 2;
        var tmpAsg = list[i - 3];
        if (lock.k === 'local' && lock.v.temp && tmpAsg && isAssignTo(tmpAsg, lock.v)) { lock = tmpAsg.e.e; removeFrom = i - 3; }
        var stripped = 0;
        (function strip(lst) {
          for (var q = lst.length - 1; q >= 0; q--) {
            var x = lst[q];
            if (x.k === 'monitor' && !x.enter && x.e.k === 'local' && x.e.v === m) { lst.splice(q, 1); stripped++; continue; }
            lists(x).forEach(strip);
          }
        })(t.body);
        list.splice(removeFrom, i - removeFrom + 1, { k: 'sync', e: lock, body: t.body });
        i = removeFrom;
      }
    });
  };

  /* try { try { A } catch (...) { B } } finally { F }  ==  try { A } catch (...) { B } finally { F } */
  PS.mergeTryFinally = function (body) {
    eachStmt(body, function (s) {
      if (s.k === 'try' && s.fin && !s.catches.length && s.body.length === 1 && s.body[0].k === 'try' && !s.body[0].fin) {
        var inner = s.body[0]; s.body = inner.body; s.catches = inner.catches;
      }
    });
  };

  PS.run = function (fn, body, m, isCtor) {
    PS.synchronizedBlocks(body);
    PS.mergeTryFinally(body);
    var isVoid = T.methodDesc(m.desc).ret === 'V';
    fn.vars.forEach(function (v) { if (v.name && v.type && !v.temp && !v.stackVar && v.defs && v.defs.length) { /* LVT-typed variables keep their declared type */ } });
    PS.finalizeTypes(fn, body, m);
    for (var guard = 0; guard < 20; guard++) {
      var ch = PS.foldTernaries(body);
      ch = PS.inlineTemps(body, fn.vars) || ch;
      if (!ch) break;
    }
    PS.increments(body);
    PS.stringConcat(body);
    PS.arrayInit(body);
    for (guard = 0; guard < 10; guard++) if (!PS.inlineTemps(body, fn.vars)) break;
    PS.finalizeTypes(fn, body, m); // second pass: folded boolean expressions now reveal boolean variables
    PS.coerce(body, m);
    PS.structural(body, isVoid, isCtor);
    PS.declarations(body, fn);
    PS.forLoops(body);
    PS.names(body, fn);
    return body;
  };
})(window.ACE);
