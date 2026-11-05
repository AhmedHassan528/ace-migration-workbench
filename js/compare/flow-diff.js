/* Structural comparison of two message flows (.msgflow / .subflow).
 * The flow file is read into a model (nodes, node properties, connections, flow-level properties) and two models are compared by structure,
 * not by text: a node is matched by its name and type, a connection by the two nodes and the two terminals it joins.
 * Ignored on purpose, because they are written differently by different Toolkit versions and say nothing about the flow: ids, plug-in ids,
 * the layout of the file, the representation of a node label (translatable or constant string). Node positions are kept (for drawing) and
 * reported as "moved", but a moved node is not a difference. */
(function (ACE) {
  'use strict';
  var FD = ACE.flowdiff = {}, mf = ACE.msgflow, util = ACE.util;

  var SKIP_ATTR = /^(xmi:|xmlns)|\.internal_npcompiler$|^(location|pluginId)$/;
  function normVal(name, v) {
    v = String(v).replace(/\r\n?/g, '\n');
    if (name === 'resourceName') v = v.replace(/^(platform:\/plugin\/)[^\/]+\//, '$1*/');
    return v;
  }
  function kids(el, name) { return Array.prototype.filter.call(el.childNodes, function (n) { return n.nodeType === 1 && (!name || n.nodeName === name); }); }

  /* every attribute and nested element of el as a flat map: "attr", "child/attr", "child[2]/attr", "child/#text" */
  function flatten(el, prefix, out) {
    var i, a;
    for (i = 0; i < el.attributes.length; i++) { a = el.attributes[i]; if (!SKIP_ATTR.test(a.name)) out[prefix + a.name] = normVal(a.name, a.value); }
    var seen = {}, total = {}, ch = kids(el).filter(function (c) {
      if (c.nodeName === 'translation' || c.nodeName === 'eAnnotations' || c.nodeName === 'bendPoints') return false;
      if (c.nodeName === 'stickyBoard' && !c.attributes.length && !c.children.length) return false;
      return true;
    });
    ch.forEach(function (c) { total[c.nodeName] = (total[c.nodeName] || 0) + 1; });
    ch.forEach(function (c) {
      var k = seen[c.nodeName] = (seen[c.nodeName] || 0) + 1;
      flatten(c, prefix + c.nodeName + (total[c.nodeName] > 1 ? '[' + k + ']' : '') + '/', out);
    });
    var txt = Array.prototype.filter.call(el.childNodes, function (n) { return (n.nodeType === 3 || n.nodeType === 4) && n.nodeValue.trim(); }).map(function (n) { return n.nodeValue.trim(); }).join(' ');
    if (txt) out[prefix + '#text'] = normVal('', txt);
    return out;
  }
  function shortTerm(t) { return String(t || '').replace(/^(Out|In)Terminal\./, ''); }

  var TYPE_FAMILY = { soap: '#2e7d9a', http: '#2e7d9a', mq: '#b5651d', jms: '#b5651d', transform: '#6a4fb3', java: '#c0392b', routing: '#2f855a', database: '#8a6d1d', error: '#c0392b', utility: '#5d6570', subflow: '#0f62fe', terminal: '#5d6570', udn: '#8e44ad', file: '#7a6a3a', kafka: '#3b6fb6', timer: '#7a6a3a', other: '#5d6570' };
  FD.familyColor = function (f) { return TYPE_FAMILY[f] || TYPE_FAMILY.other; };

  /* Read a flow file. Returns {ok, empty, error, name, nodes[], conns[], flowProps{}} */
  FD.model = function (text) {
    var m = { ok: false, empty: false, error: '', name: '', nodes: [], conns: [], flowProps: {} };
    if (text == null || text === '') { m.ok = true; m.empty = true; return m; }
    var doc;
    try { doc = new DOMParser().parseFromString(String(text).replace(/^﻿/, ''), 'application/xml'); } catch (e) { m.error = 'The file is not XML: ' + e.message; return m; }
    if (!doc.documentElement || doc.getElementsByTagName('parsererror').length) { m.error = 'The file is not well-formed XML, so no diagram can be drawn.'; return m; }
    var root = doc.documentElement, ns = {}, i;
    for (i = 0; i < root.attributes.length; i++) if (root.attributes[i].name.indexOf('xmlns:') === 0) ns[root.attributes[i].name.slice(6)] = root.attributes[i].value;
    var comps = Array.prototype.filter.call(doc.getElementsByTagName('eClassifiers'), function (c) { return /FCMComposite/.test(c.getAttribute('xmi:type') || ''); });
    var comp = comps[0] || root, scope = kids(comp, 'composition')[0] || comp;
    m.name = comp.getAttribute('name') || '';
    // flow level: its own attributes, the promoted properties, how they are presented and which node attribute each one overrides
    var fl = m.flowProps;
    for (i = 0; i < comp.attributes.length; i++) { var ca = comp.attributes[i]; if (!SKIP_ATTR.test(ca.name) && ca.name !== 'name') fl[ca.name] = normVal(ca.name, ca.value); }
    kids(comp, 'eStructuralFeatures').forEach(function (sf) {
      var f = flatten(sf, '', {}), nm = sf.getAttribute('name') || '?';
      fl['promoted property ' + nm] = ((sf.getAttribute('eType') || '').split('#').pop() + (sf.getAttribute('defaultValueLiteral') != null ? ' = ' + sf.getAttribute('defaultValueLiteral') : '')) || '(no type)';
      Object.keys(f).forEach(function (k) { if (k !== 'name' && k !== 'eType' && k !== 'defaultValueLiteral') fl['promoted property ' + nm + ' / ' + k] = f[k]; });
    });
    Array.prototype.forEach.call(doc.getElementsByTagName('propertyDescriptor'), function (pd) {
      var f = flatten(pd, '', {}), nm = pd.getAttribute('propertyName') || '?';
      Object.keys(f).forEach(function (k) { if (k !== 'propertyName') fl['property editor ' + nm + ' / ' + k] = f[k]; });
    });
    var nodeEls = kids(scope, 'nodes');
    if (!nodeEls.length) nodeEls = Array.prototype.slice.call(doc.getElementsByTagName('nodes'));
    var byId = {};
    nodeEls.forEach(function (n, idx) {
      var xt = n.getAttribute('xmi:type') || '', pre = xt.split(':')[0], nsUri = ns[pre] || pre, label = '';
      var tr = kids(n, 'translation')[0];
      if (tr) label = tr.getAttribute('string') || tr.getAttribute('key') || '';
      var id = n.getAttribute('xmi:id') || ('node' + idx), type = pre === 'eflow' ? xt : nsUri, typeLabel, family, mm = /^(ComIbm[A-Za-z0-9]+)\.msgnode$/.exec(nsUri);
      if (mm) { var t = mf && mf.NODE_TYPES[mm[1]]; typeLabel = t ? t[0] : mm[1].replace(/^ComIbm/, ''); family = t ? t[1] : 'other'; }
      else if (/\.(subflow|msgflow)$/.test(nsUri)) { typeLabel = 'Subflow: ' + util.stripExt(nsUri); family = 'subflow'; }
      else if (xt === 'eflow:FCMSource') { typeLabel = 'Input terminal'; family = 'terminal'; }
      else if (xt === 'eflow:FCMSink') { typeLabel = 'Output terminal'; family = 'terminal'; }
      else if (/\.msgnode$/.test(nsUri)) { typeLabel = nsUri.replace(/\.msgnode$/, ''); family = 'udn'; }
      else { typeLabel = xt || 'node'; family = 'other'; }
      var lm = /^\s*(-?\d+)\s*,\s*(-?\d+)/.exec(n.getAttribute('location') || '');
      var node = { idx: idx, id: id, name: label || n.getAttribute('nodeName') || id, type: type, typeLabel: typeLabel, family: family, loc: lm ? { x: +lm[1], y: +lm[2] } : null, props: flatten(n, '', {}) };
      m.nodes.push(node); byId[id] = node;
    });
    // two nodes with one name are told apart in the display only
    var cnt = {}, tot = {};
    m.nodes.forEach(function (n) { tot[n.name] = (tot[n.name] || 0) + 1; });
    m.nodes.forEach(function (n) { cnt[n.name] = (cnt[n.name] || 0) + 1; n.disp = tot[n.name] > 1 ? n.name + ' (' + cnt[n.name] + ')' : n.name; });
    var cEls = kids(scope, 'connections');
    if (!cEls.length) cEls = Array.prototype.slice.call(doc.getElementsByTagName('connections'));
    cEls.forEach(function (c) {
      var from = byId[c.getAttribute('sourceNode')], to = byId[c.getAttribute('targetNode')];
      m.conns.push({ from: from || null, to: to || null, fromT: shortTerm(c.getAttribute('sourceTerminalName')), toT: shortTerm(c.getAttribute('targetTerminalName')), fromFull: c.getAttribute('sourceTerminalName') || '', toFull: c.getAttribute('targetTerminalName') || '' });
    });
    m.conns = m.conns.filter(function (c) { return c.from && c.to; });
    Array.prototype.forEach.call(doc.getElementsByTagName('attributeLinks'), function (al) {
      var tgt = (al.getAttribute('overriddenNodes') || '').split(/\s+/).filter(Boolean).map(function (id) { return byId[id] ? byId[id].name : id; }).sort().join(', ');
      var attr = kids(al, 'overriddenAttribute').map(function (o) { return (o.getAttribute('href') || '').split('#').pop(); }).sort().join(', ');
      var k = 'promoted link ' + (al.getAttribute('promotedAttribute') || '?'), v = (tgt || '(flow)') + (attr ? ' . ' + attr : '');
      fl[k] = fl[k] ? fl[k].split(' | ').concat(v).sort().join(' | ') : v;
    });
    m.ok = true;
    return m;
  };

  /* Compare two models. a = the source (master), b = the BAR.
   * Result: pairs[] ({id, a, b, status: same|changed|only-a|only-b, diffs[], moved}), conns[] ({a, b, status: same|only-a|only-b, from, to}), flowDiffs[], list[], summary. */
  FD.diff = function (A, B) {
    var pairs = [], usedA = {}, usedB = {};
    function link(x, y) { usedA[x.idx] = 1; usedB[y.idx] = 1; var p = { id: pairs.length, a: x, b: y }; x.pair = p; y.pair = p; pairs.push(p); }
    var bBy = {};
    B.nodes.forEach(function (y) { (bBy[y.type + '|' + y.name] = bBy[y.type + '|' + y.name] || []).push(y); });
    A.nodes.forEach(function (x) {
      var l = bBy[x.type + '|' + x.name]; if (!l) return;
      var k = -1, i;
      for (i = 0; i < l.length; i++) if (!usedB[l[i].idx] && l[i].id === x.id) { k = i; break; }
      if (k < 0) for (i = 0; i < l.length; i++) if (!usedB[l[i].idx]) { k = i; break; }
      if (k >= 0) link(x, l[k]);
    });
    // the same name with another node type, then the same id (a renamed node)
    A.nodes.forEach(function (x) { if (usedA[x.idx]) return; var y = B.nodes.filter(function (z) { return !usedB[z.idx] && z.name === x.name; })[0]; if (y) link(x, y); });
    A.nodes.forEach(function (x) { if (usedA[x.idx]) return; var y = B.nodes.filter(function (z) { return !usedB[z.idx] && z.id === x.id && z.type === x.type; })[0]; if (y) link(x, y); });
    A.nodes.forEach(function (x) { if (!usedA[x.idx]) { var p = { id: pairs.length, a: x, b: null }; x.pair = p; pairs.push(p); } });
    B.nodes.forEach(function (y) { if (!usedB[y.idx]) { var p = { id: pairs.length, a: null, b: y }; y.pair = p; pairs.push(p); } });
    pairs.sort(function (p, q) { return p.id - q.id; });

    function propDiffs(pa, pb) {
      var keys = {}, out = [];
      Object.keys(pa).forEach(function (k) { keys[k] = 1; }); Object.keys(pb).forEach(function (k) { keys[k] = 1; });
      Object.keys(keys).sort().forEach(function (k) {
        var x = Object.prototype.hasOwnProperty.call(pa, k) ? pa[k] : null, y = Object.prototype.hasOwnProperty.call(pb, k) ? pb[k] : null;
        if (x === y) return;
        out.push({ name: k, a: x, b: y, kind: x == null ? 'only-b' : y == null ? 'only-a' : 'changed' });
      });
      return out;
    }
    pairs.forEach(function (p) {
      if (!p.a) { p.status = 'only-b'; p.diffs = []; return; }
      if (!p.b) { p.status = 'only-a'; p.diffs = []; return; }
      p.diffs = [];
      if (p.a.type !== p.b.type) p.diffs.push({ name: '(node type)', a: p.a.typeLabel, b: p.b.typeLabel, kind: 'changed' });
      if (p.a.name !== p.b.name) p.diffs.push({ name: '(node name)', a: p.a.name, b: p.b.name, kind: 'changed' });
      p.diffs = p.diffs.concat(propDiffs(p.a.props, p.b.props));
      p.moved = !!(p.a.loc && p.b.loc && (p.a.loc.x !== p.b.loc.x || p.a.loc.y !== p.b.loc.y));
      p.status = p.diffs.length ? 'changed' : 'same';
    });

    // connections: the same two nodes and the same two terminals
    function ckey(c) { return c.from.pair.id + '|' + c.fromT + '|' + c.to.pair.id + '|' + c.toT; }
    var bMap = {}, conns = [];
    B.conns.forEach(function (c) { (bMap[ckey(c)] = bMap[ckey(c)] || []).push(c); });
    A.conns.forEach(function (c) {
      var l = bMap[ckey(c)];
      if (l && l.length) conns.push({ a: c, b: l.shift(), status: 'same', from: c.from.pair, to: c.to.pair, fromT: c.fromT, toT: c.toT });
      else conns.push({ a: c, b: null, status: 'only-a', from: c.from.pair, to: c.to.pair, fromT: c.fromT, toT: c.toT });
    });
    Object.keys(bMap).forEach(function (k) { bMap[k].forEach(function (c) { conns.push({ a: null, b: c, status: 'only-b', from: c.from.pair, to: c.to.pair, fromT: c.fromT, toT: c.toT }); }); });
    conns.forEach(function (c, i) { c.id = i; });

    var flowDiffs = propDiffs(A.flowProps, B.flowProps);
    if (A.name !== B.name && A.name && B.name) flowDiffs.unshift({ name: '(flow name)', a: A.name, b: B.name, kind: 'changed' });

    function nm(p) { return (p.a || p.b).disp; }
    function cdesc(c) { return nm(c.from) + (c.fromT ? '.' + c.fromT : '') + ' → ' + nm(c.to) + (c.toT ? '.' + c.toT : ''); }
    FD.cdesc = cdesc;
    var list = [];
    pairs.forEach(function (p) {
      if (p.status === 'only-a') list.push({ kind: 'node', status: 'only-a', pair: p, text: 'Node "' + nm(p) + '" (' + p.a.typeLabel + ') exists only in the source' });
      else if (p.status === 'only-b') list.push({ kind: 'node', status: 'only-b', pair: p, text: 'Node "' + nm(p) + '" (' + p.b.typeLabel + ') exists only in the BAR' });
      else if (p.status === 'changed') list.push({ kind: 'node', status: 'changed', pair: p, text: 'Node "' + nm(p) + '": ' + p.diffs.length + ' difference(s) - ' + p.diffs.slice(0, 4).map(function (d) { return d.name; }).join(', ') + (p.diffs.length > 4 ? ', ...' : '') });
    });
    conns.forEach(function (c) {
      if (c.status === 'only-a') list.push({ kind: 'conn', status: 'only-a', conn: c, text: 'Connection ' + cdesc(c) + ' exists only in the source' });
      else if (c.status === 'only-b') list.push({ kind: 'conn', status: 'only-b', conn: c, text: 'Connection ' + cdesc(c) + ' exists only in the BAR' });
    });
    if (flowDiffs.length) list.push({ kind: 'flow', status: 'changed', text: 'Flow-level properties: ' + flowDiffs.length + ' difference(s) - ' + flowDiffs.slice(0, 4).map(function (d) { return d.name; }).join(', ') + (flowDiffs.length > 4 ? ', ...' : '') });

    var count = function (arr, st) { return arr.filter(function (x) { return x.status === st; }).length; };
    var summary = {
      nodes: { same: count(pairs, 'same'), changed: count(pairs, 'changed'), onlyA: count(pairs, 'only-a'), onlyB: count(pairs, 'only-b'), total: pairs.length },
      conns: { same: count(conns, 'same'), onlyA: count(conns, 'only-a'), onlyB: count(conns, 'only-b'), total: conns.length },
      flowProps: flowDiffs.length, moved: pairs.filter(function (p) { return p.moved; }).length
    };
    summary.identical = !summary.nodes.changed && !summary.nodes.onlyA && !summary.nodes.onlyB && !summary.conns.onlyA && !summary.conns.onlyB && !summary.flowProps;
    return { A: A, B: B, pairs: pairs, conns: conns, flowDiffs: flowDiffs, list: list, summary: summary };
  };

  /* Convenience: two flow texts to a diff (or {error}). */
  FD.compareText = function (srcText, barText) {
    var A = FD.model(srcText), B = FD.model(barText);
    if (!A.ok || !B.ok) return { error: (!A.ok ? 'Source: ' + A.error : '') + (!A.ok && !B.ok ? ' ' : '') + (!B.ok ? 'BAR: ' + B.error : '') };
    return FD.diff(A, B);
  };
})(window.ACE);
