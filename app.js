'use strict';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CONTEXT_AFTER = 4000;      // chars of draft sent after the cursor
const SUMMARIZE_LIMIT = 120000;  // max chars of draft sent to the summarizer
const STORE = { key: 'cw_key', model: 'cw_model', temp: 'cw_temp', style: 'cw_style', doc: 'cw_doc', story: 'cw_story', ctx: 'cw_ctx', lore: 'cw_lore', dir: 'cw_dir' };

const $ = (s) => document.querySelector(s);
const els = {
  key: $('#apiKey'), showKey: $('#showKey'),
  model: $('#model'), modelList: $('#modelList'), refreshModels: $('#refreshModels'), modelHint: $('#modelHint'),
  temp: $('#temp'), tempVal: $('#tempVal'),
  style: $('#styleNotes'), story: $('#storyNotes'), btnSummarize: $('#btnSummarize'),
  ctxSize: $('#ctxSize'), ctxMeter: $('#ctxMeter'), editor: $('#editor'), direction: $('#direction'),
  btnLore: $('#btnLore'), loreCount: $('#loreCount'), loreHint: $('#loreHint'),
  loreModal: $('#loreModal'), loreAdd: $('#loreAdd'), loreClose: $('#loreClose'),
  loreList: $('#loreList'), loreEditor: $('#loreEditor'), loreEmpty: $('#loreEmpty'),
  loreName: $('#loreName'), loreTags: $('#loreTags'), loreContent: $('#loreContent'),
  loreDelete: $('#loreDelete'),
  wordCount: $('#wordCount'), saveState: $('#saveState'), download: $('#download'),
  btnContinue: $('#btnContinue'), btnImprove: $('#btnImprove'), btnShorten: $('#btnShorten'),
  btnExpand: $('#btnExpand'), customInstr: $('#customInstr'), btnCustom: $('#btnCustom'),
  panel: $('#panel'), panelTitle: $('#panelTitle'), panelBody: $('#panelBody'),
  panelActions: $('#panelActions'), btnAccept: $('#btnAccept'), btnRetry: $('#btnRetry'),
  btnDiscard: $('#btnDiscard'), btnStop: $('#btnStop'),
};

let controller = null;   // AbortController for the in-flight request
let lastTask = null;     // { kind, instruction, selStart, selEnd, cursor } for Retry/Accept
let suggestion = '';     // accumulated streamed text

/* ---------- Persistence ---------- */

function loadState() {
  els.key.value = localStorage.getItem(STORE.key) || '';
  els.model.value = localStorage.getItem(STORE.model) || 'anthropic/claude-sonnet-4.5';
  els.temp.value = localStorage.getItem(STORE.temp) || '0.8';
  els.style.value = localStorage.getItem(STORE.style) || '';
  els.story.value = localStorage.getItem(STORE.story) || '';
  els.ctxSize.value = localStorage.getItem(STORE.ctx) || '24000';
  els.direction.value = localStorage.getItem(STORE.dir) || '';
  els.editor.value = localStorage.getItem(STORE.doc) || '';
  els.tempVal.textContent = els.temp.value;
  const end = els.editor.value.length;
  els.editor.setSelectionRange(end, end);
  updateWordCount();
  updateCtxMeter();
  renderLoreList();
  updateLoreUI();
}

let saveTimer = null;
function saveDoc() {
  clearTimeout(saveTimer);
  els.saveState.textContent = '…';
  saveTimer = setTimeout(() => {
    localStorage.setItem(STORE.doc, els.editor.value);
    els.saveState.textContent = 'saved';
    setTimeout(() => { if (els.saveState.textContent === 'saved') els.saveState.textContent = ''; }, 1500);
  }, 400);
}

function updateWordCount() {
  const words = (els.editor.value.match(/\S+/g) || []).length;
  els.wordCount.textContent = `${words} word${words === 1 ? '' : 's'}`;
}

