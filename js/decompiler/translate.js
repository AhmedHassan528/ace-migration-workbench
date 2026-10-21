/* Method translation: bytecode -> control-flow graph of blocks holding IR statements.
 *  1. decode, find leaders, build blocks, normal + exceptional edges
 *  2. local variables: reaching-definition webs (a JVM slot reused for different values becomes
 *     different variables), names/types from LocalVariableTable when present
 *  3. symbolic stack execution per block; values that cross block boundaries go through shared
 *     stack variables; evaluation order is preserved by spilling to temporaries before statements
 * Anything not supported throws an Unsupported error so the caller can fall back honestly. */
(function (ACE) {
  'use strict';
  var T = ACE.dtypes, IR = ACE.ir, BC = ACE.bytecode;
  var TR = ACE.dtranslate = {};

  function Unsupported(msg) { var e = new Error(msg); e.unsupported = true; return e; }
  TR.Unsupported = Unsupported;

  var BRANCH = /^(if|goto)/;
  var RETURNS = /^([ilfda]?return|athrow)$/;

  TR.translate = function (cf, m) {
    var code = m.code;
    var ins = BC.decode(code.bytes), byPc = {};
    ins.forEach(function (x, i) { byPc[x.pc] = i; x.next = i + 1 < ins.length ? ins[i + 1].pc : null; });
    ins.forEach(function (x) {
      if (x.name === 'jsr' || x.name === 'jsr_w' || x.name === 'ret') throw Unsupported('jsr/ret subroutines (pre-Java 6 finally blocks)');
    });

    /* ---- 1. blocks ---- */
    var leaders = new Set([0]);
    ins.forEach(function (x) {
      if (x.target != null) { leaders.add(x.target); if (x.next != null) leaders.add(x.next); }
      if (x.cases) { x.cases.forEach(function (c) { leaders.add(c.target); }); leaders.add(x.dflt); if (x.next != null) leaders.add(x.next); }
      if (RETURNS.test(x.name) && x.next != null) leaders.add(x.next);
    });
    code.exceptions.forEach(function (e) { leaders.add(e.start); leaders.add(e.handler); if (byPc[e.end] != null) leaders.add(e.end); });
    var lp = Array.from(leaders).filter(function (p) { return byPc[p] != null; }).sort(function (a, b) { return a - b; });
    var blocks = [], blockAt = {};
    lp.forEach(function (pc, i) {
      var endPc = i + 1 < lp.length ? lp[i + 1] : code.bytes.length;
      var b = { id: blocks.length, start: pc, end: endPc, insns: ins.slice(byPc[pc], byPc[endPc] != null ? byPc[endPc] : ins.length), succs: [], excSuccs: [], preds: [], excPreds: [], stmts: [], term: null, entry: null, handlerOf: [] };
      blocks.push(b); blockAt[pc] = b;
    });
    blocks.forEach(function (b) {
      var last = b.insns[b.insns.length - 1];
      var nextB = last.next != null ? blockAt[last.next] : null;
      if (last.name === 'goto' || last.name === 'goto_w') b.succs = [blockAt[last.target]];
      else if (last.target != null) b.succs = [blockAt[last.target], nextB];
      else if (last.cases) { var s = new Set(last.cases.map(function (c) { return blockAt[c.target]; })); s.add(blockAt[last.dflt]); b.succs = Array.from(s); }
      else if (RETURNS.test(last.name)) b.succs = [];
      else { if (!nextB) throw Unsupported('control falls off the end of the method'); b.succs = [nextB]; }
      b.succs.forEach(function (s) { if (!s) throw Unsupported('branch into the middle of nowhere'); });
    });
    code.exceptions.forEach(function (e, idx) {
      var h = blockAt[e.handler];
      blocks.forEach(function (b) { if (b.start >= e.start && b.start < e.end) { if (b.excSuccs.indexOf(h) < 0) b.excSuccs.push(h); } });
      h.handlerOf.push(idx);
    });
    // reachability
    var seen = new Set(), stack = [blocks[0]];
    while (stack.length) { var b0 = stack.pop(); if (seen.has(b0)) continue; seen.add(b0); b0.succs.concat(b0.excSuccs).forEach(function (s) { stack.push(s); }); }
    blocks = blocks.filter(function (b) { return seen.has(b); });
    blocks.forEach(function (b) { b.succs.forEach(function (s) { s.preds.push(b); }); b.excSuccs.forEach(function (s) { s.excPreds.push(b); }); });

    /* ---- 2. variables ---- */
    var isStatic = (m.access & 0x0008) !== 0;
    var md = T.methodDesc(m.desc);
    var paramSlots = [], slot = 0;
    if (!isStatic) { paramSlots.push({ slot: 0, desc: 'L' + cf.name + ';', isThis: true }); slot = 1; }
    md.params.forEach(function (p, i) { paramSlots.push({ slot: slot, desc: p, index: i }); slot += T.isCat2(p) ? 2 : 1; });

    var defs = []; // {id, slot, pc(-1 for params), insn}
    paramSlots.forEach(function (p) { defs.push({ id: defs.length, slot: p.slot, pc: -1, param: p }); });
    var defOf = new Map(); // insn -> def
    ins.forEach(function (x) {
      if ((x.base && /store$/.test(x.base)) || x.name === 'iinc') { var d = { id: defs.length, slot: x.local, pc: x.pc, insn: x }; defs.push(d); defOf.set(x, d); }
    });
    var maxL = Math.max(code.maxLocals, slot);
    function emptyState() { var a = []; for (var i = 0; i < maxL; i++) a.push(new Set()); return a; }
    function cloneState(s) { return s.map(function (x) { return new Set(x); }); }
    function union(into, from) { var ch = false; for (var i = 0; i < into.length; i++) from[i].forEach(function (v) { if (!into[i].has(v)) { into[i].add(v); ch = true; } }); return ch; }
    var IN = new Map(), OUT = new Map(), ALLDEFS = new Map();
    blocks.forEach(function (b) { IN.set(b, emptyState()); OUT.set(b, emptyState()); var all = emptyState(); b.insns.forEach(function (x) { var d = defOf.get(x); if (d) all[d.slot].add(d.id); }); ALLDEFS.set(b, all); });
    var entryState = emptyState(); paramSlots.forEach(function (p, i) { entryState[p.slot].add(i); });
    union(IN.get(blocks[0]), entryState);
    var changed = true, guard = 0;
    while (changed && guard++ < 1000) {
      changed = false;
      blocks.forEach(function (b) {
        var st = cloneState(IN.get(b));
        b.insns.forEach(function (x) { var d = defOf.get(x); if (d) st[d.slot] = new Set([d.id]); });
        if (union(OUT.get(b), st)) changed = true;
        b.succs.forEach(function (s) { if (union(IN.get(s), OUT.get(b))) changed = true; });
        b.excSuccs.forEach(function (h) { if (union(IN.get(h), IN.get(b))) changed = true; if (union(IN.get(h), ALLDEFS.get(b))) changed = true; });
      });
    }
    // union-find webs
    var parent = defs.map(function (d) { return d.id; });
    function find(a) { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; }
    function unite(a, b) { a = find(a); b = find(b); if (a !== b) parent[b] = a; }
    var useDef = new Map(); // load insn -> representative def id
    blocks.forEach(function (b) {
      var st = cloneState(IN.get(b));
      b.insns.forEach(function (x) {
        var isLoad = (x.base && /load$/.test(x.base)) || x.name === 'iinc';
        if (isLoad) {
          var r = Array.from(st[x.local]);
          if (!r.length) throw Unsupported('local ' + x.local + ' read before assignment at pc ' + x.pc);
          for (var i = 1; i < r.length; i++) unite(r[0], r[i]);
          if (x.name === 'iinc') unite(r[0], defOf.get(x).id);
          useDef.set(x, r[0]);
        }
        var d = defOf.get(x); if (d) st[d.slot] = new Set([d.id]);
      });
    });
    var vars = [], webVar = new Map();
    function lvtFor(slotN, pc, isStore, len) {
      var p = isStore ? pc + len : pc;
      for (var i = 0; i < code.lvt.length; i++) { var e = code.lvt[i]; if (e.index === slotN && p >= e.start && p <= e.start + e.length) return e; }
      return null;
    }
    // Debug info says which stores belong to the same source variable: merge their webs even when no
    // read connects them (e.g. "String s = null; ... s = compute(); return s;").
    if (code.lvt.length) {
      var byEntry = {};
      defs.forEach(function (d) {
        if (d.param) return;
        var le = lvtFor(d.slot, d.pc, d.insn.name !== 'iinc', d.insn.len);
        if (!le) return;
        var key = le.index + ':' + le.start;
        if (byEntry[key] != null) unite(byEntry[key], d.id); else byEntry[key] = d.id;
      });
    }
    function lvttFor(e) { if (!e) return null; for (var i = 0; i < code.lvtt.length; i++) { var t = code.lvtt[i]; if (t.index === e.index && t.start === e.start) return t.desc; } return null; }
    function varOfDef(defId) {
      var root = find(defId);
      if (webVar.has(root)) return webVar.get(root);
      var v = { id: vars.length, name: null, type: null, slot: defs[defId].slot, storeTypes: [], defs: [], params: false };
      vars.push(v); webVar.set(root, v); return v;
    }
    defs.forEach(function (d) { var v = varOfDef(d.id); v.defs.push(d); });
    vars.forEach(function (v) {
      var ps = v.defs.filter(function (d) { return d.param; });
      if (ps.length) {
        var p = ps[0].param; v.param = p; v.type = p.desc;
        if (p.isThis) { v.isThis = true; v.name = 'this'; }
        var e = code.lvt.filter(function (x) { return x.index === p.slot && x.start === 0; })[0];
        if (e && !p.isThis) { v.name = e.name; v.sig = lvttFor(e); }
        else if (!p.isThis && m.paramNames && m.paramNames[p.index] && m.paramNames[p.index].name) v.name = m.paramNames[p.index].name;
        else if (!p.isThis) v.name = 'arg' + p.index;
      }
      if (!v.name) {
        for (var i = 0; i < v.defs.length && !v.name; i++) { var d = v.defs[i]; var le = lvtFor(d.slot, d.pc, d.insn.name !== 'iinc', d.insn.len); if (le) { v.name = le.name; v.type = le.desc; v.sig = lvttFor(le); } }
      }
    });
    useDef.forEach(function (defId, x) {
      var v = varOfDef(defId);
      if (!v.name) { var le = lvtFor(x.local, x.pc, false, 0); if (le) { v.name = le.name; v.type = le.desc; v.sig = lvttFor(le); } }
    });
    function varForInsn(x) {
      if (x.name === 'iinc') return varOfDef(defOf.get(x).id);
      if (/store$/.test(x.base)) return varOfDef(defOf.get(x).id);
      return varOfDef(useDef.get(x));
    }

    /* ---- 3. symbolic execution ---- */
    var tempN = 0, svN = 0;
    function newTemp(type, sv) { var v = { id: vars.length, name: (sv ? 'stack' : 'tmp') + (sv ? svN++ : tempN++), type: type, temp: !sv, stackVar: !!sv, storeTypes: [type], defs: [] }; vars.push(v); return v; }
    var thisClass = cf.name;
    var C = function (v, type) { return { k: 'const', v: v, type: type }; };
    function local(v) { return { k: v.isThis ? 'this' : 'local', v: v, type: v.type || 'I' }; }

    // reverse post-order over normal + exceptional edges
    var order = [], vis = new Set();
    (function dfs(b) { vis.add(b); b.succs.concat(b.excSuccs).forEach(function (s) { if (!vis.has(s)) dfs(s); }); order.push(b); })(blocks[0]);
    order.reverse();
    blocks.forEach(function (b) { if (b.handlerOf.length) { var types = b.handlerOf.map(function (i) { return code.exceptions[i].type; }); var t = types.length === 1 && types[0] ? types[0] : 'java/lang/Throwable'; b.entry = [{ k: 'caught', type: 'L' + t + ';', catchTypes: types }]; } });
    blocks[0].entry = blocks[0].entry || [];

    order.forEach(function (b) {
      if (!b.entry) throw Unsupported('block at pc ' + b.start + ' has no known entry stack');
      var st = b.entry.map(function (e) { return e.k === 'caught' ? e : local(e.v); });
      var out = b.stmts;
      function push(e) { st.push(e); }
      function pop() { if (!st.length) throw Unsupported('operand stack underflow at block ' + b.start); return st.pop(); }
      function flush(extraPred) {
        for (var i = 0; i < st.length; i++) {
          var e = st[i];
          if (IR.isTrivial(e) && !(extraPred && extraPred(e))) continue;
          if (e.k === 'caught') continue;
          var t = newTemp(e.type);
          out.push({ k: 'expr', e: { k: 'assign', t: local(t), e: e, type: e.type } });
          st[i] = local(t);
        }
      }
      function emit(s, pred) { flush(pred); out.push(s); }
      function mentionsVar(v) { return function (e) { return IR.mentions(e, function (x) { return x.k === 'local' && x.v === v; }); }; }
      function cond(e, rel) {
        if (e.k === 'cmp') {
          var l = e.l, r = e.r, op = e.op;
          if (op === 'lcmp' || rel === '==' || rel === '!=') return { k: 'bin', op: rel, l: l, r: r, type: 'Z' };
          var G = /g$/.test(op);
          var B = function (o) { return { k: 'bin', op: o, l: l, r: r, type: 'Z' }; };
          if (!G) return rel === '>' ? B('>') : rel === '>=' ? B('>=') : rel === '<' ? IR.negate(B('>=')) : IR.negate(B('>'));
          return rel === '<' ? B('<') : rel === '<=' ? B('<=') : rel === '>' ? IR.negate(B('<=')) : IR.negate(B('<'));
        }
        if (e.type === 'Z' && (rel === '==' || rel === '!=')) return rel === '==' ? IR.negate(e) : e;
        return { k: 'bin', op: rel, l: e, r: C(0, 'I'), type: 'Z' };
      }
      var REL = { eq: '==', ne: '!=', lt: '<', ge: '>=', gt: '>', le: '<=' };
      for (var ii = 0; ii < b.insns.length; ii++) {
        var x = b.insns[ii], nm = x.name, a, bb, c, v, t;
        if (/^iconst_/.test(nm)) { push(C(nm === 'iconst_m1' ? -1 : Number(nm.slice(7)), 'I')); continue; }
        if (/^lconst_/.test(nm)) { push(C(BigInt(nm.slice(7)), 'J')); continue; }
        if (/^fconst_/.test(nm)) { push(C(Number(nm.slice(7)), 'F')); continue; }
        if (/^dconst_/.test(nm)) { push(C(Number(nm.slice(7)), 'D')); continue; }
        if (x.base && /load$/.test(x.base)) { v = varForInsn(x); if (!v.type) v.type = { i: 'I', l: 'J', f: 'F', d: 'D', a: T.OBJECT }[x.base[0]]; push(local(v)); continue; }
        if (x.base && /store$/.test(x.base)) {
          var val = pop(); v = varForInsn(x);
          if (!v.type) v.type = val.type === 'null' ? null : val.type;
          v.storeTypes.push(val.type);
          if (val.k === 'caught') { b.catchVar = v; v.catchParam = true; if (!v.type || v.type === 'null') v.type = val.type; continue; }
          emit({ k: 'expr', e: { k: 'assign', t: local(v), e: val, type: v.type } }, mentionsVar(v));
          continue;
        }
        switch (nm) {
          case 'nop': break;
          case 'aconst_null': push({ k: 'null', type: 'null' }); break;
          case 'bipush': case 'sipush': push(C(x.value, 'I')); break;
          case 'ldc': case 'ldc_w': case 'ldc2_w': {
            var k = cf.constant(x.index);
            if (k.kind === 'int') push(C(k.value, 'I'));
            else if (k.kind === 'float') push(C(k.value, 'F'));
            else if (k.kind === 'long') push(C(k.value, 'J'));
            else if (k.kind === 'double') push(C(k.value, 'D'));
            else if (k.kind === 'string') push(C(k.value, T.STRING));
            else if (k.kind === 'class') push({ k: 'classlit', ref: k.name[0] === '[' ? k.name : 'L' + k.name + ';', type: 'Ljava/lang/Class;' });
            else throw Unsupported('ldc of ' + k.kind + ' constant');
            break;
          }
          case 'iaload': case 'laload': case 'faload': case 'daload': case 'aaload': case 'baload': case 'caload': case 'saload': {
            var idx = pop(), arr = pop();
            var et = T.elementType(arr.type) || { i: 'I', l: 'J', f: 'F', d: 'D', a: T.OBJECT, b: 'B', c: 'C', s: 'S' }[nm[0]];
            push({ k: 'aget', a: arr, i: idx, type: et }); break;
          }
          case 'iastore': case 'lastore': case 'fastore': case 'dastore': case 'aastore': case 'bastore': case 'castore': case 'sastore': {
            var vv = pop(), i2 = pop(), ar = pop();
            var et2 = T.elementType(ar.type) || { i: 'I', l: 'J', f: 'F', d: 'D', a: T.OBJECT, b: 'B', c: 'C', s: 'S' }[nm[0]];
            emit({ k: 'expr', e: { k: 'assign', t: { k: 'aget', a: ar, i: i2, type: et2 }, e: vv, type: et2 } });
            break;
          }
          case 'pop': a = pop(); if (IR.hasSideEffects(a)) emit({ k: 'expr', e: a }); break;
          case 'pop2': a = pop(); if (!T.isCat2(a.type)) { bb = pop(); if (IR.hasSideEffects(bb)) emit({ k: 'expr', e: bb }); } if (IR.hasSideEffects(a)) emit({ k: 'expr', e: a }); break;
          case 'dup': case 'dup_x1': case 'dup_x2': case 'dup2': case 'dup2_x1': case 'dup2_x2': {
            // Make every value that will be duplicated trivial first (no double evaluation).
            var depth = nm === 'dup' || nm === 'dup_x1' || nm === 'dup_x2' ? 1 : (T.isCat2(st[st.length - 1].type) ? 1 : 2);
            for (var q = st.length - depth; q < st.length; q++) if (!IR.isTrivial(st[q])) { var tv = newTemp(st[q].type); out.push({ k: 'expr', e: { k: 'assign', t: local(tv), e: st[q], type: st[q].type } }); st[q] = local(tv); }
            var top = st.splice(st.length - depth, depth);
            var under = 0;
            if (nm === 'dup_x1' || nm === 'dup2_x1') under = 1;
            if (nm === 'dup_x2' || nm === 'dup2_x2') { var w = st[st.length - 1]; under = T.isCat2(w.type) ? 1 : 2; if (nm === 'dup2_x2' && depth === 1 && !T.isCat2(w.type)) under = 2; }
            var below = st.splice(st.length - under, under);
            st.push.apply(st, top); st.push.apply(st, below); st.push.apply(st, top);
            break;
          }
          case 'swap': a = pop(); bb = pop(); push(a); push(bb); break;
          case 'iadd': case 'ladd': case 'fadd': case 'dadd': case 'isub': case 'lsub': case 'fsub': case 'dsub':
          case 'imul': case 'lmul': case 'fmul': case 'dmul': case 'idiv': case 'ldiv': case 'fdiv': case 'ddiv':
          case 'irem': case 'lrem': case 'frem': case 'drem': case 'ishl': case 'lshl': case 'ishr': case 'lshr':
          case 'iushr': case 'lushr': case 'iand': case 'land': case 'ior': case 'lor': case 'ixor': case 'lxor': {
            bb = pop(); a = pop();
            var op = { add: '+', sub: '-', mul: '*', div: '/', rem: '%', shl: '<<', shr: '>>', ushr: '>>>', and: '&', or: '|', xor: '^' }[nm.slice(1)];
            t = { i: 'I', l: 'J', f: 'F', d: 'D' }[nm[0]];
            if (t === 'I' && (op === '&' || op === '|' || op === '^') && a.type === 'Z' && bb.type === 'Z') t = 'Z';
            push({ k: 'bin', op: op, l: a, r: bb, type: t }); break;
          }
          case 'ineg': case 'lneg': case 'fneg': case 'dneg': a = pop(); push({ k: 'un', op: '-', e: a, type: a.type }); break;
          case 'iinc': {
            v = varForInsn(x); if (!v.type) v.type = 'I';
            emit({ k: 'expr', e: { k: 'assign', t: local(v), op: x.value < 0 ? '-' : '+', e: C(Math.abs(x.value), 'I'), type: 'I', iinc: true } }, mentionsVar(v));
            break;
          }
          case 'i2l': case 'f2l': case 'd2l': a = pop(); push({ k: 'cast', to: 'J', e: a, type: 'J' }); break;
          case 'i2f': case 'l2f': case 'd2f': a = pop(); push({ k: 'cast', to: 'F', e: a, type: 'F' }); break;
          case 'i2d': case 'l2d': case 'f2d': a = pop(); push({ k: 'cast', to: 'D', e: a, type: 'D' }); break;
          case 'l2i': case 'f2i': case 'd2i': a = pop(); push({ k: 'cast', to: 'I', e: a, type: 'I' }); break;
          case 'i2b': a = pop(); push({ k: 'cast', to: 'B', e: a, type: 'B' }); break;
          case 'i2c': a = pop(); push({ k: 'cast', to: 'C', e: a, type: 'C' }); break;
          case 'i2s': a = pop(); push({ k: 'cast', to: 'S', e: a, type: 'S' }); break;
          case 'lcmp': case 'fcmpl': case 'fcmpg': case 'dcmpl': case 'dcmpg': bb = pop(); a = pop(); push({ k: 'cmp', op: nm, l: a, r: bb, type: 'I' }); break;
          case 'ifeq': case 'ifne': case 'iflt': case 'ifge': case 'ifgt': case 'ifle':
            a = pop(); b.term = { k: 'if', c: cond(a, REL[nm.slice(2)]), target: blockAt[x.target], next: blockAt[x.next] }; break;
          case 'if_icmpeq': case 'if_icmpne': case 'if_icmplt': case 'if_icmpge': case 'if_icmpgt': case 'if_icmple': case 'if_acmpeq': case 'if_acmpne':
            bb = pop(); a = pop(); b.term = { k: 'if', c: { k: 'bin', op: REL[nm.slice(-2)], l: a, r: bb, type: 'Z' }, target: blockAt[x.target], next: blockAt[x.next] }; break;
          case 'ifnull': case 'ifnonnull':
            a = pop(); b.term = { k: 'if', c: { k: 'bin', op: nm === 'ifnull' ? '==' : '!=', l: a, r: { k: 'null', type: 'null' }, type: 'Z' }, target: blockAt[x.target], next: blockAt[x.next] }; break;
          case 'goto': case 'goto_w': b.term = { k: 'goto', target: blockAt[x.target] }; break;
          case 'tableswitch': case 'lookupswitch':
            a = pop(); b.term = { k: 'switch', e: a, cases: x.cases.map(function (c2) { return { key: c2.key, target: blockAt[c2.target] }; }), dflt: blockAt[x.dflt] }; break;
          case 'ireturn': case 'lreturn': case 'freturn': case 'dreturn': case 'areturn':
            a = pop(); emit({ k: 'ret', e: a }); b.term = { k: 'exit' }; break;
          case 'return': emit({ k: 'ret', e: null }); b.term = { k: 'exit' }; break;
          case 'athrow': a = pop(); emit({ k: 'throw', e: a }); b.term = { k: 'exit' }; break;
          case 'getstatic': { var f = cf.constant(x.index); push({ k: 'field', obj: null, owner: f.owner, name: f.name, desc: f.desc, type: f.desc }); break; }
          case 'getfield': { var f2 = cf.constant(x.index); a = pop(); push({ k: 'field', obj: a, owner: f2.owner, name: f2.name, desc: f2.desc, type: f2.desc }); break; }
          case 'putstatic': { var f3 = cf.constant(x.index); a = pop(); emit({ k: 'expr', e: { k: 'assign', t: { k: 'field', obj: null, owner: f3.owner, name: f3.name, desc: f3.desc, type: f3.desc }, e: a, type: f3.desc } }, function (e) { return IR.mentions(e, function (y) { return y.k === 'field' && y.name === f3.name; }); }); break; }
          case 'putfield': { var f4 = cf.constant(x.index); a = pop(); bb = pop(); emit({ k: 'expr', e: { k: 'assign', t: { k: 'field', obj: bb, owner: f4.owner, name: f4.name, desc: f4.desc, type: f4.desc }, e: a, type: f4.desc } }, function (e) { return IR.mentions(e, function (y) { return y.k === 'field' && y.name === f4.name; }); }); break; }
          case 'invokevirtual': case 'invokespecial': case 'invokestatic': case 'invokeinterface': {
            var mr = cf.constant(x.index), mdd = T.methodDesc(mr.desc), args = [];
            for (var pi = mdd.params.length - 1; pi >= 0; pi--) args.unshift(pop());
            args.forEach(function (ar2, ai) { ar2.expect = mdd.params[ai]; });
            var obj = nm === 'invokestatic' ? null : pop();
            if (mr.name === '<init>') {
              if (obj.k === 'uninit') {
                var ne = { k: 'newobj', cls: mr.owner, desc: mr.desc, args: args, type: 'L' + mr.owner + ';' };
                var found = false;
                for (var si = 0; si < st.length; si++) if (st[si].k === 'uninit' && st[si].id === obj.id) { st[si] = ne; found = true; }
                if (!found) emit({ k: 'expr', e: ne });
              } else if (obj.k === 'this') {
                emit({ k: 'expr', e: { k: 'ctorcall', isSuper: mr.owner !== thisClass, args: args, owner: mr.owner, desc: mr.desc } });
              } else throw Unsupported('constructor call on an unexpected receiver');
              break;
            }
            var inv = { k: 'invoke', kind: nm.slice(6), obj: obj, owner: mr.owner, name: mr.name, desc: mr.desc, args: args, type: mdd.ret, isSuper: nm === 'invokespecial' && obj && obj.k === 'this' && mr.owner !== thisClass && !(m.access & 0) , sameClass: mr.owner === thisClass };
            if (inv.isSuper && (cf.access & 0x0200)) inv.isSuper = false;
            if (mdd.ret === 'V') emit({ k: 'expr', e: inv }); else push(inv);
            break;
          }
          case 'invokedynamic': {
            var id = cf.constant(x.index), bm = cf.bootstrap[id.bsm], bref = bm ? cf.constant(bm.ref) : null;
            var idesc = T.methodDesc(id.desc), dargs = [];
            for (var di = idesc.params.length - 1; di >= 0; di--) dargs.unshift(pop());
            if (bref && bref.ref && bref.ref.owner === 'java/lang/invoke/StringConcatFactory') {
              var recipe = bm.args.length ? cf.constant(bm.args[0]).value : null, parts = [], ai2 = 0, lit = '';
              if (recipe == null) { parts = dargs; }
              else {
                for (var ri = 0; ri < recipe.length; ri++) {
                  var ch = recipe[ri];
                  if (ch === '\u0001') { if (lit) { parts.push(C(lit, T.STRING)); lit = ''; } parts.push(dargs[ai2++]); }
                  else if (ch === '\u0002') throw Unsupported('string concatenation with dynamic constants');
                  else lit += ch;
                }
                if (lit) parts.push(C(lit, T.STRING));
              }
              push(TR.makeConcat(parts)); break;
            }
            throw Unsupported('invokedynamic (' + (bref && bref.ref ? bref.ref.owner.split('/').pop() + '.' + bref.ref.name : 'unknown bootstrap') + ', e.g. a lambda or method reference)');
          }
          case 'new': { var cl = cf.constant(x.index); push({ k: 'uninit', cls: cl.name, id: x.pc, type: 'L' + cl.name + ';' }); break; }
          case 'newarray': a = pop(); push({ k: 'newarr', elem: BC.NEWARRAY_TYPES[x.atype], dims: [a], type: '[' + BC.NEWARRAY_TYPES[x.atype] }); break;
          case 'anewarray': { var ac = cf.constant(x.index), ed = ac.name[0] === '[' ? ac.name : 'L' + ac.name + ';'; a = pop(); push({ k: 'newarr', elem: ed, dims: [a], type: '[' + ed }); break; }
          case 'multianewarray': { var mc = cf.constant(x.index), dims = []; for (var dd = 0; dd < x.dims; dd++) dims.unshift(pop()); push({ k: 'newarr', elem: mc.name.slice(1), dims: dims, type: mc.name }); break; }
          case 'arraylength': a = pop(); push({ k: 'alen', a: a, type: 'I' }); break;
          // Kept as statements; the structurer/passes turn the monitor pair + its catch-all handler
          // into "synchronized (x) { ... }" or the method fails honestly.
          case 'monitorenter': a = pop(); emit({ k: 'monitor', enter: true, e: a }); break;
          case 'monitorexit': a = pop(); emit({ k: 'monitor', enter: false, e: a }); break;
          case 'checkcast': { var cc = cf.constant(x.index), cd = cc.name[0] === '[' ? cc.name : 'L' + cc.name + ';'; a = pop(); push({ k: 'cast', to: cd, e: a, type: cd }); break; }
          case 'instanceof': { var ic = cf.constant(x.index); a = pop(); push({ k: 'inst', e: a, cls: ic.name, type: 'Z' }); break; }
          default: throw Unsupported('instruction ' + nm);
        }
      }
      if (!b.term) b.term = { k: 'goto', target: b.succs[0], fall: true };
      // values that stay on the stack flow into the successors through shared stack variables
      if (st.length) {
        if (b.term.k === 'exit') throw Unsupported('values left on the stack at method exit');
        for (var d = 0; d < st.length; d++) {
          if (st[d].k === 'local' && st[d].v.stackVar) continue;
          if (st[d].k === 'caught') throw Unsupported('exception value carried across blocks');
          var sv = newTemp(st[d].type, true);
          out.push({ k: 'expr', e: { k: 'assign', t: local(sv), e: st[d], type: st[d].type } });
          st[d] = local(sv);
        }
        b.succs.forEach(function (s) {
          if (!s.entry) { s.entry = st.map(function (e) { return { k: 'local', v: e.v }; }); return; }
          if (s.entry.length !== st.length) throw Unsupported('inconsistent stack depth at pc ' + s.start);
          for (var d2 = 0; d2 < st.length; d2++) if (s.entry[d2].v !== st[d2].v) out.push({ k: 'expr', e: { k: 'assign', t: local(s.entry[d2].v), e: st[d2], type: st[d2].type } });
        });
      } else b.succs.forEach(function (s) { if (!s.entry) s.entry = []; else if (s.entry.length && !s.handlerOf.length) throw Unsupported('inconsistent stack depth at pc ' + s.start); });
    });

    return { blocks: blocks, entry: blocks[0], vars: vars, params: paramSlots, md: md, isStatic: isStatic, ins: ins, code: code };
  };

  /* String concatenation node; Java's + needs a String operand among the first two parts. */
  TR.makeConcat = function (parts) {
    var isStr = function (e) { return e.type === T.STRING; };
    if (!parts.length) return { k: 'const', v: '', type: T.STRING };
    if (!(isStr(parts[0]) || (parts.length > 1 && isStr(parts[1]))) && !(parts.length === 1 && isStr(parts[0]))) parts = [{ k: 'const', v: '', type: T.STRING }].concat(parts);
    if (parts.length === 1) parts = [{ k: 'const', v: '', type: T.STRING }].concat(parts);
    return { k: 'concat', parts: parts, type: T.STRING };
  };
})(window.ACE);
