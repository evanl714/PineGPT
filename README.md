# CoWriter

A minimal AI cowriting tool that runs entirely in your browser and talks
directly to [OpenRouter](https://openrouter.ai) — no server, no build step,
no dependencies.

## Quick start

1. Get an API key at [openrouter.ai/keys](https://openrouter.ai/keys).
2. Open `index.html` in a browser (double-clicking the file works), or serve
   the folder:

   ```sh
   python3 -m http.server 8080
   # then visit http://localhost:8080
   ```

3. Paste your key in the sidebar, pick a model, and start writing.

## Features

- **Continue** (`Ctrl`/`Cmd`+`Enter`) — the model picks up from your cursor,
  matching the draft's tone and voice. If text follows the cursor, the
  continuation is asked to bridge into it.
- **Direction ("Next:" bar)** — type what should happen next ("Marla finally
  leaves the house") and Continue renders it as prose. The direction is
  appended at the very end of the prompt, where models weight it most, and it
  also activates matching lorebook entries. It clears automatically once a
  continuation is accepted; Enter in the field triggers Continue.
- **Generation length** — a toolbar selector controls how much Continue
  writes per press: one sentence, 2–4 sentences, one paragraph, 1–3
  paragraphs (default), or 4–6 paragraphs. Applies on top of a system
  prompt override; rewrites are unaffected.
- **Formatting** — generated prose puts each speaker's dialogue in its own
  paragraph (toggleable), marks scene breaks with `***` lines, and opens
  chapters with "Chapter N" lines. Toolbar Insert buttons add a scene break
  or the next auto-numbered chapter heading at the cursor.
- **Structure-aware references** — the app parses "Chapter N" headings and
  `***` breaks into a chapter/scene map. Reference "chapter 2, scene 3" in
  the Next: bar and that passage is sent to the model as labeled reference
  text — a live indicator shows what the reference resolves to (or warns if
  it doesn't exist). A scene number alone resolves within the chapter the
  cursor is in, and the model is told where the insertion point sits.
- **Selection tools** — select any passage and hit **Improve**, **Shorten**,
  **Expand**, or type a custom instruction ("make this angrier", "turn into
  dialogue") and press **Apply**.
- **Accept / Retry / Discard** — suggestions stream into a review panel and
  never touch your draft until you accept them. `Esc` dismisses.
- **Style notes** — standing instructions (POV, tense, banned words, genre)
  sent with every request.
- **Context management** — **Story notes** hold canon facts (characters,
  setting, plot so far) that accompany every request; **Summarize draft into
  notes** has the model compress your draft into a synopsis you review and
  accept into those notes; a **context size** setting (small/medium/large/
  entire draft) controls how much recent draft is sent; and a live **context
  meter** shows exactly how much of the draft the model will see, warning
  when earlier text has fallen out of the window.
- **Lorebook** — entries for characters, places, and facts, each with
  comma-separated tags. An entry is injected (as canon) only when one of its
  tags appears in the text actually being sent, so lore costs tokens only
  when it's relevant. Tag matching is word-boundary aware and
  case-insensitive; entries with no tags are always included; entries can be
  toggled off without deleting them. The sidebar shows how many entries
  match the current context. Three AI tools live in the lorebook: **Fill
  from draft** writes an entry from what the draft establishes (extractive,
  no invention), **Invent details** expands an entry with consistent
  invented specifics, and **Scan draft for entries** proposes ready-made
  entries for recurring subjects not yet covered — all reviewed in the
  suggestion panel before anything is saved.
- **Mature content toggle** — adds standing permission for explicit content
  to every request. Whether a model honors it depends on the model's own
  policies; pick accordingly.
- **System prompt override** — replaces the built-in Continue/rewrite
  instructions with your own, while lorebook, story notes, style notes, and
  the mature clause still layer on top.
- **Model picker** — type any OpenRouter model id, or press ↻ to load the
  live model list and search it.
- **Autosave** — the draft, key, and settings persist in `localStorage`.
  Download the draft as Markdown anytime.
- **Move between devices** — **Export/Import project** bundles the draft,
  notes, lorebook, and settings into one .json file; **GitHub Gist sync**
  saves that bundle to a private gist so you can ↑ Save on one device and
  ↓ Load on another (paste a token with the gist scope once per device).
  The OpenRouter API key never leaves the device either way.

## Privacy

Your API key and draft never leave your browser except as direct HTTPS
requests to `openrouter.ai`. There is no backend and no telemetry.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Layout: sidebar, toolbar, editor, suggestion panel |
| `style.css` | Theming (follows system light/dark) |
| `app.js` | OpenRouter streaming, prompts, editor logic |
