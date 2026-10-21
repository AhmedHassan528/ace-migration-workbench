/* Minimal test harness. Status values:
 *   PASS     - executed and every assertion held
 *   FAIL     - executed and an assertion failed / an exception was thrown
 *   NOT RUN  - prerequisite missing (e.g. no real BAR selected) - reason shown
 *   EXTERNAL - can only be validated in the IBM ACE Toolkit / runtime; never reported as passed here */
(function () {
  'use strict';
  var T = window.T = { tests: [], results: {} };

  function AssertError(m) { this.message = m; this.name = 'AssertError'; }
  T.skip = function (reason) { var e = new Error(reason); e.name = 'Skip'; throw e; };

  T.test = function (id, name, meta, fn) { T.tests.push({ id: id, name: name, category: meta.category, requires: meta.requires || null, external: !!meta.external, fn: fn }); };

  function ctx(log) {
    var n = 0;
    return {
      ok: function (v, msg) { n++; if (!v) throw new AssertError(msg || 'expected truthy'); log.push('✓ ' + (msg || 'ok')); },
      eq: function (a, b, msg) { n++; if (a !== b) throw new AssertError((msg || 'values differ') + ': expected ' + JSON.stringify(b) + ', got ' + JSON.stringify(a)); log.push('✓ ' + (msg || 'equal') + ' (' + JSON.stringify(a) + ')'); },
      throwsAsync: async function (fn, re, msg) { n++; try { await fn(); } catch (e) { if (re && !re.test(e.message + ' ' + (e.code || ''))) throw new AssertError((msg || 'wrong error') + ': ' + e.message); log.push('✓ ' + (msg || 'threw') + ' (' + (e.code || '') + ' ' + e.message.slice(0, 90) + ')'); return e; } throw new AssertError((msg || 'expected an exception') + ' but none was thrown'); },
      note: function (m) { log.push('· ' + m); },
      count: function () { return n; }
    };
  }

  T.run = async function (filter, env) {
    var list = T.tests.filter(filter || function () { return true; });
    for (var i = 0; i < list.length; i++) {
      var t = list[i], log = [], c = ctx(log), r = { id: t.id, name: t.name, category: t.category, log: log, at: new Date().toISOString() };
      T.results[t.id] = r; r.status = 'RUNNING'; T.render();
      var t0 = performance.now();
      try {
        if (t.external) { r.status = 'EXTERNAL'; log.push('Requires validation in the real IBM ACE Toolkit / runtime. Not executed by this suite.'); }
        else if (t.requires === 'bar' && !env.barFile) T.skip('Select the real BAR file (top of page) to run this test');
        else if (t.requires === 'workspace' && !env.workspaceFile) T.skip('Select a real Toolkit workspace ZIP (top of page) to run this test');
        if (!t.external) { await t.fn(c, env); r.status = 'PASS'; r.assertions = c.count(); if (!c.count()) { r.status = 'FAIL'; log.push('Test made no assertions'); } }
      } catch (e) {
        if (e.name === 'Skip') { r.status = 'NOT RUN'; log.push(e.message); }
        else { r.status = 'FAIL'; log.push('✗ ' + e.message); if (e.name !== 'AssertError' && e.stack) log.push(e.stack.split('\n').slice(0, 3).join('\n')); }
      }
      r.ms = Math.round(performance.now() - t0);
      T.render();
      await new Promise(function (res) { setTimeout(res, 0); });
    }
  };

  T.render = function () {
    var el = document.getElementById('results'); if (!el) return;
    var counts = {};
    var rows = T.tests.map(function (t) {
      var r = T.results[t.id] || { status: 'PENDING', log: [] };
      counts[r.status] = (counts[r.status] || 0) + 1;
      return '<tr class="s-' + r.status.replace(' ', '') + '"><td>' + t.id + '</td><td>' + ACE.util.esc(t.category) + '</td><td>' + ACE.util.esc(t.name) + '</td><td><b>' + r.status + '</b>' + (r.ms != null ? '<br><span class="m">' + r.ms + ' ms</span>' : '') + '</td><td><pre>' + ACE.util.esc(r.log.join('\n')) + '</pre></td></tr>';
    }).join('');
    document.getElementById('summary').textContent = Object.keys(counts).map(function (k) { return k + ': ' + counts[k]; }).join('   ');
    el.innerHTML = '<table><tr><th>ID</th><th>Area</th><th>Test</th><th>Status</th><th>Details</th></tr>' + rows + '</table>';
  };

  T.exportJson = function () {
    return JSON.stringify({ suite: 'IBM ACE Migration Workbench tests', at: new Date().toISOString(), environment: ACE.util.capabilities(), results: T.tests.map(function (t) { var r = T.results[t.id] || { status: 'PENDING', log: [] }; return { id: t.id, category: t.category, name: t.name, status: r.status, ms: r.ms, log: r.log }; }) }, null, 2);
  };
})();
