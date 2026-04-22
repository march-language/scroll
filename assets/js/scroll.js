// ── Theme ──────────────────────────────────────────────────────────────────
function getTheme() {
  var t = localStorage.getItem('march-doc-theme');
  if (t) return t;
  return window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark';
}
function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.textContent = theme === 'light' ? '☀' : '☽';
}
applyTheme(getTheme());
document.addEventListener('DOMContentLoaded', function() {
  const btn = document.getElementById('theme-toggle');
  if (btn) btn.addEventListener('click', function() {
    const next = getTheme() === 'dark' ? 'light' : 'dark';
    localStorage.setItem('march-doc-theme', next);
    applyTheme(next);
  });
});

let NB_PATH = document.body.dataset.nbPath;
const WS_URL  = "ws://" + location.hostname + ":" + document.body.dataset.wsPort + "/ws";
let IS_TEMP = !!document.body.dataset.isTemp;

let cells = [];   // [{kind, source, output, error, running}]
let ws = null;

// When CM module finishes loading, attach editors to any already-rendered code cells
if (!window._cmReady) {
  window._onCMReady = function() {
    document.querySelectorAll(".cm-host[data-cell]").forEach(host => {
      const idx = parseInt(host.dataset.cell, 10);
      if (!isNaN(idx) && cells[idx]) {
        const wrap = host.closest(".cell-wrap");
        if (wrap) attachEditorEvents(wrap, idx);
      }
    });
  };
}
let pendingRun = null;
let runAllTotal = 0;   // total code cells when runAll was started
let runAllDone  = 0;   // cells completed so far in runAll
let inspectorVars = {};   // name -> value string
let inspectorOpen = false;
let _unsaved = false;
let _inspectorLastCellIdx = null; // 5.8: track which cell last updated the inspector

// 5.2: unsaved-changes indicator
function setUnsaved(val) {
  _unsaved = val;
  const base = document.title.replace(/^• /, "");
  document.title = val ? "• " + base : base;
}
window.onbeforeunload = function() {
  if (_unsaved) return "You have unsaved changes. Leave?";
};
const runPolls = {};  // code-cell polling intervals
const lastStillRunning = {};  // idx -> timestamp of last still_running/output msg
const HUNG_TIMEOUT_MS = 90000; // 90 seconds
const hungTimers = {};  // idx -> setInterval id for hung detection

// ── WebSocket ────────────────────────────────────────────────────────────────

function connect() {
  setStatus("connecting", "");
  ws = new WebSocket(WS_URL);
  ws.onopen = () => {
    setStatus("ok", "connected");
    ws.send(JSON.stringify({type:"load"}));
  };
  ws.onclose = () => {
    // Clear all running poll intervals so they don't fire against a dead socket.
    Object.keys(runPolls).forEach(idx => stopRunPoll(Number(idx)));
    Object.keys(hungTimers).forEach(idx => stopHungTimer(Number(idx)));
    // 5.12: reconnection countdown
    const RECONNECT_DELAY = 2000;
    let remaining = Math.ceil(RECONNECT_DELAY / 1000);
    setStatus("err", "disconnected — retrying in " + remaining + "s");
    const countdownId = setInterval(() => {
      remaining--;
      if (remaining > 0) setStatus("err", "disconnected — retrying in " + remaining + "s");
      else { clearInterval(countdownId); setStatus("err", "disconnected — reconnecting…"); }
    }, 1000);
    setTimeout(connect, RECONNECT_DELAY);
  };
  ws.onerror = () => {};
  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); }
    catch(err) { console.error("scroll: bad ws message", err, e.data); }
  };
}

function send(obj) { if (ws && ws.readyState===1) ws.send(JSON.stringify(obj)); }

// Re-size markdown textareas once custom fonts finish loading
if (document.fonts && document.fonts.ready) {
  document.fonts.ready.then(resizeAllTextareas);
}

// ── Message handling ─────────────────────────────────────────────────────────

function handleMsg(msg) {
  if (msg.type === "notebook") {
    cells = msg.cells.map(c => ({...c, output:"", blobs:[], error:null, running:false, _elapsed_ms:null, live_output:""}));
    window._nbCells = cells;
    render();
    setStatus("ok", "loaded");
  } else if (msg.type === "running") {
    const idx = msg.index;
    if (cells[idx]) { cells[idx].running = true; cells[idx]._start_ms = Date.now(); cells[idx].live_output = ""; updateCell(idx); }
    setStatus("running", "running…");
    startRunPoll(idx);
    startHungTimer(idx);
  } else if (msg.type === "still_running") {
    const idx = msg.index;
    if (cells[idx]) {
      if (msg.live !== undefined) cells[idx].live_output = msg.live;
      lastStillRunning[idx] = Date.now();
      // Clear any hung warning since we got activity
      const wrap = document.querySelector(`[data-idx="${idx}"]`);
      if (wrap) { const w = wrap.querySelector(".hung-warning"); if (w) w.remove(); }
      updateCell(idx);  // refreshes elapsed counter + live output
    }
  } else if (msg.type === "output") {
    const idx = msg.index;
    stopRunPoll(idx);
    stopHungTimer(idx);
    if (cells[idx]) {
      cells[idx].running = false;
      cells[idx].live_output = "";
      cells[idx].output  = msg.stdout || "";
      cells[idx].blobs   = msg.blobs  || [];
      cells[idx].error   = msg.error || null;
      cells[idx]._elapsed_ms = cells[idx]._start_ms ? Date.now() - cells[idx]._start_ms : null;
      if (!msg.error) cells[idx]._dirty = false;
      updateCell(idx);
    }
    if (msg.vars) updateInspector(msg.vars, idx);
    if (pendingRun !== null) {
      runAllDone++;
      // 5.6: on error during run-all, scroll error cell into view and set status
      if (msg.error) {
        const errWrap = document.querySelector(`[data-idx="${idx}"]`);
        if (errWrap) errWrap.scrollIntoView({behavior:"smooth", block:"nearest"});
        setStatus("err", "error in cell " + (idx + 1));
        pendingRun = null;
        runAllTotal = 0;
        runAllDone  = 0;
      } else {
        const next = nextCodeCell(pendingRun + 1);
        if (next !== -1) {
          pendingRun = next;
          runCell(next);
          setStatus("running", "running cell " + (runAllDone + 1) + " / " + runAllTotal);
        } else {
          pendingRun = null;
          runAllTotal = 0;
          runAllDone  = 0;
          setStatus("ok", "done");
        }
      }
    } else {
      setStatus("ok", "done");
    }
  } else if (msg.type === "saved") {
    setUnsaved(false); // 5.2
    setStatus("ok", "saved");
    // 5.3: briefly show "✓ Saved" on the Save button
    const saveBtn = document.getElementById("btn-save");
    if (saveBtn) {
      const orig = saveBtn.innerHTML;
      saveBtn.innerHTML = '<span class="btn-ic">✓</span><span class="btn-lb">✓ Saved</span>';
      setTimeout(() => { saveBtn.innerHTML = orig; }, 1500);
    }
    setTimeout(() => setStatus("ok", "connected"), 1500);
  } else if (msg.type === "saved_as") {
    setUnsaved(false); // 5.2
    const oldVars = loadEnvVars();
    NB_PATH = msg.path;
    IS_TEMP = false;
    if (oldVars.length > 0) saveEnvVars(oldVars);
    document.body.dataset.nbPath = msg.path;
    delete document.body.dataset.isTemp;
    document.getElementById("nb-title").textContent = msg.title || msg.path;
    document.title = "March Notebook — " + (msg.title || msg.path);
    closeSaveAs();
    setStatus("ok", "saved as " + msg.title);
    // 5.3: briefly show "✓ Saved" on the Save button
    const saveBtn2 = document.getElementById("btn-save");
    if (saveBtn2) {
      const orig2 = saveBtn2.innerHTML;
      saveBtn2.innerHTML = '<span class="btn-ic">✓</span><span class="btn-lb">✓ Saved</span>';
      setTimeout(() => { saveBtn2.innerHTML = orig2; }, 1500);
    }
    setTimeout(() => setStatus("ok", "connected"), 2000);
  } else if (msg.type === "log_content") {
    const body = document.getElementById("log-body");
    const pathEl = document.getElementById("log-path");
    if (body) { body.textContent = msg.content || "(empty)"; body.scrollTop = body.scrollHeight; }
    if (pathEl && msg.path) pathEl.textContent = msg.path;
  } else if (msg.type === "dep_added") {
    showToast("Package installed: " + msg.name, "ok");
  } else if (msg.type === "dep_error") {
    showToast("Package error: " + msg.name + " — " + msg.message, "err");
  } else if (msg.type === "error") {
    setStatus("err", msg.message);
    if (pendingRun !== null) { pendingRun = null; runAllTotal = 0; runAllDone = 0; }
    const saveAsModal = document.getElementById("saveas-modal");
    if (saveAsModal && saveAsModal.style.display !== "none") {
      const errEl = document.getElementById("saveas-error");
      errEl.textContent = msg.message;
      errEl.style.display = "block";
    }
  }
}

