/* BAR archive processing engine.
 *
 * Loads a BAR (ZIP-compatible) file, verifies it, recurses into nested deployable containers
 * (.appzip, .libzip, .shlibzip, nested .bar), extracts every safe entry into an in-memory
 * virtual file tree, and derives the deployable model (applications, libraries, policies...).
 *
 * Virtual paths use "!/" to mark a container boundary, e.g.
 *   Demo.appzip!/CommonLIB.libzip!/Helpers.esql
 * Original bytes are kept unchanged; nothing in this module ever modifies extracted content. */
(function (ACE) {
  'use strict';
  var util = ACE.util, zip = ACE.zip;
  var bar = ACE.bar = {};

  bar.DEFAULT_LIMITS = {
    maxFileSize: 256 * 1024 * 1024,     // per extracted entry
    maxTotalSize: 2 * 1024 * 1024 * 1024, // total extracted bytes across all containers
    maxEntries: 200000,                 // per container
    maxDepth: 6,                        // container nesting depth
    maxRatio: 1000                      // compression-ratio warning threshold
  };

  /* Load and fully process a BAR file.
   * file: File/Blob.  opts: {limits, cancel, progress(stage, done, total, detail)} */
  bar.load = async function (file, opts) {
    opts = opts || {};
    var limits = Object.assign({}, bar.DEFAULT_LIMITS, opts.limits || {});
    var cancel = opts.cancel || new util.CancelToken();
    var progress = opts.progress || function () {};
    var t0 = Date.now();

    var ws = {
      barName: file.name || 'archive.bar', barSize: file.size, barLastModified: file.lastModified ? new Date(file.lastModified).toISOString() : null,
      barSha256: null, loadedAt: util.nowIso(), limits: limits,
      containers: [], files: [], rejected: [], issues: [], dirCount: 0,
      totalExtracted: 0, complete: true, stats: {}
    };
    function gissue(sev, code, msg, where) { ws.issues.push({ severity: sev, code: code, message: msg, where: where || null }); ACE.log(sev === 'error' ? 'error' : (sev === 'warning' ? 'warn' : 'info'), msg + (where ? ' [' + where + ']' : '')); }

    ACE.log.info('Opening ' + ws.barName + ' (' + util.fmtBytes(file.size) + ')');
    progress('open', 0, 1, ws.barName);

    // Hash the BAR in one pass only if it is reasonably sized (hashing needs the whole buffer).
    if (file.size <= 512 * 1024 * 1024) {
      try { ws.barSha256 = await util.sha256Hex(new Uint8Array(await file.arrayBuffer())); } catch (e) { ws.barSha256 = null; }
    }

    var rootSrc = zip.blobSource(file);
    var rootArchive;
    try {
      rootArchive = await zip.open(rootSrc, { maxEntries: limits.maxEntries, maxRatio: limits.maxRatio, label: ws.barName });
    } catch (e) {
      ws.complete = false;
      ws.fatal = { code: e.code || 'E_OPEN', message: e.message };
      gissue('error', e.code || 'E_OPEN', 'Cannot open BAR: ' + e.message, ws.barName);
      return ws;
    }

    var queue = [{ archive: rootArchive, vpath: '', name: ws.barName, type: 'bar', parentId: null, depth: 0 }];
    var totalEntries = rootArchive.entries.length, doneEntries = 0;

    while (queue.length) {
      cancel.check();
      var job = queue.shift();
      var cid = util.uid('c');
      var container = {
        id: cid, vpath: job.vpath, name: job.name, type: job.type, parentId: job.parentId, depth: job.depth,
        entryCount: job.archive.entries.length, issues: job.archive.issues.slice(), comment: job.archive.comment, zip64: job.archive.zip64,
        backslashNames: job.archive.entries.some(function (e) { return e.rawName.indexOf('\\') >= 0; })
      };
      ws.containers.push(container);
      container.issues.forEach(function (i) { gissue(i.severity, i.code, i.message, job.name); });
      if (container.backslashNames) gissue('info', 'I_BACKSLASH', 'Container uses backslash ("\\") path separators (written by the Toolkit on Windows); paths were normalised to "/" and original names are recorded in the manifest', job.name);

      for (var i = 0; i < job.archive.entries.length; i++) {
        var ent = job.archive.entries[i];
        doneEntries++;
        if (i % 25 === 0) { progress('extract', doneEntries, totalEntries, (job.vpath ? job.vpath + '!/' : '') + ent.path); await util.yieldUI(); cancel.check(); }
        if (ent.isDir) { ws.dirCount++; continue; }
        var where = (job.vpath ? job.vpath + '!/' : '') + (ent.path || ent.rawName);
        if (ent.unsafe) {
          ws.rejected.push({ container: job.vpath || job.name, rawName: ent.rawName, reason: ent.unsafe });
          gissue('error', 'E_UNSAFE_PATH', 'Rejected unsafe archive entry "' + ent.rawName + '": ' + ent.unsafe, job.name);
          continue;
        }
        var hardErr = ent.issues.filter(function (x) { return x.severity === 'error' && x.code !== 'E_DUPLICATE'; });
        var rec = {
          id: util.uid('f'), containerId: cid, containerVPath: job.vpath, path: ent.path, rawName: ent.rawName,
          vpath: (job.vpath ? job.vpath + '!/' : '') + ent.path,
          name: util.basename(ent.path), ext: util.ext(ent.path), size: ent.size, compressedSize: ent.compressedSize,
          method: ent.methodName, crc: ent.crc, mtime: ent.mtime, versionMadeBy: ent.versionMadeBy, hostOS: ent.hostOS,
          issues: ent.issues.slice(), bytes: null, sha256: null, extracted: false, origin: 'original'
        };
        if (ent.duplicateOf != null) {
          rec.duplicate = true;
          rec.vpath += '#duplicate-' + (i + 1);
        }
        if (hardErr.length) {
          rec.extractError = hardErr.map(function (x) { return x.message; }).join('; ');
          rec.cls = ACE.classify(ent.path, null);
          ws.files.push(rec); ws.complete = false;
          gissue('error', hardErr[0].code, 'Not extracted: ' + rec.extractError, where);
          continue;
        }
        if (ws.totalExtracted + ent.size > limits.maxTotalSize) {
          rec.extractError = 'Total extraction limit of ' + util.fmtBytes(limits.maxTotalSize) + ' reached';
          rec.cls = ACE.classify(ent.path, null);
          ws.files.push(rec); ws.complete = false;
          gissue('error', 'E_TOTAL_LIMIT', rec.extractError + '; entry skipped', where);
          continue;
        }
        try {
          rec.bytes = await zip.extract(job.archive, ent, { maxSize: limits.maxFileSize, cancel: cancel });
          rec.extracted = true;
          ws.totalExtracted += rec.bytes.length;
          rec.sha256 = await util.sha256Hex(rec.bytes);
        } catch (e) {
          if (util.isCancel(e)) throw e;
          rec.extractError = e.message; ws.complete = false;
          rec.cls = ACE.classify(ent.path, null);
          ws.files.push(rec);
          gissue('error', e.code || 'E_EXTRACT', 'Extraction failed: ' + e.message, where);
          continue;
        }
        rec.cls = ACE.classify(ent.path, rec.bytes);
        ws.files.push(rec);

        if (ACE.classify.isNestedDeployable(ent.path) && !rec.duplicate) {
          if (job.depth + 1 > limits.maxDepth) {
            gissue('warning', 'W_DEPTH', 'Nested container not opened: nesting depth limit (' + limits.maxDepth + ') reached', where);
            continue;
          }
          try {
            var inner = await zip.open(zip.bytesSource(rec.bytes), { maxEntries: limits.maxEntries, maxRatio: limits.maxRatio, label: rec.vpath });
            rec.isContainer = true;
            totalEntries += inner.entries.length;
            queue.push({ archive: inner, vpath: rec.vpath, name: rec.name, type: rec.ext, parentId: cid, depth: job.depth + 1 });
          } catch (e) {
            rec.containerError = e.message; ws.complete = false;
            gissue('error', e.code || 'E_NESTED', 'Nested archive could not be opened: ' + e.message, where);
          }
        }
      }
    }

    // Case-insensitive collisions across a container are already flagged per entry; summarise.
    ws.stats = bar.stats(ws);
    ws.stats.elapsedMs = Date.now() - t0;
    ws.model = bar.deriveModel(ws);
    ws.inputKind = ws.model.inputKind;
    if (ws.inputKind === 'workspace') ACE.log.info('Input is a Toolkit workspace ZIP: ' + ws.model.deployables.length + ' project(s) from .project files: ' + ws.model.deployables.map(function (d) { return d.name + ' [' + d.type + ']'; }).join(', '));
    progress('done', 1, 1, '');
    ACE.log.ok('Processed ' + ws.files.length + ' files in ' + ws.containers.length + ' containers (' + util.fmtBytes(ws.totalExtracted) + ' extracted) in ' + ws.stats.elapsedMs + ' ms' + (ws.complete ? '' : ' - INCOMPLETE, see issues'));
    return ws;
  };

  bar.stats = function (ws) {
    var s = { byCategory: {}, byKind: {}, files: ws.files.length, containers: ws.containers.length, rejected: ws.rejected.length, failed: 0 };
    ws.files.forEach(function (f) {
      var c = f.cls ? f.cls.category : 'unknown';
      s.byCategory[c] = (s.byCategory[c] || 0) + 1;
      var k = f.cls ? f.cls.label : '?';
      s.byKind[k] = (s.byKind[k] || 0) + 1;
      if (f.extractError) s.failed++;
    });
    return s;
  };

  /* Text of a file record (decoded lazily, cached). */
  bar.text = function (rec) {
    if (rec._text != null) return rec._text;
    if (!rec.bytes) return null;
    var d = util.decodeText(rec.bytes);
    rec._text = d.text; rec.encoding = d.encoding; rec.lossyDecode = d.lossy;
    return rec._text;
  };

  bar.byVPath = function (ws, vpath) {
    if (!ws._idx) { ws._idx = {}; ws.files.forEach(function (f) { ws._idx[f.vpath] = f; }); }
    return ws._idx[vpath] || null;
  };
  bar.container = function (ws, id) { return ws.containers.filter(function (c) { return c.id === id; })[0] || null; };
  bar.filesIn = function (ws, containerId) { return ws.files.filter(function (f) { return f.containerId === containerId; }); };

  function parseManifestProps(text) {
    var props = {};
    String(text || '').split(/[;\r\n]+/).forEach(function (kv) {
      var i = kv.indexOf('='); if (i > 0) props[kv.slice(0, i).trim()] = kv.slice(i + 1).trim();
    });
    return props;
  }

  /* Parse a broker.xml deployment descriptor into a flat list of configurable properties. */
  bar.parseBrokerXml = function (text) {
    var out = { flows: [], properties: [], parseError: null };
    try {
      var doc = new DOMParser().parseFromString(text, 'application/xml');
      if (doc.getElementsByTagName('parsererror').length) { out.parseError = 'XML parse error'; return out; }
      var flows = doc.querySelectorAll('CompiledMessageFlow, CompiledApplication, CompiledLibrary, CompiledSharedLibrary');
      Array.prototype.forEach.call(flows, function (f) {
        var fl = { kind: f.tagName, name: f.getAttribute('name') || '', props: [] };
        Array.prototype.forEach.call(f.getElementsByTagName('ConfigurableProperty'), function (p) {
          var prop = { uri: p.getAttribute('uri'), override: p.hasAttribute('override') ? p.getAttribute('override') : null, flow: fl.name, kind: f.tagName };
          fl.props.push(prop); out.properties.push(prop);
        });
        out.flows.push(fl);
      });
    } catch (e) { out.parseError = e.message; }
    return out;
  };

  /* ---------- Toolkit workspace ZIP (project folders with .project files) ---------- */
  function xmlDoc(text) {
    try { var d = new DOMParser().parseFromString(String(text || ''), 'application/xml'); return d.getElementsByTagName('parsererror').length ? null : d; } catch (e) { return null; }
  }
  function childText(el, tag) { var x = el && el.getElementsByTagName(tag)[0]; return x ? x.textContent.trim() : null; }

  /* Parse an Eclipse .project file: {name, comment, projects[], natures[], builders[], parseError} */
  bar.parseDotProject = function (text) {
    var d = xmlDoc(text);
    if (!d) return { name: null, comment: null, projects: [], natures: [], builders: [], parseError: 'XML parse error' };
    var pd = d.getElementsByTagName('projectDescription')[0];
    function list(parent, tag) { return parent ? Array.prototype.map.call(parent.getElementsByTagName(tag), function (x) { return x.textContent.trim(); }).filter(Boolean) : []; }
    var projs = pd && pd.getElementsByTagName('projects')[0];
    var bs = pd && pd.getElementsByTagName('buildSpec')[0];
    return {
      name: pd ? childText(pd, 'name') : null, comment: pd ? childText(pd, 'comment') : null,
      projects: list(projs, 'project'), natures: list(pd && pd.getElementsByTagName('natures')[0], 'nature'),
      builders: bs ? Array.prototype.map.call(bs.getElementsByTagName('buildCommand'), function (b) { return childText(b, 'name'); }).filter(Boolean) : [],
      parseError: pd ? null : 'no projectDescription element'
    };
  };
  /* Parse an Eclipse .classpath file: {entries: [{kind, path, output, sourcepath, exported, line}], parseError} */
  bar.parseClasspath = function (text) {
    var d = xmlDoc(text), out = [];
    if (!d) return { entries: out, parseError: 'XML parse error' };
    var lines = String(text).split(/\r?\n/);
    Array.prototype.forEach.call(d.getElementsByTagName('classpathentry'), function (e) {
      var path = e.getAttribute('path') || '', ln = 0;
      for (var i = 0; i < lines.length; i++) if (lines[i].indexOf('path="' + path + '"') >= 0) { ln = i + 1; break; }
      out.push({ kind: e.getAttribute('kind') || '', path: path, output: e.getAttribute('output'), sourcepath: e.getAttribute('sourcepath'), exported: e.getAttribute('exported') === 'true', line: ln || null });
    });
    return { entries: out, parseError: null };
  };
  /* Project type from its natures (Toolkit nature ids). */
  bar.projectTypeFromNatures = function (natures) {
    var n = natures.join(' ');
    if (/\bcom\.ibm\.etools\.msgbroker\.tooling\.applicationNature\b/.test(n) || /restApiNature|integrationServiceNature/i.test(n)) return 'application';
    if (/sharedLibraryNature/i.test(n)) return 'shared-library';
    if (/\bcom\.ibm\.etools\.msgbroker\.tooling\.libraryNature\b/.test(n)) return 'library';
    if (/policy/i.test(n)) return 'policy';
    if (/\borg\.eclipse\.jdt\.core\.javanature\b/.test(n)) return 'java';
    if (/messageBrokerProjectNature/.test(n)) return 'integration-project';
    return 'other';
  };

  /* Project folders of a workspace ZIP, or null when the input is a BAR (it has deployable containers
   * or no .project file at all). A .project below another project is treated as an ordinary file of
   * the outer project and reported. */
  bar.detectWorkspace = function (ws) {
    var root = ws.containers[0]; if (!root) return null;
    var rootFiles = bar.filesIn(ws, root.id);
    if (rootFiles.some(function (f) { return f.isContainer; })) return null;
    var projs = rootFiles.filter(function (f) { return !f.duplicate && f.bytes && (f.path === '.project' || /\/\.project$/.test(f.path)); })
      .map(function (f) { return { prefix: f.path.slice(0, f.path.length - '.project'.length), file: f }; });
    if (!projs.length) return null;
    var nested = [];
    projs = projs.filter(function (p) {
      var outer = projs.some(function (q) { return q !== p && q.prefix.length < p.prefix.length && p.prefix.indexOf(q.prefix) === 0; });
      if (outer) nested.push(p.file.path);
      return !outer;
    });
    return { projects: projs, nested: nested };
  };

  function deriveWorkspaceModel(ws, det) {
    var root = ws.containers[0];
    var model = { inputKind: 'workspace', deployables: [], looseFiles: [], manifest: null, buildEvidence: [], warnings: [], workspace: { nestedProjectFiles: det.nested } };
    var rootFiles = bar.filesIn(ws, root.id), owned = {};
    det.projects.forEach(function (p) {
      var dp = bar.parseDotProject(bar.text(p.file));
      var folder = p.prefix.replace(/\/$/, '').split('/').pop() || util.stripExt(ws.barName);
      var files = rootFiles.filter(function (f) { return !owned[f.id] && f.path.indexOf(p.prefix) === 0; });
      files.forEach(function (f) { owned[f.id] = true; });
      function rel(f) { return f.path.slice(p.prefix.length); }
      var cpf = files.filter(function (f) { return rel(f) === '.classpath'; })[0];
      var desc = files.filter(function (f) { return /^(application|library|restapi|policy)\.descriptor$/.test(rel(f)); })[0];
      var d = {
        id: util.uid('d'), containerId: root.id, vpath: p.prefix.replace(/\/$/, ''), name: dp.name || folder, folder: folder, fileName: folder,
        projectRoot: p.prefix, parentDeployableId: null, parentType: null,
        type: bar.projectTypeFromNatures(dp.natures), descriptor: desc ? { vpath: desc.vpath, text: bar.text(desc) } : null, brokerXml: null,
        fileIds: files.map(function (f) { return f.id; }),
        eclipse: { dotProject: dp, dotProjectVPath: p.file.vpath, classpath: cpf ? bar.parseClasspath(bar.text(cpf)) : null, classpathVPath: cpf ? cpf.vpath : null }
      };
      if (dp.parseError) model.warnings.push('.project of ' + folder + ' could not be parsed: ' + dp.parseError);
      if (dp.name && dp.name !== folder) model.warnings.push('Project folder "' + folder + '" declares the name "' + dp.name + '" in .project; the declared name is used.');
      files.forEach(function (f) { if (rel(f).toLowerCase() === 'meta-inf/broker.xml') d.brokerXml = { vpath: f.vpath, parsed: bar.parseBrokerXml(bar.text(f)) }; });
      model.deployables.push(d);
    });
    model.deployables.sort(function (a, b) { return a.name.toLowerCase().localeCompare(b.name.toLowerCase()); });
    rootFiles.forEach(function (f) { if (!owned[f.id]) model.looseFiles.push(f.id); });
    if (det.nested.length) model.warnings.push('Nested .project files (inside another project) were treated as ordinary files: ' + det.nested.join(', '));
    model.buildEvidence.push({ source: ws.barName, text: 'Toolkit workspace ZIP with ' + model.deployables.length + ' project folder(s). Project metadata (.project, .classpath, .settings) is ORIGINAL, not generated.' });
    return model;
  }

  /* Derive applications, libraries etc. from the container tree. */
  bar.deriveModel = function (ws) {
    var model = { inputKind: 'bar', deployables: [], looseFiles: [], manifest: null, buildEvidence: [], warnings: [] };
    var root = ws.containers[0];
    if (!root) return model;
    var det = bar.detectWorkspace(ws);
    if (det) return deriveWorkspaceModel(ws, det);
    var mf = ws.files.filter(function (f) { return f.containerId === root.id && f.path.toLowerCase() === 'meta-inf/manifest.mf'; })[0];
    if (mf) model.manifest = { vpath: mf.vpath, raw: bar.text(mf), props: parseManifestProps(bar.text(mf)) };

    ws.containers.forEach(function (c) {
      if (c.type === 'bar' && c.depth === 0) return;
      var parent = bar.container(ws, c.parentId);
      var files = bar.filesIn(ws, c.id);
      var d = {
        id: util.uid('d'), containerId: c.id, vpath: c.vpath, name: util.stripExt(c.name), fileName: c.name,
        parentDeployableId: null, parentType: parent ? parent.type : null,
        type: c.type === 'appzip' ? 'application' : c.type === 'libzip' ? (parent && parent.type === 'appzip' ? 'static-library' : 'library') : c.type === 'shlibzip' ? 'shared-library' : c.type === 'bar' ? 'nested-bar' : 'archive',
        descriptor: null, brokerXml: null, fileIds: files.map(function (f) { return f.id; })
      };
      files.forEach(function (f) {
        var lp = f.path.toLowerCase();
        if (lp === 'application.descriptor' || lp === 'library.descriptor') d.descriptor = { vpath: f.vpath, text: bar.text(f) };
        if (lp === 'meta-inf/broker.xml') d.brokerXml = { vpath: f.vpath, parsed: bar.parseBrokerXml(bar.text(f)) };
      });
      if (!d.descriptor && (d.type === 'application' || /library/.test(d.type))) model.warnings.push('No descriptor found in ' + c.name);
      model.deployables.push(d);
    });
    // Link parents
    model.deployables.forEach(function (d) {
      var c = bar.container(ws, d.containerId);
      var pd = model.deployables.filter(function (x) { return x.containerId === c.parentId; })[0];
      if (pd) d.parentDeployableId = pd.id;
    });
    // Loose files at BAR root (compiled flows, policy files, etc.)
    ws.files.forEach(function (f) {
      if (f.containerId !== root.id) return;
      if (/^meta-inf\//i.test(f.path) || f.isContainer) return;
      model.looseFiles.push(f.id);
    });
    var rootBroker = ws.files.filter(function (f) { return f.containerId === root.id && f.path.toLowerCase() === 'meta-inf/broker.xml'; })[0];
    if (rootBroker) model.rootBrokerXml = { vpath: rootBroker.vpath, parsed: bar.parseBrokerXml(bar.text(rootBroker)) };

    // Evidence about the build environment. We only report what is actually recorded.
    if (model.manifest) model.buildEvidence.push({ source: model.manifest.vpath, text: 'BAR manifest: ' + model.manifest.raw.trim() });
    var mixedTools = {};
    ws.files.forEach(function (f) { mixedTools[f.containerVPath + '|' + f.versionMadeBy] = { c: f.containerVPath || ws.barName, v: f.versionMadeBy }; });
    var perContainer = {};
    Object.keys(mixedTools).forEach(function (k) { var x = mixedTools[k]; (perContainer[x.c] = perContainer[x.c] || []).push(x.v); });
    Object.keys(perContainer).forEach(function (c) {
      if (perContainer[c].length > 1) {
        var later = ws.files.filter(function (f) { return (f.containerVPath || ws.barName) === c; });
        var odd = util.groupBy(later, function (f) { return f.versionMadeBy; });
        var minority = Object.keys(odd).sort(function (a, b) { return odd[a].length - odd[b].length; })[0];
        model.buildEvidence.push({ source: c, kind: 'post-build-modification', text: 'Entries were written by different ZIP tools (ZIP "version made by" values ' + perContainer[c].join(', ') + '). Entries ' + odd[minority].map(function (f) { return f.path + ' (' + (f.mtime || '?') + ')'; }).join(', ') + ' appear to have been modified after the Toolkit built the BAR.' });
        model.warnings.push('Container ' + c + ' contains entries added or modified after the BAR was built: ' + odd[minority].map(function (f) { return f.path; }).join(', '));
      }
    });
    var flowFiles = ws.files.filter(function (f) { return f.ext === 'cmf'; });
    if (flowFiles.length) model.buildEvidence.push({ source: 'contents', text: flowFiles.length + ' compiled message flow (.cmf) file(s): flow source is NOT included for these.' });
    var srcFlows = ws.files.filter(function (f) { return f.ext === 'msgflow' || f.ext === 'subflow'; });
    if (srcFlows.length) model.buildEvidence.push({ source: 'contents', text: srcFlows.length + ' message flow/subflow source file(s) deployed as source (ACE 11+ deployment style).' });
    return model;
  };
})(window.ACE);