function ctxLimit() {
  return parseInt(els.ctxSize.value, 10) || Infinity; // 0 = entire draft
}

function countWords(text) {
  return (text.match(/\S+/g) || []).length;
}

function updateCtxMeter() {
  const doc = els.editor.value;
  const limit = ctxLimit();
  els.ctxMeter.classList.remove('warn');
  if (!doc.trim()) {
    els.ctxMeter.textContent = 'Nothing to send yet.';
  } else if (doc.length <= limit) {
    els.ctxMeter.textContent = `Entire draft (${countWords(doc)} words) goes with each request, plus notes.`;
  } else {
    const sent = countWords(doc.slice(doc.length - limit));
    els.ctxMeter.textContent = `Sending the last ~${sent} of ${countWords(doc)} words. Earlier text is invisible to the model — use Summarize to keep Story notes current.`;
    els.ctxMeter.classList.add('warn');
  }
}

/* ---------- Lorebook ---------- */

let lore = (() => {
  try { return JSON.parse(localStorage.getItem(STORE.lore)) || []; } catch { return []; }
})();
let loreEditingId = null;

function saveLore() {
  localStorage.setItem(STORE.lore, JSON.stringify(lore));
}

function tagMatches(tag, text) {
  const esc = tag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Unicode-aware word boundaries so tags like "Ilsa" don't fire inside "Ailsa".
  return new RegExp(`(?:^|[^\\p{L}\\p{N}])${esc}(?:[^\\p{L}\\p{N}]|$)`, 'iu').test(text);
}

function entryTags(e) {
  return e.tags.split(',').map((t) => t.trim()).filter(Boolean);
}

// Entries that apply to the given text: enabled, with content, and either
// tagless (always on) or with at least one tag present in the text.
function matchLore(text) {
  return lore.filter((e) => e.enabled && e.content.trim()
    && (entryTags(e).length === 0 || entryTags(e).some((t) => tagMatches(t, text))));
}

function loreBlock(entries) {
  if (!entries.length) return '';
  return 'Lorebook — canon reference for people, places, and things that appear in the passage:\n\n'
    + entries.map((e) => `### ${e.name}\n${e.content.trim()}`).join('\n\n');
}

function renderLoreList() {
  els.loreList.replaceChildren(...lore.map((e) => {
    const li = document.createElement('li');
    li.className = (e.id === loreEditingId ? 'active ' : '') + (e.enabled ? '' : 'off');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = e.enabled;
    cb.title = 'Enable/disable entry';
    cb.addEventListener('click', (ev) => {
      ev.stopPropagation();
      e.enabled = cb.checked;
      saveLore();
      updateLoreUI();
    });
    const text = document.createElement('div');
    text.className = 'lore-item-text';
    const name = document.createElement('span');
    name.className = 'lore-name';
    name.textContent = e.name || '(unnamed)';
    const tags = document.createElement('span');
    tags.className = 'lore-tags';
    tags.textContent = entryTags(e).join(', ') || 'always included';
    text.append(name, tags);
    li.append(cb, text);
    li.addEventListener('click', () => selectLoreEntry(e.id));
    return li;
  }));
  els.loreEmpty.hidden = lore.length > 0;
}

function selectLoreEntry(id) {
  loreEditingId = id;
  const e = lore.find((x) => x.id === id);
  els.loreEditor.hidden = !e;
  if (e) {
    els.loreName.value = e.name;
    els.loreTags.value = e.tags;
    els.loreContent.value = e.content;
  }
  renderLoreList();
}

// The idle hint approximates a request from the end of the draft.
function updateLoreUI() {
  els.loreCount.textContent = lore.length;
  if (!lore.length) {
    els.loreHint.textContent = 'Entries whose tags appear in the sent context are included automatically.';
  } else {
    const doc = els.editor.value;
    const limit = ctxLimit();
    const scan = doc.slice(Math.max(0, doc.length - Math.min(limit, doc.length)));
    const n = matchLore(scan).length;
    els.loreHint.textContent = `${n} of ${lore.length} ${lore.length === 1 ? 'entry' : 'entries'} match the current context.`;
  }
}

