# Parity Plan — Closing the Livebook / Jupyter Gap

Sequel to `notebook-ergonomics-plan.md`. That plan got us to feature parity on
the *notebook editor*; this one closes the gap on **rich output, remote access,
and interactivity** — the things that turn a notebook into a data-science or
ops tool.

**Current state (April 2026):** All 9 phases of the ergonomics plan are shipped
(sections, drag, search, HTML export, Vega-Lite, command mode, variable
inspector, interrupt, forge add). Outputs are text + HTML + SVG + Vega-Lite.
Execution is persistent-REPL, single-process, single-user, local-only.

---

## Stage map

| Stage | Theme | Effort | Risk | Blocks |
|---|---|---|---|---|
| **1** | Quick visualization wins | 2–3 days | Low | — |
| **2** | Binary outputs & rich static renderers | 1 week | Low-Med | Stage 4 |
| **3** | Interactive DataTable & progress bar | 1 week | Low | — |
| **4** | Bidirectional widget protocol | 2–3 weeks | **High** | Stage 5 |
| **5** | Reactive execution (auto-rerun on input) | 1–2 weeks | Med | — |
| **6** | Remote kernels & SSH bastion | 2–3 weeks | **High** | — |
| **7** | Database smart cells | 1–2 weeks | Med | Stage 6 recommended |
| **8** | Notebook metadata & multi-format export | 1 week | Low | — |
| **9** | Collaboration & checkpoints | Weeks | **High** | — |

Stages 1–3 are independent and cheap — ship first. Stage 4 is the architectural
turning point: it introduces a client→server message channel for widget values,
which everything interactive depends on. Stages 6–9 are long projects; commit
only after 1–5 land and we have real users.

---

## Stage 1 — Quick visualization wins

Pure client-side. No server changes. Ship together.

### 1.1 Mermaid diagram rendering

- Detect ```` ```mermaid ```` fenced blocks inside Markdown cells; replace with
  a `<div class="mermaid">` and call `mermaid.run()`.
- Also detect Mermaid output from code cells (string starting with
  `graph `, `sequenceDiagram`, `flowchart`, `erDiagram`, `stateDiagram`, etc.).
- Lazy-load `mermaid.min.js` from CDN on first use (same pattern as Vega).
- Theme: match our dark palette via `mermaid.initialize({theme:'dark'})`.

### 1.2 Math rendering (KaTeX)

- `$...$` inline, `$$...$$` block inside Markdown cells.
- Lazy-load KaTeX on first use.
- Gate behind a toggle in the toolbar so users who don't need it don't pay.

### 1.3 Syntax-highlighted output

- If a code cell's output starts with ```` ```lang ```` (user explicitly marked
  it), render via the same CodeMirror highlighter we use for source.
- New helper `Scroll.Code.fenced("json", value)` in stdlib (see library list
  below).

### 1.4 Copy-as-Markdown for outputs

Extend the existing "Copy output" button with a dropdown: **plain**, **as
Markdown**, **as HTML**. Helpful when pasting into docs/PRs.

### 1.5 Todos

- [ ] `assets/js/mermaid.js` loader wrapper (mirror `ensureVega`).
- [ ] `renderMermaid(src, el)` in `scroll.js`; hook into markdown render + cell output render.
- [ ] `assets/js/katex.js` loader + `renderMath(el)`.
- [ ] Detect `$` / `$$` in markdown output; run KaTeX over those spans.
- [ ] `scroll.css` — dark-friendly Mermaid + KaTeX overrides.
- [ ] Toolbar toggle for math rendering (stored in `localStorage`).
- [ ] Extend `copyOutput` to multi-format dropdown.
- [x] `lib/scroll/code.march` — `fenced/2` helper (see *New libraries*).

### 1.6 Testing

- **Unit (JS):** none needed — thin wrappers around CDN libs.
- **Playwright (new, see Testing infrastructure below):**
  - Run cell that outputs a Mermaid graph → snapshot has `<svg>`, no errors in console.
  - Run cell with `$E = mc^2$` → snapshot has KaTeX `.katex` span.
  - Copy-as-HTML button places HTML on clipboard (use `navigator.clipboard.readText`).
