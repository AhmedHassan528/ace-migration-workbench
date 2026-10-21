/* JVM instruction set: opcode table, instruction decoder and a javap-style disassembler.
 * Operand formats:
 *   ''  none           'b' s1 immediate      'B' u1 cp index (ldc)    'l' u1 local index
 *   's' s2 immediate   'S' u2 cp index       'i' iinc (u1 local, s1)  'j' s2 branch    'J' s4 branch
 *   'T' tableswitch    'L' lookupswitch      'M' invokeinterface      'D' invokedynamic
 *   'A' newarray type  'N' multianewarray    'W' wide prefix */
(function (ACE) {
  'use strict';
  var bc = ACE.bytecode = {};

  var T = [
    'nop', '', 'aconst_null', '', 'iconst_m1', '', 'iconst_0', '', 'iconst_1', '', 'iconst_2', '', 'iconst_3', '', 'iconst_4', '', 'iconst_5', '',
    'lconst_0', '', 'lconst_1', '', 'fconst_0', '', 'fconst_1', '', 'fconst_2', '', 'dconst_0', '', 'dconst_1', '',
    'bipush', 'b', 'sipush', 's', 'ldc', 'B', 'ldc_w', 'S', 'ldc2_w', 'S',
    'iload', 'l', 'lload', 'l', 'fload', 'l', 'dload', 'l', 'aload', 'l',
    'iload_0', '', 'iload_1', '', 'iload_2', '', 'iload_3', '', 'lload_0', '', 'lload_1', '', 'lload_2', '', 'lload_3', '',
    'fload_0', '', 'fload_1', '', 'fload_2', '', 'fload_3', '', 'dload_0', '', 'dload_1', '', 'dload_2', '', 'dload_3', '',
    'aload_0', '', 'aload_1', '', 'aload_2', '', 'aload_3', '',
    'iaload', '', 'laload', '', 'faload', '', 'daload', '', 'aaload', '', 'baload', '', 'caload', '', 'saload', '',
    'istore', 'l', 'lstore', 'l', 'fstore', 'l', 'dstore', 'l', 'astore', 'l',
    'istore_0', '', 'istore_1', '', 'istore_2', '', 'istore_3', '', 'lstore_0', '', 'lstore_1', '', 'lstore_2', '', 'lstore_3', '',
    'fstore_0', '', 'fstore_1', '', 'fstore_2', '', 'fstore_3', '', 'dstore_0', '', 'dstore_1', '', 'dstore_2', '', 'dstore_3', '',
    'astore_0', '', 'astore_1', '', 'astore_2', '', 'astore_3', '',
    'iastore', '', 'lastore', '', 'fastore', '', 'dastore', '', 'aastore', '', 'bastore', '', 'castore', '', 'sastore', '',
    'pop', '', 'pop2', '', 'dup', '', 'dup_x1', '', 'dup_x2', '', 'dup2', '', 'dup2_x1', '', 'dup2_x2', '', 'swap', '',
    'iadd', '', 'ladd', '', 'fadd', '', 'dadd', '', 'isub', '', 'lsub', '', 'fsub', '', 'dsub', '',
    'imul', '', 'lmul', '', 'fmul', '', 'dmul', '', 'idiv', '', 'ldiv', '', 'fdiv', '', 'ddiv', '',
    'irem', '', 'lrem', '', 'frem', '', 'drem', '', 'ineg', '', 'lneg', '', 'fneg', '', 'dneg', '',
    'ishl', '', 'lshl', '', 'ishr', '', 'lshr', '', 'iushr', '', 'lushr', '', 'iand', '', 'land', '', 'ior', '', 'lor', '', 'ixor', '', 'lxor', '',
    'iinc', 'i',
    'i2l', '', 'i2f', '', 'i2d', '', 'l2i', '', 'l2f', '', 'l2d', '', 'f2i', '', 'f2l', '', 'f2d', '', 'd2i', '', 'd2l', '', 'd2f', '', 'i2b', '', 'i2c', '', 'i2s', '',
    'lcmp', '', 'fcmpl', '', 'fcmpg', '', 'dcmpl', '', 'dcmpg', '',
    'ifeq', 'j', 'ifne', 'j', 'iflt', 'j', 'ifge', 'j', 'ifgt', 'j', 'ifle', 'j',
    'if_icmpeq', 'j', 'if_icmpne', 'j', 'if_icmplt', 'j', 'if_icmpge', 'j', 'if_icmpgt', 'j', 'if_icmple', 'j', 'if_acmpeq', 'j', 'if_acmpne', 'j',
    'goto', 'j', 'jsr', 'j', 'ret', 'l', 'tableswitch', 'T', 'lookupswitch', 'L',
    'ireturn', '', 'lreturn', '', 'freturn', '', 'dreturn', '', 'areturn', '', 'return', '',
    'getstatic', 'S', 'putstatic', 'S', 'getfield', 'S', 'putfield', 'S',
    'invokevirtual', 'S', 'invokespecial', 'S', 'invokestatic', 'S', 'invokeinterface', 'M', 'invokedynamic', 'D',
    'new', 'S', 'newarray', 'A', 'anewarray', 'S', 'arraylength', '', 'athrow', '', 'checkcast', 'S', 'instanceof', 'S',
    'monitorenter', '', 'monitorexit', '', 'wide', 'W', 'multianewarray', 'N', 'ifnull', 'j', 'ifnonnull', 'j', 'goto_w', 'J', 'jsr_w', 'J'
  ];
  var NAMES = [], FMT = [];
  for (var i = 0; i < T.length; i += 2) { NAMES.push(T[i]); FMT.push(T[i + 1]); }
  bc.NAMES = NAMES; bc.FMT = FMT;
  bc.opcode = {}; NAMES.forEach(function (n, k) { bc.opcode[n] = k; });

  bc.NEWARRAY_TYPES = { 4: 'Z', 5: 'C', 6: 'F', 7: 'D', 8: 'B', 9: 'S', 10: 'I', 11: 'J' };

  /* Decode a code array into instructions: {pc, op, name, len, ...operands} */
  bc.decode = function (code) {
    var out = [], p = 0, n = code.length;
    function u1() { if (p >= n) throw new Error('Truncated bytecode'); return code[p++]; }
    function s1() { var v = u1(); return v > 127 ? v - 256 : v; }
    function u2() { var v = (code[p] << 8) | code[p + 1]; if (p + 2 > n) throw new Error('Truncated bytecode'); p += 2; return v; }
    function s2() { var v = u2(); return v > 32767 ? v - 65536 : v; }
    function s4() { if (p + 4 > n) throw new Error('Truncated bytecode'); var v = (code[p] << 24) | (code[p + 1] << 16) | (code[p + 2] << 8) | code[p + 3]; p += 4; return v | 0; }
    while (p < n) {
      var pc = p, op = u1();
      if (op >= NAMES.length) throw new Error('Unknown opcode 0x' + op.toString(16) + ' at pc ' + pc);
      var ins = { pc: pc, op: op, name: NAMES[op] }, f = FMT[op];
      switch (f) {
        case 'b': ins.value = s1(); break;
        case 's': ins.value = s2(); break;
        case 'B': ins.index = u1(); break;
        case 'S': ins.index = u2(); break;
        case 'l': ins.local = u1(); break;
        case 'i': ins.local = u1(); ins.value = s1(); break;
        case 'j': ins.target = pc + s2(); break;
        case 'J': ins.target = pc + s4(); break;
        case 'A': ins.atype = u1(); break;
        case 'M': ins.index = u2(); u1(); u1(); break;
        case 'D': ins.index = u2(); u1(); u1(); break;
        case 'N': ins.index = u2(); ins.dims = u1(); break;
        case 'T': {
          while (p % 4 !== 0) p++;
          var def = pc + s4(), lo = s4(), hi = s4(); ins.dflt = def; ins.cases = [];
          if (hi < lo || hi - lo > 100000) throw new Error('Bad tableswitch at pc ' + pc);
          for (var k = lo; k <= hi; k++) ins.cases.push({ key: k, target: pc + s4() });
          break;
        }
        case 'L': {
          while (p % 4 !== 0) p++;
          var d2 = pc + s4(), np = s4(); ins.dflt = d2; ins.cases = [];
          if (np < 0 || np > 100000) throw new Error('Bad lookupswitch at pc ' + pc);
          for (k = 0; k < np; k++) { var key = s4(); ins.cases.push({ key: key, target: pc + s4() }); }
          break;
        }
        case 'W': {
          var op2 = u1(); ins.op = op2; ins.name = NAMES[op2]; ins.wide = true; ins.local = u2();
          if (NAMES[op2] === 'iinc') ins.value = s2();
          break;
        }
      }
      // Normalise short forms: iload_2 -> iload local 2, iconst_3 -> value
      var m = /^([ilfda])(load|store)_(\d)$/.exec(ins.name);
      if (m) { ins.local = Number(m[3]); ins.base = m[1] + m[2]; } else if (/^[ilfda](load|store)$/.test(ins.name)) ins.base = ins.name;
      ins.len = p - pc;
      out.push(ins);
    }
    return out;
  };

  /* javap-style listing (used in reports and for methods the decompiler cannot handle). */
  bc.disassemble = function (cf, method) {
    var code = method.code; if (!code) return '(no code: ' + ((method.access & 0x0400) ? 'abstract' : (method.access & 0x0100) ? 'native' : 'none') + ')';
    var ins, lines = [];
    try { ins = bc.decode(code.bytes); } catch (e) { return 'bytecode could not be decoded: ' + e.message; }
    ins.forEach(function (x) {
      var s = String(x.pc).padStart(5) + ': ' + x.name;
      if (x.local != null && !/_\d$/.test(x.name)) s += ' ' + x.local;
      if (x.value != null) s += ' ' + x.value;
      if (x.target != null) s += ' ' + x.target;
      if (x.atype != null) s += ' ' + bc.NEWARRAY_TYPES[x.atype];
      if (x.index != null) {
        var c = cf.constant(x.index);
        if (c) s += ' #' + x.index + ' // ' + (c.kind === 'string' ? '"' + c.value + '"' : c.kind === 'class' ? c.name : c.owner ? c.owner + '.' + c.name + ':' + c.desc : c.name ? c.name + ':' + c.desc : String(c.value));
      }
      if (x.cases) s += ' {' + x.cases.map(function (c2) { return c2.key + ': ' + c2.target; }).join(', ') + ', default: ' + x.dflt + '}';
      lines.push(s);
    });
    if (code.exceptions.length) { lines.push('  Exception table:'); code.exceptions.forEach(function (e) { lines.push('    from ' + e.start + ' to ' + e.end + ' target ' + e.handler + ' type ' + (e.type || 'any')); }); }
    return lines.join('\n');
  };
})(window.ACE);