/* ---------- Model list ---------- */

async function fetchModels() {
  els.refreshModels.disabled = true;
  els.modelHint.textContent = 'Loading models…';
  try {
    const res = await fetch(MODELS_URL);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    const ids = (data.data || []).map((m) => m.id).sort();
    els.modelList.replaceChildren(...ids.map((id) => {
      const opt = document.createElement('option');
      opt.value = id;
      return opt;
    }));
    els.modelHint.textContent = `${ids.length} models loaded — type to search.`;
  } catch (err) {
    els.modelHint.textContent = `Could not load models: ${err.message}`;
  } finally {
    els.refreshModels.disabled = false;
  }
}

/* ---------- Prompt building ---------- */

function systemPrompt(kind, loreText) {
  if (kind === 'summarize') {
    return 'You are an expert story editor building a working synopsis for the author\u2019s own reference. '
      + 'From the draft you are given, produce compact notes covering: the characters and their key traits and '
      + 'relationships; the setting; the plot events in order; and any open threads or unresolved questions. '
      + 'Be specific about names and facts, stay under 300 words, and output only the notes \u2014 no preamble, '
      + 'no commentary.';
  }
  const base = kind === 'continue'
    ? 'You are an expert co-writer. Continue the draft seamlessly from exactly where it leaves off. '
      + 'Match the existing tone, voice, tense, point of view, and formatting. Never repeat or rephrase text '
      + 'that is already in the draft, never summarize, and never add commentary, headings, or quotation marks '
      + 'around your output. Write only the continuation itself — a natural stretch of one to three paragraphs '
      + 'unless the form of the draft clearly calls for something else (dialogue, verse, a list, etc.).'
    : 'You are an expert editor. Rewrite the passage the user gives you according to their instruction. '
      + 'Preserve the meaning and any formatting (paragraph breaks, markdown) unless the instruction says otherwise, '
      + 'and match the tone of the surrounding draft. Output only the rewritten passage — no commentary, no quotation '
      + 'marks around it, no explanation of your changes.';
  let out = base;
  if (loreText) out += '\n\n' + loreText;
  const story = els.story.value.trim();
  if (story && kind !== 'summarize') {
    out += `\n\nEstablished story/project notes — treat these as canon even if the draft excerpt does not mention them:\n${story}`;
  }
  const style = els.style.value.trim();
  if (style) out += `\n\nStanding style notes from the author:\n${style}`;
  return out;
}

function directionBlock(direction) {
  return '\n\nAuthorial direction — the passage you write next must depict this happening:\n'
    + direction
    + '\nFollow the direction faithfully, but render it as prose in the draft\u2019s voice; never quote it or acknowledge it as an instruction.';
}

function continueUserMessage(before, after, direction) {
  let msg = 'Here is my draft, up to the point where I need you to continue:\n\n'
    + '<draft>\n' + before + '\n</draft>\n\n';
  if (after.trim()) {
    msg += 'The draft resumes AFTER the insertion point with the following text, so your continuation must '
      + 'bridge into it naturally without repeating it:\n\n<later_text>\n' + after + '\n</later_text>\n\n';
  }
  msg += 'Continue writing from the exact end of the draft.';
  if (direction) msg += directionBlock(direction);
  return msg;
}

function rewriteUserMessage(instruction, passage, before, after) {
  let msg = `Instruction: ${instruction}\n\n`;
  const ctx = (before || after)
    ? `For tone and continuity, here is the surrounding draft.\nBefore the passage:\n<before>\n${before}\n</before>\nAfter the passage:\n<after>\n${after}\n</after>\n\n`
    : '';
  return msg + ctx + 'The passage to rewrite:\n\n<passage>\n' + passage + '\n</passage>';
}