- **Regression:** existing Vega-Lite tests still pass.

---

## Stage 2 — Binary outputs & rich static renderers

Introduce a **new WS message type** for non-text outputs. This is the last
server-protocol change we can make before Stage 4 closes the door on backwards
compat for a while, so bundle anything protocol-adjacent here.

### 2.1 New output sentinel protocol

Currently cells emit stdout text. Extend `runtime.march` to recognize a new
sentinel block:

```
__SCROLL_BLOB__:<mime>:<base64>\n
__SCROLL_BLOB_END__\n
```

Parser in `runner.march` / `runtime.march` buffers these, emits them as
structured output items. WS `output` message grows an optional `blobs` field:

```json
{"type":"output", "index":2, "stdout":"...", "blobs":[
  {"mime":"image/png", "data":"iVBOR..."},
  {"mime":"application/json+plotly", "data":"..."}
]}
```

### 2.2 Client renderers

Dispatch on `blob.mime`:

| mime | Renderer |
|---|---|
| `image/png`, `image/jpeg`, `image/gif`, `image/webp` | `<img src="data:mime;base64,...">` |
| `image/svg+xml` | inline SVG (already supported via text) |
| `application/pdf` | `<embed>` with download fallback |
| `audio/*` | `<audio controls>` |
| `video/*` | `<video controls>` |
| `application/json+plotly` | lazy-load plotly.js and `Plotly.newPlot(el, spec)` |
| `application/geo+json` | lazy-load Leaflet, render map |

Use DOMPurify (already a dep) on anything HTML-adjacent.

### 2.3 Stdlib additions (see *New libraries* section)

- `Scroll.Image` — emit PNG/JPEG from a byte buffer.
- `Scroll.Audio`, `Scroll.Video`, `Scroll.Pdf`.
- `Scroll.Plotly` — spec-as-map → sentinel.
- `Scroll.Map` — GeoJSON → sentinel.

### 2.4 Size limits & safety

- Per-blob cap: 8 MB (matches existing 64 KB stdout cap spirit; blobs are
  allowed much larger). Oversize → error output.
- Per-cell total cap: 32 MB.
- Base64 lives only in WS messages, never persisted to `.scrollmd` (outputs
  stay in browser memory).
- MIME sniff blobs we claim are images; reject anything whose magic bytes
  don't match to prevent HTML injection via `image/png` claim.

### 2.5 Todos

- [ ] `lib/runner.march` — emit `__SCROLL_BLOB__` sentinel; update split logic to preserve binary-ish lines.
- [x] `lib/runtime.march` — parse sentinel blocks out of output capture (`BlobParser.parse` called in `poll_result`).
- [x] `lib/protocol.march` — serialize `blobs:` field in output message (`output_msg/5` with blobs param).
- [x] `lib/session.march` — pass blobs through run handler.
- [x] `assets/js/scroll.js` — `renderBlob(blob, el)` dispatcher; update `renderOutput`.
- [ ] `assets/js/plotly.js`, `leaflet.js` loaders.
- [x] `lib/scroll/image.march`, `audio.march`, `video.march`, `pdf.march` (see *New libraries*).
- [ ] `lib/scroll/plotly.march`, `map.march` (see *New libraries*).
- [ ] Magic-byte sniff table in JS for claimed image MIME types.
- [x] Error path: oversize blob → render placeholder `[blob too large: N MB]` in `BlobParser.parse_with_limit`.

### 2.6 Testing

- **Unit (March):** parse sentinel blocks with binary content; ensure no
  corruption when base64 contains `=`, `+`, `/`.
- **Property (March):** round-trip random byte buffers through base64 + sentinel
  extraction; assert byte-exact.
- **Integration (Python/WS):** cell emits `Scroll.Image.png(bytes)` → receive
  `blobs:[{mime:image/png,...}]` message; decode; compare to original bytes.
- **Security:** cell claims `image/png` but emits HTML bytes; assert renderer
  rejects and falls back to hex dump.
- **Playwright:** run cell with Plotly chart → `<svg>` present in container; no
  console errors.
