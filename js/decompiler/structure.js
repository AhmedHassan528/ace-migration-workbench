/* Control-flow structuring: CFG of IR blocks -> structured Java statements.
 * Uses dominators (loops), post-dominators (if/switch/try join points), natural loops, exception
 * regions from the exception table, and compound-condition merging for && / ||.
 * Unsupported shapes (irreducible flow, overlapping or split try ranges, jumps out of a try body
 * to an unrelated block) raise Unsupported errors instead of producing guessed code. */
(function (ACE) {
  'use strict';
  var IR = ACE.ir, TR = ACE.dtranslate;
  var S = ACE.dstructure = {};
  var Unsupported = TR.Unsupported;

  /* Cooper-Harvey-Kennedy dominators over nodes reachable from entry. Returns Map node->idom. */
  function dominators(entry, succ) {
    var order = [], vis = new Set();
    (function dfs(n) { vis.add(n); succ(n).forEach(function (s) { if (!vis.has(s)) dfs(s); }); order.push(n); })(entry);
    order.reverse();
    var idx = new Map(); order.forEach(function (n, i) { idx.set(n, i); });
    var preds = new Map(); order.forEach(function (n) { preds.set(n, []); });
    order.forEach(function (n) { succ(n).forEach(function (s) { if (preds.has(s)) preds.get(s).push(n); }); });
    var idom = new Map(); idom.set(entry, entry);
    function intersect(a, b) { while (a !== b) { while (idx.get(a) > idx.get(b)) a = idom.get(a); while (idx.get(b) > idx.get(a)) b = idom.get(b); } return a; }
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 1; i < order.length; i++) {
        var n = order[i], ps = preds.get(n).filter(function (p) { return idom.has(p); });
        if (!ps.length) continue;
        var ni = ps[0];
        for (var k = 1; k < ps.length; k++) ni = intersect(ps[k], ni);
        if (idom.get(n) !== ni) { idom.set(n, ni); changed = true; }
      }
    }
    return idom;
  }
  function dominates(idom, a, b) { var x = b; while (true) { if (x === a) return true; var p = idom.get(x); if (!p || p === x) return x === a; x = p; } }

  /* Merge short-circuit conditions (&&, ||) into single conditional blocks. */
  function mergeConditions(blocks) {
    var changed = true;
    while (changed) {
      changed = false;
      for (var i = 0; i < blocks.length; i++) {
        var b1 = blocks[i];
        if (!b1 || b1.dead || !b1.term || b1.term.k !== 'if') continue;
        [b1.term.next, b1.term.target].forEach(function (b2) {
          if (changed || !b2 || b2 === b1 || b2.dead || b2.term.k !== 'if' || b2.stmts.length || b2.preds.length !== 1 || b2.excPreds.length || b2.handlerOf.length) return;
          if (b2.excSuccs.length !== b1.excSuccs.length || b2.excSuccs.some(function (h, k) { return b1.excSuccs[k] !== h; })) return;
          var J1 = b1.term.c, T1 = b1.term.target, N1 = b1.term.next, J2 = b2.term.c, T2 = b2.term.target, N2 = b2.term.next, nt = null;
          var OR = function (a, b) { return { k: 'bin', op: '||', l: a, r: b, type: 'Z' }; }, AND = function (a, b) { return { k: 'bin', op: '&&', l: a, r: b, type: 'Z' }; };
          if (b2 === N1 && T2 === T1) nt = { c: OR(J1, J2), target: T1, next: N2 };
          else if (b2 === N1 && N2 === T1) nt = { c: AND(IR.negate(J1), J2), target: T2, next: T1 };
          else if (b2 === T1 && T2 === N1) nt = { c: AND(J1, IR.negate(J2)), target: N2, next: N1 };
          else if (b2 === T1 && N2 === N1) nt = { c: AND(J1, J2), target: T2, next: N1 };
          if (!nt || nt.target === nt.next) return;
          b1.term = { k: 'if', c: nt.c, target: nt.target, next: nt.next };
          b2.dead = true;
          b1.succs = [nt.target, nt.next];
          [T2, N2].forEach(function (s) { s.preds = s.preds.filter(function (p) { return p !== b2; }); });
          [nt.target, nt.next].forEach(function (s) { if (s.preds.indexOf(b1) < 0) s.preds.push(b1); });
          changed = true;
        });
      }
    }
    return blocks.filter(function (b) { return !b.dead; });
  }

  /* Remove blocks that contain nothing but "goto X": they execute no code, so redirecting their
   * predecessors to X preserves behaviour and gives loops/ifs/tries their real targets. */
  function collapseJumps(blocks, entry) {
    var changed = true;
    while (changed) {
      changed = false;
      blocks.forEach(function (b) {
        if (b.dead || b === entry || b.stmts.length || b.term.k !== 'goto' || b.handlerOf.length) return;
        var t = b.term.target;
        if (t === b) return;
        var clash = b.preds.some(function (p) { return p.term.k === 'if' && ((p.term.target === b && p.term.next === t) || (p.term.next === b && p.term.target === t)); });
        if (clash) return;
        b.preds.forEach(function (p) {
          p.succs = p.succs.map(function (s) { return s === b ? t : s; }).filter(function (s, i, a) { return a.indexOf(s) === i; });
          if (p.term.k === 'goto' && p.term.target === b) p.term.target = t;
          if (p.term.k === 'if') { if (p.term.target === b) p.term.target = t; if (p.term.next === b) p.term.next = t; }
          if (p.term.k === 'switch') { p.term.cases.forEach(function (c) { if (c.target === b) c.target = t; }); if (p.term.dflt === b) p.term.dflt = t; }
          if (t.preds.indexOf(p) < 0) t.preds.push(p);
        });
        t.preds = t.preds.filter(function (p) { return p !== b; });
        b.dead = true; changed = true;
      });
      blocks = blocks.filter(function (b) { return !b.dead; });
    }
    return blocks;
  }

  S.structure = function (fn) {
    var blocks = mergeConditions(collapseJumps(fn.blocks, fn.entry));
    var entry = fn.entry, code = fn.code;
    var allSucc = function (b) { return b.succs.concat(b.excSuccs); };
    var idom = dominators(entry, allSucc);
    // Post-dominators with a virtual EXIT node. Two versions:
    //   normal  - normal edges only: join points of if/switch and loop exits
    //   full    - including exception edges: join point (follow) of a try statement
    function postdom(succFn) {
      var EXIT = { id: -1, exit: true };
      var rp = new Map([[EXIT, []]]); blocks.forEach(function (b) { rp.set(b, []); });
      blocks.forEach(function (b) {
        var ss = succFn(b);
        ss.forEach(function (s) { if (rp.has(s)) rp.get(s).push(b); });
        if (!ss.length) rp.get(EXIT).push(b);
      });
      var m = dominators(EXIT, function (n) { return rp.get(n) || []; });
      return function (b) { var p = m.get(b); return !p || p === EXIT || p === b ? null : p; };
    }
    var ipdom = postdom(function (b) { return b.succs; });
    var ipdomFull = postdom(allSucc);

    // natural loops (normal edges only)
    var loops = new Map();
    blocks.forEach(function (u) {
      u.succs.forEach(function (h) {
        if (!dominates(idom, h, u)) return;
        var L = loops.get(h) || { header: h, body: new Set([h]) };
        var stack = [u];
        while (stack.length) { var n = stack.pop(); if (L.body.has(n)) continue; L.body.add(n); n.preds.forEach(function (p) { stack.push(p); }); n.excPreds.forEach(function (p) { stack.push(p); }); }
        loops.set(h, L);
      });
    });
    // irreducibility check: every retreating edge must be a back edge
    (function () {
      var state = new Map();
      (function dfs(n) {
        state.set(n, 1);
        n.succs.forEach(function (s) {
          if (state.get(s) === 1 && !dominates(idom, s, n)) throw Unsupported('irreducible control flow');
          if (!state.has(s)) dfs(s);
        });
        state.set(n, 2);
      })(entry);
    })();
    // parent loop = smallest other loop whose body contains this header
    loops.forEach(function (L) {
      var best = null;
      loops.forEach(function (P) { if (P !== L && P.body.has(L.header) && P.body.size > L.body.size && (!best || P.body.size < best.body.size)) best = P; });
      L.parent = best;
    });
    loops.forEach(function (L) {
      var exits = new Set();
      L.body.forEach(function (n) { n.succs.forEach(function (s) { if (!L.body.has(s)) exits.add(s); }); });
      L.exits = Array.from(exits);
      var pd = ipdom(L.header);
      while (pd && L.body.has(pd)) pd = ipdom(pd);
      L.exit = pd && exits.has(pd) ? pd : (L.exits.length === 1 ? L.exits[0] : (pd || null));
      // A nested loop's natural exit stays inside its parent loop; exits that leave the parent loop
      // too are labelled breaks of the parent ("break outer"), and a jump to the parent's update
      // block is the target of "continue outer".
      if (L.parent) {
        var inner = L.exits.filter(function (x) { return L.parent.body.has(x); });
        if (inner.length && (!L.exit || !L.parent.body.has(L.exit))) {
          var count = function (x) { var n = 0; L.body.forEach(function (b) { b.succs.forEach(function (s2) { if (s2 === x) n++; }); }); return n; };
          L.exit = inner.slice().sort(function (a, b) { return count(b) - count(a) || a.start - b.start; })[0];
        }
      }
    });

    /* ---- finally regions (catch-all handlers) ----
     * javac compiles "finally { F }" as: F copied inline on every exit path of the try (outside the
     * protected ranges), plus a catch-all handler "astore t; F; aload t; athrow". "synchronized"
     * compiles to the same shape with F = monitorexit. We accept a catch-all handler only when its
     * body is straight-line F followed by rethrowing the caught exception, and every inline copy we
     * remove must match F statement for statement. Anything else stays unsupported. */
    function canon(stmts) {
      var ids = new Map();
      return JSON.stringify(stmts, function (k, v) {
        if (typeof v === 'bigint') return 'n' + v;
        if (k === 'expect' || k === 'brk' || k === 'ref') return undefined;
        if (v && typeof v === 'object' && v.k === undefined && (v.defs || v.storeTypes || v.param !== undefined || v.stackVar !== undefined)) { if (!ids.has(v)) ids.set(v, ids.size); return 'var#' + ids.get(v); }
        return v;
      });
    }
    var finRegions = [];
    var catchAll = {};
    code.exceptions.forEach(function (e) { if (e.type === null) (catchAll[e.handler] = catchAll[e.handler] || []).push(e); });
    Object.keys(catchAll).forEach(function (hpc) {
      var H = blocks.filter(function (b) { return b.start === Number(hpc); })[0];
      if (!H) return;
      // straight-line chain of the handler
      var chain = [H], cur = H, guard = 0;
      while (cur.term.k === 'goto' && cur.succs.length === 1 && cur.succs[0].preds.length === 1 && !cur.succs[0].handlerOf.length && guard++ < 50) { cur = cur.succs[0]; chain.push(cur); }
      if (cur.term.k !== 'exit') throw Unsupported('finally/synchronized handler with branches (handler at pc ' + hpc + ')');
      var stmts = [].concat.apply([], chain.map(function (b) { return b.stmts; }));
      var last = stmts[stmts.length - 1], tv = H.catchVar;
      var rethrows = last && last.k === 'throw' && ((tv && last.e.k === 'local' && last.e.v === tv) || last.e.k === 'caught');
      if (!rethrows) throw Unsupported('catch-all handler that is not a finally block (handler at pc ' + hpc + ')');
      var F = stmts.slice(0, -1);
      if (F.some(function (s) { return IR.mentions(s.e || s.c || {}, function (x) { return (x.k === 'local' && x.v === tv) || x.k === 'caught'; }); })) throw Unsupported('finally block that uses the exception');
      var chainPcs = function (pc) { return chain.some(function (b) { return pc >= b.start && pc < b.end; }); };
      var ranges = catchAll[hpc].filter(function (e) { return !chainPcs(e.start); });
      var P = new Set(blocks.filter(function (b) { return chain.indexOf(b) < 0 && ranges.some(function (e) { return b.start >= e.start && b.start < e.end; }); }));
      if (!P.size) throw Unsupported('empty finally-protected range');
      var start = Math.min.apply(null, ranges.map(function (e) { return e.start; }));
      finRegions.push({ fin: true, handler: H, chain: chain, F: F, Fcanon: canon(F), tv: tv, blocks: P, entry: blocks.filter(function (b) { return b.start === start; })[0], start: start, end: Math.max.apply(null, ranges.map(function (e) { return e.end; })) });
    });
    function copyLength(FR, b) {
      if (!FR.F.length) return 0;
      if (b.stmts.length < FR.F.length) return -1;
      return canon(b.stmts.slice(0, FR.F.length)) === FR.Fcanon ? FR.F.length : -1;
    }
    finRegions.forEach(function (FR) {
      if (!FR.entry) throw Unsupported('finally region without entry');
      var f = ipdom(FR.entry), g = 0;
      while (f && g++ < 1000 && (FR.blocks.has(f) || copyLength(FR, f) > 0 || FR.chain.indexOf(f) >= 0)) f = ipdom(f);
      FR.follow = f;
    });

    // try regions (typed catch clauses)
    var regions = [], byKey = {};
    code.exceptions.forEach(function (e) {
      if (e.type === null) return;
      var key = e.start + ':' + e.end;
      var R = byKey[key];
      if (!R) { R = byKey[key] = { start: e.start, end: e.end, handlers: [] }; regions.push(R); }
      var h = blocks.filter(function (b) { return b.start === e.handler; })[0];
      if (!h) return;
      var ex = R.handlers.filter(function (x) { return x.block === h; })[0];
      if (ex) ex.types.push(e.type); else R.handlers.push({ block: h, types: [e.type] });
    });
    var handlerOwner = new Map();
    regions.forEach(function (R) {
      R.handlers.forEach(function (h) { if (handlerOwner.has(h.block) && handlerOwner.get(h.block) !== R) throw Unsupported('try/finally or catch handler shared by several protected ranges'); handlerOwner.set(h.block, R); });
      R.blocks = new Set(blocks.filter(function (b) { return b.start >= R.start && b.start < R.end; }));
      R.entry = blocks.filter(function (b) { return b.start === R.start; })[0];
      R.handlers.forEach(function (h) { if (h.types.indexOf(null) >= 0) { if (h.types.length > 1) throw Unsupported('catch-all handler combined with typed catches'); } });
    });
    regions = regions.filter(function (R) { return R.entry && R.blocks.size; });
    regions.forEach(function (R) {
      regions.forEach(function (Q) {
        if (Q === R) return;
        var over = Q.start < R.end && R.start < Q.end, inside = (Q.start >= R.start && Q.end <= R.end) || (R.start >= Q.start && R.end <= Q.end);
        if (over && !inside) throw Unsupported('overlapping try ranges');
      });
      // follow: post-dominator of the entry, with exceptional edges considered
      var f = ipdomFull(R.entry);
      while (f && (R.blocks.has(f) || R.handlers.some(function (h) { return dominates(idom, h.block, f); }))) f = ipdomFull(f);
      R.follow = f;
    });
    regions.sort(function (a, b) { return (b.end - b.start) - (a.end - a.start); });

    var emitted = new Set(), opened = new Set(), labelN = 0;
    var vars = fn.vars;

    function newVar(type, name) { var v = { id: vars.length, name: name, type: type, storeTypes: [type], defs: [], catchParam: true }; vars.push(v); return v; }

    function jumpTo(target, ctx) {
      if (target === ctx.fall) return [];
      for (var i = ctx.br.length - 1; i >= 0; i--) {
        var B = ctx.br[i];
        if (B.kind === 'loop' && B.header === target) {
          var innerLoop = ctx.br.slice(i + 1).some(function (x) { return x.kind === 'loop'; });
          if (innerLoop) { B.label = B.label || ('label' + (labelN++)); return [{ k: 'cont', label: B.label }]; }
          return [{ k: 'cont' }];
        }
        if (B.exit && B.exit === target) {
          if (i < ctx.br.length - 1) { B.label = B.label || ('label' + (labelN++)); return [{ k: 'break', label: B.label, ref: B }]; }
          return [{ k: 'break', ref: B }];
        }
      }
      return null;
    }

    function child(ctx, o) { return Object.assign({}, ctx, o); }

    function follow(cur, ctx) {
      var f = ipdom(cur);
      if (!f) return null;
      if (ctx.loop && !ctx.loop.body.has(f)) return null;
      if (ctx.region && !ctx.region.blocks.has(f)) return null;
      if (emitted.has(f)) return null;
      return f;
    }

    function structure(cur, ctx, first) {
      var out = [];
      while (cur) {
        if (!first) {
          var j = jumpTo(cur, ctx);
          if (j) { return out.concat(j); }
        }
        first = false;
        // A block holding nothing but "goto X" just outside a try range (javac places the jump over
        // the handlers there) is transparent: follow it. It executes no code, so it can be skipped
        // even when it is shared by several paths.
        if (ctx.region && !ctx.region.blocks.has(cur) && !cur.stmts.length && cur.term.k === 'goto' && !loops.has(cur) && !cur.handlerOf.length) {
          emitted.add(cur);
          var tj = jumpTo(cur.term.target, ctx);
          if (tj) return out.concat(tj);
          cur = cur.term.target; continue;
        }
        if (emitted.has(cur) && !cur.stmts.length && cur.term.k === 'goto') { cur = cur.term.target; continue; }
        if (emitted.has(cur)) throw Unsupported('block at pc ' + cur.start + ' would be emitted twice (unstructured flow)');
        // javac leaves a trailing "return <value already computed>" outside the protected range;
        // such a block cannot throw, so placing it inside the try body does not change behaviour.
        var nonThrowing = function (st) { return (st.k === 'ret' && (!st.e || IR.isTrivial(st.e))) || (st.k === 'expr' && st.e.k === 'assign' && st.e.t.k === 'local' && IR.isTrivial(st.e.e)); };
        // Leaving a try that has a finally: the block starts with the inline copy of F (innermost
        // finally first). Remove the verified copies; the remainder must be a plain jump/return.
        if (ctx.region && !ctx.region.blocks.has(cur) && ctx.fins && ctx.fins.length) {
          var rest = cur.stmts, stripped = 0;
          for (var fi = ctx.fins.length - 1; fi >= 0; fi--) {
            var FR0 = ctx.fins[fi];
            if (FR0.blocks.has(cur)) break;
            if (!FR0.F.length) continue;
            var n0 = copyLength(FR0, { stmts: rest });
            if (n0 < 0) break;
            rest = rest.slice(n0); stripped++;
          }
          if (stripped && rest.every(nonThrowing) && (cur.term.k === 'exit' || cur.term.k === 'goto')) {
            emitted.add(cur);
            rest.forEach(function (s) { out.push(s); });
            if (cur.term.k === 'exit') return out;
            cur = cur.term.target; continue;
          }
        }
        if (ctx.region && !ctx.region.blocks.has(cur) && cur.stmts.every(nonThrowing) && cur.preds.every(function (p) { return ctx.region.blocks.has(p); }) && !cur.handlerOf.length && (cur.term.k === 'exit' || cur.term.k === 'goto')) { /* allowed */ }
        else if (ctx.region && !ctx.region.blocks.has(cur)) throw Unsupported('jump from a try block to code outside it (pc ' + cur.start + ')');
        if (ctx.loop && !ctx.loop.body.has(cur) && cur.preds.some(function (p) { return !ctx.loop.body.has(p); })) throw Unsupported('loop exit to shared code at pc ' + cur.start);
        var L = loops.get(cur);
        // finally region starting here (the try-finally is outside any try-catch at the same entry)
        var FRx = finRegions.filter(function (r) { return r.entry === cur && !opened.has(r); }).sort(function (a, b) { return b.blocks.size - a.blocks.size; })[0];
        var loopFirstF = L && !L.opened && FRx && !Array.from(L.body).every(function (b) { return FRx.blocks.has(b); });
        if (FRx && !loopFirstF) {
          opened.add(FRx);
          FRx.chain.forEach(function (b) { emitted.add(b); });
          var fctx = child(ctx, { fall: FRx.follow || ctx.fall, region: FRx, fins: (ctx.fins || []).concat([FRx]) });
          var fbody = structure(cur, fctx, true);
          out.push({ k: 'try', body: fbody, catches: [], fin: FRx.F.slice() });
          if (!FRx.follow) return out;
          cur = FRx.follow; continue;
        }
        // try region starting here (outermost unopened)?
        var R = regions.filter(function (r) { return r.entry === cur && !opened.has(r); })[0];
        var loopFirst = L && !L.opened && R && !Array.from(L.body).every(function (b) { return R.blocks.has(b); });
        if (R && !loopFirst) {
          opened.add(R);
          var tctx = child(ctx, { fall: R.follow || ctx.fall, region: R });
          var body = structure(cur, tctx, true);
          var catches = R.handlers.map(function (h) {
            if (emitted.has(h.block)) throw Unsupported('catch handler reached twice');
            var hv = h.block.catchVar || newVar(h.block.entry[0].type, 'ex');
            var hb = structure(h.block, child(ctx, { fall: R.follow || ctx.fall, region: ctx.region }), true);
            hb = hb.map(function (s) { return replaceCaught(s, hv); });
            return { types: h.types.map(function (t) { return t || 'java/lang/Throwable'; }), v: hv, body: hb, catchAll: h.types[0] === null };
          });
          out.push({ k: 'try', body: body, catches: catches });
          if (!R.follow) return out;
          cur = R.follow; continue;
        }
        if (L && !L.opened) {
          L.opened = true;
          var B = { kind: 'loop', header: cur, exit: L.exit, label: null };
          var lctx = child(ctx, { fall: cur, br: ctx.br.concat([B]), loop: L });
          var lbody = structure(cur, lctx, true);
          var st = { k: 'while', c: { k: 'const', v: true, type: 'Z' }, body: lbody, brk: B };
          out.push(st);
          if (!L.exit) return out;
          cur = L.exit; continue;
        }
        emitted.add(cur);
        cur.stmts.forEach(function (s) { out.push(s); });
        var t = cur.term;
        if (t.k === 'exit') return out;
        if (t.k === 'goto') { cur = t.target; continue; }
        if (t.k === 'if') {
          var f = follow(cur, ctx);
          var bctx = child(ctx, { fall: f || ctx.fall });
          var thenS = structure(t.next, bctx, false);
          var elseS = structure(t.target, bctx, false);
          var c = IR.negate(t.c);
          if (!thenS.length && elseS.length) { thenS = elseS; elseS = []; c = t.c; }
          out.push({ k: 'if', c: c, then: thenS, els: elseS });
          if (!f) return out;
          cur = f; continue;
        }
        if (t.k === 'switch') {
          var sf = follow(cur, ctx);
          var SB = { kind: 'switch', exit: sf, label: null };
          var targets = [];
          t.cases.forEach(function (c2) { if (targets.indexOf(c2.target) < 0) targets.push(c2.target); });
          if (targets.indexOf(t.dflt) < 0) targets.push(t.dflt);
          targets = targets.filter(function (x) { return x !== sf; }).sort(function (a, b) { return a.start - b.start; });
          var cases = targets.map(function (tg, ti) {
            var keys = t.cases.filter(function (c3) { return c3.target === tg; }).map(function (c3) { return c3.key; });
            var cctx = child(ctx, { fall: targets[ti + 1] || sf || ctx.fall, br: ctx.br.concat([SB]) });
            // Reaching the next case target = fallthrough (nothing emitted); reaching the switch exit
            // from a non-last case = break (emitted by jumpTo).
            var body = structure(tg, cctx, false);
            return { keys: keys, dflt: t.dflt === tg, body: body };
          });
          var swS = { k: 'switch', e: t.e, cases: cases, brk: SB, keyType: t.e.type };
          out.push(swS);
          if (!sf) return out;
          cur = sf; continue;
        }
        throw Unsupported('unknown terminator ' + t.k);
      }
      return out;
    }
    function replaceCaught(s, v) {
      var f = function (e) { return IR.map(e, function (x) { if (x.k === 'caught') return { k: 'local', v: v, type: v.type }; }); };
      var c = Object.assign({}, s);
      if (s.e) c.e = f(s.e);
      if (s.c) c.c = f(s.c);
      ['then', 'els', 'body'].forEach(function (k) { if (s[k]) c[k] = s[k].map(function (x) { return replaceCaught(x, v); }); });
      if (s.cases) c.cases = s.cases.map(function (cs) { return Object.assign({}, cs, { body: cs.body.map(function (x) { return replaceCaught(x, v); }) }); });
      if (s.catches) c.catches = s.catches.map(function (cs) { return Object.assign({}, cs, { body: cs.body.map(function (x) { return replaceCaught(x, v); }) }); });
      return c;
    }

    var body = structure(entry, { fall: null, br: [], loop: null, region: null }, true);
    var missing = blocks.filter(function (b) { return !emitted.has(b); });
    if (missing.length) throw Unsupported('code at pc ' + missing.map(function (b) { return b.start; }).join(', ') + ' could not be placed in the structured output');
    return body;
  };
})(window.ACE);
