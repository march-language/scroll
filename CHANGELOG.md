# Changelog

All notable changes to Scroll are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and Scroll adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.2] - 2026-07-30

### Changed

- **`bastion` now comes from the forge registry, pinned to 0.2.4**, instead of
  tracking its `main` branch over git. 0.1.1 shipped
  `bastion = { git = …, branch = "main" }`, which meant every install picked up
  whatever bastion's `main` happened to be that day. The dependency is now the
  published [bastion 0.2.4](https://forgepm.org/packages/bastion?tab=versions) —
  the exact version this release was tested against.

- **`depot` is declared again** — reluctantly, and for a different reason than
  the one 0.1.1 removed. Scroll does not use depot; it is bastion's dependency.
  Forge does not resolve the transitive dependencies of a **registry**
  dependency: `forge deps` fetches bastion's tarball and stops, so bastion's own
  `Depot.Middleware` fails to compile with `Module Pool not found`. A **git**
  dependency does recurse, which is why 0.1.1 could drop the line. Verified by
  purging both from the CAS and re-resolving each way. The declaration can go
  once forge resolves registry deps transitively.

## [0.1.1] - 2026-07-30

### Fixed

- **`bastion` is fetched from git instead of a hard-coded local path.**
  `forge.toml` declared `bastion = { path = "/Users/…/code/bastion" }` — an
  absolute path on one maintainer's machine. Every other install resolved
  nothing, so `forge install https://github.com/march-language/scroll` (the
  command this README advertises) failed with `Unknown module Router` /
  `Middleware` / `Static`. Now declared as a git dependency, verified from a
  clean clone with no local checkout present.

- **Assets are located from `argv`, not the first `MARCH_LIB_PATH` entry.**
  `asset_root()` assumed the leading entry was scroll's own `lib/`, but forge
  puts dependency lib dirs first. With any dependency declared it resolved to
  the wrong directory and 404'd every CSS/JS file — which silently broke the
  WebSocket too, since the browser never loaded the JS that opens it. The
  notebook just sat at "connecting" forever with no error anywhere.

- **Module collision with `bastion`.** Scroll's `Session` module collided with
  `Bastion.Session` (which bastion aliases to `Session` internally), so the
  linker resolved `Session.ws_loop` to the wrong module and the build failed
  with an undefined symbol. Renamed to `WsSession`.

- **`File.write`'s `FileError` was concatenated as a raw `String`**, a
  typecheck error in `lib/scroll.march` and `test/test_scroll.march`.

- **Stale `start_run_proc` test** asserted end-to-end behaviour that moved to
  `session.march` several refactors ago; rewritten against the stub's actual
  contract.

### Changed

- **Dropped the direct `depot` dependency.** It was only ever declared to work
  around a forge bug where `forge test` resolved direct dependencies but not
  transitive ones, so `bastion`'s own `depot` dependency went missing under
  `test` while `check`/`build` were fine. Fixed upstream in
  [march#127](https://github.com/march-language/march/pull/127); scroll does
  not use `depot` itself.

- **Reverted the `()` → `None` stub workaround** in `lib/processes.march`.
  Those three no-op stubs returned `None` because returning unit crashed the
  compiled binary. The cause was never the "cross-module dispatch" bug the
  comments claimed — it was a parser bug that glued a line holding only `()`
  onto the previous line, turning `let _ = x` + `()` into a call of `x`. Fixed
  upstream in [march#129](https://github.com/march-language/march/pull/129),
  so the stubs return `()` again and the misleading comments are gone.

### Notes

- Requires a March toolchain containing march#127 and march#129 — see
  [Requirements](README.md#requirements).
- Two compiler bugs found while getting this release green were fixed upstream:
  [march#120](https://github.com/march-language/march/pull/120) (an ESeq
  codegen bug that discarded a tail call's result, crashing `BlobParser.parse`)
  and [march#125](https://github.com/march-language/march/pull/125) (an idle
  WebSocket blocking every other connection in the interpreter's event loop —
  one open notebook tab froze the whole dev server).

## [0.1.0]

Initial release.

[Unreleased]: https://github.com/march-language/scroll/compare/v0.1.2...HEAD
[0.1.2]: https://github.com/march-language/scroll/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/march-language/scroll/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/march-language/scroll/releases/tag/v0.1.0
