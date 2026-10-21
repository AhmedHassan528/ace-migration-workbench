/* Lightweight Java syntax sanity check for generated sources.
 * It tokenises the text (strings, chars, comments, numbers, identifiers, operators) and checks that
 * brackets balance and nest correctly. It is NOT a compiler: passing it does not mean the code compiles. */
(function (ACE) {
  'use strict';
  ACE.syntaxCheck = function (src) {
    var errors = [], stack = [], i = 0, n = src.length, line = 1, tokens = 0;
    var PAIR = { ')': '(', ']': '[', '}': '{' };
    while (i < n) {
      var c = src[i];
      if (c === '\n') { line++; i++; continue; }
      if (/\s/.test(c)) { i++; continue; }
      if (c === '/' && src[i + 1] === '/') { while (i < n && src[i] !== '\n') i++; continue; }
      if (c === '/' && src[i + 1] === '*') { var e = src.indexOf('*/', i + 2); if (e < 0) { errors.push('unterminated comment at line ' + line); break; } line += (src.slice(i, e).match(/\n/g) || []).length; i = e + 2; continue; }
      if (c === '"' || c === "'") {
        var q = c, j = i + 1;
        while (j < n && src[j] !== q) { if (src[j] === '\\') j++; if (src[j] === '\n') { errors.push('unterminated literal at line ' + line); break; } j++; }
        if (j >= n) { errors.push('unterminated literal at line ' + line); break; }
        if (q === "'" && !/^'(\\(u[0-9a-fA-F]{4}|[0-7]{1,3}|.)|[^\\'])'$/.test(src.slice(i, j + 1))) errors.push('bad char literal ' + src.slice(i, j + 1) + ' at line ' + line);
        i = j + 1; tokens++; continue;
      }
      if ('([{'.indexOf(c) >= 0) { stack.push({ c: c, line: line }); i++; tokens++; continue; }
      if (')]}'.indexOf(c) >= 0) {
        var top = stack.pop();
        if (!top || top.c !== PAIR[c]) errors.push('unbalanced "' + c + '" at line ' + line + (top ? ' (open "' + top.c + '" from line ' + top.line + ')' : ''));
        i++; tokens++; continue;
      }
      if (/[A-Za-z_$0-9.]/.test(c)) { while (i < n && /[A-Za-z_$0-9.]/.test(src[i])) i++; tokens++; continue; }
      if (/[;,:?=<>!~+\-*\/%&|^@]/.test(c)) { i++; tokens++; continue; }
      errors.push('unexpected character "' + c + '" at line ' + line); i++;
      if (errors.length > 20) break;
    }
    stack.forEach(function (s) { errors.push('unclosed "' + s.c + '" from line ' + s.line); });
    return { ok: errors.length === 0, errors: errors.slice(0, 10), tokens: tokens, lines: line };
  };
})(window.ACE);
