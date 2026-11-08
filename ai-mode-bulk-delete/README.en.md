# AI Mode · Bulk Delete

[繁體中文](README.md) ｜ [简体中文](README.zh-CN.md) ｜ **English**

Draws checkboxes on the "Recent threads" list in the Google AI Mode sidebar
(`google.com/search?udm=50`), lets you select all of them, and deletes every selected thread in one go.

Free, no limits, and nothing leaves your computer. No backend, no accounts, no tokens.

---

## Why this exists

Similar extensions put bulk delete behind a paywall (5 free deletions, then pay up),
but all they really do is click each row's `⋮` → Delete → Confirm, one after another.
A single content script can do exactly that — no money required.

---

## Install (unpacked)

1. Put the whole `ai-mode-bulk-delete` folder somewhere you won't delete by accident
2. Open Chrome and go to `chrome://extensions`
3. Turn on **Developer mode** (top right)
4. Click **Load unpacked** (top left) and pick the `ai-mode-bulk-delete` folder
5. Pin the toolbar icon (optional)

> Chrome shows a "Disable developer mode extensions" notice on every start — just click **Keep**.

After installing, **reload** any Google page that was already open, otherwise the content script won't be injected.

---

## Usage

1. Open Google AI Mode and expand the "Recent threads" list in the sidebar
2. The panel appears on the right (you can also toggle it from the toolbar icon)
3. Select with the panel, or click the checkboxes that appear on the left of each row
4. Hit **Delete selected** → confirm → wait for it to finish

> The checkboxes make room for themselves by giving each row a left gutter (only `padding-left` is
> touched), so a box never covers the title. Uncheck "Page checkboxes" to restore the original spacing.
> This is resolution- and zoom-independent: everything is computed in CSS pixels with `getBoundingClientRect()`.

> **Duplicate titles** (say two threads both named "Browser Harness") are treated as two separate rows.
> Selection keys off each row's `data-thread-id`, not its title, so "select all" always matches the row
> count, and delete/export handle one row at a time — the second one is never skipped.

What's on the panel:

| Button | What it does |
| --- | --- |
| Select all / Invert / Clear | Selection helpers |
| Rescan | Re-read the list manually |
| Calibrate | When the list can't be found, click one thread to teach it |
| Diagnose | Copy the current DOM info to the clipboard (for bug reports) |
| Delete selected | Start the bulk delete (turns into "Stop" while running) |
| Export list | Save selected titles as a plain-text list (handy before deleting; never produces .md) |
| Export contents | Capture the full conversation of the selected threads as plain text / JSON |
| Load all threads | Auto-scroll to pull in older, lazily-loaded threads |

"Interval" is the wait in milliseconds between items. Default 700 ms; lowering it (e.g. 300) is much
faster, but if Google is slow some items may fail — failures stay in the list so you can re-run them.

### Interface language

The **Language** dropdown switches **Traditional Chinese / Simplified Chinese / English**.
The change is instant and remembered. Export headers, logs and dialogs all follow it.

---

## Exporting conversation contents

Click **Export contents** → choose format / scope → start.

It opens each thread by itself, waits until the text stops changing, copies the conversation area,
and finally writes everything into a single file (not one file per thread).

| Format | Output |
| --- | --- |
| Plain text | One `【n】Title` heading per thread, blank line between paragraphs, two blank lines around headings, list items indented by two spaces |
| JSON | `{ threads: [{ title, url, text }] }` — easy to process in code |

**Source cards and the ad rail are left out.** Google appends a row of "Sources" cards to each answer
(favicon + site name + title + snippet), and the right column sometimes carries sponsored ads.
None of that helps someone who just wants the answer, so it never reaches the exported file.

Detection works by asking "is almost all of this text inside one external link?". Google's source links
are redirects (`www.google.com/url?q=…`), so a `google.com` host is *not* a reason to skip them; cards
built with `role="link"` and no `<a>` at all are recognised too. Links **inside the answer body** are
never stripped — if there's still a real paragraph around the link, it's body text.

Output looks roughly like this:

```
AI Mode Thread Export
Exported: 2026/11/8 12:13 PM
Threads: 3
Source: https://www.google.com/search?udm=50...

──────────────────────────────────────────────

【1】DSH Discord model integration

Yes, DeepSeek Harness (DSH) ships a matching plugin...


Key takeaways

1. Break the requirement into a few small steps.

──────────────────────────────────────────────
```