- **Size limit:** cell emits 50 MB blob → receive `error` not `output`; server
  doesn't OOM.

---

## Stage 3 — Interactive DataTable & progress bar

No new protocol needed; these are enhanced HTML outputs that the browser
already knows how to render.

### 3.1 Sortable/filterable DataTable

Replace `DataFrame.to_html` with `DataFrame.to_scroll_table()` that emits a
`<table class="scroll-dt" data-rows='[...]'>` carrying the data as JSON in a
`data-` attribute (not rendered twice — JS hydrates).

On render, JS:
- Adds click-to-sort headers.
- Adds filter input per column (toggle).
- Paginates at 100 rows default; "show all" toggle.
- Hides data-attribute after hydration.

### 3.2 Progress bar (one-way, no interactivity yet)

`Scroll.Progress.new(total)` returns an ID; `update(id, done)` emits:

```
__SCROLL_PROGRESS__:{id}:{done}/{total}\n
```

Server parses during **live streaming** (already in place since the live-output
commit 93f280a), pushes `{type:"progress", index, id, done, total}` WS message.
JS finds `[data-progress-id=id]` and updates the bar.

Note: this is *streaming one-way output*, not bidirectional — no Stage 4
dependency.

### 3.3 Todos

- [ ] `lib/scroll/dataframe_ext.march` — `to_scroll_table/1` producing hydration-ready HTML.
- [ ] `assets/js/datatable.js` — hydrate, sort, filter, paginate; isolated module.
- [ ] `scroll.css` — table styles matching dark theme.
- [ ] `lib/scroll/progress.march` — `new/1`, `update/2`, `done/1`.
- [ ] Live-output parser in `runtime.march` — recognize `__SCROLL_PROGRESS__`.
- [ ] New WS message `progress`; client handler updates DOM.
- [ ] Handle multiple progress bars in one cell (unique IDs).

### 3.4 Testing

- **Unit (JS, Vitest — see Testing infrastructure):**
  - `hydrateTable` with 1 row, 0 rows, 10k rows (perf ceiling).
  - Sort stability; mixed-type columns.
  - Filter with regex-unsafe characters.
- **Playwright:**
  - Render 1k-row table → scroll performance OK (frame budget < 16ms).
  - Click column header → sort order verified via DOM text.
  - Type in filter → visible row count drops.
- **Integration (WS):** progress cell emits 10 updates → client receives 10 `progress` messages; final one has `done==total`.
- **Property:** progress counter monotonic; never exceeds total.

---

## Stage 4 — Bidirectional widget protocol

**The architectural turning point.** Introduce a client→server channel for
widget values. Everything in Stages 5, 7 depends on this.

### 4.1 Protocol

New WS messages:

```json
// client → server: user moved a slider
{"type":"widget_set", "cell_index": 2, "widget_id": "n", "value": 42}

// server → client: widget was created
{"type":"widget_new", "cell_index": 2, "widget": {
  "id": "n", "kind": "slider", "min": 0, "max": 100, "value": 42,
  "label": "N", "step": 1
}}
```

The server keeps a per-connection **Widget Registry** in `Vault` keyed by
`(cell_index, widget_id)`. `run_cells_to(N)` passes current widget values into
the generated runner as literal March values at the top of the cell block:

```march
-- auto-injected by generate_runner
let n = 42  -- from widget "n" in cell 2
```

### 4.2 Widget creation (March side)

Cells create widgets by emitting a sentinel:

```march
let n = Scroll.Input.slider("n", min: 0, max: 100, default: 10)
-- emits __SCROLL_WIDGET__{"id":"n","kind":"slider","min":0,"max":100,"value":10}
-- returns the current value (10 first time, whatever user set on re-run)
```

First run: value = default. Subsequent runs: value read from Vault registry
(set by last `widget_set` message).

### 4.3 Widget kinds

