import {EditorState} from "@codemirror/state";
import {EditorView, keymap, highlightActiveLine, drawSelection, highlightSpecialChars} from "@codemirror/view";
import {defaultKeymap, history, historyKeymap, indentWithTab} from "@codemirror/commands";
import {LanguageSupport, StreamLanguage, bracketMatching} from "@codemirror/language";
import {tags as t} from "@lezer/highlight";
import {HighlightStyle, syntaxHighlighting} from "@codemirror/language";

// ── March language mode ──────────────────────────────────────────────────
const marchKeywords = new Set(["do","end","fn","pfn","let","match","if","else","mod","type","actor","assert","import","use","with","and","or","not","true","false","in","when"]);
const marchBuiltins = new Set(["println","to_string","spawn","send","receive","panic","self"]);

const marchLang = StreamLanguage.define({
  startState() { return {inString:false,inTriple:false}; },
  token(stream, state) {
    if (state.inTriple) {
      if (stream.match('\"\"\"')) { state.inTriple = false; return "string"; }
      stream.next(); return "string";
    }
    if (state.inString) {
      if (stream.eat("\\\\")) { stream.next(); return "string"; }
      if (stream.eat('"')) { state.inString = false; return "string"; }
      stream.next(); return "string";
    }
    if (stream.match("--")) { stream.skipToEnd(); return "comment"; }
    if (stream.match('\"\"\"')) { state.inTriple = true; return "string"; }
    if (stream.eat('"')) { state.inString = true; return "string"; }
    if (stream.match(/^0[xX][0-9a-fA-F_]+/) || stream.match(/^[0-9][0-9_]*(\.[0-9_]+)?([eE][+-]?[0-9]+)?/)) return "number";
    if (stream.match(/^[|>]{2}|^->|^\+\+|^[=!<>]=|^<-/)) return "operator";
    if (stream.match(/^[+\-*\/%<>=!&|^~@#]/)) return "operator";
    if (stream.match(/^[()[\]{},;:\.]/)) return "punctuation";
    if (stream.match(/^[A-Z][A-Za-z0-9_]*/)) {
      if (stream.eat(".")) return "meta";
      return "type";
    }
    if (stream.match(/^[a-z_][A-Za-z0-9_]*/)) {
      const w = stream.current();
      if (w === "true" || w === "false") return "atom";
      if (marchKeywords.has(w)) return "keyword";
      if (marchBuiltins.has(w)) return "builtin";
      if (stream.peek() === "(") return "def";
      return "variable";
    }
    stream.next();
    return null;
  }
});

const marchHighlight = HighlightStyle.define([
  {tag: t.keyword,                        color: "#c792ea"},
  {tag: t.definition(t.variableName),     color: "var(--acc)"},
  {tag: t.variableName,                   color: "var(--code-text)"},
  {tag: t.typeName,                       color: "#FBBF24"},
  {tag: t.string,                         color: "#c3e88d"},
  {tag: t.number,                         color: "#f78c6c"},
  {tag: t.comment,                        color: "#546e7a", fontStyle: "italic"},
  {tag: t.operator,                       color: "#89ddff"},
  {tag: t.punctuation,                    color: "#89ddff"},
  {tag: t.meta,                            color: "#82aaff"},
  {tag: t.atom,                           color: "#f78c6c"},
  {tag: t.standard(t.name),               color: "var(--acc)"},
]);

// ── Editor factory ──────────────────────────────────────────────────────
const editors = new Map(); // idx -> EditorView

window._cmEditors = editors;

window.createCMEditor = function(container, idx, source, onChange) {
  if (editors.has(idx)) { editors.get(idx).destroy(); editors.delete(idx); }
  const updateListener = EditorView.updateListener.of(update => {
    if (update.docChanged && onChange) onChange(update.state.doc.toString());
  });
  // Notebook keybindings: Cmd/Ctrl+Enter, Shift+Enter, Escape
  const notebookKeymap = keymap.of([
    {key: "Mod-Enter", run: () => {
      const cell = window._nbCells && window._nbCells[idx];
      if (cell && cell.kind === "code" && window.runCell) window.runCell(idx);
      else if (cell && cell.kind === "server" && window.startServer) window.startServer(idx);
      return true;
    }},
    {key: "Shift-Enter", run: () => {
      const cell = window._nbCells && window._nbCells[idx];
      if (cell && cell.kind === "code" && window.runCell) window.runCell(idx);
      const nextIdx = idx + 1;
      if (window._nbCells && nextIdx < window._nbCells.length) {
        setTimeout(() => { if (window.focusCM) window.focusCM(nextIdx); }, 30);
      } else if (window.addCell) {
        window.addCell("code", idx);
      }
      return true;
    }},
    {key: "Escape", run: () => {
      if (window.cmdSelect) window.cmdSelect(idx, false);
      return true;
    }},
  ]);
  const view = new EditorView({
    state: EditorState.create({
      doc: source || "",
      extensions: [
        highlightSpecialChars(),
        history(),
        drawSelection(),
        highlightActiveLine(),
        bracketMatching(),
        new LanguageSupport(marchLang),
        syntaxHighlighting(marchHighlight),
        notebookKeymap,
        keymap.of([...defaultKeymap, ...historyKeymap, indentWithTab]),
        updateListener,
        EditorView.lineWrapping,
        EditorState.tabSize.of(2),
      ]
    }),
    parent: container,
  });
  editors.set(idx, view);
  return view;
};

window.getCMValue = function(idx) {
  const v = editors.get(idx);
  return v ? v.state.doc.toString() : null;
};

window.focusCM = function(idx) {
  const v = editors.get(idx);
  if (v) { v.focus(); v.dispatch({selection:{anchor:v.state.doc.length}}); }
};

window.destroyCM = function(idx) {
  const v = editors.get(idx);
  if (v) { v.destroy(); editors.delete(idx); }
};

window._cmReady = true;
// Signal to the main script that CM is loaded
if (window._onCMReady) window._onCMReady();