**Simplified → Traditional** conversion is on by default. Some people type their prompts in Simplified,
or the answers quote Simplified sources; with this on, the exported file never mixes in Simplified
characters. Turn it off if you don't need it.

Things worth knowing:

- **Keep the tab in the foreground** while it runs — background tabs get throttled and capture will fail
- The page keeps jumping around; that's it switching threads, which is expected
- Each thread is captured only once it has really finished: after ~1.2 s of silence it **checks once
  more** for growth, and keeps waiting if the text is still growing — so long answers aren't cut short
- Long answers are scrolled to the bottom and back first, to force not-yet-rendered paragraphs out
- Only if it's still generating after 40 s does it force-stop, and the log marks `⚠ maybe incomplete`
  so you know to re-read that one
- After a long thread it waits a bit longer before clicking the next one, so the page can settle
- If switching to a thread fails once, it **retries by itself** (the log shows `↻ retried once`)
- Only text that is visible on screen is captured — no images, charts or collapsed sections
- Very long conversations with lazy loading may only yield the part that was loaded
- If it grabs the wrong region (the whole page, or the whole sidebar), use **Calibrate contents** in the
  settings window and click the conversation area; from then on it only captures that element

> The conversation area doesn't need calibration up front: it samples several points to the right of the
> sidebar and picks the largest container that excludes it, so `main`, `#main` and full-width wrappers all
> work. Only override with "Calibrate contents" if it genuinely picks the wrong thing.

---

## When the thread list can't be found

Google's class names change constantly, so this extension doesn't rely on them. It tries:

1. The `aria-label` containing "More options" on the right of each row, then walks up to the whole row
2. A structural guess (left side, width, height, vertical stacking, excluding navigation items)
3. Your calibration result

**Calibrate**: click **Calibrate** on the panel → a blue hint appears at the top of the page → click any
**one** thread in the sidebar.

Calibration prefers to remember that row's **class** (shared by every row in the same DOM), falling back
to "ancestor path + tag". If the remembered selector only matches a single row, the extension **discards
it** and returns to auto-detection instead of getting stuck in a broken state.

---

## Privacy

- Reads only the DOM of the page in front of you, and only simulates clicks after you press a button
- No `fetch` to any external server, no analytics, no telemetry
- Settings live in `chrome.storage.local` only
- Never reads cookies or tokens, never touches your passwords

---

## Known limitations

- **Deletion is permanent.** Google has no undo API, and the extension can't bring threads back
- Exported contents are text only — no images or table structure
- Exported files exclude "Sources" cards and the ad rail; if you need those URLs, note them yourself
- Export switches threads, so the page ends up on the last one captured
- Simplified→Traditional is mostly a character map; rare polyphonic/variant cases (e.g. 干 vs 乾) rely on
  a common-word table and can still pick the wrong character
- A Google redesign can break it → hit **Diagnose**, paste the output, and the selectors can be fixed
- Only the "Recent threads" list is supported; the account's "All activity" page is not handled
- You must be signed in already; the extension never signs you in
- Don't run it together with the paid extension — both draw checkboxes on the page

---

## File layout

```
manifest.json          MV3 manifest
content/content.js     all logic (detect, checkboxes, delete engine, export, panel)
content/i18n.js        UI strings for the three languages
content/s2t.js         Simplified → Traditional tables (trimmed OpenCC STCharacters)
popup/                 toolbar popup
icons/                 icons
test/run-test.js       end-to-end test (launches a real Chrome)
test/aimode/fixture.html  fake AI Mode page used by the tests
test/shot.js           screenshot helper
test/make-icons.py     regenerate icons
test/build-s2t.js      regenerate the conversion tables
```

---

## Development

```bash
node test/run-test.js   # full flow in headless Chrome (load → calibrate → single delete → bulk delete)
node test/shot.js       # regenerate preview.png
py test/make-icons.py   # redraw the icons
```

The test copies the extension into a temp folder, rewrites its match pattern to `http://127.0.0.1/*`,
and loads it through CDP's `Extensions.loadUnpacked` (`--load-extension` is unreliable in headless mode).