| Kind | March constructor |
|---|---|
| Slider | `Scroll.Input.slider(id, min:, max:, step:, default:)` |
| Text | `Scroll.Input.text(id, default:, placeholder:)` |
| Number | `Scroll.Input.number(id, default:, min:, max:)` |
| Select | `Scroll.Input.select(id, options:, default:)` |
| Checkbox | `Scroll.Input.checkbox(id, default:)` |
| Button | `Scroll.Input.button(id, label:)` — fires event not value |
| File upload | `Scroll.Input.file(id, accept:)` — bytes into Vault, path returned |

### 4.4 Client rendering

`renderOutput` hydrates `__SCROLL_WIDGET__` sentinels into real DOM inputs.
`oninput` → debounced `widget_set`. No re-run until user hits Shift+Enter or
Stage 5's auto-rerun kicks in.

### 4.5 File uploads

Special case — uploads go through a separate `upload` WS message (or HTTP
POST for large files). Server writes bytes to `/tmp/__scroll_upload_{uuid}`,
stores path in Vault, `Scroll.Input.file(id)` returns the path string.

### 4.6 Todos

- [ ] Protocol spec in `specs/widget-protocol.md` (canonical message shapes).
- [ ] `lib/session.march` — handle `widget_set`, maintain per-conn widget registry.
- [ ] `lib/runner.march` — inject widget values at the top of runner source.
- [ ] `lib/scroll/input.march` — all widget constructors emit sentinel + read-from-env.
- [ ] `assets/js/widgets.js` — render each kind; debounced `widget_set`.
- [ ] `scroll.css` — widget styles (match dark theme).
- [ ] File upload: HTTP POST endpoint `/upload/:session_id`; multipart parsing.
- [ ] `Scroll.Input.button` fires `widget_event` (separate from `widget_set`).
- [ ] Persistence: widget values saved in `.scrollmd` frontmatter so reopening a notebook preserves them (optional, opt-in).

### 4.7 Testing

- **Unit (March):** widget sentinel parsing; value injection generates valid March source.
- **Property:** widget registry is never corrupted by concurrent sets across multiple cells.
- **Integration (Python/WS):**
  - Create slider, set value, re-run cell → cell sees new value.
  - Two cells with same widget ID → second wins; warning logged.
  - Set value before widget exists → ignored or queued (decide).
- **Security:**
  - Widget value contains code injection attempt (`"; System.cmd("rm -rf /")`) → value is escaped at injection time; only literals allowed.
  - File upload with traversal path (`../../etc/passwd`) → rejected.
  - File upload size cap: 100 MB default, configurable.
- **Playwright:**
  - Move slider → server receives `widget_set`; next re-run reflects new value.
  - Upload file → subsequent cell reads bytes correctly.
  - Button click → `widget_event` received.

---

## Stage 5 — Reactive execution

Once widgets exist, the obvious next step is: **when a widget changes, auto-rerun
downstream cells**. Livebook calls these "frames"; Jupyter has
`ipywidgets.interact`.

### 5.1 Dependency tracking

Already partly possible: `generate_runner` knows which bindings each cell
uses. Extend it to produce a **binding dependency graph**:

```
cell 2: reads {n}, writes {df}
cell 3: reads {df}, writes {mean}
cell 4: reads {mean}, writes {}
```

When `n` changes (widget), auto-rerun cells 2, 3, 4 in order.

### 5.2 Reactivity modes (per notebook setting)

- **Manual** (default, current): user hits Shift+Enter.
- **Auto-on-input**: widget change → auto-rerun dependents.
- **Auto-on-edit**: source edit → dim downstream (already done) + optional auto-rerun.

### 5.3 Todos

- [ ] `lib/runner.march` — annotate each cell with `reads:` / `writes:` sets.
- [ ] `lib/scroll/graph.march` — topological order; dependents of a binding.
- [ ] `session.march` — on `widget_set`, if auto mode on, schedule re-run of dependents.
- [ ] UI: per-notebook reactivity toggle in toolbar.
- [ ] UI: dependency arrows in variable inspector (optional).
- [ ] Debounce widget changes before triggering run (300ms default).

### 5.4 Testing

- **Unit:** graph construction from cell reads/writes; topo sort; cycle detection.
- **Property:** for any DAG of cells, dependent set is always downstream; no false negatives.
- **Integration:** slider in cell A → cells B, C that depend on A auto-rerun; cell D (independent) doesn't.
- **Edge:** cell with side effects only (println, HTTP) — still re-runs (by design).

