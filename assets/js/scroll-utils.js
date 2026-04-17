// assets/js/scroll-utils.js — Pure, side-effect-free helpers extracted from
// scroll.js so they can be unit-tested with Vitest without a browser.
//
// Every function here must be:
//   - Free of DOM access (no document.*, window.*, localStorage.*)
//   - Free of network / WebSocket calls
//   - Deterministic given the same inputs
//
// scroll.js imports these at the top; tests import from this module directly.
//
// Stage notes:
//   isPotentiallyLongRunning — existing logic from scroll.js, extracted here
//   detectOutputType         — extracted + extended for Stage 1.3 fenced output
//   parseFencedOutput        — new for Stage 1.3 (syntax-highlighted output)
//   renderBlobHtml           — new for Stage 2.1 (binary blob rendering)

// ── isPotentiallyLongRunning ──────────────────────────────────────────────────

const SLOW_PATTERNS = [
  /\bHttp\./,/\bHttpClient\./,/\bHttpTransport\./,
  /\bTask\.async\b/,/\bTask\.await\b/,/\btask_spawn\b/,
  /\bProcess\.run\b/,/\bProcess\.spawn\b/,
  /\bSocket\./,/\bChannelSocket\./,/\bTls\./,
  /\bSystem\.sleep\b/,
  /\bFile\.read\b/,/\bFile\.write\b/,
];

/**
 * Heuristically decide whether a code cell's source might take a long time.
 * Used to show the ⏱ badge in the UI — false negatives are fine; false
 * positives are mildly annoying but not harmful.
 *
 * @param {string} src - The cell source text.
 * @returns {boolean}
 */
export function isPotentiallyLongRunning(src) {
  if (SLOW_PATTERNS.some(p => p.test(src))) return true;
  // Detect recursive named functions: `fn foo(` … `foo(` appears again later.
  const m = src.match(/\bfn\s+(\w+)\s*\(/);
  if (m && new RegExp('\\b' + m[1] + '\\s*\\(').test(src.slice(src.indexOf(m[0]) + m[0].length))) return true;
  return false;
}

// ── Output type detection ─────────────────────────────────────────────────────

/**
 * Classify a cell output string for rendering dispatch.
 *
 * Returns one of:
 *   'vega'   — Vega-Lite JSON spec (render with vegaEmbed)
 *   'html'   — SVG, HTML table, or full HTML page (sanitize + innerHTML)
 *   'fenced' — CommonMark fenced code block (syntax-highlight via CodeMirror)
 *   'text'   — plain text (escape and wrap in <pre>)
 *
 * @param {string} text - Raw cell output string.
 * @returns {'vega'|'html'|'fenced'|'text'}
 */
export function detectOutputType(text) {
  const t = text.trimStart();
  if (t.startsWith('{') && t.includes('"$schema"') && t.includes('vega.github.io/schema/vega-lite')) {
    return 'vega';
  }
  if (t.startsWith('<svg') || t.startsWith('<table') || t.startsWith('<!DOCTYPE') || t.startsWith('<html')) {
    return 'html';
  }
  if (parseFencedOutput(text) !== null) {
    return 'fenced';
  }
  return 'text';
}

// ── Fenced output parsing (Stage 1.3) ────────────────────────────────────────

/**
 * Parse a CommonMark-style fenced code block from a cell output string.
 *
 * This is the counterpart to `ScrollCode.fenced/2` on the server side: if a
 * cell emits `ScrollCode.fenced("json", value)`, its output starts with a
 * backtick fence; this function extracts the lang tag and body so the
 * browser can hand them to a CodeMirror syntax highlighter.
 *
 * Returns `{ lang, body }` when the text is a fenced block, `null` otherwise.
 * Supports extended fences (4+ backticks) produced by `ScrollCode.fenced` for
 * bodies that themselves contain 3-backtick runs.
 *
 * @param {string} text - Raw cell output string.
 * @returns {{ lang: string, body: string } | null}
 */
export function parseFencedOutput(text) {
  const t = text.trimStart();
  // Match the opening fence: 3+ backticks followed by optional lang, then \n
  const openMatch = t.match(/^(`{3,})([^\n`]*)\n/);
  if (!openMatch) return null;

  const fence = openMatch[1];      // e.g. "```" or "````"
  const lang = openMatch[2].trim(); // e.g. "json" or ""
  const afterOpen = t.slice(openMatch[0].length);

  // The closing fence is exactly `fence` on its own line (possibly at end of string).
  // We match it as a line that starts with the fence string and contains nothing
  // else (no extra backticks), following CommonMark spec.
  const closePattern = new RegExp('(?:^|\\n)' + fence.replace(/`/g, '\\`') + '(?:`*)(?:\\n|$)');
  const closeMatch = closePattern.exec(afterOpen);
  if (!closeMatch) return null;

  // Body is everything between the open fence line and the close fence line.
  // closeMatch.index is the position of the \n before the closing fence (or 0
  // if the close fence is at the very start, which can't happen after a body).
  const bodyEnd = closeMatch.index + (afterOpen[closeMatch.index] === '\n' ? 1 : 0);
  const body = afterOpen.slice(0, closeMatch.index + (afterOpen[closeMatch.index] === '\n' ? 0 : 0));

  // Trim a single leading \n from body (from the newline that ended the open
  // fence line — already consumed by openMatch[0]) and any trailing \n.
  return { lang, body: body.replace(/\n$/, '') };
}

// ── Blob rendering (Stage 2.1) ────────────────────────────────────────────────

function escAttr(s) {
  return String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

/**
 * Render a single blob object as an HTML string.
 *
 * @param {{ mime: string, data: string }} blob
 * @returns {string} HTML string
 */
export function renderBlobHtml(blob) {
  const mime = blob.mime || '';
  const src = `data:${escAttr(mime)};base64,${blob.data}`;
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
  return `<div class="blob-wrap blob-unknown"><a href="${src}" download="output.bin">[${escAttr(mime)} blob — download]</a></div>`;
}
