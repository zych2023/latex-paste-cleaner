# Latex Paste Cleaner

[中文说明](README.zh-CN.md)

Automatically cleans up LaTeX formulas when pasting from web pages or AI chats into Obsidian. Fixes broken formulas (`\\(...\\)` → `$...$`, `\\[...\\]` → `$$...$$`, double escapes, HTML entities, Unicode math symbols, nested corrupted escapes) while preserving the formatting of normal text.

## Why

Copying math content from web pages (MathJax/KaTeX rendered) or AI chats often produces badly corrupted LaTeX:

- `\\(x^2\\)` / `\\[\\int dx\\]` (double-escaped delimiters)
- `$\\boldsymbol{\\(\\boldsymbol{\\(y=x\\)}\\)}$` (nested corrupted escapes from HTML rendering interleaving)
- `\\bol\\(\\mathrm{d}s\\)ymbol{...}` (command names split by interleaved formulas)
- `&times;`, `&le;` (HTML entities)
- `≥`, `×`, `α` (Unicode math symbols)
- Bare `[ ... ]` display math, unpaired/misordered delimiters

This plugin detects math regions in pasted text, cleans them thoroughly, and leaves everything else untouched.

## Features

- **Smart paste interception**: only triggers when the content contains LaTeX signals; plain text/code passes through completely untouched
- **HTML surgery mode (default)**: replaces only formula nodes with clean LaTeX, preserving bold/lists/etc. of the surrounding text
- **Plain text mode**: inserts everything as plain text (most reliable, no formatting)
- **"Clean up current note" command**: fixes existing notes (selection first, otherwise the whole note)
- Unicode math symbols (≥ × α etc.) are converted **only inside math regions** — never in normal text
- `\\[0,2π]` style escaped brackets in headings (not math) are preserved

## Install

1. Copy the `latex-paste-cleaner/` folder into your vault's `.obsidian/plugins/`
2. Obsidian → Settings → Community plugins → enable "Latex Paste Cleaner"
3. No restart needed (restart Obsidian if the list doesn't refresh)

## Usage

Just paste. When the clipboard contains LaTeX math signals, the plugin cleans the formulas automatically.

To fix existing broken notes: open the note → Command palette (Ctrl+P) → "清理当前笔记的 LaTeX 公式" (Clean up current note's LaTeX).

### Settings

| Setting | Description |
|---|---|
| Enable paste interception | Automatically clean when pasted content contains math signals. Disable to keep only the manual command. |
| Paste mode | HTML surgery (preserve formatting, default) / Plain text (most reliable) |
| Fix HTML entities in text regions | Restore `&lt;` → `<` etc. outside math regions. Math regions are always fixed. |

> **Note on HTML paste**: Obsidian's built-in "Convert pasted HTML to Markdown" escapes `$` signs in pasted HTML, which breaks inline math rendering even with this plugin. If formulas don't render after an HTML paste, either switch to "Plain text" paste mode in the plugin settings, or disable "Convert pasted HTML to Markdown" in Obsidian → Settings → Editor.

## Development

```bash
cd .obsidian/plugins/latex-paste-cleaner
node tests/test-cleaner.cjs   # 67 tests, no dependencies
```

The plugin is a single `main.js` file (Obsidian's plugin loader does not support relative requires). Core functions are additionally exported for Node testing via a mock `obsidian` module.

## Notes

- Only triggers when content contains LaTeX command signals (`\frac`, `\\(`, `$$` etc.); plain text pasting is completely unaffected
- The core logic is defensive by design: unknown or ambiguous content is left untouched rather than risk damaging it

## License

MIT