// ── Run process management ────────────────────────────────────────────────────

function startRunPoll(idx) {
  stopRunPoll(idx);
  let delay = 50;
  function tick() {
    if (!runPolls[idx]) return;
    send({type:"poll_run", index:idx});
    delay = Math.min(Math.ceil(delay * 1.5), 300);
    runPolls[idx] = setTimeout(tick, delay);
  }
  runPolls[idx] = setTimeout(tick, delay);
}

function stopRunPoll(idx) {
  if (runPolls[idx]) {
    clearTimeout(runPolls[idx]);
    delete runPolls[idx];
  }
}

function startHungTimer(idx) {
  stopHungTimer(idx);
  lastStillRunning[idx] = Date.now();
  hungTimers[idx] = setInterval(() => {
    if (!cells[idx] || !cells[idx].running) { stopHungTimer(idx); return; }
    if (Date.now() - (lastStillRunning[idx] || 0) > HUNG_TIMEOUT_MS) {
      const wrap = document.querySelector(`[data-idx="${idx}"]`);
      if (wrap) {
        let warn = wrap.querySelector(".hung-warning");
        if (!warn) {
          warn = document.createElement("div");
          warn.className = "hung-warning";
          warn.textContent = "⚠ No output for 90 s — process may have hung.";
          const liveOut = wrap.querySelector(".cell-live-out");
          if (liveOut) liveOut.appendChild(warn);
          else {
            const codeDiv = wrap.querySelector(".cell-code");
            if (codeDiv) codeDiv.appendChild(warn);
          }
        }
      }
    }
  }, 5000);
}

function stopHungTimer(idx) {
  if (hungTimers[idx]) {
    clearInterval(hungTimers[idx]);
    delete hungTimers[idx];
  }
  delete lastStillRunning[idx];
  // Clear any existing warning
  const wrap = document.querySelector(`[data-idx="${idx}"]`);
  if (wrap) {
    const warn = wrap.querySelector(".hung-warning");
    if (warn) warn.remove();
  }
}

function stopRun(idx) {
  stopRunPoll(idx);
  stopHungTimer(idx);
  send({type:"stop_run", index:idx});
}

// ── Cell operations ──────────────────────────────────────────────────────────

function nbSource() {
  return cells.map(c => {
    if (c.kind === "markdown") return c.source;
    if (c.kind === "section")  return "<!-- section: " + c.source + " -->";
    return "```march\n" + c.source + "\n```";
  }).join("\n\n");
}

function runCell(idx) {
  if (cells[idx] && cells[idx].kind === "code") {
    // 3.7: if a runAll is in progress, abort it and stop the running cell
    if (pendingRun !== null && pendingRun !== idx) {
      const inProgress = pendingRun;
      pendingRun = null;
      runAllTotal = 0;
      runAllDone  = 0;
      stopRun(inProgress);
    }
    send({type:"save", content: nbSource()});
    const env = getEnvString();
    send({type:"run", index:idx, env: env || undefined});
  }
}

function firstCodeCell() {
  for (let i=0;i<cells.length;i++) if(cells[i].kind==="code") return i;
  return -1;
}

function nextCodeCell(from) {
  for (let i=from;i<cells.length;i++) if(cells[i].kind==="code") return i;
  return -1;
}

function runAll() {
  const first = firstCodeCell();
  if (first === -1) return;
  // Stop any in-progress polls before resetting state — prevents stale
  // intervals from firing poll_run for wrong indices after render().
  Object.keys(runPolls).forEach(idx => stopRunPoll(Number(idx)));
  cells.forEach(c => { c.output=""; c.blobs=[]; c.error=null; c.running=false; c._dirty=false; c.live_output=""; });
  render();
  runAllTotal = cells.filter(c => c.kind === "code").length;
  runAllDone  = 0;
  pendingRun = first;
  runCell(first);
  setStatus("running", "running cell 1 / " + runAllTotal);
}

function clearCell(idx) {
  if (!cells[idx]) return;
  cells[idx].output = "";
  cells[idx].error = null;
  cells[idx]._elapsed_ms = null;
  updateCell(idx);
}

function clearAll() {
  cells.forEach((c, i) => { c.output=""; c.error=null; c._elapsed_ms=null; });
  render();
}

function toggleSrcCollapse(idx) {
  if (!cells[idx]) return;
  cells[idx]._src_collapsed = !cells[idx]._src_collapsed;
  updateCell(idx);
}

function toggleOutCollapse(idx) {
  if (!cells[idx]) return;
  cells[idx]._out_collapsed = !cells[idx]._out_collapsed;
  updateCell(idx);
}

function copyOutput(idx) {
  if (!cells[idx]) return;
  const text = cells[idx].output || cells[idx].error || "";
  navigator.clipboard.writeText(text).then(() => {
    const btn = document.querySelector(`[data-idx="${idx}"] .copy-btn`);
    if (btn) { btn.textContent = "Copied ✓"; setTimeout(() => { btn.textContent = "Copy"; }, 1500); }
  });
}

// ── Long-running static analysis ─────────────────────────────────────────────
// Canonical, unit-tested implementations live in assets/js/scroll-utils.js.
// This file uses classic <script> loading (no import) so functions are inlined.

const SLOW_PATTERNS = [
  /\bHttp\./,/\bHttpClient\./,/\bHttpTransport\./,
  /\bTask\.async\b/,/\bTask\.await\b/,/\btask_spawn\b/,
  /\bProcess\.run\b/,/\bProcess\.spawn\b/,
  /\bSocket\./,/\bChannelSocket\./,/\bTls\./,
  /\bSystem\.sleep\b/,
  /\bFile\.read\b/,/\bFile\.write\b/,
];

