/* JAR inspection and classification.
 * For every .jar extracted from the BAR: list entries and classes, read the manifest, detect
 * nested JARs, parse class files (version + API references), and classify the JAR as
 * application / third-party / product / driver / possible-driver, with recorded evidence.
 * Drivers are never selected for decompilation by default. */
(function (ACE) {
  'use strict';
  var util = ACE.util, zip = ACE.zip, java = ACE.java;
  var jars = ACE.jars = {};

  jars.parseManifest = function (text) {
    var main = {}, sections = [], cur = main, last = null;
    String(text || '').split(/\r\n|\r|\n/).forEach(function (line) {
      if (line === '') { if (cur !== main || Object.keys(main).length) { cur = {}; sections.push(cur); } last = null; return; }
      if (line[0] === ' ' && last) { cur[last] += line.slice(1); return; }
      var i = line.indexOf(':'); if (i <= 0) return;
      last = line.slice(0, i).trim(); cur[last] = line.slice(i + 1).trim();
    });
    return { main: main, sections: sections.filter(function (s) { return Object.keys(s).length; }) };
  };

  function globToRe(g) { return new RegExp('^' + String(g).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i'); }

  /* Inspect one JAR (bytes). */
  jars.inspect = async function (name, bytes, opts) {
    opts = opts || {};
    var info = { name: name, size: bytes.length, entries: 0, classCount: 0, classes: [], packages: {}, versions: {}, manifest: null, serviceDrivers: [], nestedJars: [], resources: 0, parseErrors: [], error: null, signed: false };
    var arc;
    try { arc = await zip.open(zip.bytesSource(bytes), { label: name }); }
    catch (e) { info.error = 'Not a readable JAR/ZIP: ' + e.message; return info; }
    info.entries = arc.entries.length;
    info.archiveIssues = arc.issues.concat.apply(arc.issues, arc.entries.map(function (e) { return e.issues.filter(function (i) { return i.severity !== 'info'; }); }));
    var maxParse = opts.maxClassesParsed || 50000;
    for (var i = 0; i < arc.entries.length; i++) {
      var e = arc.entries[i];
      if (e.isDir || e.unsafe) continue;
      var p = e.path;
      if (i % 200 === 0) { await util.yieldUI(); if (opts.cancel) opts.cancel.check(); }
      if (/\.class$/i.test(p)) {
        info.classCount++;
        var pkg = p.indexOf('/') >= 0 ? p.slice(0, p.lastIndexOf('/') + 1) : '(default package)';
        info.packages[pkg] = (info.packages[pkg] || 0) + 1;
        if (/(^|\/)module-info\.class$/.test(p) || /^META-INF\/versions\//.test(p)) info.multiRelease = info.multiRelease || /^META-INF\/versions\//.test(p);
        if (info.classCount <= maxParse && !opts.summaryOnly) {
          try {
            var cb = await zip.extract(arc, e, { maxSize: 64 * 1024 * 1024 });
            var cf = java.parseClass(cb);
            cf.path = p; cf.bytes = cb; // original bytecode, preserved under bin/ in the generated project
            info.versions[cf.major] = (info.versions[cf.major] || 0) + 1;
            info.classes.push(cf);
          } catch (err) { info.parseErrors.push({ path: p, error: err.message }); }
        }
      } else if (/\.jar$/i.test(p)) {
        info.nestedJars.push({ path: p, size: e.size });
      } else if (/^META-INF\/MANIFEST\.MF$/i.test(p)) {
        try { info.manifest = jars.parseManifest(util.decodeText(await zip.extract(arc, e)).text); } catch (err) { info.parseErrors.push({ path: p, error: err.message }); }
      } else if (/^META-INF\/services\/java\.sql\.Driver$/i.test(p)) {
        try { info.serviceDrivers = util.decodeText(await zip.extract(arc, e)).text.split(/\r?\n/).map(function (s) { return s.replace(/#.*/, '').trim(); }).filter(Boolean); } catch (err) { /* ignore */ }
      } else if (/^META-INF\/.*\.(SF|RSA|DSA|EC)$/i.test(p)) {
        info.signed = true;
      } else info.resources++;
    }
    var majors = Object.keys(info.versions).map(Number);
    info.minMajor = majors.length ? Math.min.apply(null, majors) : null;
    info.maxMajor = majors.length ? Math.max.apply(null, majors) : null;
    return info;
  };

  function share(info, prefixes) {
    var tot = 0, hit = 0;
    Object.keys(info.packages).forEach(function (pk) {
      var c = info.packages[pk]; tot += c;
      if (prefixes.some(function (p) { return pk.indexOf(p) === 0; })) hit += c;
    });
    return tot ? hit / tot : 0;
  }

  /* Classify a JAR. Returns {type, driverId, driverName, score, evidence[]} */
  jars.classify = function (info, settings) {
    var sigs = window.ACE_DRIVER_SIGNATURES || [];
    var ev = [], best = null, bestScore = 0;
    var mfAll = '';
    if (info.manifest) {
      mfAll = JSON.stringify(info.manifest.main) + JSON.stringify(info.manifest.sections);
    }
    var implementsDriver = info.classes.filter(function (c) { return c.interfaces.indexOf('java/sql/Driver') >= 0; }).map(function (c) { return c.name.replace(/\//g, '.'); });
    sigs.forEach(function (s) {
      var score = 0, e = [];
      var svcHit = info.serviceDrivers.filter(function (d) { return s.driverClasses.indexOf(d) >= 0 || s.packages.some(function (p) { return d.replace(/\./g, '/').indexOf(p) === 0; }); });
      if (svcHit.length) { score += 60; e.push('META-INF/services/java.sql.Driver registers ' + svcHit.join(', ')); }
      var pk = Object.keys(info.packages).filter(function (p) { return s.packages.some(function (sp) { return p.indexOf(sp) === 0; }); });
      if (pk.length) { var n = pk.reduce(function (a, p) { return a + info.packages[p]; }, 0); score += 40; e.push(n + ' classes in driver package(s) ' + s.packages.filter(function (sp) { return pk.some(function (p) { return p.indexOf(sp) === 0; }); }).join(', ')); }
      var dc = implementsDriver.filter(function (c) { return s.driverClasses.indexOf(c) >= 0; });
      if (dc.length) { score += 20; e.push('class ' + dc.join(', ') + ' implements java.sql.Driver'); }
      var mfHit = s.manifest.filter(function (m) { return mfAll.toLowerCase().indexOf(m.toLowerCase()) >= 0; });
      if (mfHit.length) { score += 20; e.push('manifest mentions "' + mfHit.join('", "') + '"'); }
      var fnHit = s.filePatterns.filter(function (fp) { return new RegExp(fp, 'i').test(info.name); });
      if (fnHit.length) { score += 10; e.push('file name "' + info.name + '" matches driver naming pattern ' + fnHit.join(', ')); }
      if (score > bestScore) { bestScore = score; best = { sig: s, evidence: e }; }
    });
    // Generic signals for drivers not in the signature list
    var generic = [];
    if (!best || bestScore < 40) {
      if (info.serviceDrivers.length) { generic.push('META-INF/services/java.sql.Driver registers ' + info.serviceDrivers.join(', ')); }
      if (implementsDriver.length) { generic.push('class(es) ' + implementsDriver.slice(0, 3).join(', ') + ' implement java.sql.Driver'); }
      if (/jdbc/i.test(mfAll)) generic.push('manifest mentions JDBC');
      if (/jdbc|driver/i.test(info.name)) generic.push('file name contains "jdbc"/"driver"');
    }
    if (best && bestScore >= 40) return { type: 'driver', driverId: best.sig.id, driverName: best.sig.name, score: bestScore, evidence: best.evidence };
    if (generic.length && (info.serviceDrivers.length || implementsDriver.length)) return { type: 'driver', driverId: 'generic', driverName: 'Unidentified JDBC driver', score: 60, evidence: generic };
    if ((best && bestScore >= 20) || generic.length) return { type: 'possible-driver', driverId: best ? best.sig.id : 'generic', driverName: best ? best.sig.name : 'Unidentified', score: bestScore, evidence: (best ? best.evidence : []).concat(generic) };
    if (info.error) return { type: 'invalid', score: 0, evidence: [info.error] };
    if (!info.classCount) return { type: 'no-classes', score: 0, evidence: ['JAR contains no .class files'] };
    var prod = share(info, window.ACE_PRODUCT_PREFIXES || []);
    if (prod > 0.5) return { type: 'product', score: 0, evidence: [Math.round(prod * 100) + '% of classes are IBM ACE product packages'] };
    var tp = share(info, window.ACE_THIRD_PARTY_PREFIXES || []);
    if (tp > 0.6) return { type: 'third-party', score: 0, evidence: [Math.round(tp * 100) + '% of classes are in well-known third-party packages'] };
    return { type: 'application', score: 0, evidence: ['No driver, product or third-party signature matched; ' + info.classCount + ' class(es) treated as application code'] };
  };

  /* Decide default decompilation eligibility, applying exclusion list and manual overrides. */
  jars.decide = function (rec, settings) {
    var cls = rec.classification, ex = (settings && settings.exclusions) || [], ov = (settings && settings.jarOverrides) || {};
    var userEx = ex.filter(function (pat) {
      pat = String(pat).trim(); if (!pat) return false;
      if (/^sha256:/i.test(pat)) return rec.sha256 && pat.slice(7).toLowerCase() === rec.sha256;
      if (/^pkg:/i.test(pat)) { var pp = pat.slice(4).replace(/\./g, '/'); return Object.keys(rec.info.packages).some(function (k) { return k.indexOf(pp) === 0; }); }
      return globToRe(pat).test(rec.name);
    });
    var d = { eligible: true, selected: true, reason: '', excludedBy: null };
    if (cls.type === 'driver') { d.selected = false; d.excludedBy = 'driver'; d.reason = 'Database driver (' + cls.driverName + '): excluded from decompilation by policy. Evidence: ' + cls.evidence.join('; '); }
    else if (cls.type === 'possible-driver') { d.selected = false; d.excludedBy = 'possible-driver'; d.reason = 'Possible database driver (' + cls.driverName + '): excluded by default. Evidence: ' + cls.evidence.join('; '); }
    else if (cls.type === 'product') { d.eligible = false; d.selected = false; d.excludedBy = 'product'; d.reason = 'IBM ACE product library - never decompiled'; }
    else if (cls.type === 'third-party') { d.selected = false; d.excludedBy = 'third-party'; d.reason = 'Third-party library (not application code); include manually if needed'; }
    else if (cls.type === 'no-classes' || cls.type === 'invalid') { d.eligible = false; d.selected = false; d.excludedBy = cls.type; d.reason = cls.evidence.join('; '); }
    if (userEx.length) { d.selected = false; d.excludedBy = 'user-exclusion'; d.reason = 'Matches exclusion pattern(s): ' + userEx.join(', ') + (d.reason ? ' | ' + d.reason : ''); }
    var o = rec.sha256 ? ov[rec.sha256] : null;
    if (o === 'include' && d.eligible) { d.selected = true; d.override = 'include'; d.reason = 'Manually included by user' + (d.excludedBy ? ' (default: ' + d.excludedBy + ')' : ''); }
    if (o === 'exclude') { d.selected = false; d.override = 'exclude'; d.excludedBy = d.excludedBy || 'user'; d.reason = 'Manually excluded by user' + (d.reason ? ' | ' + d.reason : ''); }
    return d;
  };

  /* Analyse all JARs in the workspace. Identical JARs (same SHA-256) are grouped. */
  jars.analyzeWorkspace = async function (ws, settings, opts) {
    opts = opts || {};
    var list = ws.files.filter(function (f) { return f.ext === 'jar' && f.bytes; });
    var groups = {}, out = [];
    for (var i = 0; i < list.length; i++) {
      var f = list[i];
      if (opts.progress) opts.progress('jars', i, list.length, f.vpath);
      if (opts.cancel) opts.cancel.check();
      var key = f.sha256 || f.vpath;
      if (groups[key]) { groups[key].occurrences.push(f.vpath); groups[key].fileIds.push(f.id); continue; }
      var info = await jars.inspect(f.name, f.bytes, { cancel: opts.cancel });
      var rec = { id: util.uid('j'), name: f.name, sha256: f.sha256, size: f.size, fileIds: [f.id], occurrences: [f.vpath], info: info };
      rec.classification = jars.classify(info, settings);
      groups[key] = rec; out.push(rec);
    }
    out.forEach(function (r) { r.decision = jars.decide(r, settings); });
    ws.jars = out;
    ACE.log.info('Analysed ' + list.length + ' JAR file(s) (' + out.length + ' distinct): ' + out.map(function (r) { return r.name + '=' + r.classification.type; }).join(', '));
    return out;
  };
})(window.ACE);