---

## Stage 6 — Remote kernels & SSH bastion

Biggest architectural change. Today the March REPL runs in the same process as
the notebook server. For remote use, we need the REPL to live elsewhere.

### 6.1 Local vs remote kernel abstraction

Introduce `lib/scroll/kernel.march`:

```
mod Kernel do
  trait do
    fn start() -> KernelHandle
    fn send(handle, src) -> Result
    fn stop(handle) -> ()
  end
end

mod LocalKernel do ... end       -- current behavior
mod SshKernel do ... end         -- new
mod DockerKernel do ... end      -- future
```

Refactor `runtime.march` to call through the trait.

### 6.2 SSH kernel

Spawns `march repl` on a remote host via `ssh user@host march repl`. Streams
stdin/stdout over the SSH pipe. Sentinel parsing unchanged — the protocol
already works over any bytestream.

Complications:
- Temp file I/O is local-only; remote kernel can't use `/tmp/__scroll_rt_*`.
  Replace with in-band sentinel framing over stdout (requires Stage 2 protocol
  changes to be clean).
- Interrupt: SSH second channel to send SIGINT to remote pid.
- File upload / download: scp under the hood.

### 6.3 Bastion / jump host support

In the `Kernel` config:

```toml
[kernel]
type = "ssh"
host = "prod-worker-1.internal"
jump = "bastion.company.com"
key = "~/.ssh/prod_rsa"
```

Under the hood: `ssh -J bastion.company.com prod-worker-1.internal march repl`.

### 6.4 Kernel picker UI

Toolbar dropdown: **Local** / **SSH (prod-worker-1)** / **+ Add kernel…**.
Switching kernels is destructive (loses REPL state); confirm dialog.

### 6.5 Todos

- [ ] `lib/scroll/kernel.march` — trait + LocalKernel impl (refactor existing).
- [ ] `lib/scroll/ssh_kernel.march` — SSH spawn, stream, interrupt.
- [ ] Replace tempfile I/O with in-band sentinel framing (this is needed anyway for cleanliness).
- [ ] Kernel configuration in `mynotebook.toml` `[kernels]` section.
- [ ] `assets/js/kernels.js` — picker, status indicator (connected/disconnected).
- [ ] New WS messages: `kernel_list`, `kernel_switch`, `kernel_status`.
- [ ] Docs: "Connecting through a bastion" guide with worked example.

### 6.6 Testing

- **Unit:** SSH command construction; jump-host flag threading.
- **Integration (local):** run SSH kernel pointed at `localhost` (requires
  `sshd` + key); same test suite as LocalKernel should pass.
- **CI:** use Docker-compose to stand up an SSH server in CI so this runs
  automatically.
- **Security:**
  - No host key verification bypass by default; `--insecure` flag required.
  - Credentials never logged.
  - Connection failures surface cleanly, not as opaque stderr.

---

## Stage 7 — Database smart cells

Build on Stage 6 (remote access) and Stage 4 (widgets for connection config).

### 7.1 New cell kind: `database`

Stored in `.scrollmd` as:

