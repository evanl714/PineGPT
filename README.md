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
- **Model picker** — type any OpenRouter model id, or press ↻ to load the
  live model list and search it.
- **Autosave** — the draft, key, and settings persist in `localStorage`.
  Download the draft as Markdown anytime.

## Privacy

Your API key and draft never leave your browser except as direct HTTPS
requests to `openrouter.ai`. There is no backend and no telemetry.

## Files

| File | Purpose |
| --- | --- |
| `index.html` | Layout: sidebar, toolbar, editor, suggestion panel |
| `style.css` | Theming (follows system light/dark) |
| `app.js` | OpenRouter streaming, prompts, editor logic |
