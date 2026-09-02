import EditorWorker from "monaco-editor/esm/vs/editor/editor.worker?worker";
import * as monaco from "monaco-editor/esm/vs/editor/editor.api";
import "monaco-editor/esm/vs/basic-languages/monaco.contribution";
import "monaco-editor/esm/vs/editor/contrib/bracketMatching/browser/bracketMatching";
import "monaco-editor/esm/vs/editor/contrib/caretOperations/browser/caretOperations";
import "monaco-editor/esm/vs/editor/contrib/clipboard/browser/clipboard";
import "monaco-editor/esm/vs/editor/contrib/comment/browser/comment";
import "monaco-editor/esm/vs/editor/contrib/contextmenu/browser/contextmenu";
import "monaco-editor/esm/vs/editor/contrib/find/browser/findController";
import "monaco-editor/esm/vs/editor/contrib/folding/browser/folding";
import "monaco-editor/esm/vs/editor/contrib/format/browser/formatActions";
import "monaco-editor/esm/vs/editor/contrib/gotoError/browser/gotoError";
import "monaco-editor/esm/vs/editor/contrib/hover/browser/hoverContribution";
import "monaco-editor/esm/vs/editor/contrib/linesOperations/browser/linesOperations";
import "monaco-editor/esm/vs/editor/contrib/multicursor/browser/multicursor";
import "monaco-editor/esm/vs/editor/contrib/suggest/browser/suggestController";
import "monaco-editor/esm/vs/editor/contrib/wordHighlighter/browser/wordHighlighter";
import "monaco-editor/esm/vs/editor/contrib/wordOperations/browser/wordOperations";

if (typeof self !== "undefined") {
  self.MonacoEnvironment = {
    ...self.MonacoEnvironment,
    getWorker() {
      return new EditorWorker();
    },
  };
}

let registered = false;

export function loadRadishMonaco() {
  if (!registered) {
    registerRadishLanguage();
    registered = true;
  }
  return monaco;
}

function registerRadishLanguage() {
  monaco.languages.register({
    id: "radish",
    aliases: ["Radish", "radish"],
    extensions: [".rad"],
  });
  monaco.languages.setLanguageConfiguration("radish", {
    comments: { lineComment: "#" },
    indentationRules: {
      increaseIndentPattern: /^\s*(?:Workflow|Node\s+[A-Za-z][A-Za-z0-9-]*|with|needs|to|inputs|outputs|environment)\s*:\s*(?:#.*)?$/i,
      decreaseIndentPattern: /^\s*(?:Radish|Workflow|Node\s+[A-Za-z][A-Za-z0-9-]*)\b/i,
    },
    onEnterRules: [
      {
        beforeText: /^\s*(?:Workflow|Node\s+[A-Za-z][A-Za-z0-9-]*|with|needs|to|inputs|outputs|environment)\s*:\s*(?:#.*)?$/i,
        action: { indentAction: monaco.languages.IndentAction.Indent },
      },
    ],
  });
  monaco.languages.setMonarchTokensProvider("radish", {
    defaultToken: "",
    ignoreCase: true,
    tokenizer: {
      root: [
        [/^\s*(Radish)(\s*:)/, ["keyword.radish", "delimiter"]],
        [/^\s*(Workflow)(\s*:)/, ["keyword.radish", "delimiter"]],
        [/^\s*(Node)(\s+)([A-Za-z][A-Za-z0-9-]*)(\s*:)/, ["keyword.radish", "", "type.identifier", "delimiter"]],
        [/#.*$/, "comment"],
        [/\{\{[^}]+\}\}/, "variable.predefined"],
        [/"(?:\\.|[^"\\])*"/, "string"],
        [/\b(?:true|false|null)\b/, "constant"],
        [/\b\d+(?:\.\d+)?(?:ms|s|m|h|d)?\b/, "number"],
        [/\b(?:and|or|not|contains|matches|exists|is)\b/, "keyword.operator"],
        [/(?:==|!=|<=|>=|<|>)/, "operator"],
        [/\b(?:agent|bash-command|python-script|prompt-file|file|folder|open-resource|http-request|notification|approval-gate|local-search|local-vectorize|common-llm-task|loop|break|workflow)\b/, "type"],
        [/^\s*([A-Za-z][A-Za-z0-9-]*)(\s*:)/, ["attribute.name", "delimiter"]],
        [/[{},]/, "delimiter"],
      ],
    },
  });
  monaco.editor.defineTheme("gofer-radish-light", {
    base: "vs",
    inherit: true,
    colors: {
      "editor.background": "#fbfbfc",
      "editor.lineHighlightBackground": "#4f46e512",
      "editorGutter.background": "#fbfbfc",
    },
    rules: [
      { token: "keyword.radish", foreground: "6D28D9", fontStyle: "bold" },
      { token: "type.identifier", foreground: "18181B", fontStyle: "bold" },
      { token: "attribute.name", foreground: "2563EB" },
      { token: "type", foreground: "0E7490", fontStyle: "bold" },
      { token: "variable.predefined", foreground: "0E7490" },
      { token: "string", foreground: "15803D" },
      { token: "number", foreground: "B45309" },
      { token: "keyword.operator", foreground: "7C3AED", fontStyle: "bold" },
      { token: "operator", foreground: "7C3AED" },
      { token: "comment", foreground: "8A8A93", fontStyle: "italic" },
    ],
  });
  monaco.editor.defineTheme("gofer-radish-dark", {
    base: "vs-dark",
    inherit: true,
    colors: {
      "editor.background": "#19191b",
      "editor.lineHighlightBackground": "#6366F124",
      "editorGutter.background": "#19191b",
    },
    rules: [
      { token: "keyword.radish", foreground: "C4B5FD", fontStyle: "bold" },
      { token: "type.identifier", foreground: "F4F4F5", fontStyle: "bold" },
      { token: "attribute.name", foreground: "93C5FD" },
      { token: "type", foreground: "67E8F9", fontStyle: "bold" },
      { token: "variable.predefined", foreground: "67E8F9" },
      { token: "string", foreground: "86EFAC" },
      { token: "number", foreground: "FCD34D" },
      { token: "keyword.operator", foreground: "C4B5FD", fontStyle: "bold" },
      { token: "operator", foreground: "C4B5FD" },
      { token: "comment", foreground: "71717A", fontStyle: "italic" },
    ],
  });
}
