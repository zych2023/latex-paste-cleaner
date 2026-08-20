# Latex Paste Cleaner

[中文说明](README.zh-CN.md)

An Obsidian plugin that automatically cleans up LaTeX formulas when you paste content from web pages or AI chats. It fixes broken formulas (`\\(...\\)` → `$...$`, `\\[...\\]` → `$$...$$`, double escapes, HTML entities, Unicode math symbols, nested corrupted escapes, split command names) while preserving the formatting of your normal text.

> **Status**: submitted to the Obsidian community plugin marketplace (pending review). Until it's listed, install manually with the steps below.

## Features

- **Smart paste interception**: only triggers when the content contains LaTeX math signals; plain text and code pass through completely untouched
- **HTML surgery mode (default)**: replaces only formula nodes with clean LaTeX, preserving bold/lists/etc. of the surrounding text
- **Plain text mode**: inserts everything as plain text (most reliable, no formatting)
- **"Clean up current note" command**: fixes existing broken notes (selection first, otherwise the whole note)
- Unicode math symbols (≥ × α etc.) are converted **only inside math regions** — never in normal text
- `\\[0,2π]` style escaped brackets in headings (not math) are preserved
- **Bilingual UI**: English / 中文, switch in the first settings option

## Install (manual, until marketplace approval)

1. Go to the [Releases page](https://github.com/zych2023/latex-paste-cleaner/releases) and download the latest `latex-paste-cleaner-*.zip` (or the repo as ZIP)
2. Extract the folder `latex-paste-cleaner/`
3. Put the whole folder into your vault's plugins directory:
   - `<your-vault>/.obsidian/plugins/latex-paste-cleaner/`
   - (The `.obsidian` folder is hidden — enable "show hidden files" if you can't see it)
4. Restart Obsidian (or reload: Settings → Community plugins → click "Reload plugins")
5. Obsidian → Settings → **Community plugins** → enable **Latex Paste Cleaner**

> If the plugin doesn't appear in the list, restart Obsidian completely.

## Usage

**Just paste.** When the clipboard contains LaTeX math signals, the plugin cleans the formulas automatically — that's it.

### Fix existing broken notes

1. Open the note with corrupted formulas
2. Open the command palette (`Ctrl+P` / `Cmd+P`)
3. Run **"Clean up current note's LaTeX"** (中文：清理当前笔记的 LaTeX 公式)
   - With a selection: only the selection is cleaned
   - Without a selection: the whole note is cleaned

### Settings

Open Settings → **Community plugins** → **Latex Paste Cleaner**:

| Setting | Description |
|---|---|
| **Language** | 中文 / English — switches all settings text and the command name |
| Enable paste interception | Automatically clean pasted content when it contains math signals. Disable to keep only the manual command. |
| Paste mode | **HTML surgery** (preserve formatting, default) / **Plain text** (most reliable) |
| Fix HTML entities in text regions | Restore `&lt;` → `<` etc. outside math regions. Math regions are always fixed. |

### Known limitation (HTML paste & `$` escaping)

Obsidian's built-in "Convert pasted HTML to Markdown" escapes `$` signs in pasted HTML, which breaks inline math rendering even with this plugin. If formulas don't render after an HTML paste:

- Switch "Paste mode" to **Plain text** in the plugin settings, **or**
- Disable "Convert pasted HTML to Markdown" in Obsidian → Settings → **Editor**

## Development

```bash
cd <plugin-dir>
node tests/test-cleaner.cjs   # 67 tests, no dependencies
```

The plugin is a single `main.js` file (Obsidian's plugin loader does not support relative requires). Core functions are additionally exported for Node testing via a mock `obsidian` module.

## Notes

- Only triggers when the content contains LaTeX command signals (`\frac`, `\\(`, `$$` etc.); plain text pasting is completely unaffected
- The core logic is defensive by design: unknown or ambiguous content is left untouched rather than risk damaging it

## License

MIT
