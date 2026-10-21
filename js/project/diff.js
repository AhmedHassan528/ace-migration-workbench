/* Line diff (LCS). Small files use full dynamic programming; large files fall back to a
 * prefix/suffix trim so memory stays bounded. Output: [{op:' '|'-'|'+', a, b, text}] */
(function (ACE) {
  'use strict';
  ACE.diff = function (oldText, newText) {
    var a = ACE.util.lines(oldText), b = ACE.util.lines(newText);
    var pre = 0; while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++;
    var sa = a.length, sb = b.length;
    while (sa > pre && sb > pre && a[sa - 1] === b[sb - 1]) { sa--; sb--; }
    var A = a.slice(pre, sa), B = b.slice(pre, sb), out = [], i, j;
    for (i = 0; i < pre; i++) out.push({ op: ' ', a: i + 1, b: i + 1, text: a[i] });
    if (A.length * B.length > 4e6) {
      A.forEach(function (t, k) { out.push({ op: '-', a: pre + k + 1, b: null, text: t }); });
      B.forEach(function (t, k) { out.push({ op: '+', a: null, b: pre + k + 1, text: t }); });
    } else {
      var n = A.length, m = B.length, L = [];
      for (i = 0; i <= n; i++) L.push(new Uint32Array(m + 1));
      for (i = n - 1; i >= 0; i--) for (j = m - 1; j >= 0; j--) L[i][j] = A[i] === B[j] ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
      i = 0; j = 0;
      while (i < n && j < m) {
        if (A[i] === B[j]) { out.push({ op: ' ', a: pre + i + 1, b: pre + j + 1, text: A[i] }); i++; j++; }
        else if (L[i + 1][j] >= L[i][j + 1]) { out.push({ op: '-', a: pre + i + 1, b: null, text: A[i] }); i++; }
        else { out.push({ op: '+', a: null, b: pre + j + 1, text: B[j] }); j++; }
      }
      while (i < n) { out.push({ op: '-', a: pre + i + 1, b: null, text: A[i] }); i++; }
      while (j < m) { out.push({ op: '+', a: null, b: pre + j + 1, text: B[j] }); j++; }
    }
    for (i = sa, j = sb; i < a.length; i++, j++) out.push({ op: ' ', a: i + 1, b: j + 1, text: a[i] });
    return out;
  };

  /* Unified-diff text with context. */
  ACE.diff.unified = function (oldText, newText, nameA, nameB, ctx) {
    ctx = ctx == null ? 3 : ctx;
    var d = ACE.diff(oldText, newText), lines = ['--- ' + (nameA || 'a'), '+++ ' + (nameB || 'b')];
    var keep = d.map(function () { return false; });
    d.forEach(function (x, k) { if (x.op !== ' ') for (var q = Math.max(0, k - ctx); q <= Math.min(d.length - 1, k + ctx); q++) keep[q] = true; });
    var inHunk = false;
    d.forEach(function (x, k) {
      if (!keep[k]) { inHunk = false; return; }
      if (!inHunk) { lines.push('@@ -' + (x.a || '?') + ' +' + (x.b || '?') + ' @@'); inHunk = true; }
      lines.push(x.op + x.text);
    });
    return lines.join('\n');
  };

  ACE.diff.stats = function (d) {
    return { added: d.filter(function (x) { return x.op === '+'; }).length, removed: d.filter(function (x) { return x.op === '-'; }).length };
  };
})(window.ACE);