/* ---------- OpenRouter streaming ---------- */

async function streamCompletion(messages, onDelta) {
  const key = els.key.value.trim();
  if (!key) throw new Error('Add your OpenRouter API key in the sidebar first.');
  const model = els.model.value.trim();
  if (!model) throw new Error('Pick a model in the sidebar first.');

  controller = new AbortController();
  const res = await fetch(API_URL, {
    method: 'POST',
    signal: controller.signal,
    headers: {
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'X-Title': 'CoWriter',
    },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      temperature: parseFloat(els.temp.value),
    }),
  });

  if (!res.ok) {
    let detail = '';
    try { detail = (await res.json()).error?.message || ''; } catch { /* ignore */ }
    throw new Error(`OpenRouter returned ${res.status}${detail ? `: ${detail}` : ''}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep any partial line for the next chunk
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue; // skips SSE comments/keepalives
      const payload = line.slice(6).trim();
      if (payload === '[DONE]') return;
      let json;
      try { json = JSON.parse(payload); } catch { continue; }
      if (json.error) throw new Error(json.error.message || 'Model returned an error mid-stream.');
      const delta = json.choices?.[0]?.delta?.content;
      if (delta) onDelta(delta);
    }
  }
}

/* ---------- Task orchestration ---------- */

function setBusy(busy) {
  for (const b of [els.btnContinue, els.btnImprove, els.btnShorten, els.btnExpand, els.btnCustom, els.btnSummarize]) {
    const needsSelection = b !== els.btnContinue && b !== els.btnSummarize;
    b.disabled = busy || (needsSelection && !hasSelection());
  }
}

function hasSelection() {
  return els.editor.selectionStart !== els.editor.selectionEnd;
}

function openPanel(title) {
  els.panelTitle.textContent = title;
  els.panelBody.textContent = '';
  els.panelBody.classList.remove('error');
  els.panelBody.classList.add('cursor-blink');
  els.panelActions.hidden = true;
  els.btnStop.hidden = false;
  els.panel.hidden = false;
}

function closePanel() {
  els.panel.hidden = true;
  suggestion = '';
}

async function runTask(task) {
  lastTask = task;
  suggestion = '';
  const doc = els.editor.value;
  let messages;

  if (task.kind === 'summarize') {
    messages = [
      { role: 'system', content: systemPrompt('summarize') },
      { role: 'user', content: 'Here is the draft:\n\n<draft>\n' + doc.slice(0, SUMMARIZE_LIMIT) + '\n</draft>\n\nWrite the synopsis notes.' },
    ];
    openPanel('Synopsis — accept to add to Story notes');
  } else if (task.kind === 'continue') {
    const limit = ctxLimit();
    const before = doc.slice(Math.max(0, task.cursor - Math.min(limit, task.cursor)), task.cursor);
    const after = doc.slice(task.cursor, task.cursor + CONTEXT_AFTER);
    const direction = els.direction.value.trim();
    // The direction joins the lore scan so naming a character in it activates their entry.
    const loreText = loreBlock(matchLore(before + '\n' + after + '\n' + direction));
    if (!before.trim()) {
      // Nothing written yet — let the model open the piece instead of continuing it.
      let opening = 'The draft is currently empty. Write an opening — one to three paragraphs — that fits the style notes if any were given, or an engaging opening of your choice otherwise.';
      if (direction) opening += directionBlock(direction);
      messages = [
        { role: 'system', content: systemPrompt('continue', loreText) },
        { role: 'user', content: opening },
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt('continue', loreText) },
        { role: 'user', content: continueUserMessage(before, after, direction) },
      ];
    }
    openPanel('Continuation');
  } else {
    const passage = doc.slice(task.selStart, task.selEnd);
    const before = doc.slice(Math.max(0, task.selStart - 2000), task.selStart);
    const after = doc.slice(task.selEnd, task.selEnd + 2000);
    const loreText = loreBlock(matchLore(before + passage + after));
    messages = [
      { role: 'system', content: systemPrompt('rewrite', loreText) },
      { role: 'user', content: rewriteUserMessage(task.instruction, passage, before, after) },
    ];
    openPanel(`Rewrite — ${task.instruction.length > 40 ? task.instruction.slice(0, 40) + '…' : task.instruction}`);
  }

  setBusy(true);
  try {
    await streamCompletion(messages, (delta) => {
      suggestion += delta;
      els.panelBody.textContent = suggestion;
      els.panelBody.scrollTop = els.panelBody.scrollHeight;
    });
    finishStream();
  } catch (err) {
    if (err.name === 'AbortError') {
      finishStream(); // keep whatever streamed before Stop
    } else {
      els.panelBody.classList.remove('cursor-blink');
      els.panelBody.classList.add('error');
      els.panelBody.textContent = err.message;
      els.btnStop.hidden = true;
      els.panelActions.hidden = false;
      els.btnAccept.hidden = true;
    }
  } finally {
    controller = null;
    setBusy(false);
  }
}

function finishStream() {
  els.panelBody.classList.remove('cursor-blink');
  els.btnStop.hidden = true;
  els.panelActions.hidden = false;
  els.btnAccept.hidden = !suggestion.trim();
}

function acceptSuggestion() {
  if (!lastTask || !suggestion.trim()) return;
  const doc = els.editor.value;

  if (lastTask.kind === 'summarize') {
    const text = suggestion.trim();
    const existing = els.story.value.trim();
    els.story.value = existing ? existing + '\n\n' + text : text;
    localStorage.setItem(STORE.story, els.story.value);
    closePanel();
    updateCtxMeter();
    return;
  }

  if (lastTask.kind === 'continue') {
    const before = doc.slice(0, lastTask.cursor);
    let text = suggestion.replace(/\s+$/, '');
    // Smart joining: add a space unless the draft already ends (or the suggestion begins) with whitespace/punctuation.
    if (before && !/\s$/.test(before) && !/^[\s.,;:!?)\]'"”’—-]/.test(text)) text = ' ' + text;
    els.editor.value = before + text + doc.slice(lastTask.cursor);
    const pos = (before + text).length;
    els.editor.setSelectionRange(pos, pos);
    els.direction.value = '';
    localStorage.setItem(STORE.dir, '');
  } else {
    const text = suggestion.replace(/\s+$/, '');
    els.editor.value = doc.slice(0, lastTask.selStart) + text + doc.slice(lastTask.selEnd);
    els.editor.setSelectionRange(lastTask.selStart, lastTask.selStart + text.length);
  }

  els.editor.focus();
  closePanel();
  saveDoc();
  updateWordCount();
}

function startContinue() {
  if (controller) return;
  const cursor = els.editor.selectionEnd; // retained even while the textarea is blurred
  runTask({ kind: 'continue', cursor });
}

function startRewrite(instruction) {
  if (controller || !hasSelection() || !instruction.trim()) return;
  runTask({
    kind: 'rewrite',
    instruction: instruction.trim(),
    selStart: els.editor.selectionStart,
    selEnd: els.editor.selectionEnd,
  });
}

/* ---------- Wiring ---------- */

loadState();

els.key.addEventListener('input', () => localStorage.setItem(STORE.key, els.key.value.trim()));
els.showKey.addEventListener('click', () => {
  els.key.type = els.key.type === 'password' ? 'text' : 'password';
});
els.model.addEventListener('input', () => localStorage.setItem(STORE.model, els.model.value.trim()));
els.refreshModels.addEventListener('click', fetchModels);
els.temp.addEventListener('input', () => {
  els.tempVal.textContent = els.temp.value;
  localStorage.setItem(STORE.temp, els.temp.value);
});
els.style.addEventListener('input', () => localStorage.setItem(STORE.style, els.style.value));
els.story.addEventListener('input', () => localStorage.setItem(STORE.story, els.story.value));
els.ctxSize.addEventListener('change', () => {
  localStorage.setItem(STORE.ctx, els.ctxSize.value);
  updateCtxMeter();
  updateLoreUI();
});
els.btnLore.addEventListener('click', () => { els.loreModal.hidden = false; });
els.loreClose.addEventListener('click', () => { els.loreModal.hidden = true; updateLoreUI(); });
els.loreModal.addEventListener('click', (e) => {
  if (e.target === els.loreModal) { els.loreModal.hidden = true; updateLoreUI(); }
});
els.loreAdd.addEventListener('click', () => {
  const entry = { id: crypto.randomUUID(), name: 'New entry', tags: '', content: '', enabled: true };
  lore.push(entry);
  saveLore();
  selectLoreEntry(entry.id);
  updateLoreUI();
  els.loreName.select();
});
els.loreDelete.addEventListener('click', () => {
  lore = lore.filter((e) => e.id !== loreEditingId);
  loreEditingId = null;
  els.loreEditor.hidden = true;
  saveLore();
  renderLoreList();
  updateLoreUI();
});
for (const [el, field] of [[els.loreName, 'name'], [els.loreTags, 'tags'], [els.loreContent, 'content']]) {
  el.addEventListener('input', () => {
    const e = lore.find((x) => x.id === loreEditingId);
    if (!e) return;
    e[field] = el.value;
    saveLore();
    renderLoreList();
    updateLoreUI();
  });
}

els.btnSummarize.addEventListener('click', () => {
  if (controller) return;
  if (!els.editor.value.trim()) return;
  runTask({ kind: 'summarize' });
});

els.editor.addEventListener('input', () => { saveDoc(); updateWordCount(); updateCtxMeter(); updateLoreUI(); });
document.addEventListener('selectionchange', () => {
  if (controller) return;
  // A textarea keeps its selection while blurred, so no focus check —
  // requiring focus here would disable a toolbar button mid-click.
  const enabled = hasSelection();
  for (const b of [els.btnImprove, els.btnShorten, els.btnExpand, els.btnCustom]) b.disabled = !enabled;
});

els.btnContinue.addEventListener('click', startContinue);
els.direction.addEventListener('input', () => localStorage.setItem(STORE.dir, els.direction.value));
els.direction.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startContinue(); }
});
els.btnImprove.addEventListener('click', () => startRewrite('Improve this passage: tighten the prose, sharpen word choice, and fix any awkwardness, while keeping the meaning and roughly the same length.'));
els.btnShorten.addEventListener('click', () => startRewrite('Shorten this passage to roughly half its length while keeping every essential point and the same tone.'));
els.btnExpand.addEventListener('click', () => startRewrite('Expand this passage with more detail, texture, and development, roughly doubling its length, in the same voice.'));
els.btnCustom.addEventListener('click', () => startRewrite(els.customInstr.value));
els.customInstr.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); startRewrite(els.customInstr.value); }
});

els.btnStop.addEventListener('click', () => controller?.abort());
els.btnAccept.addEventListener('click', acceptSuggestion);
els.btnRetry.addEventListener('click', () => { if (!controller && lastTask) runTask(lastTask); });
els.btnDiscard.addEventListener('click', () => { controller?.abort(); closePanel(); els.editor.focus(); });

els.download.addEventListener('click', () => {
  const blob = new Blob([els.editor.value], { type: 'text/markdown' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'draft.md';
  a.click();
  URL.revokeObjectURL(a.href);
});

document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
    e.preventDefault();
    startContinue();
  } else if (e.key === 'Escape' && !els.loreModal.hidden) {
    els.loreModal.hidden = true;
    updateLoreUI();
  } else if (e.key === 'Escape' && !els.panel.hidden) {
    controller?.abort();
    closePanel();
  }
});
