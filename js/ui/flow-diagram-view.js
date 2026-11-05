/* Draws two message flows side by side (SVG, no library) with the structural differences marked.
 * Both diagrams share one coordinate system, so a node that exists on one side only is shown as a dashed ghost at the same place on the other side. */
(function (ACE) {
  'use strict';
  var UI = ACE.ui, util = ACE.util, esc = util.esc, FD = ACE.flowdiff;
  var NS = 'http://www.w3.org/2000/svg', W = 140, H = 46, SX = 1.5, SY = 1.7, PAD = 30;

  function svgEl(name, attrs, parent) {
    var e = document.createElementNS(NS, name);
    if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, attrs[k]); });
    if (parent) parent.appendChild(e);
    return e;
  }
  function clip(s, n) { s = String(s == null ? '' : s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  /* positions of the nodes of one model: the saved ones, or a layered layout when the file has none */
  function layout(model) {
    var pos = {}, ns = model.nodes;
    if (ns.length && ns.every(function (n) { return n.loc; })) { ns.forEach(function (n) { pos[n.idx] = { x: n.loc.x * SX, y: n.loc.y * SY }; }); return pos; }
    var layer = {}, indeg = {};
    ns.forEach(function (n) { indeg[n.idx] = 0; });
    model.conns.forEach(function (c) { indeg[c.to.idx]++; });
    var queue = ns.filter(function (n) { return !indeg[n.idx]; });
    if (!queue.length && ns.length) queue = [ns[0]];
    queue.forEach(function (n) { layer[n.idx] = 0; });
    for (var qi = 0; qi < queue.length && qi < 5000; qi++) {
      var cur = queue[qi];
      model.conns.forEach(function (c) { if (c.from === cur && layer[c.to.idx] == null) { layer[c.to.idx] = layer[cur.idx] + 1; queue.push(c.to); } });
    }
    var rows = {};
    ns.forEach(function (n) { var l = layer[n.idx] || 0; rows[l] = (rows[l] || 0); pos[n.idx] = { x: l * (W + 60), y: rows[l] * (H + 34) }; rows[l]++; });
    return pos;
  }

  UI.flowDiagram = function (host, diff, o) {
    o = o || {};
    var labelA = o.labelA || 'Source (master)', labelB = o.labelB || 'BAR', S = diff.summary;
    var pa = layout(diff.A), pb = layout(diff.B), P = {}, minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    diff.pairs.forEach(function (p) {
      var a = p.a ? pa[p.a.idx] : pb[p.b.idx], b = p.b ? pb[p.b.idx] : pa[p.a.idx];
      P[p.id] = { a: a, b: b };
      [a, b].forEach(function (q) { minX = Math.min(minX, q.x); minY = Math.min(minY, q.y); maxX = Math.max(maxX, q.x + W); maxY = Math.max(maxY, q.y + H); });
    });
    if (!diff.pairs.length) { minX = minY = 0; maxX = 400; maxY = 120; }
    var ox = PAD - minX, oy = PAD - minY, VW = maxX - minX + 2 * PAD, VH = maxY - minY + 2 * PAD + 10;

    var chips = function (n, cls, t) { return n ? '<span class="fd-chip ' + cls + '">' + n + ' ' + t + '</span>' : ''; };
    host.innerHTML = '<div class="fd-top">' +
      '<div class="fd-sum"><b>Nodes</b> ' + S.nodes.same + ' identical ' + chips(S.nodes.changed, 'chg', 'with different configuration') + chips(S.nodes.onlyA, 'del', 'only in ' + esc(labelA)) + chips(S.nodes.onlyB, 'add', 'only in ' + esc(labelB)) +
      ' &nbsp; <b>Connections</b> ' + S.conns.same + ' identical ' + chips(S.conns.onlyA, 'del', 'only in ' + esc(labelA)) + chips(S.conns.onlyB, 'add', 'only in ' + esc(labelB)) +
      (S.flowProps ? ' &nbsp; ' + chips(S.flowProps, 'chg', 'flow-level difference(s)') : '') + (S.identical ? ' &nbsp; <span class="fd-chip ok">The two flows have the same structure</span>' : '') + '</div>' +
      '<div class="row" style="gap:10px"><span class="fd-legend"><i class="lg same"></i>same <i class="lg chg"></i>different configuration <i class="lg del"></i>only in ' + esc(labelA) + ' <i class="lg add"></i>only in ' + esc(labelB) + ' <i class="lg ghost"></i>missing on this side</span>' +
      '<label class="small">Zoom <select class="fdZoom"><option value="fit">Fit</option><option value="0.75">75%</option><option value="1">100%</option><option value="1.5">150%</option><option value="2">200%</option></select></label></div></div>' +
      '<div class="fd-panes"><div><div class="fd-title">' + esc(labelA) + (diff.A.name ? ' - ' + esc(diff.A.name) : '') + '</div><div class="fd-pane" data-side="a"></div></div>' +
      '<div><div class="fd-title">' + esc(labelB) + (diff.B.name ? ' - ' + esc(diff.B.name) : '') + '</div><div class="fd-pane" data-side="b"></div></div></div>' +
      '<div class="fd-bottom"><div class="fd-list"><div class="fd-h">Differences (' + diff.list.length + ')</div></div><div class="fd-detail"><div class="fd-h">Details</div><div class="fd-dbody small muted">Click a node, a connection or a difference to see its configuration on both sides.</div></div></div>';

    var panes = {}, svgs = {}, nodeG = {}, edgeG = {}, selected = null;
    ['a', 'b'].forEach(function (side) {
      var pane = host.querySelector('.fd-pane[data-side="' + side + '"]');
      panes[side] = pane;
      var svg = svgEl('svg', { viewBox: '0 0 ' + VW + ' ' + VH, class: 'fd-svg', role: 'img', 'aria-label': 'Message flow diagram: ' + (side === 'a' ? labelA : labelB) }, pane);
      svgs[side] = svg;
      var defs = svgEl('defs', null, svg);
      ['same', 'del', 'add', 'ghost', 'sel'].forEach(function (k) {
        var mk = svgEl('marker', { id: 'fdarrow-' + side + '-' + k, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' }, defs);
        svgEl('path', { d: 'M0,0 L10,5 L0,10 z', class: 'fd-arrow ' + k }, mk);
      });
      // connections first, so the nodes are on top
      diff.conns.forEach(function (c) {
        var own = side === 'a' ? c.a : c.b;
        var cls = own ? (c.status === 'same' ? 'same' : (c.status === 'only-a' ? 'del' : 'add')) : 'ghost';
        var from = P[c.from.id][side], to = P[c.to.id][side];
        var x1 = from.x + ox + W, y1 = from.y + oy + H / 2, x2 = to.x + ox, y2 = to.y + oy + H / 2, dx = Math.max(50, Math.abs(x2 - x1) / 2);
        var g = svgEl('g', { class: 'fd-edge ' + cls, 'data-c': c.id }, svg);
        svgEl('title', null, g).textContent = FD.cdesc(c) + (cls === 'ghost' ? ' (not in this file)' : c.status === 'same' ? '' : c.status === 'only-a' ? ' (only in ' + labelA + ')' : ' (only in ' + labelB + ')');
        svgEl('path', { d: 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2, class: 'fd-hit' }, g);
        svgEl('path', { d: 'M' + x1 + ',' + y1 + ' C' + (x1 + dx) + ',' + y1 + ' ' + (x2 - dx) + ',' + y2 + ' ' + x2 + ',' + y2, class: 'fd-line', 'marker-end': 'url(#fdarrow-' + side + '-' + cls + ')' }, g);
        if (c.fromT && c.fromT !== 'out') svgEl('text', { x: x1 + 4, y: y1 - 5, class: 'fd-term' }, g).textContent = clip(c.fromT, 14);
        if (c.toT && c.toT !== 'in') svgEl('text', { x: x2 - 4, y: y2 - 5, class: 'fd-term', 'text-anchor': 'end' }, g).textContent = clip(c.toT, 14);
        (edgeG[c.id] = edgeG[c.id] || []).push(g);
        g.addEventListener('click', function () { select({ conn: c }); });
      });
      diff.pairs.forEach(function (p) {
        var own = side === 'a' ? p.a : p.b, shown = own || p.a || p.b, q = P[p.id][side];
        var st = !own ? 'ghost' : p.status === 'same' ? 'same' : p.status === 'changed' ? 'chg' : (p.status === 'only-a' ? 'del' : 'add');
        var g = svgEl('g', { class: 'fd-node ' + st, 'data-p': p.id, transform: 'translate(' + (q.x + ox) + ',' + (q.y + oy) + ')', tabindex: 0, role: 'button' }, svg);
        svgEl('title', null, g).textContent = shown.disp + ' (' + shown.typeLabel + ')' + (!own ? ' - not in this file' : p.status === 'changed' ? ' - ' + p.diffs.length + ' difference(s): ' + p.diffs.slice(0, 6).map(function (d) { return d.name; }).join(', ') : p.status === 'same' ? '' : p.status === 'only-a' ? ' - only in ' + labelA : ' - only in ' + labelB);
        svgEl('rect', { width: W, height: H, rx: 6, class: 'fd-box' }, g);
        svgEl('rect', { width: 7, height: H, rx: 3, fill: FD.familyColor(shown.family), class: 'fd-band' }, g);
        svgEl('text', { x: 14, y: 19, class: 'fd-name' }, g).textContent = clip(shown.disp, 19);
        svgEl('text', { x: 14, y: 35, class: 'fd-type' }, g).textContent = clip(shown.typeLabel, 22);
        if (own && p.status === 'changed') {
          svgEl('circle', { cx: W - 4, cy: 4, r: 9, class: 'fd-badge' }, g);
          svgEl('text', { x: W - 4, y: 8, class: 'fd-badget', 'text-anchor': 'middle' }, g).textContent = String(p.diffs.length);
        }
        (nodeG[p.id] = nodeG[p.id] || []).push(g);
        g.addEventListener('click', function () { select({ pair: p }); });
        g.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select({ pair: p }); } });
      });
    });

    // list of differences
    var list = host.querySelector('.fd-list');
    if (!diff.list.length) list.insertAdjacentHTML('beforeend', '<div class="small muted" style="padding:6px 8px">None: nodes, node configuration, connections and flow properties are the same.</div>');
    diff.list.forEach(function (it, i) {
      var d = document.createElement('div'); d.className = 'fd-item ' + (it.status === 'only-a' ? 'del' : it.status === 'only-b' ? 'add' : 'chg'); d.tabIndex = 0;
      d.textContent = it.text; d.setAttribute('data-i', i);
      d.onclick = function () { select(it.kind === 'node' ? { pair: it.pair } : it.kind === 'conn' ? { conn: it.conn } : { flow: true }, true); };
      d.onkeydown = function (e) { if (e.key === 'Enter') d.onclick(); };
      list.appendChild(d);
    });

    function vtext(v) { return v == null ? '<span class="muted">(not set)</span>' : '<code>' + esc(clip(v, 600)) + '</code>'; }
    function propsTable(rows, an, bn) {
      if (!rows.length) return '<div class="small muted">No configured properties.</div>';
      return '<table class="grid fd-tbl"><tr><th>Property</th><th>' + esc(an) + '</th><th>' + esc(bn) + '</th></tr>' + rows.map(function (r) {
        return '<tr class="' + (r.kind === 'same' ? '' : r.kind === 'changed' ? 'chg' : r.kind === 'only-a' ? 'del' : 'add') + '"><td><code>' + esc(r.name) + '</code></td><td>' + vtext(r.a) + '</td><td>' + vtext(r.b) + '</td></tr>';
      }).join('') + '</table>';
    }
    function allRows(p) {
      var keys = {}, rows = [], pa2 = p.a ? p.a.props : {}, pb2 = p.b ? p.b.props : {};
      Object.keys(pa2).forEach(function (k) { keys[k] = 1; }); Object.keys(pb2).forEach(function (k) { keys[k] = 1; });
      var dmap = {}; (p.diffs || []).forEach(function (d) { dmap[d.name] = d; });
      (p.diffs || []).filter(function (d) { return d.name.charAt(0) === '('; }).forEach(function (d) { rows.push(d); });
      Object.keys(keys).sort().forEach(function (k) {
        if (dmap[k]) rows.push(dmap[k]);
        else rows.push({ name: k, a: Object.prototype.hasOwnProperty.call(pa2, k) ? pa2[k] : null, b: Object.prototype.hasOwnProperty.call(pb2, k) ? pb2[k] : null, kind: 'same' });
      });
      // differences first
      return rows.filter(function (r) { return r.kind !== 'same'; }).concat(rows.filter(function (r) { return r.kind === 'same'; }));
    }
    function select(sel, scroll) {
      selected = sel;
      Object.keys(nodeG).forEach(function (k) { nodeG[k].forEach(function (g) { g.classList.remove('sel'); }); });
      Object.keys(edgeG).forEach(function (k) { edgeG[k].forEach(function (g) { g.classList.remove('sel'); }); });
      var db = host.querySelector('.fd-dbody'), h = '';
      if (sel.pair) {
        var p = sel.pair, nm = (p.a || p.b).disp;
        (nodeG[p.id] || []).forEach(function (g) { g.classList.add('sel'); });
        h = '<div><b>' + esc(nm) + '</b> <span class="muted">' + esc((p.a || p.b).typeLabel) + '</span> &nbsp; ' + (p.status === 'same' ? '<span class="fd-chip ok">same</span>' : p.status === 'changed' ? '<span class="fd-chip chg">' + p.diffs.length + ' difference(s)</span>' : p.status === 'only-a' ? '<span class="fd-chip del">only in ' + esc(labelA) + '</span>' : '<span class="fd-chip add">only in ' + esc(labelB) + '</span>') + (p.moved ? ' <span class="small muted">(placed differently in the two files; not counted as a difference)</span>' : '') + '</div>';
        var conn = diff.conns.filter(function (c) { return c.from === p || c.to === p; });
        h += propsTable(allRows(p), labelA, labelB);
        if (conn.length) h += '<div class="small" style="margin-top:6px"><b>Connections of this node</b></div>' + conn.map(function (c) { return '<div class="small fd-citem ' + (c.status === 'same' ? '' : c.status === 'only-a' ? 'del' : 'add') + '">' + esc(FD.cdesc(c)) + (c.status === 'same' ? '' : c.status === 'only-a' ? ' - only in ' + esc(labelA) : ' - only in ' + esc(labelB)) + '</div>'; }).join('');
        if (scroll) (nodeG[p.id] || []).forEach(function (g) { var side = g.parentNode === svgs.a ? 'a' : 'b', pane = panes[side], q = P[p.id][side]; pane.scrollTo({ left: Math.max(0, (q.x + ox) * zoomK() - pane.clientWidth / 2 + W / 2), top: Math.max(0, (q.y + oy) * zoomK() - pane.clientHeight / 2), behavior: 'auto' }); });
      } else if (sel.conn) {
        var c2 = sel.conn;
        (edgeG[c2.id] || []).forEach(function (g) { g.classList.add('sel'); });
        [c2.from, c2.to].forEach(function (p3) { (nodeG[p3.id] || []).forEach(function (g) { g.classList.add('sel'); }); });
        h = '<div><b>Connection</b> <code>' + esc(FD.cdesc(c2)) + '</code> &nbsp; ' + (c2.status === 'same' ? '<span class="fd-chip ok">in both files</span>' : c2.status === 'only-a' ? '<span class="fd-chip del">only in ' + esc(labelA) + '</span>' : '<span class="fd-chip add">only in ' + esc(labelB) + '</span>') + '</div>' +
          '<div class="small">From <b>' + esc((c2.from.a || c2.from.b).disp) + '</b>, terminal <code>' + esc(c2.fromT || '-') + '</code>, to <b>' + esc((c2.to.a || c2.to.b).disp) + '</b>, terminal <code>' + esc(c2.toT || '-') + '</code>.</div>';
      } else if (sel.flow) {
        h = '<div><b>Flow-level properties</b> (promoted properties and how they are wired to the nodes)</div>' + propsTable(diff.flowDiffs, labelA, labelB);
      }
      db.className = 'fd-dbody'; db.innerHTML = h;
      host.querySelectorAll('.fd-item').forEach(function (d) { d.classList.remove('sel'); });
    }

    // zoom and linked scrolling
    function zoomK() { var v = host.querySelector('.fdZoom').value; return v === 'fit' ? (panes.a.clientWidth - 2) / VW : Number(v); }
    function applyZoom() {
      var v = host.querySelector('.fdZoom').value;
      ['a', 'b'].forEach(function (s) {
        if (v === 'fit') { svgs[s].style.width = '100%'; svgs[s].style.height = 'auto'; }
        else { svgs[s].style.width = (VW * Number(v)) + 'px'; svgs[s].style.height = (VH * Number(v)) + 'px'; }
      });
    }
    host.querySelector('.fdZoom').onchange = applyZoom;
    var busy = false;
    ['a', 'b'].forEach(function (s) {
      var other = s === 'a' ? 'b' : 'a';
      panes[s].addEventListener('scroll', function () { if (busy) return; busy = true; panes[other].scrollLeft = panes[s].scrollLeft; panes[other].scrollTop = panes[s].scrollTop; busy = false; });
    });
    // a wide flow is unreadable when fitted into the pane: start at 75% and let the two panes scroll together
    if (host.querySelector('.fdZoom').value === 'fit' && panes.a.clientWidth && (panes.a.clientWidth - 2) / VW < 0.6) host.querySelector('.fdZoom').value = '0.75';
    applyZoom();
    var first = diff.list.filter(function (i) { return i.kind === 'node'; })[0];
    if (first) select({ pair: first.pair });
    return { select: select, diff: diff };
  };
})(window.ACE);
