/* HER2 reader study viewer. Reads window.STUDY (study.js), keeps scores in localStorage and exports
   CSV. Opened from disk it needs no server or network. Hosted as a claude.ai artifact, it also saves
   each reader's scores to the artifact database (scores/<user id>, readable only by the owner), and
   the owner gets a coordinator panel to download everyone's scores. */
(function () {
  "use strict";
  var S = window.STUDY;
  var $ = function (id) { return document.getElementById(id); };
  var STORE = "her2rs/v1/";
  var FIELDS = ["score", "comment"];                  // score: 0 | 1+ | 2+ | 3+ | na (cannot be scored)
  var CSV_COLS = ["reader", "session", "order", "read_id", "status"].concat(FIELDS)
                 .concat(["rois_viewed", "n_rois", "seconds", "saved_at"]);

  if (!S) {
    document.body.innerHTML = "<p style='padding:24px'>study.js is missing. This folder is not a built " +
      "reader package.</p>";
    return;
  }
  if (S.preview || S.demo) $("preview-banner").classList.remove("hidden");
  if (S.demo) $("preview-banner").textContent = "DEMO: the real IHC is shown in both arms. For testing " +
    "the study workflow only; these scores are not part of the study.";

  // ---------- in-page dialogs (the artifact frame disables alert/confirm) ----------
  function ask(msg, okLabel, cancelLabel) {
    return new Promise(function (resolve) {
      $("dlg-msg").textContent = msg;
      $("dlg-ok").textContent = okLabel || "OK";
      $("dlg-cancel").textContent = cancelLabel || "Cancel";
      $("dlg-cancel").classList.toggle("hidden", cancelLabel === null);
      $("dlg").classList.remove("hidden");
      $("dlg-ok").focus();
      function done(v) {
        $("dlg").classList.add("hidden");
        $("dlg-ok").onclick = $("dlg-cancel").onclick = null;
        resolve(v);
      }
      $("dlg-ok").onclick = function () { done(true); };
      $("dlg-cancel").onclick = function () { done(false); };
    });
  }
  function notify(msg) { return ask(msg, "OK", null); }

  function lsGet(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); return true; } catch (e) { return false; } }

  // ---------- file download: platform prompt in the artifact, a plain link from disk ----------
  function saveFile(name, text) {
    var use = window.claude && window.claude.use ? window.claude.use("downloads") : Promise.resolve(null);
    return use.then(function (dl) {
      if (dl) return dl.save({ filename: name, data: text }).catch(function (e) {
        if (e && e.code !== "declined") notify("The download did not work (" + (e.message || e.code) + ").");
      });
      var a = document.createElement("a");
      a.href = URL.createObjectURL(new Blob([text], { type: "text/csv" }));
      a.download = name;
      document.body.appendChild(a); a.click(); a.remove();
      setTimeout(function () { URL.revokeObjectURL(a.href); }, 5000);
    });
  }

  // ---------- storage ----------
  function storeKey(reader, session) { return STORE + reader + "/" + session; }
  function load(reader, session) {
    try {
      var v = JSON.parse(lsGet(storeKey(reader, session)) || "null");
      if (v && v.reads) return v;
    } catch (e) { /* fall through */ }
    return { reads: {}, started: null, finished: null };
  }
  function persist(sync) {
    var ok = lsSet(storeKey(st.reader, st.session), JSON.stringify(st.data));
    if (!ok && !remote) $("save-state").textContent = "Could not save in this browser. Export the CSV now.";
    if (sync !== false) pushRemote(st.reader, st.session, st.data);
    return ok;
  }

  // ---------- study server: the artifact's db (null when opened from disk) ----------
  var remote = null, remoteExists = false, remoteBusy = false, remoteQueue = {};
  function remoteStatus(msg) { $("remote-state").textContent = msg; }
  function sessionKey(reader, session) { return reader + "_" + session; }

  function mergeRemote(doc) {
    var ss = (doc && doc.sessions) || {};
    Object.keys(ss).forEach(function (k) {
      var rs = k.split("_"), reader = rs[0], session = rs[1];
      if (!S.reads[reader] || !reads(reader, session)) return;
      var d = load(reader, session), r = ss[k] || {}, rr = r.reads || {};
      Object.keys(rr).forEach(function (id) {
        var a = d.reads[id], b = rr[id];
        if (!a || (b.saved_at || "") > (a.saved_at || "") || (a.status !== "saved" && b.status === "saved"))
          d.reads[id] = JSON.parse(JSON.stringify(b));
      });
      d.started = d.started || r.started || null;
      d.finished = d.finished || r.finished || null;
      lsSet(storeKey(reader, session), JSON.stringify(d));
    });
  }

  function pushRemote(reader, session, data) {
    if (!remote) return;
    remoteQueue[sessionKey(reader, session)] = JSON.parse(JSON.stringify(data));
    if (remoteBusy) return;
    remoteBusy = true;
    setTimeout(flushRemote, 800);                         // coalesce a burst of edits into one write
  }
  function flushRemote() {
    var batch = remoteQueue;
    remoteQueue = {};
    if (!Object.keys(batch).length || !remote) { remoteBusy = false; return; }
    var body = { updated: new Date().toISOString(), sessions: batch };
    var w = remoteExists ? remote.ref.update(body) : remote.ref.set(body);
    w.then(function () {
      remoteExists = true;
      remoteStatus("Saved to the study server " + new Date().toLocaleTimeString() + ".");
      flushRemote();
    }, function (e) {
      remoteBusy = false;
      if (e && e.code === "unavailable") {                 // transient: retry once later
        Object.keys(batch).forEach(function (k) { if (!remoteQueue[k]) remoteQueue[k] = batch[k]; });
        remoteBusy = true;
        setTimeout(flushRemote, 3000 + Math.random() * 2000);
        return;
      }
      remote = null;
      remoteStatus("Scores could not be saved to the study server, so they are kept in this browser only. " +
                   "Please export the CSV after each session.");
    });
  }

  if (window.claude && window.claude.use) {
    Promise.all([window.claude.use("db"), window.claude.use("user")]).then(function (r) {
      var db = r[0], user = r[1];
      if (!db || !user) return null;
      return user.id().then(function (uid) {
        if (!uid) return null;
        var ref = db.doc("scores/" + uid);
        return ref.get().then(function (snap) {
          remote = { db: db, user: user, uid: uid, ref: ref };
          remoteExists = snap.exists;
          if (snap.exists) mergeRemote(snap.data());
          remoteStatus("Your scores are saved to the study server as well as in this browser.");
          renderProgress();
          return user.isOwner().then(function (o) { if (o) showCoordinator(); });
        });
      });
    }).catch(function () { remote = null; });
  }

  // ---------- coordinator panel (artifact owner only) ----------
  var allDocs = [];
  function showCoordinator() {
    $("coord").classList.remove("hidden");
    $("btn-coord-refresh").onclick = refreshCoordinator;
    $("btn-coord-csv").onclick = function () {
      var lines = [["user_id"].concat(CSV_COLS).join(",")];
      allDocs.forEach(function (doc) {
        var ss = doc.data.sessions || {};
        Object.keys(ss).sort().forEach(function (k) {
          var rs = k.split("_");
          csvRows(rs[0], rs[1], ss[k]).forEach(function (row) { lines.push(csvCell(doc.id) + "," + row); });
        });
      });
      if (lines.length === 1) { notify("No scores on the study server yet."); return; }
      saveFile("her2_scores_all_" + new Date().toISOString().slice(0, 10) + ".csv", lines.join("\r\n") + "\r\n");
    };
    refreshCoordinator();
  }
  function refreshCoordinator() {
    remote.db.collection("scores").get().then(function (q) {
      allDocs = q.docs.filter(function (d) { return d.exists; }).map(function (d) { return { id: d.id, data: d.data() }; });
      var html = "<tr><th>Account</th><th>Reader / session</th><th>Scored</th><th>Finished</th><th>Last saved</th></tr>";
      allDocs.forEach(function (doc) {
        var ss = doc.data.sessions || {};
        Object.keys(ss).sort().forEach(function (k) {
          var rs = k.split("_"), list = reads(rs[0], rs[1]) || [], rr = (ss[k] || {}).reads || {};
          var n = list.filter(function (x) { return rr[x.id] && rr[x.id].status === "saved"; }).length;
          html += "<tr><td>\u2026" + doc.id.slice(-6) + "</td><td>" + rs[0] + " / S" + rs[1] + "</td><td>" + n +
            " / " + list.length + "</td><td>" + ((ss[k].finished || "").slice(0, 10)) + "</td><td>" +
            (doc.data.updated || "").replace("T", " ").slice(0, 16) + "</td></tr>";
        });
      });
      $("coord-table").innerHTML = allDocs.length ? html : "<tr><td>No reader has saved a score yet.</td></tr>";
    }, function (e) { $("coord-table").innerHTML = "<tr><td>Could not read the study server (" + e.code + ").</td></tr>"; });
  }

  // ---------- start screen ----------
  S.readers.forEach(function (r) {
    var o = document.createElement("option"); o.value = o.textContent = r; $("sel-reader").appendChild(o);
  });
  try {
    var last = JSON.parse(lsGet(STORE + "last") || "null");
    if (last) { $("sel-reader").value = last.reader; $("sel-session").value = String(last.session); }
  } catch (e) { /* ignore */ }

  function reads(reader, session) { return S.reads[reader][String(session)]; }

  function renderProgress() {
    var t = $("progress-table");
    var html = "<tr><th>Reader</th><th>Session</th><th>Scored</th><th>Finished</th></tr>";
    S.readers.forEach(function (r) {
      [1, 2].forEach(function (s) {
        var d = load(r, s), list = reads(r, s);
        var n = list.filter(function (x) { return d.reads[x.id] && d.reads[x.id].status === "saved"; }).length;
        if (!n && !d.started) return;
        html += "<tr><td>" + r + "</td><td>" + s + "</td><td>" + n + " / " + list.length + "</td><td>" +
          (d.finished ? d.finished.slice(0, 10) : "") + "</td></tr>";
      });
    });
    t.innerHTML = html;
    t.classList.toggle("hidden", t.rows.length < 2);
    checkWashout();
  }

  function checkWashout() {
    var r = $("sel-reader").value, s = Number($("sel-session").value), w = $("start-warning");
    var msg = "";
    if (s === 2 && S.washout_days > 0) {
      var d1 = load(r, 1);
      if (!d1.finished) {
        msg = "Session 1 has not been finished in this browser. Session 2 should start at least " +
          S.washout_days + " days after session 1 is finished.";
      } else {
        var days = (Date.now() - Date.parse(d1.finished)) / 864e5;
        if (days < S.washout_days)
          msg = "Session 1 was finished " + Math.floor(days) + " days ago. Please wait until " +
            new Date(Date.parse(d1.finished) + S.washout_days * 864e5).toISOString().slice(0, 10) +
            " (" + S.washout_days + "-day washout) before starting session 2.";
      }
    }
    w.textContent = msg;
    w.classList.toggle("hidden", !msg);
  }
  $("sel-reader").onchange = $("sel-session").onchange = checkWashout;

  $("btn-start").onclick = function () {
    var r = $("sel-reader").value, s = Number($("sel-session").value);
    var warn = !$("start-warning").classList.contains("hidden");
    (warn ? ask($("start-warning").textContent, "Start anyway") : Promise.resolve(true)).then(function (go) {
      if (!go) return;
      lsSet(STORE + "last", JSON.stringify({ reader: r, session: s }));
      openSession(r, s);
    });
  };
  $("btn-export-start").onclick = function () {
    exportCsv($("sel-reader").value, Number($("sel-session").value));
  };
  $("inp-import").onchange = function (ev) {
    var f = ev.target.files[0];
    if (!f) return;
    f.text().then(function (txt) {
      $("import-msg").textContent = importCsv(txt);
      renderProgress();
      ev.target.value = "";
    });
  };

  // ---------- CSV ----------
  function csvCell(v) {
    v = v == null ? "" : String(v);
    return /[",\n\r]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
  }
  function rowObj(reader, session, i, x, a) {
    var row = { reader: reader, session: session, order: i + 1, read_id: x.id, status: a.status,
                rois_viewed: (a.viewed || []).length, n_rois: S.images[x.ihc].length,
                seconds: Math.round(a.seconds || 0), saved_at: a.saved_at || "" };
    FIELDS.forEach(function (k) { row[k] = a[k]; });
    return row;
  }
  function csvRows(reader, session, d) {
    var out = [], list = reads(reader, session) || [], rr = (d && d.reads) || {};
    list.forEach(function (x, i) {
      var a = rr[x.id];
      if (!a) return;
      var row = rowObj(reader, session, i, x, a);
      out.push(CSV_COLS.map(function (k) { return csvCell(row[k]); }).join(","));
    });
    return out;
  }

  // ---------- Google Sheet (config.js: STUDY_CONFIG.sheet_url; for a static host such as GitHub Pages) ----------
  // Each saved case is POSTed as one row. The response is opaque (no-cors), so a row counts as sent once
  // the request leaves; rows that fail to leave stay in an outbox in this browser and are retried.
  var CFG = window.STUDY_CONFIG || {};
  var OUTBOX = STORE + "outbox";
  var clientId = lsGet(STORE + "client") || ("c" + Math.random().toString(36).slice(2, 10));
  lsSet(STORE + "client", clientId);
  function outbox() { try { return JSON.parse(lsGet(OUTBOX) || "[]"); } catch (e) { return []; } }
  function sendSheet(row) {
    if (!CFG.sheet_url) return;
    var box = outbox();
    box.push(Object.assign({ token: CFG.token || "", client: clientId }, row));
    lsSet(OUTBOX, JSON.stringify(box));
    flushSheet();
  }
  var sheetBusy = false;
  function flushSheet() {
    var box = outbox();
    if (!CFG.sheet_url || sheetBusy || !box.length) return;
    sheetBusy = true;
    fetch(CFG.sheet_url, { method: "POST", mode: "no-cors", headers: { "Content-Type": "text/plain;charset=utf-8" },
                           body: JSON.stringify(box[0]) })
      .then(function () {
        var rest = outbox().slice(1);
        lsSet(OUTBOX, JSON.stringify(rest));
        sheetBusy = false;
        $("remote-state").textContent = "Scores are sent to the study coordinator as you save them.";
        if (rest.length) flushSheet();
      }, function () {
        sheetBusy = false;
        $("remote-state").textContent = "Some scores could not be sent yet (offline?). They are kept in this " +
          "browser and will be sent when you save the next case.";
      });
  }
  if (CFG.sheet_url) {
    $("remote-state").textContent = "Scores are sent to the study coordinator as you save them.";
    flushSheet();
  }
  function exportCsv(reader, session) {
    var rows = csvRows(reader, session, load(reader, session));
    if (!rows.length) { notify("No scores yet for " + reader + " session " + session + "."); return; }
    saveFile("her2_scores_" + reader + "_S" + session + "_" + new Date().toISOString().slice(0, 10) + ".csv",
             [CSV_COLS.join(",")].concat(rows).join("\r\n") + "\r\n");
  }
  function parseCsv(txt) {
    var rows = [], row = [], cell = "", q = false;
    for (var i = 0; i < txt.length; i++) {
      var c = txt[i];
      if (q) {
        if (c === '"' && txt[i + 1] === '"') { cell += '"'; i++; }
        else if (c === '"') q = false;
        else cell += c;
      } else if (c === '"') q = true;
      else if (c === ",") { row.push(cell); cell = ""; }
      else if (c === "\n" || c === "\r") {
        if (c === "\r" && txt[i + 1] === "\n") i++;
        row.push(cell); rows.push(row); row = []; cell = "";
      } else cell += c;
    }
    if (cell || row.length) { row.push(cell); rows.push(row); }
    return rows.filter(function (r) { return r.length > 1; });
  }
  function importCsv(txt) {
    var rows = parseCsv(txt);
    if (!rows.length) return "Empty file.";
    var h = rows[0], n = 0, sessions = {};
    for (var i = 1; i < rows.length; i++) {
      var o = {};
      h.forEach(function (k, j) { o[k] = rows[i][j]; });
      if (!S.reads[o.reader] || !reads(o.reader, o.session)) continue;
      var x = reads(o.reader, o.session).filter(function (r) { return r.id === o.read_id; })[0];
      if (!x) continue;
      var key = o.reader + "/" + o.session;
      if (!sessions[key]) sessions[key] = load(o.reader, o.session);
      var a = { status: o.status || "saved", seconds: Number(o.seconds) || 0, saved_at: o.saved_at || null,
                viewed: [] };
      FIELDS.forEach(function (k) { a[k] = o[k] === "" ? null : o[k]; });
      for (var j = 0; j < Number(o.rois_viewed || 0); j++) a.viewed.push(j);
      sessions[key].reads[o.read_id] = a;
      sessions[key].started = sessions[key].started || a.saved_at;
      n++;
    }
    Object.keys(sessions).forEach(function (k) {
      var d = sessions[k], rs = k.split("/"), list = reads(rs[0], rs[1]);
      var saved = list.map(function (x) { return d.reads[x.id]; })
                      .filter(function (a) { return a && a.status === "saved"; });
      if (!d.finished && saved.length === list.length)   // a session finished on another computer
        d.finished = saved.map(function (a) { return a.saved_at || ""; }).sort().pop() || new Date().toISOString();
      lsSet(STORE + k, JSON.stringify(d));
      pushRemote(rs[0], rs[1], d);
    });
    return n ? "Imported " + n + " scores." : "No matching scores in this file (wrong study?).";
  }

  // ---------- reading ----------
  var st = null;               // {reader, session, data, list, idx, roi}
  var viewers = {}, syncing = false;

  function tileSource(token, roi) {
    var wh = S.images[token][roi];
    if (wh[2]) return { type: "image", url: wh[2], buildPyramid: true };   // a single image (demo)
    return { Image: { xmlns: "http://schemas.microsoft.com/deepzoom/2008",
                      Url: "img/" + token + "/roi" + roi + "_files/", Format: S.tile.format,
                      Overlap: String(S.tile.overlap), TileSize: String(S.tile.size),
                      Size: { Width: String(wh[0]), Height: String(wh[1]) } } };
  }

  function makeViewer(id) {
    var v = OpenSeadragon({
      element: $(id), prefixUrl: "lib/openseadragon/images/", showNavigator: true,
      navigatorPosition: "BOTTOM_RIGHT", navigatorSizeRatio: 0.18, showRotationControl: false,
      showFullPageControl: false, maxZoomPixelRatio: 2, minZoomImageRatio: 0.8, visibilityRatio: 0.3,
      animationTime: 0.5, zoomPerScroll: 1.4, crossOriginPolicy: false, preserveImageSizeOnResize: true,
      gestureSettingsMouse: { clickToZoom: false, dblClickToZoom: true },
      keyboardNavEnabled: false
    });
    v.addHandler("viewport-change", function () { onMove(v); });
    v.addHandler("animation-finish", showMag);
    v.addHandler("open", showMag);
    v.addHandler("open-failed", function () { notify("An image could not be loaded. Please tell the study coordinator."); });
    return v;
  }

  function onMove(src) {
    if (src === viewers.ihc) showMag();
    if (syncing || !$("chk-sync").checked) return;
    var dst = src === viewers.he ? viewers.ihc : viewers.he;
    if (!dst.world.getItemCount() || !src.world.getItemCount()) return;
    syncing = true;
    dst.viewport.zoomTo(src.viewport.getZoom(), null, true);
    dst.viewport.panTo(src.viewport.getCenter(), true);
    syncing = false;
  }

  function showMag() {
    var v = viewers.ihc;
    if (!v.world.getItemCount()) return;
    var z = v.viewport.viewportToImageZoom(v.viewport.getZoom(true));
    $("mag").textContent = "≈" + (20 * z).toFixed(z < 0.5 ? 1 : 0) + "×";
  }

  function openSession(reader, session) {
    st = { reader: reader, session: session, data: load(reader, session), list: reads(reader, session),
           idx: 0, roi: 0 };
    if (!st.data.started) { st.data.started = new Date().toISOString(); persist(); }
    // resume at the first unsaved read
    var first = st.list.findIndex(function (x) { var a = st.data.reads[x.id]; return !a || a.status !== "saved"; });
    st.idx = first < 0 ? 0 : first;
    var sel = $("sel-case");
    sel.innerHTML = "";
    st.list.forEach(function (x, i) {
      var o = document.createElement("option"); o.value = i; sel.appendChild(o);
    });
    $("start").classList.add("hidden");
    $("read").classList.remove("hidden");
    if (!viewers.he) { viewers.he = makeViewer("osd-he"); viewers.ihc = makeViewer("osd-ihc"); }
    showRead(st.idx);
  }

  function cur() { return st.list[st.idx]; }
  function ans() {
    var x = cur();
    if (!st.data.reads[x.id]) st.data.reads[x.id] = { status: "draft", seconds: 0, viewed: [] };
    return st.data.reads[x.id];
  }

  function refreshCaseList() {
    var opts = $("sel-case").options, n = 0;
    st.list.forEach(function (x, i) {
      var a = st.data.reads[x.id], done = a && a.status === "saved";
      if (done) n++;
      opts[i].textContent = "Case " + (i + 1) + (done ? "  ✓" : a ? "  (draft)" : "");
    });
    $("sel-case").value = st.idx;
    $("hdr-bar").style.width = (100 * n / st.list.length) + "%";
    $("hdr-title").textContent = st.reader + " · Session " + st.session + " · Case " + (st.idx + 1) +
      " of " + st.list.length + " · " + n + " scored";
    $("btn-prev").disabled = st.idx === 0;
    $("btn-next").disabled = st.idx === st.list.length - 1;
  }

  function showRead(i) {
    st.idx = i;
    var x = cur(), a = st.data.reads[x.id];
    fillForm(a || {});
    // ROI strip (IHC thumbnails)
    var strip = $("roi-strip");
    strip.innerHTML = "";
    S.images[x.ihc].forEach(function (wh, j) {
      var b = document.createElement("button");
      b.type = "button"; b.className = "roi-thumb"; b.title = "ROI " + (j + 1);
      b.innerHTML = "<img alt='' src='" + (wh[2] || "img/" + x.ihc + "/roi" + j + "_thumb.jpg") +
        "'><span class='n'>" + (j + 1) + "</span>";
      b.onclick = function () { showRoi(j); };
      strip.appendChild(b);
    });
    refreshCaseList();
    showRoi(0);
    $("form-msg").classList.add("hidden");
    $("save-state").textContent = a && a.status === "saved" ? "Saved " + (a.saved_at || "").replace("T", " ").slice(0, 16) : "";
  }

  function showRoi(j) {
    var x = cur(), n = S.images[x.ihc].length;
    st.roi = j;
    viewers.he.open(tileSource(x.he, j));
    viewers.ihc.open(tileSource(x.ihc, j));
    var a = ans();
    if (a.viewed.indexOf(j) < 0) { a.viewed.push(j); persist(); }
    var thumbs = $("roi-strip").children;
    for (var k = 0; k < thumbs.length; k++) {
      thumbs[k].classList.toggle("active", k === j);
      thumbs[k].classList.toggle("seen", a.viewed.indexOf(k) >= 0);
    }
    $("roi-label").textContent = "ROI " + (j + 1) + " / " + n;
  }

  // ---------- form ----------
  var form = $("form");
  function fillForm(a) {
    form.reset();
    FIELDS.forEach(function (k) {
      var v = a[k];
      if (v == null || v === "") return;
      var el = form.elements[k];
      if (el instanceof RadioNodeList) {
        Array.prototype.forEach.call(el, function (r) { r.checked = r.value === String(v); });
      } else el.value = v;
    });
  }

  function readForm() {
    var o = {};
    FIELDS.forEach(function (k) {
      var el = form.elements[k];
      o[k] = el.value === "" ? null : el.value;
    });
    return o;
  }


  form.addEventListener("change", function () {
    var a = ans(), o = readForm();
    FIELDS.forEach(function (k) { a[k] = o[k]; });
    if (a.status === "saved" && validate(o).length) a.status = "draft";   // an edit made it incomplete
    persist();
    refreshCaseList();
  });

  function validate(o) {
    return o.score ? [] : ["the HER2 score"];
  }

  form.addEventListener("submit", function (ev) {
    ev.preventDefault();
    var o = readForm(), miss = validate(o), msg = $("form-msg");
    if (miss.length) {
      msg.textContent = "Please choose " + miss.join(", ") + ".";
      msg.classList.remove("hidden");
      return;
    }
    msg.classList.add("hidden");
    var a = ans(), n = S.images[cur().ihc].length;
    var unseen = a.viewed.length < n ? "You have viewed " + a.viewed.length + " of " + n + " ROIs of this case." : "";
    (unseen ? ask(unseen, "Save anyway", "Go back") : Promise.resolve(true)).then(function (go) {
      if (go) commit(a, o);
    });
  });

  function commit(a, o) {
    FIELDS.forEach(function (k) { a[k] = o[k]; });
    a.status = "saved";
    a.saved_at = new Date().toISOString();
    persist();
    sendSheet(rowObj(st.reader, st.session, st.idx, cur(), a));
    var next = st.list.findIndex(function (x, i) {
      var b = st.data.reads[x.id]; return i > st.idx && (!b || b.status !== "saved");
    });
    if (next < 0) next = st.list.findIndex(function (x) {
      var b = st.data.reads[x.id]; return !b || b.status !== "saved";
    });
    if (next < 0) { finishSession(); return; }
    showRead(next);
  }

  function finishSession() {
    refreshCaseList();
    if (!st.data.finished) { st.data.finished = new Date().toISOString(); persist(); }
    var r = st.reader, s = st.session;
    notify("All " + st.list.length + " cases of session " + s + " are scored. " +
           (remote || CFG.sheet_url ? "They have been sent to the study coordinator. Please also keep the CSV " +
                                      "file that follows as a backup."
                   : "Please save the CSV file that follows and send it to the study coordinator.") +
           " You can still review and edit your scores.").then(function () { exportCsv(r, s); });
  }

  // ---------- navigation / timing ----------
  $("btn-prev").onclick = function () { if (st.idx > 0) showRead(st.idx - 1); };
  $("btn-next").onclick = function () { if (st.idx < st.list.length - 1) showRead(st.idx + 1); };
  $("sel-case").onchange = function () { showRead(Number(this.value)); };
  $("btn-export").onclick = function () { exportCsv(st.reader, st.session); };
  $("btn-exit").onclick = function () {
    persist();
    $("read").classList.add("hidden");
    $("start").classList.remove("hidden");
    st = null;
    renderProgress();
  };

  var lastTick = Date.now();
  setInterval(function () {
    var now = Date.now(), dt = (now - lastTick) / 1000;
    lastTick = now;
    if (!st || document.visibilityState !== "visible" || dt > 5) return;   // idle tab / sleep: not counted
    var a = ans();
    a.seconds = (a.seconds || 0) + dt;
    if (Math.round(a.seconds) % 15 === 0) persist(false);       // local only: never a timed remote write
  }, 1000);
  window.addEventListener("beforeunload", function () { if (st) persist(false); });

  renderProgress();
  // index.html?reader=R1&session=2 preselects; &go=1 also opens the session (for testing)
  var q = new URLSearchParams(location.search);
  if (q.get("reader") && S.reads[q.get("reader")]) $("sel-reader").value = q.get("reader");
  if (q.get("session")) $("sel-session").value = q.get("session");
  checkWashout();
  if (q.get("go") === "1") openSession($("sel-reader").value, Number($("sel-session").value));
})();
