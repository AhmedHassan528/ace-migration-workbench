/* UI core: routing, progress/cancel, log panel and shared renderers.
 * All dynamic text is HTML-escaped with esc() before insertion. */
(function (ACE) {
  'use strict';
  var util = ACE.util, esc = util.esc;
  var UI = ACE.ui = { views: {}, current: null, busy: false, cancel: null };

  UI.$ = function (sel, root) { return (root || document).querySelector(sel); };
  UI.$$ = function (sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll(sel)); };

  /* Every page owns its input and its state: a page gets its own workflow controller (view.ctl) and nothing
   * is shared with another page. A page that works on a file (BAR or source code) declares its input in
   * view.input (see UI.inputHtml); the page that compares two inputs (compare) keeps its own state. */
  UI.register = function (name, view) {
    view.id = name;
    if (view.input) view.ctl = ACE.workflow.create();
    UI.views[name] = view;
  };
  UI.firstView = function () { var a = UI.$('#nav a[data-view]'); return a ? a.getAttribute('data-view') : null; };
  UI.show = function (name) {
    if (!UI.views[name]) name = UI.firstView();
    UI.current = name;
    UI.$$('#nav a[data-view]').forEach(function (a) { a.classList.toggle('active', a.getAttribute('data-view') === name); });
    var el = UI.$('#view'), v = UI.views[name], st = v.ctl ? v.ctl.state : null;
    try { el.innerHTML = v.render(st); if (v.bind) v.bind(el, st); }
    catch (e) { el.innerHTML = '<div class="banner err">View failed to render: ' + esc(e.message) + '</div>'; ACE.log.error('Render ' + name + ': ' + e.message, e.stack); }
    try { location.hash = name; } catch (e) { /* ignore */ }
  };
  UI.refresh = function () { if (UI.current) UI.show(UI.current); };

  /* ---------- the input of one page ----------
   * view.input = { title, what, accept, multiple, folder, reject: /ext/i, kind: 'bar' | 'workspace' | 'any', hint }
   *   kind 'bar'       only a BAR is accepted (a Toolkit workspace ZIP is refused with a message)
   *   kind 'workspace' only source code is accepted: a Toolkit workspace ZIP (several ZIPs are combined) or a folder
   *   kind 'any'       a BAR or a workspace ZIP */
  var KIND_ERR = {
    bar: 'This page takes a BAR file, but "{n}" is source code (a Toolkit workspace ZIP).',
    workspace: 'This page takes source code (a Toolkit workspace ZIP or folder), but "{n}" is a BAR file. A BAR or a JAR is not accepted here.'
  };
  UI.inputHtml = function (view) {
    var o = view.input, ws = view.ctl.state.ws, id = 'in_' + view.id;
    var h = '<div class="card"><div class="row"><b>' + esc(o.title) + '</b> <span class="muted small">' + esc(o.hint || '') + '</span></div><div class="row">' +
      '<label class="btn primary" for="' + id + '">Choose ' + (o.multiple ? 'file(s)' : 'file') + '…</label><input type="file" id="' + id + '" accept="' + esc(o.accept) + '"' + (o.multiple ? ' multiple' : '') + ' hidden>' +
      (o.folder ? ' <label class="btn" for="' + id + 'D">Choose folder…</label><input type="file" id="' + id + 'D" webkitdirectory multiple hidden>' : '') + ' ';
    if (ws && !ws.fatal) h += '<span><b>' + esc(view.loadedName || ws.barName) + '</b> <span class="muted">(' + util.fmtBytes(ws.barSize) + ', ' + (ws.inputKind === 'workspace' ? 'Toolkit workspace: ' + ws.model.deployables.length + ' project(s)' : 'BAR: ' + ws.model.deployables.length + ' deployable(s)') + ', ' + ws.files.length + ' files)</span></span>';
    else h += '<span class="muted">nothing loaded</span>';
    return h + '</div>' + (view.error ? '<div class="banner err">' + esc(view.error) + '</div>' : '') + '</div>';
  };
  UI.bindInput = function (el, view) {
    var id = 'in_' + view.id;
    function pick(input) { if (input && (input.files && input.files.length || input.folder && input.folder.length || input.zips && input.zips.length)) UI.loadInput(view, input); }
    var f = UI.$('#' + id, el); if (f) f.onchange = function (e) { var a = Array.prototype.slice.call(e.target.files); e.target.value = ''; pick(view.input.multiple ? { zips: a } : { zips: a.slice(0, 1) }); };
    var d = UI.$('#' + id + 'D', el); if (d) d.onchange = function (e) { var a = Array.prototype.slice.call(e.target.files); e.target.value = ''; pick({ folder: a }); };
  };
  UI.loadInput = function (view, input) {
    var o = view.input, ctl = view.ctl, names = (input.zips || []).map(function (f) { return f.name; });
    view.error = null;
    var bad = names.filter(function (n) { return o.reject && o.reject.test(n); })[0];
    if (bad) { view.error = '"' + bad + '" is not accepted on this page: ' + (o.rejectWhy || 'wrong kind of input') + '.'; UI.refresh(); return; }
    return UI.run('Load ' + (names[0] || 'folder'), async function (cancel, progress) {
      try {
        var file = o.kind === 'workspace' ? await ACE.workflow.sourceZip(input, { cancel: cancel, progress: progress }) : input.zips[0];
        ctl.clear(); view.loadedName = null;
        var ws = await ctl.load(file, { cancel: cancel, progress: progress });
        if (ws.fatal) { view.error = 'The file could not be opened: ' + ws.fatal.message; ctl.clear(); return; }
        if (o.kind === 'bar' && ws.inputKind !== 'bar') { view.error = KIND_ERR.bar.replace('{n}', file.name); ctl.clear(); return; }
        if (o.kind === 'workspace' && ws.inputKind !== 'workspace') { view.error = KIND_ERR.workspace.replace('{n}', file.name); ctl.clear(); return; }
        view.loadedName = file.name;
        if (view.onLoaded) view.onLoaded(ws);
      } catch (e) { if (util.isCancel(e)) throw e; view.error = 'The input could not be read: ' + e.message; ctl.clear(); ACE.log.error(view.error, e.stack); }
    });
  };
  UI.noInput = function (view, what) { return view.ctl.state.ws ? null : '<div class="banner">' + esc(what) + '</div>'; };

  /* ---------- progress & cancellation ---------- */
  UI.progress = function (stage, done, total, detail) {
    var pct = total ? Math.min(100, Math.round(done / total * 100)) : 0;
    UI.$('#progFill').style.width = pct + '%';
    UI.$('#progText').textContent = stage + (total ? ' ' + done + '/' + total : '') + (detail ? ' - ' + detail : '');
  };
  /* In-page dialogs. The browser's own confirm()/alert() are not used: embedded or sandboxed browsers
   * (and "prevent additional dialogs") silently suppress them, which made buttons appear to do nothing.
   * UI.ask(message, onYes, {ok, cancel, onNo}) - confirmation; UI.notify(message) - information. */
  function dialog(message, buttons) {
    var old = document.getElementById('uiDialog'); if (old) old.remove();
    var back = document.createElement('div'); back.id = 'uiDialog'; back.className = 'dlg-back';
    var box = document.createElement('div'); box.className = 'dlg'; box.setAttribute('role', 'dialog'); box.setAttribute('aria-modal', 'true');
    var msg = document.createElement('div'); msg.className = 'dlg-msg'; msg.textContent = message; box.appendChild(msg);
    var row = document.createElement('div'); row.className = 'row dlg-btns';
    function close() { back.remove(); document.removeEventListener('keydown', onKey, true); }
    buttons.forEach(function (b) {
      var el = document.createElement('button'); el.className = 'btn' + (b.primary ? ' primary' : ''); el.textContent = b.label;
      el.onclick = function () { close(); if (b.fn) b.fn(); };
      row.appendChild(el); b.el = el;
    });
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); var c = buttons.filter(function (b) { return b.cancel; })[0] || buttons[buttons.length - 1]; c.el.click(); }
    }
    document.addEventListener('keydown', onKey, true);
    box.appendChild(row); back.appendChild(box); document.body.appendChild(back);
    (buttons.filter(function (b) { return b.primary; })[0] || buttons[0]).el.focus();
  }
  UI.ask = function (message, onYes, opts) {
    opts = opts || {};
    dialog(message, [{ label: opts.ok || 'OK', primary: true, fn: onYes }, { label: opts.cancel || 'Cancel', cancel: true, fn: opts.onNo }]);
  };
  UI.notify = function (message) { dialog(message, [{ label: 'OK', primary: true, cancel: true }]); };

  /* Run a long operation with the progress bar and the Cancel button. */
  UI.run = async function (label, fn) {
    if (UI.busy) { UI.notify('Another operation is still running.'); return; }
    UI.busy = true; UI.cancel = new util.CancelToken();
    var btn = UI.$('#cancelBtn'); btn.disabled = false;
    UI.progress(label, 0, 0, 'starting');
    var t0 = Date.now();
    try {
      var r = await fn(UI.cancel, UI.progress);
      UI.progress(label + ' finished in ' + (Date.now() - t0) + ' ms', 1, 1, '');
      return r;
    } catch (e) {
      if (util.isCancel(e)) { ACE.log.warn(label + ' cancelled: ' + e.message); UI.progress(label + ' CANCELLED', 0, 1, ''); }
      else { ACE.log.error(label + ' failed: ' + e.message, e.stack); UI.progress(label + ' FAILED: ' + e.message, 0, 1, ''); }
    } finally { UI.busy = false; btn.disabled = true; UI.cancel = null; UI.refresh(); }
  };

  /* ---------- log panel ---------- */
  var counts = { error: 0, warn: 0 };
  UI.initLog = function () {
    var panel = UI.$('#logPanel');
    function line(e) {
      if (e.level === 'error') counts.error++; if (e.level === 'warn') counts.warn++;
      var d = document.createElement('div'); d.className = 'log-' + e.level;
      d.textContent = e.t.slice(11, 19) + ' ' + e.level.toUpperCase().padEnd(5) + ' ' + e.msg;
      panel.appendChild(d); if (panel.childNodes.length > 3000) panel.removeChild(panel.firstChild);
      panel.scrollTop = panel.scrollHeight;
      UI.$('#logCounts').textContent = counts.error + ' error(s), ' + counts.warn + ' warning(s)';
      if (e.level === 'error') document.body.classList.add('logopen');
    }
    ACE.log.entries().forEach(line);
    ACE.on('log', line);
    ACE.on('log-clear', function () { panel.innerHTML = ''; counts.error = counts.warn = 0; UI.$('#logCounts').textContent = ''; });
    UI.$('#logToggle').onclick = function () { document.body.classList.toggle('logopen'); };
    UI.$('#logClear').onclick = function () { ACE.log.clear(); };
    UI.$('#logSave').onclick = function () { util.download(ACE.log.entries().map(function (e) { return e.t + ' ' + e.level.toUpperCase() + ' ' + e.msg; }).join('\r\n'), 'workbench-log.txt', 'text/plain'); };
    UI.$('#cancelBtn').onclick = function () { if (UI.cancel) UI.cancel.cancel('Cancelled by user'); };
  };

  /* ---------- renderers ---------- */
  UI.sev = function (s) { return '<span class="sev sev-' + esc(String(s).split(' ')[0]) + '">' + esc(s) + '</span>'; };
  UI.tag = function (cat, label) { return '<span class="tag ' + esc(cat) + '">' + esc(label || ACE.classify.CATEGORY_LABELS[cat] || cat) + '</span>'; };
  UI.status = function (s) { return '<span class="sev st-' + esc(s) + '">' + esc(String(s).toUpperCase()) + '</span>'; };
  UI.refs = function (refs) { return (refs || []).map(function (r) { return /^https?:/.test(r.url) ? '<a href="' + esc(r.url) + '" target="_blank" rel="noopener" title="Online reference (not available offline)">' + esc(r.title) + '</a>' : '<span title="' + esc(r.url) + '">' + esc(r.title) + ' <span class="muted">(' + esc(r.url) + ')</span></span>'; }).join('<br>'); };

  UI.diffHtml = function (d, context) {
    context = context == null ? 3 : context;
    var keep = d.map(function () { return false; });
    d.forEach(function (x, k) { if (x.op !== ' ') for (var q = Math.max(0, k - context); q <= Math.min(d.length - 1, k + context); q++) keep[q] = true; });
    var h = '', gap = false;
    d.forEach(function (x, k) {
      if (!keep[k]) { if (!gap) { h += '<div class="gap">…</div>'; gap = true; } return; }
      gap = false;
      var cls = x.op === '+' ? 'add' : x.op === '-' ? 'del' : '';
      var num = (x.a ? String(x.a).padStart(4) : '    ') + ' ' + (x.b ? String(x.b).padStart(4) : '    ');
      h += '<div class="' + cls + '">' + esc(num + ' ' + x.op + ' ' + x.text) + '</div>';
    });
    return '<div class="diff">' + h + '</div>';
  };

  /* Build a nested tree (object) from paths. */
  UI.pathTree = function (items, pathOf) {
    var root = { name: '', dirs: {}, files: [] };
    items.forEach(function (it) {
      var parts = pathOf(it).split('/'), node = root;
      for (var i = 0; i < parts.length - 1; i++) { node.dirs[parts[i]] = node.dirs[parts[i]] || { name: parts[i], dirs: {}, files: [] }; node = node.dirs[parts[i]]; }
      node.files.push({ name: parts[parts.length - 1], item: it });
    });
    return root;
  };
  UI.treeHtml = function (node, depth, fileHtml) {
    var h = '';
    Object.keys(node.dirs).sort().forEach(function (k) {
      h += '<div class="dir" style="padding-left:' + (6 + depth * 14) + 'px">▸ ' + esc(k) + '/</div>' + UI.treeHtml(node.dirs[k], depth + 1, fileHtml);
    });
    node.files.sort(function (a, b) { return a.name.localeCompare(b.name); }).forEach(function (f) { h += fileHtml(f, depth); });
    return h;
  };

  UI.findingsTable = function (findings, opts) {
    opts = opts || {};
    if (!findings.length) return '<p class="muted">No findings.</p>';
    var rows = findings.map(function (f) {
      var loc = f.file ? '<code>' + esc(f.file) + (f.line ? ':' + f.line : '') + '</code>' : '';
      var ev = Array.isArray(f.evidence) ? f.evidence.map(function (e) { return typeof e === 'string' ? esc(e) : esc(e.text) + (e.where ? ' <span class="muted">[' + esc(e.where) + (e.line ? ':' + e.line : '') + ']</span>' : ''); }).join('<br>') : '';
      return '<tr><td>' + UI.sev(f.severity) + (f.blocker ? '<br><b class="sev-Error">BLOCKER</b>' : '') + '</td><td><b>' + esc(f.title) + '</b> <code class="muted">' + esc(f.ruleId) + '</code>' + (f.note ? '<br><i class="small">' + esc(f.note) + '</i>' : '') + '<details><summary class="small">Why it matters</summary><p class="small">' + esc(f.why) + '</p></details></td><td>' + loc + (loc && ev ? '<br>' : '') + '<span class="small">' + ev + '</span></td><td class="small">' + esc(f.action) + (f.autofixAvailable != null ? '<br><span class="muted">Auto-fix: ' + (f.autofixAvailable ? 'available' : 'no') + '</span>' : '') + '</td><td class="small">' + esc(f.status) + (f.confidence ? ', ' + esc(f.confidence) + ' confidence' : '') + (f.docVerification ? '<br><span class="muted">' + esc(f.docVerification.text) + '</span>' : '') + '<br>' + UI.refs(f.refs) + '</td></tr>';
    }).join('');
    return '<div class="scroll"><table class="grid"><tr><th>Severity</th><th>Finding</th><th>Location / evidence</th><th>Suggested action</th><th>Basis / reference</th></tr>' + rows + '</table></div>';
  };

  UI.sevCounts = function (findings) {
    var c = {}; findings.forEach(function (f) { c[f.severity] = (c[f.severity] || 0) + 1; });
    return ['Error', 'Warning', 'Manual Review', 'Information'].map(function (s) { return UI.sev(s) + ' ' + (c[s] || 0); }).join(' &nbsp; ');
  };
})(window.ACE);
