/* Reviewed source transformations for the ACE 13 working copy.
 *
 * Rules: a fix is only PROPOSED here. Nothing is applied until the user confirms it in the UI.
 * Every applied fix keeps the previous text (undo), is recorded in the change log, and the
 * unchanged original is exported under _original-before-changes/. A fix declines to produce a
 * proposal when the code does not match its narrow, well-understood pattern. */
(function (ACE) {
  'use strict';
  var util = ACE.util;
  var tx = ACE.transforms = {};

  var B64_HELPER = [
    '',
    '   // Added by IBM ACE Migration Workbench (fix base64-legacy-encoder).',
    '   // Exact replacement for com.ibm.misc / sun.misc BASE64Encoder.encode(byte[]): a line separator',
    '   // (System.lineSeparator()) after every full 57-byte input block, standard Base64 alphabet and padding.',
    '   // Verified byte-for-byte against com.ibm.misc.BASE64Encoder on IBM Java 8 for input lengths 0..1200.',
    '   private static String legacyBase64Encode(byte[] data) {',
    '      java.util.Base64.Encoder enc = java.util.Base64.getEncoder();',
    '      String sep = System.lineSeparator();',
    '      StringBuilder sb = new StringBuilder();',
    '      for (int off = 0; off < data.length; off += 57) {',
    '         int len = Math.min(57, data.length - off);',
    '         sb.append(enc.encodeToString(java.util.Arrays.copyOfRange(data, off, off + len)));',
    '         if (len == 57) {',
    '            sb.append(sep);',
    '         }',
    '      }',
    '      return sb.toString();',
    '   }'
  ].join('\n');

  /* Insert text before the closing brace of the first top-level class. */
  function insertBeforeClassEnd(text, insert) {
    var mk = ACE.java17.mask(text).code;
    var start = mk.search(/\b(class|enum)\s+\w+[^{]*\{/);
    if (start < 0) return null;
    var open = mk.indexOf('{', start), depth = 0;
    for (var i = open; i < mk.length; i++) {
      if (mk[i] === '{') depth++;
      else if (mk[i] === '}') { depth--; if (depth === 0) return text.slice(0, i).replace(/\s*$/, '\n') + insert + '\n' + text.slice(i); }
    }
    return null;
  }

  /* Narrow BASE64Encoder rewrite shared by both Base64 fixes. call: the text that replaces "<encoder>.encode(";
   * helper: insert the legacy helper method. */
  function rewriteBase64(text, call, helper) {
        var t = text, notes = [];
        // 1. "Type v = new Type();" + v.encode(x)  ->  legacyBase64Encode(x)
        var declRe = /^[ \t]*(?:final\s+)?(?:(?:com\.ibm\.misc|sun\.misc)\.)?BASE64Encoder\s+(\w+)\s*=\s*new\s+(?:(?:com\.ibm\.misc|sun\.misc)\.)?BASE64Encoder\s*\(\s*\)\s*;[ \t]*\r?\n/m, m;
        while ((m = declRe.exec(t))) {
          var v = m[1];
          var rest = t.slice(0, m.index) + t.slice(m.index + m[0].length);
          var uses = rest.match(new RegExp('\\b' + v + '\\b(?!\\s*\\.\\s*encode\\s*\\()', 'g'));
          var encUses = rest.match(new RegExp('\\b' + v + '\\s*\\.\\s*encode\\s*\\(', 'g'));
          if (uses && uses.length) return { ok: false, reason: 'Variable "' + v + '" is used for something other than encode(...); not rewritten automatically.' };
          t = rest.replace(new RegExp('\\b' + v + '\\s*\\.\\s*encode\\s*\\(', 'g'), call);
          notes.push('replaced variable ' + v + ' (' + (encUses ? encUses.length : 0) + ' encode call(s))');
        }
        // 2. new BASE64Encoder().encode(x)
        var inl = /new\s+(?:(?:com\.ibm\.misc|sun\.misc)\.)?BASE64Encoder\s*\(\s*\)\s*\.\s*encode\s*\(/g;
        var c = (t.match(inl) || []).length;
        if (c) { t = t.replace(inl, call); notes.push('replaced ' + c + ' inline encode call(s)'); }
        // 3. imports
        t = t.replace(/^[ \t]*import\s+(?:com\.ibm\.misc|sun\.misc)\.BASE64Encoder\s*;[ \t]*\r?\n/mg, function () { notes.push('removed import'); return ''; });
        if (/\bBASE64Encoder\b/.test(ACE.java17.mask(t).code)) return { ok: false, reason: 'BASE64Encoder is still referenced after the narrow rewrite (unsupported usage); fix not applicable.' };
        if (!notes.length) return { ok: false, reason: 'No BASE64Encoder usage matched.' };
        if (helper && !/legacyBase64Encode\s*\(\s*byte/.test(t)) {
          var withHelper = insertBeforeClassEnd(t, B64_HELPER);
          if (!withHelper) return { ok: false, reason: 'Could not locate the class body to add the helper method.' };
          t = withHelper; notes.push('added private static helper legacyBase64Encode(byte[])');
        }
        return { ok: true, text: t, notes: notes };
  }

  /* Fixes. "group": fixes in the same group are ALTERNATIVES for the same problem - applying one
   * supersedes the others for that file. "when": short guidance shown with the choice. */
  tx.FIXES = {
    'base64-legacy-encoder': {
      group: 'base64', recommended: true,
      title: 'Replace BASE64Encoder with java.util.Base64, keeping the old output exactly (line breaks included)',
      when: 'Choose this when anything compares, stores or signs the exact Base64 text (database values, partner systems, existing tokens). Output is identical to the old encoder on any input length.',
      why: 'BASE64Encoder does not exist on IBM Semeru Runtime 17 (verified), the default JRE of ACE 13.0.8. The old encoder inserts the platform line separator after every 57 input bytes (76 characters). The added helper reproduces encode(byte[]) output exactly (verified against com.ibm.misc.BASE64Encoder for input lengths 0..1200). Only encode(byte[]) is rewritten; any other use (encodeBuffer, streams, subclassing) stops the fix.',
      apply: function (text) { return rewriteBase64(text, 'legacyBase64Encode(', true); }
    },
    'base64-basic-encoder': {
      group: 'base64',
      title: 'Replace BASE64Encoder with java.util.Base64.getEncoder() (single line, no line breaks)',
      when: 'Choose this when the receiver decodes the value with a tolerant decoder and nothing depends on the exact text. The result is identical to the old encoder only for inputs shorter than 57 bytes (e.g. 3DES/PKCS5 ciphertext of plaintext up to 55 bytes); longer values lose their line breaks.',
      why: 'BASE64Encoder does not exist on IBM Semeru Runtime 17 (verified). java.util.Base64 is part of Java 8 and 17, so the code runs on ACE 12.0.5 and 13.0.8 without an extra JAR. The basic encoder never inserts line breaks, unlike the old encoder (break after every 57 input bytes). A receiver that decodes with Java\'s basic decoder rejects old values that contain line breaks.',
      apply: function (text) { return rewriteBase64(text, 'java.util.Base64.getEncoder().encodeToString(', false); }
    },
    'drop-ibm-provider': {
      title: 'Remove explicit IBM security provider ("IBMJCE"/"IBMJCEPlus") from getInstance calls',
      why: 'The IBMJCE/IBMJCEPlus providers are absent on IBM Semeru Runtime 17 (verified), so getInstance(alg, "IBMJCE") throws NoSuchProviderException. Without the argument the default provider (SunJCE) is used. Verified: TripleDES/ECB/PKCS5Padding produced identical ciphertext on IBMJCE and SunJCE. Because the single-argument form cannot throw NoSuchProviderException, that exception is also removed from multi-catch clauses (Java rejects catching an exception that cannot be thrown).',
      apply: function (text) {
        var notes = [], t = text;
        var re = /\b(Cipher|Mac|KeyGenerator|SecretKeyFactory|KeyStore|MessageDigest|Signature|KeyPairGenerator|KeyFactory|SecureRandom|KeyAgreement|AlgorithmParameters)\s*\.\s*getInstance\s*\(\s*("(?:[^"\\]|\\.)*"|[\w.]+)\s*,\s*"(IBMJCE|IBMJCEPlus|IBMJCEFIPS)"\s*\)/g;
        t = t.replace(re, function (all, cls, alg, prov) { notes.push(cls + '.getInstance(' + alg + ', "' + prov + '") -> ' + cls + '.getInstance(' + alg + ')'); return cls + '.getInstance(' + alg + ')'; });
        if (!notes.length) return { ok: false, reason: 'No getInstance(<algorithm>, "IBMJCE") call in a supported form found. Other provider usages need manual changes.' };
        var code = ACE.java17.mask(t).code;
        var stillThrows = /getInstance\s*\([^()]*,\s*(?:"[^"]*"|[\w.]+)\s*\)/.test(code) || /\bSecurity\s*\.\s*getProvider\b/.test(code);
        if (!stillThrows) {
          var before = t;
          t = t.replace(/(catch\s*\(\s*(?:[\w.]+\s*\|\s*)*)NoSuchProviderException\s*\|\s*/g, '$1').replace(/(catch\s*\([^)]*?)\s*\|\s*NoSuchProviderException\b/g, '$1');
          if (t !== before) notes.push('removed NoSuchProviderException from multi-catch clause(s)');
          if (/catch\s*\(\s*(?:final\s+)?(?:java\.security\.)?NoSuchProviderException\s+\w+\s*\)/.test(ACE.java17.mask(t).code)) notes.push('WARNING: a catch (NoSuchProviderException e) clause remains and will not compile; edit it manually');
          if (!/\bNoSuchProviderException\b/.test(ACE.java17.mask(t).code.replace(/^\s*import[^;]*;/mg, ''))) {
            t = t.replace(/^[ \t]*import\s+java\.security\.NoSuchProviderException\s*;[ \t]*\r?\n/m, function () { notes.push('removed unused import java.security.NoSuchProviderException'); return ''; });
          }
        }
        return { ok: true, text: t, notes: notes };
      }
    }
  };

  /* Propose fixes for findings. sources: [{outPath, text, label}] (current ACE 13 text). */
  tx.propose = function (javaFindings, sources) {
    var proposals = [], seen = {};
    javaFindings.forEach(function (f) {
      if (!f.autofix || !tx.FIXES[f.autofix]) return;
      // the rule's fix plus its alternatives (same group), recommended one first
      var g = tx.FIXES[f.autofix].group;
      var ids = [f.autofix].concat(g ? Object.keys(tx.FIXES).filter(function (k) { return k !== f.autofix && tx.FIXES[k].group === g; }) : []);
      sources.forEach(function (s) {
        if (f.source === 'source' && f.file !== s.findingFile) return;
        if (f.source === 'bytecode' && !(s.className && f.className === s.className)) return;
        ids.forEach(function (fixId) {
          var key = fixId + '|' + s.outPath; if (seen[key]) return; seen[key] = 1;
          var fix = tx.FIXES[fixId], r = fix.apply(s.text);
          var p = { id: util.uid('fx'), fixId: fixId, group: fix.group || null, recommended: !!fix.recommended, when: fix.when || null, title: fix.title, why: fix.why, ruleId: f.ruleId, outPath: s.outPath, label: s.label, findingIds: [f.id], status: r.ok ? 'proposed' : 'not-applicable', reason: r.reason || null, notes: r.notes || [], before: s.text, after: r.ok ? r.text : null };
          if (r.ok) { p.diff = ACE.diff(s.text, r.text); p.stats = ACE.diff.stats(p.diff); }
          proposals.push(p);
        });
      });
    });
    return proposals;
  };

  /* Proposals that are alternatives to p (same group, same file). */
  tx.alternatives = function (ws, p) {
    return (ws.proposals || []).filter(function (x) { return x !== p && p.group && x.group === p.group && x.outPath === p.outPath; });
  };


  /* Apply a confirmed proposal to the ACE 13 overlay. */
  tx.apply = function (ws, proposal) {
    ws.ws13 = ws.ws13 || { overlay: {}, changelog: [] };
    var cur = ws.ws13.overlay[proposal.outPath];
    var currentText = cur ? cur.text : proposal.before;
    if (currentText !== proposal.before) throw new Error('The file changed since this fix was proposed; re-run the analysis to get a fresh proposal.');
    var entry = { t: util.nowIso(), kind: 'autofix', fixId: proposal.fixId, ruleId: proposal.ruleId, title: proposal.title, why: proposal.why, notes: proposal.notes, before: currentText, after: proposal.after, unified: ACE.diff.unified(currentText, proposal.after, 'a/' + proposal.outPath, 'b/' + proposal.outPath) };
    ws.ws13.overlay[proposal.outPath] = { text: proposal.after, origin: 'transformed', history: (cur ? cur.history : []).concat([entry]) };
    ws.ws13.changelog.push(Object.assign({ path: proposal.outPath, action: 'applied' }, entry));
    proposal.status = 'applied';
    tx.alternatives(ws, proposal).forEach(function (x) { if (x.status === 'proposed' || x.status === 'not-applicable') { x.status = 'superseded'; x.reason = 'Not needed: alternative "' + proposal.fixId + '" was accepted for this file.'; } });
    ACE.log.ok('Applied fix ' + proposal.fixId + ' to ' + proposal.outPath);
  };

  /* Undo the most recent change to a file in a working copy ('ws12' | 'ws13'). */
  tx.undo = function (ws, copy, outPath) {
    var wc = ws[copy]; if (!wc || !wc.overlay[outPath]) return false;
    var ov = wc.overlay[outPath], last = ov.history[ov.history.length - 1];
    if (ov.history.length <= 1) delete wc.overlay[outPath];
    else { ov.history = ov.history.slice(0, -1); ov.text = last.before; }
    wc.changelog.push({ t: util.nowIso(), path: outPath, action: 'undone', kind: last.kind, title: 'Undo: ' + last.title, fixId: last.fixId || null });
    // An undone fix (from any view) is no longer applied; it and the alternatives it superseded are
    // re-proposed from the restored text by the next analysis.
    if (copy === 'ws13' && last.kind === 'autofix') {
      var p = (ws.proposals || []).filter(function (x) { return x.status === 'applied' && x.fixId === last.fixId && x.outPath === outPath; })[0];
      if (p) { var drop = [p].concat(tx.alternatives(ws, p).filter(function (x) { return x.status === 'superseded'; })); ws.proposals = ws.proposals.filter(function (x) { return drop.indexOf(x) < 0; }); }
    }
    ACE.log.info('Undid "' + last.title + '" on ' + outPath + ' (' + copy + ')');
    return true;
  };

  /* Record a manual edit from the Source Explorer. */
  tx.recordEdit = function (ws, copy, outPath, originalText, newText) {
    ws[copy] = ws[copy] || { overlay: {}, changelog: [] };
    var wc = ws[copy], cur = wc.overlay[outPath], before = cur ? cur.text : originalText;
    if (before === newText) return false;
    var entry = { t: util.nowIso(), kind: 'user-edit', title: 'Manual edit in Source Explorer', before: before, after: newText, unified: ACE.diff.unified(before, newText, 'a/' + outPath, 'b/' + outPath) };
    wc.overlay[outPath] = { text: newText, origin: cur && cur.origin === 'transformed' ? 'transformed' : 'user-edited', history: (cur ? cur.history : []).concat([entry]) };
    wc.changelog.push(Object.assign({ path: outPath, action: 'edited' }, entry));
    return true;
  };
})(window.ACE);
