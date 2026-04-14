# Scroll

Interactive notebook for March — Livebook-style in the browser.

Notebooks are plain Markdown files (`.scrollmd`) with fenced March code blocks. Open them in the browser, run cells interactively, and save changes back to disk.

## Installation

Scroll is installed as a forge archive. From a local checkout:

```bash
forge install scroll@/path/to/scroll
```

Or from git:

```bash
forge install scroll@https://github.com/march-lang/scroll
```

## Usage

### Start a notebook server

```bash
# Open an existing notebook
forge scroll.serve mynotebook.scrollmd

# Create a new notebook (opens a blank one in the browser)
forge scroll.serve

# Specify a port (default: 4040)
forge scroll.serve mynotebook.scrollmd --port 8080
```

## Notebook format

A `.scrollmd` file is standard Markdown. Code cells use fenced March blocks:

````markdown
# My Notebook

Some prose here.

```march
let x = 6 * 7
```

```march
x
```
````

- **Markdown cells** — rendered as HTML in the browser
- **Code cells** — run in sequence; each cell sees bindings from earlier cells
- **`let` bindings** are silent (no auto-print), just like a REPL assignment
- **Plain expressions** auto-print their value if non-unit

### Server cells

Long-running processes (HTTP servers, background workers) use the `march:server` fence:

````markdown
```march:server
HttpServer.start(3000)
```
````

Server cells run as background processes with Start/Stop controls in the UI.

## Running tests

```bash
cd /path/to/scroll
forge test
```

## Development

After editing `lib/scroll.march`, changes are live immediately — no reinstall needed when installed as a path archive (`forge install scroll@./`).