function isPotentiallyLongRunning(src) {
  if (SLOW_PATTERNS.some(p => p.test(src))) return true;
  const m = src.match(/\bfn\s+(\w+)\s*\(/);
  if (m && new RegExp('\\b' + m[1] + '\\s*\\(').test(src.slice(src.indexOf(m[0]) + m[0].length))) return true;
  return false;
}

// ── Blob rendering (Stage 2.1) ───────────────────────────────────────────────
// Renders a single {mime, data} blob object from an output message.
// Dispatch table:
//   image/*          → <img>
//   audio/*          → <audio controls>
//   video/*          → <video controls>
//   application/pdf  → <embed> + download link

function renderBlob(blob) {
  const mime = blob.mime || '';
  const src = `data:${esc(mime)};base64,${blob.data}`;
  if (mime.startsWith('image/')) {
    return `<div class="blob-wrap blob-image"><img src="${src}" alt="" style="max-width:100%;border-radius:4px;display:block"></div>`;
  }
  if (mime.startsWith('audio/')) {
    return `<div class="blob-wrap blob-audio"><audio controls src="${src}" style="width:100%;margin:4px 0"></audio></div>`;
  }
  if (mime.startsWith('video/')) {
    return `<div class="blob-wrap blob-video"><video controls src="${src}" style="max-width:100%;border-radius:4px;display:block"></video></div>`;
  }
  if (mime === 'application/pdf') {
    return `<div class="blob-wrap blob-pdf"><embed type="application/pdf" src="${src}" style="width:100%;height:480px;border-radius:4px"></embed><div style="margin-top:4px;font-size:12px"><a href="${src}" download="output.pdf">Download PDF</a></div></div>`;
  }
  // Unknown MIME — show a download link
  return `<div class="blob-wrap blob-unknown"><a href="${src}" download="output.bin">[${esc(mime)} blob — download]</a></div>`;
}

function renderBlobs(blobs) {
  if (!blobs || blobs.length === 0) return '';
  return blobs.map(renderBlob).join('');
}

// ── Fenced output parsing (Stage 1.3) ────────────────────────────────────────
// Canonical impl: assets/js/scroll-utils.js parseFencedOutput — keep in sync.

function parseFencedOutput(text) {
  const t = text.trimStart();
  const openMatch = t.match(/^(`{3,})([^\n`]*)\n/);
  if (!openMatch) return null;
  const fence = openMatch[1];
  const lang = openMatch[2].trim();
  const afterOpen = t.slice(openMatch[0].length);
  const closePattern = new RegExp('(?:^|\\n)' + fence.replace(/`/g, '\\`') + '(?:`*)(?:\\n|$)');
  const closeMatch = closePattern.exec(afterOpen);
  if (!closeMatch) return null;
  const body = afterOpen.slice(0, closeMatch.index);
  return { lang, body: body.replace(/\n$/, '') };
}

function saveNotebook() {
  if (IS_TEMP) { openSaveAs(); return; }
  send({type:"save", content: nbSource()});
}

function openSaveAs() {
  const modal = document.getElementById("saveas-modal");
  const inp = document.getElementById("saveas-path");
  const errEl = document.getElementById("saveas-error");
  errEl.style.display = "none";
  if (!inp.value) {
    const name = cells.length > 0 && cells[0].kind === "markdown"
      ? cells[0].source.replace(/^#\s+/, "").trim().replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 40) || "notebook"
      : "notebook";
    inp.value = name + ".scrollmd";
  }
  // 5.14: show subtitle when notebook is temporary
  const subtitleId = "saveas-temp-subtitle";
  let subtitle = document.getElementById(subtitleId);
  if (IS_TEMP) {
    if (!subtitle) {
      subtitle = document.createElement("p");
      subtitle.id = subtitleId;
      subtitle.style.cssText = "font-size:12px;color:var(--dim);margin-bottom:10px;font-style:italic";
      subtitle.textContent = "This notebook is temporary. Choose a path to save it permanently.";
      const h3 = document.querySelector("#saveas-inner h3");
      if (h3) h3.insertAdjacentElement("afterend", subtitle);
    }
  } else if (subtitle) {
    subtitle.remove();
  }
  modal.style.display = "flex";
  inp.focus();
  inp.select();
  trapFocus(modal);
}

function closeSaveAs() {
  const modal = document.getElementById("saveas-modal");
  releaseFocus(modal);
  modal.style.display = "none";
}

function confirmSaveAs() {
  const inp = document.getElementById("saveas-path");
  const errEl = document.getElementById("saveas-error");
  let path = inp.value.trim();
  if (!path) { errEl.textContent = "Path cannot be empty"; errEl.style.display = "block"; return; }
  const basename = path.split("/").pop();
  if (!basename.includes(".")) path += ".scrollmd";
  send({type:"save_as", path: path, content: nbSource()});
  setStatus("running", "saving…");
}

// ── Environment variables ────────────────────────────────────────────────────

function envStorageKey() { return "scroll-env:" + NB_PATH; }

function loadEnvVars() {
  try { return JSON.parse(localStorage.getItem(envStorageKey())) || []; }
  catch(e) { return []; }
}

function saveEnvVars(vars) {
  localStorage.setItem(envStorageKey(), JSON.stringify(vars));
}

function getEnvString() {
  return loadEnvVars().filter(v => v.key && v.enabled !== false)
    .map(v => {
      const k = v.key.replace(/[\r\n]/g, "");
      const val = (v.value || "").replace(/[\r\n]/g, "");
      return k + "=" + val;
    }).join("\n");
}

function openEnvPanel() {
  const modal = document.getElementById("env-modal");
  modal.style.display = "flex";
  renderEnvRows();
  trapFocus(modal);
}

function closeEnvPanel() {
  const modal = document.getElementById("env-modal");
  releaseFocus(modal);
  collectEnvFromDOM();
  modal.style.display = "none";
}

function renderEnvRows() {
  const body = document.getElementById("env-body");
  const vars = loadEnvVars();
  if (vars.length === 0) {
    body.innerHTML = '<p class="env-empty">No environment variables set.</p>';
    return;
  }
  body.innerHTML = vars.map((v, i) =>
    `<div class="env-row" data-env-idx="${i}">
      <input type="checkbox" class="env-toggle" ${v.enabled !== false ? "checked" : ""} title="Enable/disable" />
      <input type="text" class="env-key" value="${esc(v.key)}" placeholder="KEY" spellcheck="false" />
      <span class="env-eq">=</span>
      <input type="text" class="env-val" value="${esc(v.value)}" placeholder="value" spellcheck="false" />
      <button class="add-btn env-del" title="Remove">✕</button>
    </div>`
  ).join("");
  body.querySelectorAll(".env-del").forEach((btn, i) => {
    btn.onclick = () => { const vs = loadEnvVars(); vs.splice(i, 1); saveEnvVars(vs); renderEnvRows(); };
  });
}

function collectEnvFromDOM() {
  const rows = document.querySelectorAll(".env-row");
  const vars = [];
  rows.forEach(row => {
    const key = row.querySelector(".env-key").value.trim();
    const value = row.querySelector(".env-val").value;
    const enabled = row.querySelector(".env-toggle").checked;
    if (key) vars.push({key, value, enabled});
  });
  saveEnvVars(vars);
}

function addEnvVar() {
  collectEnvFromDOM();
  const vars = loadEnvVars();
  vars.push({key: "", value: "", enabled: true});
  saveEnvVars(vars);
  renderEnvRows();
  const last = document.querySelector(".env-row:last-child .env-key");
  if (last) last.focus();
}

// ── Debug log panel ──────────────────────────────────────────────────────────

let logPollId = null;

function openLogPanel() {
  if (logPollId) clearInterval(logPollId);
  const panel = document.getElementById("log-panel");
  panel.style.display = "flex";
  send({type:"read_log"});
  logPollId = setInterval(() => send({type:"read_log"}), 3000);
  trapFocus(panel);
}

function closeLogPanel() {
  const panel = document.getElementById("log-panel");
  releaseFocus(panel);
  panel.style.display = "none";
  if (logPollId) { clearInterval(logPollId); logPollId = null; }
}

function addCell(kind, afterIdx) {
  const newCell = {kind, source:"", output:"", error:null, running:false};
  cells.splice(afterIdx+1, 0, newCell);
  setUnsaved(true); // 5.2
  render();
  const newIdx = afterIdx + 1;
  if (kind === "code" && window.focusCM) {
    setTimeout(() => window.focusCM(newIdx), 30);
  } else {
    const ta = document.querySelector(`[data-idx="${newIdx}"] textarea`);
    if (ta) ta.focus();
  }
}

function deleteCell(idx) {
  if (cells.length <= 1) return;
  if (cells[idx] && cells[idx].running && cells[idx].kind === "code") stopRun(idx);
  cells.splice(idx, 1);
  setUnsaved(true); // 5.2

  // Fix up stale indices held in module-level state after the splice.
  // pendingRun
  if (pendingRun !== null) {
    if (pendingRun === idx) pendingRun = null;
    else if (pendingRun > idx) pendingRun--;
  }
  // runPolls: stop old timers; restart with shifted keys for indices > idx
  const toRestart = [];
  Object.keys(runPolls).forEach(k => {
    const i = Number(k);
    if (i !== idx) toRestart.push(i > idx ? i - 1 : i);
  });
  Object.keys(runPolls).forEach(k => stopRunPoll(Number(k)));
  toRestart.forEach(newIdx => startRunPoll(newIdx));
  // cmdSelected
  if (cmdSelected !== null) {
    if (cmdSelected > idx) cmdSelected--;
    else if (cmdSelected === idx) cmdSelected = Math.min(idx, cells.length - 1);
  }

  render();
}

function moveCell(idx, dir) {
  const to = idx + dir;
  if (to < 0 || to >= cells.length) return;
  [cells[idx], cells[to]] = [cells[to], cells[idx]];
  setUnsaved(true); // 5.2
  render();
  saveNotebook();
}

// ── Drag to reorder ───────────────────────────────────────────────────────────

let _draggingIdx = -1;

function attachDragEvents(wrap, idx) {
  // Only enable draggable when the user presses the grab handle.
  // This lets clicks on textareas, buttons, etc. work normally.
  const handle = wrap.querySelector(".drag-handle");
  if (handle) {
    handle.addEventListener("mousedown", () => { wrap.draggable = true; });
    handle.addEventListener("mouseup",   () => { wrap.draggable = false; });
  }
  wrap.addEventListener("dragstart", (e) => {
    _draggingIdx = idx;
    e.dataTransfer.effectAllowed = "move";
    setTimeout(() => wrap.style.opacity = "0.5", 0);
  });
  wrap.addEventListener("dragend", () => {
    wrap.draggable = false;
    wrap.style.opacity = "";
    document.querySelectorAll(".drag-over-top,.drag-over-bottom").forEach(el => {
      el.classList.remove("drag-over-top","drag-over-bottom");
    });
    _draggingIdx = -1;
  });
  wrap.addEventListener("dragover", (e) => {
    if (_draggingIdx === -1 || _draggingIdx === idx) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    const rect = wrap.getBoundingClientRect();
    const half = rect.top + rect.height / 2;
    wrap.classList.remove("drag-over-top","drag-over-bottom");
    wrap.classList.add(e.clientY < half ? "drag-over-top" : "drag-over-bottom");
  });
  wrap.addEventListener("dragleave", () => {
    wrap.classList.remove("drag-over-top","drag-over-bottom");
  });
  wrap.addEventListener("drop", (e) => {
    e.preventDefault();
    wrap.classList.remove("drag-over-top","drag-over-bottom");
    const from = _draggingIdx;
    if (from === -1 || from === idx) return;
    const rect = wrap.getBoundingClientRect();
    const insertAfter = e.clientY >= rect.top + rect.height / 2;
    const [moved] = cells.splice(from, 1);
    // After removal, recalculate target index
    let target = from < idx ? idx - 1 : idx;
    if (insertAfter) target++;
    cells.splice(target, 0, moved);
    render();
    saveNotebook();
  });
}

// ── Markdown renderer (minimal) ──────────────────────────────────────────────

function renderMd(src) {
  let html = "";
  const lines = src.split("\n");
  let inUl = false, inP = false;
  for (const line of lines) {
    const t = line.trim();
    if (!t) {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (inP)  { html += "</p>";  inP  = false; }
      continue;
    }
    if (t === "---" || t === "***") {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (inP)  { html += "</p>";  inP  = false; }
      html += "<hr>"; continue;
    }
    const hm = t.match(/^(#{1,3})\s+(.+)/);
    if (hm) {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (inP)  { html += "</p>";  inP  = false; }
      const lvl = hm[1].length;
      html += `<h${lvl}>${inline(hm[2])}</h${lvl}>`;
      continue;
    }
    if (t.startsWith("- ") || t.startsWith("* ")) {
      if (inP)  { html += "</p>";  inP  = false; }
      if (!inUl){ html += "<ul>";  inUl = true;  }
      html += `<li>${inline(t.slice(2))}</li>`;
      continue;
    }
    if (inUl) { html += "</ul>"; inUl = false; }
    if (!inP) { html += "<p>"; inP = true; } else { html += " "; }
    html += inline(t);
  }
  if (inUl) html += "</ul>";
  if (inP)  html += "</p>";
  return html;
}

function inline(s) {
  s = s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

// ── Render ───────────────────────────────────────────────────────────────────

function esc(s) {
  return String(s).replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

function render() {
  const nb = document.getElementById("notebook");
  nb.innerHTML = "";
  cells.forEach((cell, idx) => {
    const wrap = document.createElement("div");
    wrap.className = "cell-wrap cell";
    wrap.dataset.idx = idx;

    if (cell.kind === "markdown") {
      wrap.innerHTML = markdownCell(idx, cell);
      attachMarkdownEvents(wrap, idx);
    } else if (cell.kind === "section") {
      wrap.innerHTML = sectionCell(idx, cell);
    } else {
      wrap.innerHTML = codeCell(idx, cell);
      attachEditorEvents(wrap, idx);
    }

    // Drag handle
    const handle = document.createElement("span");
    handle.className = "drag-handle";
    handle.textContent = "⠿";
    handle.title = "Drag to reorder";
    wrap.appendChild(handle);
    attachDragEvents(wrap, idx);

    // Click on cell wrapper (not button/textarea/editor) → command mode.
    // Clicks on the CodeMirror editor are excluded: the editor handles its
    // own focus.  If we were in command mode, exit it so keystrokes go to CM.
    wrap.addEventListener("click", (e) => {
      if (e.target.closest(".cm-editor")) {
        if (cmdActive) cmdExit();
      } else if (!e.target.closest("button,textarea,a,input")) {
        cmdSelect(idx, false);
      }
    });

    // between-cell add bar
    const bar = document.createElement("div");
    bar.className = "add-cell-bar";
    bar.innerHTML = `<button onclick="addCell('markdown',${idx})">+ md</button><button onclick="addCell('code',${idx})">+ code</button><button onclick="addSection(${idx})">+ §</button>`;
    wrap.appendChild(bar);

    nb.appendChild(wrap);
  });

  // end add bar
  const endBar = document.createElement("div");
  endBar.style.cssText = "display:flex;justify-content:center;gap:8px;padding:12px 0";
  endBar.innerHTML = `<button class="add-btn" onclick="addCell('markdown',${cells.length-1})">+ Markdown</button><button class="add-btn" onclick="addCell('code',${cells.length-1})">+ Code</button><button class="add-btn" onclick="addSection(${cells.length-1})">+ Section</button>`;
  nb.appendChild(endBar);
  // Restore command mode selection highlight if still valid
  if (cmdActive && cmdSelected >= 0 && cmdSelected < cells.length) {
    const selWrap = document.querySelector(`[data-idx="${cmdSelected}"]`);
    if (selWrap) { selWrap.classList.add("cmd-selected"); selWrap.setAttribute("tabindex", "-1"); }
  }
  // Defer a resize pass for markdown textareas (code cells use CM)
  requestAnimationFrame(resizeAllTextareas);
}

function sectionCell(idx, cell) {
  const collapsed = !!cell._collapsed;
  return `<div class="cell-section" data-collapsed="${collapsed}">
    <div class="section-bar">
      <span class="section-rule"></span>
      <input class="section-title" value="${esc(cell.source||'Section')}" onchange="cells[${idx}].source=this.value;saveNotebook()" onblur="cells[${idx}].source=this.value;saveNotebook()" title="Click to rename section" />
      <span class="section-rule"></span>
      <button class="add-btn" onclick="toggleSection(${idx})" title="${collapsed?'Expand':'Collapse'}">${collapsed?'▶':'▼'}</button>
      <button class="add-btn" onclick="moveCell(${idx},-1)" title="Move up">↑</button>
      <button class="add-btn" onclick="moveCell(${idx},1)" title="Move down">↓</button>
      <button class="add-btn" onclick="deleteCell(${idx})" title="Delete">✕</button>
    </div>
  </div>`;
}

function toggleSection(idx) {
  if (!cells[idx]) return;
  cells[idx]._collapsed = !cells[idx]._collapsed;
  // hide/show all cells until next section or end
  const collapsed = cells[idx]._collapsed;
  for (let i = idx + 1; i < cells.length; i++) {
    if (cells[i].kind === "section") break;
    const w = document.querySelector(`[data-idx="${i}"]`);
    if (w) w.style.display = collapsed ? "none" : "";
  }
  updateCell(idx);
}

function addSection(afterIdx) {
  const title = prompt("Section title:", "");
  if (title === null) return;
  const newCell = {kind:"section", source:title||"Section", output:"", error:null, running:false};
  cells.splice(afterIdx+1, 0, newCell);
  render();
  saveNotebook();
}

function markdownCell(idx, cell) {
  const editing = !!cell._editing;
  const editorHtml = editing
    ? `<div class="cell-md-editor"><textarea data-cell="${idx}" spellcheck="false">${esc(cell.source)}</textarea></div>`
    : "";
  return `<div class="cell-md-wrap${editing ? ' editing' : ''}">
    <div class="cell-md-header">
      <span class="cell-md-label">markdown</span>
      <div class="cell-md-actions">
        <button class="add-btn" onclick="moveCell(${idx},-1)" title="Move up" aria-label="Move up">↑</button>
        <button class="add-btn" onclick="moveCell(${idx},1)" title="Move down" aria-label="Move down">↓</button>
        <button class="add-btn" onclick="event.stopPropagation();toggleMdEdit(${idx})" title="${editing?'Done':'Edit'}" aria-label="${editing?'Done editing':'Edit'}">${editing?'✓':'✎'}</button>
        <button class="add-btn" onclick="deleteCell(${idx})" title="Delete" aria-label="Delete">✕</button>
      </div>
    </div>
    <div class="cell-md" onclick="if(!event.target.closest('button'))toggleMdEdit(${idx})">${renderMd(cell.source)||'<span style="color:#4b5563;font-style:italic">Click to edit…</span>'}</div>
    ${editorHtml}
  </div>`;
}

function toggleMdEdit(idx) {
  if (!cells[idx]) return;
  cells[idx]._editing = !cells[idx]._editing;
  updateCell(idx);
  if (cells[idx]._editing) {
    const wrap = document.querySelector(`[data-idx="${idx}"]`);
    const ta = wrap && wrap.querySelector("textarea");
    if (ta) { ta.focus(); autoResize(ta); }
  }
}

function attachMarkdownEvents(wrap, idx) {
  const ta = wrap.querySelector(".cell-md-editor textarea");
  if (!ta) return;
  ta.addEventListener("input", () => {
    cells[idx].source = ta.value;
    setUnsaved(true); // 5.2
    // live-update the preview while editing
    const preview = wrap.querySelector(".cell-md");
    if (preview) preview.innerHTML = renderMd(ta.value) || '<span style="color:#4b5563;font-style:italic">Click to edit…</span>';
    autoResize(ta);
  });
  installEscapeHandler(ta, idx);
  ta.addEventListener("keydown", (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      cells[idx].source = ta.value;
      cells[idx]._editing = false;
      updateCell(idx);
      cmdSelect(idx, false);
    }
  });
  autoResize(ta);
}

let _vegaLoaded = false;
function ensureVega(cb, containerEl) {
  // 5.9: helper to mark container as failed
  function vegaLoadError() {
    if (containerEl) containerEl.textContent = "[Vega-Lite chart — failed to load renderer from CDN]";
  }
  if (_vegaLoaded) { cb(); return; }
  const s1 = document.createElement('script');
  s1.src = 'https://cdn.jsdelivr.net/npm/vega@5/build/vega.min.js';
  s1.onerror = vegaLoadError; // 5.9
  s1.onload = () => {
    const s2 = document.createElement('script');
    s2.src = 'https://cdn.jsdelivr.net/npm/vega-lite@5/build/vega-lite.min.js';
    s2.onerror = vegaLoadError; // 5.9
    s2.onload = () => {
      const s3 = document.createElement('script');
      s3.src = 'https://cdn.jsdelivr.net/npm/vega-embed@6/build/vega-embed.min.js';
      s3.onerror = vegaLoadError; // 5.9
      s3.onload = () => { _vegaLoaded = true; cb(); };
      document.head.appendChild(s3);
    };
    document.head.appendChild(s2);
  };
  document.head.appendChild(s1);
}

function renderOutput(text) {
  const t = text.trimStart();
  // Vega-Lite spec: JSON object with $schema pointing to vega.github.io
  if (t.startsWith('{') && t.includes('"$schema"') && t.includes('vega.github.io/schema/vega-lite')) {
    const id = 'vg-' + Math.random().toString(36).slice(2);
    // Render placeholder immediately, embed after scripts load
    setTimeout(() => {
      const vegaContainer = document.getElementById(id);
      ensureVega(() => {
        const el = document.getElementById(id);
        if (!el) return;
        try {
          const spec = JSON.parse(t);
          vegaEmbed(el, spec, {theme: 'dark', actions: {export: true, source: false, compiled: false, editor: false}})
            .catch(e => { el.textContent = 'Vega error: ' + e.message; });
        } catch(e) { el.textContent = 'JSON parse error: ' + e.message; }
      }, vegaContainer);
    }, 0);
    return `<div class="cell-out-html"><div id="${id}" class="vg-embed"></div></div>`;
  }
  if (t.startsWith('<svg') || t.startsWith('<table') || t.startsWith('<!DOCTYPE') || t.startsWith('<html')) {
    const clean = typeof DOMPurify !== 'undefined'
      ? DOMPurify.sanitize(text, {FORCE_BODY: true, ADD_TAGS: ['svg'], ADD_ATTR: ['viewBox','xmlns','stroke','fill','stroke-width','stroke-linecap','stroke-linejoin','d','cx','cy','r','x','y','width','height','transform','class','id','style']})
      : text;
    return `<div class="cell-out-html">${clean}</div>`;
  }
  // Stage 1.3: CommonMark fenced code block — syntax-highlighted output.
  // ScrollCode.fenced("json", value) produces this format on the server side.
  const fenced = parseFencedOutput(text);
  if (fenced !== null) {
    const { lang, body } = fenced;
    const langAttr = lang ? ` data-lang="${esc(lang)}"` : '';
    const langLabel = lang ? `<span class="fenced-lang">${esc(lang)}</span>` : '';
    return `<div class="cell-out-fenced"${langAttr}>${langLabel}<pre><code>${esc(body)}</code></pre></div>`;
  }
  return `<div class="cell-out">${esc(text)}</div>`;
}

function codeCell(idx, cell) {
  const cls = cell.running ? " running" : cell.error ? " has-error" : "";
  const liveMs = cell.running && cell._start_ms ? Date.now() - cell._start_ms : null;
  const fmtMs = (ms) => ms < 1000 ? ms+"ms" : (ms/1000).toFixed(1)+"s";
  const timing = cell.running && liveMs != null
    ? ` · ${fmtMs(liveMs)}`
    : (cell._elapsed_ms != null ? ` · ${fmtMs(cell._elapsed_ms)}` : "");
  const lbl = cell.running ? `running…${timing}` : `In [${idx+1}]${timing}`;
  const lblCls = cell.running ? " running" : "";
  const staleBadge = cell._dirty ? `<span class="stale-badge" title="Source changed since last run — re-run this cell to refresh output">↻ stale</span>` : "";
  const slowBadge = (!cell.running && isPotentiallyLongRunning(cell.source)) ? `<span class="slow-badge" title="May take a while — use ⬛ to stop">⏱</span>` : "";
  const srcCollapsed = !!cell._src_collapsed;
  const outCollapsed = !!cell._out_collapsed;
  const srcToggle = `<button class="add-btn" onclick="toggleSrcCollapse(${idx})" title="${srcCollapsed?'Expand source':'Collapse source'}" aria-label="${srcCollapsed?'Expand source':'Collapse source'}">${srcCollapsed?'⌄':'⌃'}</button>`;
  const outToggle = `<button class="add-btn" onclick="toggleOutCollapse(${idx})" title="${outCollapsed?'Expand output':'Collapse output'}" aria-label="${outCollapsed?'Expand output':'Collapse output'}">${outCollapsed?'▸':'▾'}</button>`;
  const srcPreview = srcCollapsed ? `<div class="src-preview" onclick="toggleSrcCollapse(${idx})">${esc(cell.source.split('\\n')[0])}</div>` : "";
  const blobsHtml = renderBlobs(cell.blobs);
  const hasOut = !!(cell.output || cell.error || blobsHtml);
  const copyBtn = hasOut ? `<button class="copy-btn" onclick="copyOutput(${idx})">Copy</button>` : "";
  const outHtml = cell.error
    ? `<div class="cell-out-wrap">${copyBtn}<div class="cell-err">${esc(cell.error)}</div>${blobsHtml}</div>`
    : (cell.output || blobsHtml)
      ? `<div class="cell-out-wrap">${copyBtn}${cell.output ? renderOutput(cell.output) : ""}${blobsHtml}</div>`
      : "";
  const liveHtml = cell.running && cell.live_output
    ? `<div class="cell-live-out"><pre>${esc(cell.live_output)}</pre></div>`
    : "";
  const dirtyAttr = cell._dirty ? ' data-dirty="1"' : "";
  const srcCls = srcCollapsed ? " src-collapsed" : "";
  const outCls = outCollapsed ? " out-collapsed" : "";
  const actionBtn = cell.running
    ? `<button class="stop-btn" onclick="stopRun(${idx})" aria-label="Stop">⬛ Stop</button>`
    : `<button class="run-btn" onclick="runCell(${idx})" aria-label="Run">▶ Run</button>`;
  return `<div class="cell-code${cls}${srcCls}${outCls}"${dirtyAttr}>
    <div class="cell-header">
      <span class="cell-label${lblCls}">${lbl}</span>${staleBadge}${slowBadge}
      <div class="add-btns">
        ${srcToggle}${outToggle}
        <button class="add-btn" onclick="moveCell(${idx},-1)" title="Move up" aria-label="Move up">↑</button>
        <button class="add-btn" onclick="moveCell(${idx},1)" title="Move down" aria-label="Move down">↓</button>
        <button class="add-btn" onclick="clearCell(${idx})" title="Clear output" aria-label="Clear output">○</button>
        <button class="add-btn" onclick="deleteCell(${idx})" title="Delete" aria-label="Delete">✕</button>
      </div>
      ${actionBtn}
    </div>
    <div class="cm-host" data-cell="${idx}"></div>
    ${srcPreview}
    ${liveHtml}
    ${outHtml}
  </div>`;
}

function updateCell(idx) {
  const wrap = document.querySelector(`[data-idx="${idx}"]`);
  if (!wrap) return;
  const cell = cells[idx];
  // Capture current CM editor value before overwriting innerHTML
  const cmVal = window.getCMValue && window.getCMValue(idx);
  if (cmVal != null) cell.source = cmVal;
  if (window.destroyCM) window.destroyCM(idx);
  if (cell.kind === "markdown") {
    wrap.innerHTML = markdownCell(idx, cell);
    attachMarkdownEvents(wrap, idx);
  } else if (cell.kind === "code") {
    wrap.innerHTML = codeCell(idx, cell);
    attachEditorEvents(wrap, idx);
    // 3.4: auto-scroll live output unless user has scrolled up
    if (cell.running && cell.live_output) {
      const liveEl = wrap.querySelector(".cell-live-out pre");
      if (liveEl) {
        const atBottom = liveEl.scrollTop >= liveEl.scrollHeight - liveEl.clientHeight - 32;
        if (atBottom || liveEl.scrollHeight <= liveEl.clientHeight) {
          liveEl.scrollTop = liveEl.scrollHeight;
        }
      }
    }
  } else if (cell.kind === "section") {
    wrap.innerHTML = sectionCell(idx, cell);
  }
  // re-attach the add bar
  const bar = document.createElement("div");
  bar.className = "add-cell-bar";
  bar.innerHTML = `<button onclick="addCell('markdown',${idx})">+ md</button><button onclick="addCell('code',${idx})">+ code</button><button onclick="addSection(${idx})">+ §</button>`;
  wrap.appendChild(bar);
  // Re-apply command mode selection if this cell was selected
  if (cmdActive && cmdSelected === idx) {
    wrap.classList.add("cmd-selected");
    wrap.setAttribute("tabindex", "-1");
  }
  // Click on wrapper → command mode
  wrap.addEventListener("click", (e) => {
    if (!e.target.closest("button,textarea,a,input,.cm-editor")) cmdSelect(idx, false);
  });
}

function attachEditorEvents(wrap, idx) {
  const host = wrap.querySelector(".cm-host");
  if (!host || !window._cmReady) return;
  const source = cells[idx].source || "";
  window.createCMEditor(host, idx, source, (newVal) => {
    cells[idx].source = newVal;
    setUnsaved(true); // 5.2
    // Mark this cell and all later code cells as dirty (output may be stale)
    if (cells[idx].kind === "code") {
      for (let i = idx; i < cells.length; i++) {
        if (cells[i].kind === "code") cells[i]._dirty = true;
      }
      const cellDiv = wrap.querySelector(".cell-code");
      if (cellDiv) cellDiv.setAttribute("data-dirty", "1");
    }
  });
}

function autoResize(ta) {
  if (!ta) return;
  ta.style.height = "1px";
  ta.style.height = Math.max(48, ta.scrollHeight) + "px";
}

function resizeAllTextareas() {
  document.querySelectorAll(".cell-md-editor textarea").forEach(autoResize);
}

function toggleInspector() {
  inspectorOpen = !inspectorOpen;
  const panel = document.getElementById("inspector");
  if (inspectorOpen) panel.classList.remove("inspector-hidden");
  else panel.classList.add("inspector-hidden");
}

function updateInspector(vars, idx) {
  if (vars && typeof vars === "object") {
    Object.assign(inspectorVars, vars);
  }
  // 5.8: track last cell that updated inspector
  if (idx !== undefined && idx !== null) _inspectorLastCellIdx = idx;
  if (!inspectorOpen) return;
  const body = document.getElementById("inspector-body");
  const names = Object.keys(inspectorVars);
  if (names.length === 0) {
    body.innerHTML = '<p class="inspector-empty">Run a cell to see variables.</p>';
    return;
  }
  // 5.8: "Last updated" line
  const lastUpdated = _inspectorLastCellIdx !== null
    ? `<div style="font-size:10px;color:var(--dim);padding:4px 6px 8px;font-style:italic">Last updated: Cell ${_inspectorLastCellIdx + 1}</div>`
    : "";
  const TRUNC = 80;
  body.innerHTML = lastUpdated + names.map(name => {
    const fullVal = String(inspectorVars[name] || "");
    // 5.8: truncate display at 80 chars, show full value in title
    const displayVal = fullVal.length > TRUNC ? fullVal.slice(0, TRUNC) + "…" : fullVal;
    const en = esc(name);
    const ev = esc(displayVal);
    const efull = esc(fullVal);
    return `<div class="inspector-row" title="${en} = ${efull}"><span class="inspector-name">${en}</span><span class="inspector-val" title="${efull}">${ev}</span></div>`;
  }).join("");
}

function setStatus(cls, text) {
  const el = document.getElementById("status");
  el.className = cls;
  el.textContent = text;
}

function showToast(message, type) {
  const toast = document.createElement("div");
  toast.textContent = message;
  toast.style.cssText = "position:fixed;bottom:24px;right:24px;padding:12px 20px;" +
    "border-radius:8px;color:#fff;font-size:14px;z-index:9999;transition:opacity 0.5s;" +
    "background:" + (type === "ok" ? "#22c55e" : "#ef4444") + ";";
  document.body.appendChild(toast);
  setTimeout(() => { toast.style.opacity = "0"; }, 3000);
  setTimeout(() => { toast.remove(); }, 3500);
}

// ── Export to HTML ────────────────────────────────────────────────────────────

function exportHtml() {
  const css = Array.from(document.styleSheets).map(ss => {
    try { return Array.from(ss.cssRules).map(r => r.cssText).join("\n"); }
    catch(e) { return ""; }
  }).join("\n");

  let body = "";
  cells.forEach((cell, idx) => {
    if (cell.kind === "section") {
      const t = esc(cell.source||"");
      body += `<div class="cell-section"><div class="section-bar"><span class="section-rule"></span><span class="section-title">${t}</span><span class="section-rule"></span></div></div>\n`;
    } else if (cell.kind === "markdown") {
      body += `<div class="cell-md-wrap"><div class="cell-md">${renderMd(cell.source||"")}</div></div>\n`;
    } else {
      // 5.15: capture CM highlighted HTML if editor is available
      let srcHtml = "";
      const cmHost = document.querySelector(`.cm-host[data-cell="${idx}"]`);
      if (cmHost) {
        const cmContent = cmHost.querySelector(".cm-content");
        if (cmContent) {
          srcHtml = cmContent.innerHTML;
        }
      }
      const src = esc(cell.source||"");
      const srcBlock = srcHtml
        ? `<div class="cm-content cell-src-highlighted" style="font-family:'JetBrains Mono','Fira Code','SF Mono',monospace;font-size:13px;padding:12px 18px;background:var(--code);border-radius:6px;overflow:auto;white-space:pre-wrap">${srcHtml}</div>`
        : `<pre class="cell-src" style="background:var(--code);padding:12px;border-radius:6px;overflow:auto">${src}</pre>`;
      const out = cell.output ? renderOutput(cell.output) : "";  // renderOutput already sanitizes
      const err = cell.error ? `<div class="cell-error">${esc(cell.error)}</div>` : "";
      body += `<div class="cell-code"><div class="cell-header"><span class="cell-label">code</span></div>${srcBlock}<div class="cell-out">${out}${err}</div></div>\n`;
    }
  });

  const name = NB_PATH.replace(/.*[\\/]/, "").replace(/\.[^.]*$/, "") || "notebook";
  const theme = getTheme();
  const html = `<!DOCTYPE html>
<html lang="en" data-theme="${theme}">
<head>
<meta charset="UTF-8">
<title>${name}</title>
<style>${css}</style>
</head>
<body style="padding:36px 48px;max-width:900px;margin:0 auto">
${body}
</body>
</html>`;

  const blob = new Blob([html], {type:"text/html"});
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = name + ".html";
  a.click();
  URL.revokeObjectURL(a.href);
}

// ── Notebook search ───────────────────────────────────────────────────────────

let _searchMatches = [];
let _searchCursor  = -1;

function openSearch() {
  const modal = document.getElementById("search-modal");
  modal.style.display = "flex";
  const inp = document.getElementById("search-input");
  inp.focus();
  inp.select();
}

function closeSearch() {
  document.getElementById("search-modal").style.display = "none";
  document.getElementById("search-input").value = "";
  _searchMatches = [];
  _searchCursor = -1;
  document.querySelectorAll(".search-match").forEach(el => el.classList.remove("search-match"));
}

function runSearch(term) {
  document.querySelectorAll(".search-match").forEach(el => el.classList.remove("search-match"));
  _searchMatches = [];
  if (!term) { document.getElementById("search-count").textContent = ""; return; }
  const q = term.toLowerCase();
  cells.forEach((c, i) => {
    const haystack = (c.source || "") + "\n" + (c.output || "") + "\n" + (c.error || "");
    if (haystack.toLowerCase().includes(q)) {
      _searchMatches.push(i);
      const w = document.querySelector(`[data-idx="${i}"]`);
      if (w) w.classList.add("search-match");
    }
  });
  _searchCursor = _searchMatches.length > 0 ? 0 : -1;
  updateSearchCursor();
}

function updateSearchCursor() {
  const count = _searchMatches.length;
  const countEl = document.getElementById("search-count");
  if (count === 0) {
    countEl.textContent = "no matches";
    countEl.classList.add("search-no-matches"); // 5.7: red when no matches
  } else {
    countEl.textContent = `${_searchCursor+1} / ${count}`;
    countEl.classList.remove("search-no-matches");
  }
  if (count > 0 && _searchCursor >= 0) {
    const w = document.querySelector(`[data-idx="${_searchMatches[_searchCursor]}"]`);
    if (w) w.scrollIntoView({behavior:"smooth", block:"nearest"});
  }
}

function searchNext() {
  if (_searchMatches.length === 0) return;
  const wasLast = _searchCursor === _searchMatches.length - 1;
  _searchCursor = (_searchCursor + 1) % _searchMatches.length;
  if (wasLast) showToast("Wrapped to top", "ok"); // 5.7
  updateSearchCursor();
}

function searchPrev() {
  if (_searchMatches.length === 0) return;
  const wasFirst = _searchCursor === 0;
  _searchCursor = (_searchCursor - 1 + _searchMatches.length) % _searchMatches.length;
  if (wasFirst) showToast("Wrapped to bottom", "ok"); // 5.7
  updateSearchCursor();
}

document.getElementById("search-input").addEventListener("input", (e) => runSearch(e.target.value));
document.getElementById("search-input").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSearch(); return; }
  if (e.key === "Enter") {
    if (e.shiftKey) searchPrev(); else searchNext();
    e.preventDefault();
  }
});

// ── Toolbar buttons ──────────────────────────────────────────────────────────

document.getElementById("btn-run-all").onclick    = runAll;
document.getElementById("btn-clear-all").onclick  = clearAll;
document.getElementById("btn-save").onclick       = saveNotebook;
document.getElementById("btn-add-code").onclick    = () => addCell("code",     cells.length-1);
document.getElementById("btn-add-md").onclick      = () => addCell("markdown", cells.length-1);
document.getElementById("btn-add-section").onclick = () => addSection(cells.length-1);
document.getElementById("btn-export").onclick      = exportHtml;
document.getElementById("btn-inspector").onclick   = () => { toggleInspector(); updateInspector(null); };

// Save As modal
document.getElementById("saveas-confirm").onclick = confirmSaveAs;
document.getElementById("saveas-cancel").onclick = closeSaveAs;
document.getElementById("saveas-path").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { closeSaveAs(); return; }
  if (e.key === "Enter") { e.preventDefault(); confirmSaveAs(); }
});

// Env panel
document.getElementById("btn-env").onclick = openEnvPanel;
document.getElementById("env-add").onclick = addEnvVar;
document.getElementById("env-save").onclick = closeEnvPanel;

// Log panel
document.getElementById("btn-log").onclick = () => {
  const panel = document.getElementById("log-panel");
  if (panel.style.display === "none") openLogPanel();
  else closeLogPanel();
};

// ── Phase 5: chord visual banner ─────────────────────────────────────────────

let _chordBannerTimer = null;

function showChordBanner(idx, text) {
  // Remove any existing banner
  document.querySelectorAll(".chord-banner").forEach(el => el.remove());
  if (_chordBannerTimer) { clearTimeout(_chordBannerTimer); _chordBannerTimer = null; }
  const wrap = document.querySelector(`[data-idx="${idx}"]`);
  if (!wrap) return;
  const banner = document.createElement("div");
  banner.className = "chord-banner";
  banner.textContent = text;
  wrap.style.position = "relative"; // ensure relative positioning
  wrap.appendChild(banner);
  _chordBannerTimer = setTimeout(() => {
    banner.classList.add("fade");
    setTimeout(() => { if (banner.parentNode) banner.remove(); }, 400);
    _chordBannerTimer = null;
  }, 600);
}

function clearChordBanner() {
  document.querySelectorAll(".chord-banner").forEach(el => el.remove());
  if (_chordBannerTimer) { clearTimeout(_chordBannerTimer); _chordBannerTimer = null; }
}

// ── Phase 3: Command mode ─────────────────────────────────────────────────────

let cmdSelected = -1;   // index of selected cell in command mode, -1 = none
let cmdActive   = false; // true when in command mode
let cmdLastKey  = "";
let cmdLastMs   = 0;

function cmdSelect(idx, scrollIntoView) {
  // Persist current editor value before switching
  if (cmdSelected >= 0 && cells[cmdSelected]) {
    const oldWrap = document.querySelector(`[data-idx="${cmdSelected}"]`);
    if (oldWrap) {
      const cmVal = window.getCMValue && window.getCMValue(cmdSelected);
      if (cmVal != null) cells[cmdSelected].source = cmVal;
      else {
        const ta = oldWrap.querySelector("textarea[data-cell]");
        if (ta) cells[cmdSelected].source = ta.value;
      }
      oldWrap.classList.remove("cmd-selected");
    }
  }
  cmdSelected = idx;
  cmdActive   = true;
  const wrap = document.querySelector(`[data-idx="${idx}"]`);
  if (wrap) {
    wrap.classList.add("cmd-selected");
    wrap.setAttribute("tabindex", "-1");
    wrap.focus();
    if (scrollIntoView !== false) wrap.scrollIntoView({block:"nearest"});
  }
  document.getElementById("mode-badge").className = "cmd";
}

function cmdExit() {
  if (cmdSelected >= 0) {
    const wrap = document.querySelector(`[data-idx="${cmdSelected}"]`);
    if (wrap) wrap.classList.remove("cmd-selected");
  }
  cmdSelected = -1;
  cmdActive   = false;
  document.getElementById("mode-badge").className = "";
}

function cmdEnterEdit(idx) {
  if (idx < 0 || idx >= cells.length) return;
  cmdActive = false;
  if (cells[idx] && cells[idx].kind === "markdown") {
    cells[idx]._editing = true;
    updateCell(idx);
  }
  const wrap = document.querySelector(`[data-idx="${idx}"]`);
  if (!wrap) return;
  const kind = cells[idx] && cells[idx].kind;
  if (kind === "code" && window.focusCM) {
    window.focusCM(idx);
  } else {
    const ta = wrap.querySelector("textarea");
    if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
  }
  document.getElementById("mode-badge").className = "";
}

function convertCell(idx, toKind) {
  if (!cells[idx] || cells[idx].kind === toKind) return;
  cells[idx].kind = toKind;
  cells[idx].output = "";
  cells[idx].error = null;
  cells[idx]._editing = false;
  updateCell(idx);
  setTimeout(() => cmdSelect(idx, false), 10);
}

// ── Focus trap for modals ─────────────────────────────────────────────────────

const FOCUSABLE = 'a[href],button:not([disabled]),input,select,textarea,[tabindex]:not([tabindex="-1"])';

function trapFocus(modalEl) {
  if (!modalEl) return;
  const focusable = Array.from(modalEl.querySelectorAll(FOCUSABLE));
  if (focusable.length > 0 && !modalEl.contains(document.activeElement)) focusable[0].focus();
  function handler(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      releaseFocus(modalEl);
      // Determine which close function to call based on modal id
      const id = modalEl.id;
      if (id === "saveas-modal") closeSaveAs();
      else if (id === "env-modal") closeEnvPanel();
      else if (id === "log-panel") closeLogPanel();
      else if (id === "cheatsheet") hideCheatsheet();
      return;
    }
    if (e.key !== "Tab") return;
    const current = focusable.filter(el => !el.offsetParent && el.offsetParent !== null || el.offsetParent);
    const live = Array.from(modalEl.querySelectorAll(FOCUSABLE));
    if (live.length === 0) return;
    const first = live[0];
    const last  = live[live.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) { e.preventDefault(); last.focus(); }
    } else {
      if (document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  }
  modalEl._focusTrapHandler = handler;
  modalEl.addEventListener("keydown", handler);
}

function releaseFocus(modalEl) {
  if (!modalEl || !modalEl._focusTrapHandler) return;
  modalEl.removeEventListener("keydown", modalEl._focusTrapHandler);
  delete modalEl._focusTrapHandler;
}

function showCheatsheet() {
  const el = document.getElementById("cheatsheet");
  el.classList.add("visible");
  trapFocus(el);
}

function hideCheatsheet() {
  const el = document.getElementById("cheatsheet");
  releaseFocus(el);
  el.classList.remove("visible");
}

document.getElementById("cheatsheet").addEventListener("click", (e) => {
  if (e.target === document.getElementById("cheatsheet")) hideCheatsheet();
});

// Enter command mode when Escape pressed in textarea
function installEscapeHandler(ta, idx) {
  ta.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      cells[idx].source = ta.value;
      ta.blur();
      cmdSelect(idx, false);
    }
  });
}

// ── Keyboard shortcuts ───────────────────────────────────────────────────────

document.addEventListener("keydown", (e) => {
  const tag = document.activeElement && document.activeElement.tagName;
  const inCM = !!(document.activeElement && document.activeElement.closest && document.activeElement.closest(".cm-editor"));
  const inInput = tag === "TEXTAREA" || tag === "INPUT" || inCM;

  // Global shortcuts (work in any mode)
  if ((e.metaKey||e.ctrlKey) && e.shiftKey && e.key==="Enter") { e.preventDefault(); runAll(); return; }
  if ((e.metaKey||e.ctrlKey) && e.key==="s") { e.preventDefault(); saveNotebook(); return; }
  if ((e.metaKey||e.ctrlKey) && e.key==="f") { e.preventDefault(); openSearch(); return; }

  // Command mode shortcuts
  if (cmdActive && !inInput) {
    const now = Date.now();
    const dbl = (k) => cmdLastKey === k && (now - cmdLastMs) < 500;
    e.preventDefault();
    // 5.1: clear chord banner on any non-chord key
    if (e.key !== "d" && e.key !== "0") clearChordBanner();
    switch(e.key) {
      case "j": case "ArrowDown": {
        if (e.shiftKey) { moveCell(cmdSelected, 1); setTimeout(() => cmdSelect(Math.min(cmdSelected + 1, cells.length - 1), false), 20); break; }
        const next = cmdSelected < cells.length - 1 ? cmdSelected + 1 : cmdSelected;
        cmdSelect(next); break;
      }
      case "k": case "ArrowUp": {
        if (e.shiftKey) { moveCell(cmdSelected, -1); setTimeout(() => cmdSelect(Math.max(cmdSelected - 1, 0), false), 20); break; }
        const prev = cmdSelected > 0 ? cmdSelected - 1 : 0;
        cmdSelect(prev); break;
      }
      case "Enter":
        cmdEnterEdit(cmdSelected); break;
      case "a":
        addCell("code", cmdSelected - 1);
        setTimeout(() => cmdSelect(cmdSelected, false), 20);
        break;
      case "b":
        addCell("code", cmdSelected);
        setTimeout(() => cmdSelect(cmdSelected + 1, false), 20);
        break;
      case "m":
        convertCell(cmdSelected, "markdown"); break;
      case "y":
        convertCell(cmdSelected, "code"); break;
      case "d":
        if (dbl("d")) {
          clearChordBanner(); // 5.1
          const old = cmdSelected; deleteCell(old); cmdLastKey = "";
          setTimeout(() => { if (old > 0) cmdSelect(old-1); else if (cells.length>0) cmdSelect(0); }, 20);
        } else {
          cmdLastKey = "d"; cmdLastMs = now;
          showChordBanner(cmdSelected, "d · Press again to delete"); // 5.1
        }
        return;
      case "0":
        if (dbl("0")) {
          clearChordBanner(); // 5.4
          clearCell(cmdSelected); cmdLastKey = "";
        } else {
          cmdLastKey = "0"; cmdLastMs = now;
          showChordBanner(cmdSelected, "0 · Press again to clear output"); // 5.4
        }
        return;
      case "o":
        toggleOutCollapse(cmdSelected); break;
      case "Escape":
        cmdExit(); break;
      case "/":
        openSearch(); break;
      case "n":
        if (e.shiftKey) searchPrev(); else searchNext(); break;
      case "?":
        showCheatsheet(); break;
      default:
        // Shift+Enter: run + move next
        if (e.shiftKey && e.key === "Enter") {
          if (cells[cmdSelected] && cells[cmdSelected].kind === "code") runCell(cmdSelected);
          const next2 = cmdSelected < cells.length - 1 ? cmdSelected + 1 : cmdSelected;
          cmdSelect(next2);
        }
    }
    cmdLastKey = e.key;
    cmdLastMs  = now;
  }
});

// Expose to CM module keybindings
window._nbCells = cells;
window.runCell = runCell;
window.addCell = addCell;
window.cmdSelect = cmdSelect;

// Defer WebSocket connection until DOMContentLoaded so module scripts
// (editor.js) can be served by the single-threaded march HTTP server
// before it enters the blocking WebSocket recv() loop.
document.addEventListener('DOMContentLoaded', function() { connect(); });
