/* Project Explorer model (IBM ACE Toolkit style), built from the real workspace.
 *
 * The tree is LOGICAL (Message Flows, Subflows, ESQLs, Java, Included Libraries, Other Resources...),
 * but every file node keeps its real export path (leaf.path). Grouping never renames or moves files:
 * exports always use leaf.path, which is exactly the path used by the ACE 12/13 packages.
 *
 * Node: {id, kind, label, children[], path?}
 *   kinds: project-app, project-lib, project-shlib, project-java, group, folder, package, schema,
 *          libref, info, file
 * File node extra: ftype, src ('bar' | 'toolkit-project' | 'java'), rec (BAR file record),
 *                  jar (JAR record), origin */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var EX = ACE.explorer = {};

  var GROUPS = [
    ['flows', 'Message Flows', function (e) { return e === 'msgflow'; }],
    ['subflows', 'Subflows', function (e) { return e === 'subflow'; }],
    ['esql', 'ESQLs', function (e) { return e === 'esql'; }],
    ['maps', 'Maps', function (e) { return e === 'map' || e === 'msgmap'; }],
    ['schemas', 'Schema Definitions', function (e) { return e === 'xsd' || e === 'mxsd' || e === 'mset' || e === 'dictionary' || e === 'xsdzip'; }],
    ['interfaces', 'Interfaces', function (e) { return e === 'wsdl'; }]
  ];

  EX.ftype = function (name) {
    var e = util.ext(name);
    if (name === '.project' || name === '.classpath') return 'eclipse';
    return { java: 'java', esql: 'esql', msgflow: 'msgflow', subflow: 'subflow', jar: 'jar', 'class': 'class', xsd: 'xsd', wsdl: 'wsdl', xml: 'xml', descriptor: 'xml', properties: 'properties', prefs: 'properties', map: 'map', txt: 'text', json: 'json', yaml: 'text', yml: 'text', cmf: 'binary' }[e] || 'other';
  };
  EX.isText = function (ftype) { return ['java', 'esql', 'msgflow', 'subflow', 'xsd', 'wsdl', 'xml', 'properties', 'map', 'text', 'json', 'eclipse', 'other'].indexOf(ftype) >= 0; };

  function node(id, kind, label, extra) { return Object.assign({ id: id, kind: kind, label: label, children: [] }, extra || {}); }
  function sortKids(n) {
    var order = { 'package': 0, folder: 1, schema: 1, group: 0, info: 0, libref: 2, file: 3 };
    n.children.sort(function (a, b) {
      if (n.kind === 'project-app' || n.kind === 'project-lib' || n.kind === 'project-shlib') return 0; // fixed Toolkit order
      var oa = order[a.kind] != null ? order[a.kind] : 1, ob = order[b.kind] != null ? order[b.kind] : 1;
      if (a.label === '(default package)') oa = -1; if (b.label === '(default package)') ob = -1;
      return oa - ob || a.label.localeCompare(b.label);
    });
    n.children.forEach(sortKids);
  }
  /* Insert a file under parent following its physical sub-folders (relative path). */
  function addPhysical(parent, rel, leaf, idPrefix) {
    var parts = rel.split('/'), cur = parent;
    for (var i = 0; i < parts.length - 1; i++) {
      var fid = idPrefix + '/' + parts.slice(0, i + 1).join('/');
      var f = cur.children.filter(function (c) { return c.id === fid; })[0];
      if (!f) { f = node(fid, 'folder', parts[i]); cur.children.push(f); }
      cur = f;
    }
    cur.children.push(leaf);
  }
  /* Package declared in Java source (comments/strings ignored). null = default package. */
  EX.javaPackage = function (text) {
    var code = ACE.java17 ? ACE.java17.mask(String(text || '')).code : String(text || '');
    var m = /^\s*package\s+([A-Za-z_$][\w$]*(?:\s*\.\s*[A-Za-z_$][\w$]*)*)\s*;/m.exec(code);
    return m ? m[1].replace(/\s+/g, '') : null;
  };

  EX.build = function (ws, opts) {
    opts = opts || {};
    var S = ACE.settings.current || {}, pj = S.project || {};
    var lay = ACE.project.layout(ws), refs = ACE.project.references(ws, ws.facts);
    var esqlSchema = {}; ((ws.facts && ws.facts.esql) || []).forEach(function (e) { esqlSchema[e.vpath] = e.schema || ''; });
    var fileById = {}; ws.files.forEach(function (f) { fileById[f.id] = f; });
    var roots = [], leaves = {};
    function leaf(path, src, extra) {
      var l = node('f:' + path, 'file', util.basename(path), Object.assign({ path: path, src: src, ftype: EX.ftype(util.basename(path)) }, extra || {}));
      leaves[path] = l; return l;
    }

    // Java projects (decompiled or imported) and where their JAR lives
    var javaProjects = [];
    Object.keys(ws.decompiled || {}).forEach(function (sha) {
      var d = ws.decompiled[sha], jr = (ws.jars || []).filter(function (j) { return j.sha256 === sha; })[0];
      if (!jr || !d.results || !d.results.some(function (r) { return r.source; })) return;
      var ep = ACE.eclipse.files(ws, jr, { target: 'ace12', keepOriginalJar: pj.keepOriginalJar !== false, includeExcluded: !!pj.libIncludeExcluded });
      javaProjects.push({ name: ep.plan.name, jar: jr, files: ep.files, containers: jr.occurrences.map(function (o) { return o.indexOf('!/') >= 0 ? o.slice(0, o.lastIndexOf('!/')) : ''; }) });
    });
    // Original Java projects from a Toolkit workspace ZIP: source folders come from the original .classpath
    lay.projects.filter(function (p) { return p.type === 'java'; }).forEach(function (p) {
      var cp = p.eclipse && p.eclipse.classpath, srcDirs = cp ? cp.entries.filter(function (e) { return e.kind === 'src' && e.path && e.path.charAt(0) !== '/'; }).map(function (e) { return e.path.replace(/\/$/, '') + '/'; }) : [];
      if (!srcDirs.length) srcDirs = ['src/'];
      var files = lay.files.filter(function (l) { return l.project === p.name; }).map(function (l) { var f = fileById[l.fileId]; return { path: l.outPath, data: f && f.bytes, rec: f, origin: 'original' }; }).filter(function (x) { return x.rec; });
      var referencedBy = lay.projects.filter(function (q) { return q.eclipse && (q.eclipse.dotProject.projects || []).indexOf(p.name) >= 0 && q.type !== 'java'; }).map(function (q) { return q.name; });
      javaProjects.push({ name: p.name, original: true, files: files, srcDirs: srcDirs, containers: [], referencedBy: referencedBy });
    });
    function javaFileLeaves(jp) {
      return jp.files.map(function (f) {
        if (leaves[f.path]) return leaves[f.path];
        if (jp.original) return leaf(f.path, 'bar', { rec: f.rec, origin: 'original', javaProject: jp.name });
        return leaf(f.path, 'java', { jar: jp.jar, origin: f.origin, javaProject: jp.name, note: f.note });
      });
    }
    function inSrc(jp, path) {
      var rel = path.slice(jp.name.length + 1);
      return (jp.srcDirs || ['src/']).some(function (s) { return rel.indexOf(s) === 0; });
    }
    // Java tree: <project> -> packages (from the actual package declaration) -> .java files
    function javaSourceTree(jp, idPrefix) {
      var n = node(idPrefix + '/jp:' + jp.name, 'project-java', jp.name, { javaProject: jp.name });
      var pk = {};
      javaFileLeaves(jp).forEach(function (l) {
        if (!/\.java$/.test(l.path) || !inSrc(jp, l.path)) return;
        var fd = jp.files.filter(function (x) { return x.path === l.path; })[0];
        var ov = (ws.ws12 && ws.ws12.overlay[l.path]) || (ws.ws13 && ws.ws13.overlay[l.path]);
        var text = ov ? ov.text : (fd ? (typeof fd.data === 'string' ? fd.data : util.decodeText(fd.data).text) : '');
        var p = EX.javaPackage(text);
        l.pkg = p;
        var key = p || '(default package)';
        if (!pk[key]) { pk[key] = node(n.id + '/pkg:' + key, 'package', key); n.children.push(pk[key]); }
        pk[key].children.push(l);
      });
      if (!n.children.length) n.children.push(node(n.id + '/none', 'info', 'no source files'));
      return n;
    }
    // Eclipse view of a Java project (physical): src/<packages>, bin/, Lib/, metadata
    function javaPhysical(jp, idPrefix, skipSrc) {
      var n = node(idPrefix + '/jpr:' + jp.name, 'project-java', jp.name, { javaProject: jp.name });
      if (!skipSrc) { var src = javaSourceTree(jp, n.id); src.kind = 'folder'; src.label = 'src'; n.children.push(src); }
      javaFileLeaves(jp).forEach(function (l) {
        var rel = l.path.slice(jp.name.length + 1);
        if (inSrc(jp, l.path) && (/\.java$/.test(rel) || !jp.original)) return;
        addPhysical(n, rel, l, n.id);
      });
      // Like the Toolkit: output folder and Eclipse metadata are hidden in the tree (still exported)
      n.children.forEach(function (c) { if ((c.kind === 'folder' && (c.label === 'bin' || c.label === '.settings')) || (c.kind === 'file' && c.label.charAt(0) === '.')) c.hidden = true; });
      return n;
    }

    // Toolkit projects (applications, libraries)
    lay.projects.forEach(function (p) {
      if (p.type === 'java') return; // shown through javaProjects
      var kind = p.type === 'application' ? 'project-app' : p.type === 'shared-library' ? 'project-shlib' : 'project-lib';
      var root = node('p:' + p.name, kind, p.name, { projectName: p.name, projectType: p.type });
      var groups = {}, other = node(root.id + '/g:other', 'group', 'Other Resources');
      GROUPS.forEach(function (g) { groups[g[0]] = node(root.id + '/g:' + g[0], 'group', g[1]); });
      var esqlSchemas = {};
      lay.files.filter(function (l) { return l.project === p.name; }).forEach(function (l) {
        var f = fileById[l.fileId]; if (!f) return;
        var lf = leaf(l.outPath, 'bar', { rec: f, origin: 'original' });
        if (/^(application|library|restapi)\.descriptor$|^\.project$|^\.classpath$/.test(l.relPath)) lf.hidden = true; // hidden in the Toolkit view, still exported
        var e = util.ext(l.relPath), g = GROUPS.filter(function (x) { return x[2](e); })[0];
        if (g && g[0] === 'esql') {
          var sch = esqlSchema[f.vpath] || '';
          if (!sch) groups.esql.children.push(lf);
          else { if (!esqlSchemas[sch]) { esqlSchemas[sch] = node(root.id + '/sch:' + sch, 'schema', sch); groups.esql.children.push(esqlSchemas[sch]); } esqlSchemas[sch].children.push(lf); }
        } else if (g) addPhysical(groups[g[0]], l.relPath, lf, groups[g[0]].id);
        else addPhysical(other, l.relPath, lf, other.id);
      });
      var gen = ACE.project.generatedProjectFile(ws, p, refs);
      if (gen && gen.text) other.children.push(leaf(p.name + '/.project', 'toolkit-project', { projectRef: p, origin: 'generated', note: gen.note, hidden: true }));
      GROUPS.forEach(function (g) { if (groups[g[0]].children.length) root.children.push(groups[g[0]]); });
      // Java: projects whose JAR is deployed in this project's container
      var jps = javaProjects.filter(function (jp) { return jp.containers.indexOf(p.containerVPath) >= 0 || (jp.referencedBy || []).indexOf(p.name) >= 0; });
      jps.forEach(function (jp) { jp.attached = true; });
      var notDecompiled = (ws.jars || []).filter(function (j) { return j.classification.type === 'application' && !javaProjects.some(function (jp) { return jp.jar === j; }) && j.occurrences.some(function (o) { return o.indexOf('!/') >= 0 && o.slice(0, o.lastIndexOf('!/')) === p.containerVPath; }); });
      if (jps.length || notDecompiled.length) {
        var jg = node(root.id + '/g:java', 'group', 'Java');
        jps.forEach(function (jp) { jg.children.push(javaSourceTree(jp, jg.id)); });
        notDecompiled.forEach(function (j) { jg.children.push(node(jg.id + '/nd:' + j.name, 'info', util.stripExt(j.name) + ': not decompiled yet (Java Decompiler)')); });
        root.children.push(jg);
      }
      var lr = refs[p.name] || [];
      if (lr.length) {
        var ig = node(root.id + '/g:libs', 'group', 'Included Libraries');
        lr.forEach(function (r) { ig.children.push(node(ig.id + '/' + r.project, 'libref', r.project, { target: 'p:' + r.project, note: r.reasons.join('; ') })); });
        root.children.push(ig);
      }
      // Other Resources: the Java projects' non-source files (Lib/, bin/, metadata), then this project's own resources
      jps.forEach(function (jp) { other.children.unshift(javaPhysical(jp, other.id, true)); });
      other.children.forEach(function (c) { if (c.kind === 'folder' && c.label === '.settings') c.hidden = true; });
      if (other.children.length) root.children.push(other);
      roots.push(root);
    });
    // Toolkit order: projects alphabetically. A Java project is shown inside the library/application
    // that deploys its JAR (Java + Other Resources), exactly as in the Toolkit; only a Java project
    // that belongs to no Toolkit project gets its own top-level node.
    roots.sort(function (a, b) { return a.label.toLowerCase().localeCompare(b.label.toLowerCase()); });
    javaProjects.forEach(function (jp) { if (!jp.attached) roots.push(javaPhysical(jp, 'root', false)); });
    javaProjects.forEach(function (jp) { jp.leaves = javaFileLeaves(jp); });
    // BAR metadata and anything not in a project
    var meta = node('meta', 'folder', 'BAR metadata (not part of any project)');
    lay.metadata.concat(lay.unassigned).forEach(function (m) { var f = fileById[m.fileId]; if (f) addPhysical(meta, m.outPath, leaf(m.outPath, 'bar', { rec: f, origin: 'original-metadata' }), 'meta'); });
    if (meta.children.length) roots.push(meta);
    roots.forEach(sortKids);
    var byId = {};
    (function index(list, parent) { list.forEach(function (n) { n.parentId = parent ? parent.id : null; byId[n.id] = n; index(n.children, n); }); })(roots, null);
    return { roots: roots, byId: byId, leaves: leaves, javaProjects: javaProjects };
  };

  /* Leaves (unique by path) under a node. */
  EX.leavesUnder = function (n, out, seen) {
    out = out || []; seen = seen || {};
    if (n.kind === 'file') { if (!seen[n.path]) { seen[n.path] = 1; out.push(n); } return out; }
    n.children.forEach(function (c) { EX.leavesUnder(c, out, seen); });
    return out;
  };

  /* Current content of a file in a copy: 'orig' | 'ws12' | 'ws13'. Returns Uint8Array or string. */
  EX.read = function (ws, leaf, copy) {
    var overlay = copy === 'ws12' ? ws.ws12.overlay : copy === 'ws13' ? ws.ws13.overlay : null;
    if (overlay && overlay[leaf.path]) return overlay[leaf.path].text;
    if (leaf.src === 'bar') return leaf.rec.bytes;
    if (leaf.src === 'toolkit-project') { var g = ACE.project.generatedProjectFile(ws, leaf.projectRef, ACE.project.references(ws, ws.facts)); return g ? g.text : ''; }
    if (leaf.src === 'java') {
      var pj = (ACE.settings.current || {}).project || {};
      var ep = ACE.eclipse.files(ws, leaf.jar, { target: copy === 'ws13' ? 'ace13' : 'ace12', overlay: overlay || {}, keepOriginalJar: pj.keepOriginalJar !== false, includeExcluded: !!pj.libIncludeExcluded });
      var f = ep.files.filter(function (x) { return x.path === leaf.path; })[0];
      return f ? f.data : null;
    }
    return null;
  };
  EX.readText = function (ws, leaf, copy) {
    var d = EX.read(ws, leaf, copy);
    if (d == null) return null;
    return typeof d === 'string' ? d : util.decodeText(d).text;
  };
  EX.readBytes = function (ws, leaf, copy) {
    var d = EX.read(ws, leaf, copy);
    if (d == null) return null;
    return typeof d === 'string' ? util.encodeUtf8(d) : d;
  };

  /* Build a ZIP of leaves and VERIFY it before returning: every expected path must be present
   * once, readable, CRC-correct and byte-identical to the content that was written. */
  EX.exportZip = async function (ws, leafList, copy, progress) {
    var t0 = Date.now(), w = new ACE.zip.Writer(), expected = {}, total = 0, errors = [];
    leafList.forEach(function (l) {
      var b = EX.readBytes(ws, l, copy);
      if (b == null) { errors.push('no content for ' + l.path); return; }
      if (expected[l.path]) return;
      expected[l.path] = b; total += b.length;
      w.add(l.path, b, { date: l.rec && l.rec.mtime ? l.rec.mtime : null });
    });
    if (errors.length) throw new Error('Export aborted: ' + errors.join('; '));
    var blob = await w.build(progress);
    // verification pass
    var arc = await ACE.zip.open(ACE.zip.bytesSource(new Uint8Array(await blob.arrayBuffer())));
    var seen = {};
    for (var i = 0; i < arc.entries.length; i++) {
      var e = arc.entries[i];
      if (e.isDir) continue;
      if (!expected[e.path]) throw new Error('Verification failed: unexpected entry ' + e.path);
      if (seen[e.path]) throw new Error('Verification failed: duplicate entry ' + e.path);
      seen[e.path] = 1;
      var got = await ACE.zip.extract(arc, e);
      if (!util.bytesEqual(got, expected[e.path])) throw new Error('Verification failed: content mismatch for ' + e.path);
    }
    var missing = Object.keys(expected).filter(function (p) { return !seen[p]; });
    if (missing.length) throw new Error('Verification failed: missing ' + missing.join(', '));
    return { blob: blob, files: Object.keys(expected).length, size: total, zipSize: blob.size, ms: Date.now() - t0, verified: true, paths: Object.keys(expected).sort() };
  };
})(window.ACE);