```
<!-- database: pg_prod -->
```html
<!-- connection: postgresql://... -->
<!-- query: SELECT * FROM users LIMIT 100 -->
```

Parsed as `Database(connection_id, sql)`. Runs via a March DB client library
(to be built — see *New libraries*).

### 7.2 Connection manager

Toolbar "Connections" → list of named connections (Postgres, MySQL, SQLite,
DuckDB). Saved in `mynotebook.toml`:

```toml
[connections.pg_prod]
type = "postgres"
host = "db.internal"
port = 5432
user = "analytics"
password_env = "PG_PROD_PASSWORD"  -- never inline
database = "metrics"
ssh_jump = "bastion.company.com"  -- reuse Stage 6
```

### 7.3 Smart-cell UI

- SQL editor with syntax highlighting (CodeMirror SQL mode).
- Result pane auto-uses Stage 3's DataTable.
- Parameter substitution via Stage 4 widgets: `SELECT * FROM users WHERE id = {{user_id}}` where `user_id` is a cell widget.
- `EXPLAIN` button.

### 7.4 Todos

- [ ] `lib/db/postgres.march` — Postgres wire protocol client (biggest new dep).
- [ ] `lib/db/sqlite.march` — SQLite bindings via FFI.
- [ ] `lib/db/duckdb.march` — DuckDB (embedded analytics DB; low priority).
- [ ] `lib/cells.march` — new `Database` cell variant.
- [ ] `lib/scroll/connection.march` — connection registry, env-var secret resolution.
- [ ] SQL syntax highlighting in CodeMirror.
- [ ] `{{widget}}` parameterization in SQL.

### 7.5 Testing

- **Unit (March):** Postgres wire protocol — startup, query, row parse, error. This is the heaviest piece; property-test against a real Postgres in Docker.
- **Integration:** execute query → receive rows → render in DataTable.
- **Security:** SQL injection via widget substitution — use parameterized queries; widgets become `$1`, `$2`.
- **Secret hygiene:** password never appears in `.scrollmd`, logs, or error messages.

---

## Stage 8 — Metadata & multi-format export

Low-risk polish.

### 8.1 Notebook frontmatter

Add YAML frontmatter to `.scrollmd`:

```markdown
---
title: "Sales analysis Q1"
author: "Alice"
created: 2026-04-01
tags: [analytics, quarterly]
---
```

Editable in a toolbar "Notebook info" modal.

### 8.2 Export formats

Beyond current HTML export:

| Format | Approach |
|---|---|
| **PDF** | Server-side headless Chrome (`puppeteer` binary) renders exported HTML → PDF. |
| **Markdown** | Strip fences, keep outputs as code blocks. |
| **Jupyter `.ipynb`** | JSON schema; outputs as code blocks (no kernel round-trip). |
| **Slides** | HTML export + reveal.js wrapper; section cells become slide boundaries. |
| **March script** | Concatenate code cells; markdown becomes `--` comments. |

### 8.3 Todos

- [ ] `lib/cells.march` — parse/emit YAML frontmatter.
- [ ] Toolbar modal for title/author/tags.
- [ ] `exportMarkdown`, `exportIpynb`, `exportSlides`, `exportScript` functions.
- [ ] PDF export — spawn headless Chrome; optional feature.

### 8.4 Testing

- Round-trip `.scrollmd` → parsed → serialized: byte-identical.
- Export each format, parse back (where possible), verify content preserved.

---

## Stage 9 — Collaboration & checkpoints

Largest, most uncertain. Not planning in detail until Stages 1–8 land and we
know who the users are.

Open questions:
- CRDT or OT? (Livebook uses OT via Phoenix LiveView.)
- Do we need a central server or peer-to-peer?
- How do checkpoints interact with the REPL state?

Research phase first; implementation planning after.

---

## New libraries

Summary of March libraries this plan introduces. Each gets its own module
under `lib/scroll/` (stdlib-adjacent) or a standalone package.

| Module | Stage | Purpose | Rough size |
|---|---|---|---|
| `Scroll.Code` | 1 | `fenced(lang, value)` helper | Tiny |
| `Scroll.Image` | 2 | PNG/JPEG blob output | Small |
| `Scroll.Audio` | 2 | Audio blob output | Small |
| `Scroll.Video` | 2 | Video blob output | Small |
| `Scroll.Pdf` | 2 | PDF blob output | Small |
| `Scroll.Plotly` | 2 | Plotly spec → sentinel | Small |
| `Scroll.Map` | 2 | GeoJSON sentinel | Small |
| `Scroll.DataFrameExt` | 3 | `to_scroll_table/1` | Small |
| `Scroll.Progress` | 3 | Progress-bar updates | Small |
| `Scroll.Input` | 4 | All widget constructors | Medium |
| `Scroll.Graph` | 5 | Dep graph + topo sort | Small |
| `Scroll.Kernel` | 6 | Kernel trait + LocalKernel | Medium |
| `Scroll.SshKernel` | 6 | Remote kernel via SSH | Medium |
| `Scroll.Connection` | 7 | DB connection registry | Small |
| `march/db/postgres` | 7 | **Postgres wire protocol** | **Large** |
| `march/db/sqlite` | 7 | SQLite FFI | Medium |
| `march/db/duckdb` | 7 | DuckDB FFI (optional) | Medium |
| `Scroll.Frontmatter` | 8 | YAML parse/emit | Small |

The **Postgres client** is the only big greenfield library here. It's
independently useful outside notebooks — March needs it anyway — so budget it
as a separate project that this plan unblocks, not a notebook-private piece.

---

## Testing infrastructure

Current test surface:
- 117 March unit tests via `march test` (cells parsing, runner generation)
- 32 Python WebSocket end-to-end tests
- 24 property tests

This plan adds a lot of **browser-visible** functionality (charts, widgets,
tables). We need browser testing.

### Add: Playwright suite

- `test/browser/` — Playwright tests in JS.
- Start the notebook server on a random port per test; open a headless Chrome
  page; exercise cells; assert DOM/console/network.
- CI runs Playwright after WS tests pass.

### Add: Vitest for JS units

`assets/js/scroll.js` is now ~59 KB with enough logic to deserve unit tests.

- Extract pure functions (`isPotentiallyLongRunning`, `renderBlob` dispatcher,
  `hydrateTable`, search/highlight logic) into importable modules.
- `test/js/` with Vitest.
- Run headless in CI.

### Add: property tests per stage

Pattern established by `test_property.march` (24 tests). Each new stage's
parsers get property coverage:

- Stage 2: binary base64 round-trip.
- Stage 4: widget value injection never produces invalid March source for any
  JSON value.
- Stage 5: dep graph topo sort correctness for random DAGs.
- Stage 7: SQL parameter substitution always parameterized, never interpolated.

### Add: Docker-compose fixtures for CI

- `sshd` container for Stage 6.
- `postgres` container for Stage 7.
- `chromium` for Playwright (via `mcr.microsoft.com/playwright` image).

### Test-plan checklist per PR

Every stage PR must include:

- [ ] March unit tests for pure logic.
- [ ] Property tests for parsers / graph algorithms.
- [ ] Python integration test for WS messages.
- [ ] Playwright test for user-visible behavior.
- [ ] Security test for any new input surface.
- [ ] Docs update in `README.md` or `specs/`.

---

## Big todo list (flat, for tracking)

Grouped by stage. Check off as you ship.

### Stage 1 — Quick visualization wins
- [ ] Mermaid loader + renderer (markdown + output paths)
- [ ] KaTeX loader + renderer + toolbar toggle
- [x] CommonMark fenced code-block output (`parseFencedOutput` in scroll.js + CSS)
- [ ] Copy-as-Markdown / HTML dropdown
- [x] `Scroll.Code.fenced/2` stdlib helper
- [ ] Dark-theme CSS overrides for Mermaid + KaTeX
- [ ] Playwright smoke tests for all three renderers

### Stage 2 — Binary outputs
- [x] `__SCROLL_BLOB__` sentinel protocol (`lib/scroll/blob_parser.march` + runtime.march + protocol.march)
- [x] `blobs:` field in output WS message (protocol.march, session.march)
- [x] `renderBlob` dispatcher in scroll.js (image/audio/video/pdf + unknown fallback)
- [ ] Plotly + Leaflet lazy loaders
- [x] `Scroll.Image`, `Audio`, `Video`, `Pdf` modules
- [ ] `Scroll.Plotly`, `Scroll.Map` modules
- [ ] Magic-byte sniff for claimed image MIMEs
- [x] 8 MB per-blob cap (via `BlobParser.parse_with_limit`)
- [x] Malformed blob tests (missing end marker, empty MIME, no colon)
- [ ] Playwright: image, Plotly, map rendered

### Stage 3 — DataTable & progress
- [ ] `to_scroll_table/1` in DataFrame
- [ ] `datatable.js` hydration (sort/filter/paginate)
- [ ] `Scroll.Progress` module
- [ ] `__SCROLL_PROGRESS__` sentinel in live-stream parser
- [ ] `progress` WS message type
- [ ] 1k-row perf test
- [ ] Concurrent progress bars in one cell

### Stage 4 — Widget protocol
- [ ] `specs/widget-protocol.md` canonical spec
- [ ] Per-connection widget registry in Vault
- [ ] `widget_set`, `widget_new`, `widget_event` WS messages
- [ ] Value injection into generated runner
- [ ] `Scroll.Input.slider/text/number/select/checkbox/button/file`
- [ ] `widgets.js` hydration + debounced set
- [ ] File upload HTTP endpoint with traversal guard
- [ ] 100 MB upload cap
- [ ] Injection-safety tests (code-in-widget-value)
- [ ] Widget state persistence in frontmatter (opt-in)

### Stage 5 — Reactive execution
- [ ] reads/writes annotations per cell in runner
- [ ] `Scroll.Graph` topo sort
- [ ] Reactivity mode toggle (manual / auto-input / auto-edit)
- [ ] Debounced auto-rerun on `widget_set`
- [ ] Dep arrow overlay in variable inspector (optional)
- [ ] Cycle detection

### Stage 6 — Remote kernels
- [ ] `Scroll.Kernel` trait + `LocalKernel` refactor
- [ ] In-band sentinel framing (replace tempfile I/O)
- [ ] `Scroll.SshKernel` — spawn, stream, interrupt, jump host
- [ ] `[kernels]` section in `mynotebook.toml`
- [ ] Kernel picker UI + status indicator
- [ ] `kernel_list`, `kernel_switch`, `kernel_status` WS messages
- [ ] CI: `sshd` Docker fixture
- [ ] Bastion guide doc

### Stage 7 — Database cells
- [ ] `march/db/postgres` wire protocol client
- [ ] `march/db/sqlite` FFI
- [ ] `Database` cell variant parse/emit
- [ ] `Scroll.Connection` registry with env-var secrets
- [ ] SQL syntax highlighting
- [ ] `{{widget}}` → `$1` parameterization
- [ ] CI: `postgres` Docker fixture
- [ ] SQL-injection safety tests

### Stage 8 — Metadata & export
- [ ] YAML frontmatter parse/emit
- [ ] Notebook-info modal
- [ ] Markdown export
- [ ] `.ipynb` export
- [ ] Slides (reveal.js) export
- [ ] March-script export
- [ ] PDF export via headless Chrome (feature-flagged)

### Stage 9 — Collab & checkpoints
- [ ] Research spike — CRDT vs OT
- [ ] Decision doc
- [ ] (Implementation plan written after research)

### Cross-cutting infrastructure
- [ ] Playwright test harness in `test/browser/`
- [x] Vitest harness in `test/js/` (36 tests: `isPotentiallyLongRunning`, `detectOutputType`, `parseFencedOutput`, `renderBlobHtml`)
- [ ] CI: Docker-compose fixtures (sshd, postgres, chromium)
- [x] Extract pure JS helpers into importable modules for unit testing (`assets/js/scroll-utils.js`)
- [ ] Stage-gate template for PRs (tests required per stage)

---

## Decision log / open questions

- **Protocol versioning.** After Stage 2 and Stage 4 we've changed the wire
  twice. Add a `scroll_protocol` version string to WS handshake so the client
  can warn on mismatch.
- **Widget state in `.scrollmd`.** Persist? Tempting for reproducibility, risky
  for secrets. Default: no; opt-in flag in frontmatter.
- **Out-of-order execution.** Jupyter allows it; breaks our REPL model. Stay
  with 0..N replay and lean into reactivity (Stage 5) instead — worth writing
  up as a decision record.
- **Remote kernel isolation.** Today each browser tab gets its own LocalKernel.
  With SSH, do we multiplex tabs onto one remote REPL, or spawn one per tab?
  Default to one-per-tab for consistency; make multiplexing an explicit
  `[kernels.foo] shared = true` config.
- **Postgres client.** This is the biggest standalone library. Could we depend
  on a vendored native binary instead of implementing the wire protocol? Yes,
  but that hurts distribution and SSH-tunnel scenarios. Lean toward pure
  March, budget the time.
