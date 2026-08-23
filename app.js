'use strict';

const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const MODELS_URL = 'https://openrouter.ai/api/v1/models';
const CONTEXT_AFTER = 4000;      // chars of draft sent after the cursor
const SUMMARIZE_LIMIT = 120000;  // max chars of draft sent to the summarizer
const STORE = { key: 'cw_key', model: 'cw_model', temp: 'cw_temp', style: 'cw_style', doc: 'cw_doc', story: 'cw_story', ctx: 'cw_ctx', lore: 'cw_lore', dir: 'cw_dir', sys: 'cw_sys', mature: 'cw_mature', len: 'cw_len', dlg: 'cw_dlg', gh: 'cw_gh', gist: 'cw_gist' };

const $ = (s) => document.querySelector(s);
const els = {
  key: $('#apiKey'), showKey: $('#showKey'),
  model: $('#model'), modelList: $('#modelList'), refreshModels: $('#refreshModels'), modelHint: $('#modelHint'),
  temp: $('#temp'), tempVal: $('#tempVal'), genLen: $('#genLen'),
  dlgFmt: $('#dlgFmt'), btnSceneBreak: $('#btnSceneBreak'), btnChapterBreak: $('#btnChapterBreak'), dirRef: $('#dirRef'),
  style: $('#styleNotes'), story: $('#storyNotes'), btnSummarize: $('#btnSummarize'),
  sysOverride: $('#sysOverride'), matureOk: $('#matureOk'),
  loreScan: $('#loreScan'), loreFill: $('#loreFill'), loreInvent: $('#loreInvent'),
  ctxSize: $('#ctxSize'), ctxMeter: $('#ctxMeter'), editor: $('#editor'), direction: $('#direction'),
  menuBtn: $('#menuBtn'), scrim: $('#scrim'), sidebarClose: $('#sidebarClose'),
  btnLore: $('#btnLore'), loreCount: $('#loreCount'), loreHint: $('#loreHint'),
  loreModal: $('#loreModal'), loreAdd: $('#loreAdd'), loreClose: $('#loreClose'),
  loreList: $('#loreList'), loreEditor: $('#loreEditor'), loreEmpty: $('#loreEmpty'),
  loreName: $('#loreName'), loreTags: $('#loreTags'), loreContent: $('#loreContent'),
  loreDelete: $('#loreDelete'),
  wordCount: $('#wordCount'), saveState: $('#saveState'), download: $('#download'),
  exportProj: $('#exportProj'), importProj: $('#importProj'), importFile: $('#importFile'),
  ghToken: $('#ghToken'), showGh: $('#showGh'), syncSave: $('#syncSave'), syncLoad: $('#syncLoad'), syncStatus: $('#syncStatus'),
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
  els.sysOverride.value = localStorage.getItem(STORE.sys) || '';
  els.matureOk.checked = localStorage.getItem(STORE.mature) === '1';
  els.genLen.value = localStorage.getItem(STORE.len) || 'couple';
  els.dlgFmt.checked = localStorage.getItem(STORE.dlg) !== '0';
  els.ghToken.value = localStorage.getItem(STORE.gh) || '';
  els.editor.value = localStorage.getItem(STORE.doc) || '';
  els.tempVal.textContent = els.temp.value;
  const end = els.editor.value.length;
  els.editor.setSelectionRange(end, end);
  updateWordCount();
  updateCtxMeter();
  renderLoreList();
  updateLoreUI();
  updateDirRef();
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

/* ---------- Document structure (chapters & scenes) ---------- */

const CHAPTER_RE = /^[ \t]*chapter\s+(\d+)\b[^\n]*$/gim;
const SCENE_BREAK_RE = /^[ \t]*(?:\*[ \t]*\*[ \t]*\*|-{3,})[ \t]*$/gm;

// Chapters are "Chapter N" heading lines; scenes split each chapter on *** lines.
function parseStructure(doc) {
  const heads = [];
  CHAPTER_RE.lastIndex = 0;
  let m;
  while ((m = CHAPTER_RE.exec(doc))) {
    heads.push({ index: m.index, bodyStart: m.index + m[0].length, num: parseInt(m[1], 10), label: `Chapter ${parseInt(m[1], 10)}` });
  }
  const chapters = [];
  if (!heads.length) {
    chapters.push({ num: null, label: null, start: 0, bodyStart: 0, end: doc.length });
  } else {
    if (heads[0].index > 0) {
      chapters.push({ num: null, label: 'the front matter before Chapter 1', start: 0, bodyStart: 0, end: heads[0].index });
    }
    heads.forEach((h, i) => chapters.push({
      num: h.num, label: h.label, start: h.index, bodyStart: h.bodyStart,
      end: i + 1 < heads.length ? heads[i + 1].index : doc.length,
    }));
  }
  for (const c of chapters) {
    const body = doc.slice(c.bodyStart, c.end);
    SCENE_BREAK_RE.lastIndex = 0;
    const bounds = [];
    let last = 0;
    let b;
    while ((b = SCENE_BREAK_RE.exec(body))) {
      bounds.push([last, b.index]);
      last = b.index + b[0].length;
    }
    bounds.push([last, body.length]);
    c.scenes = bounds.map(([a, z]) => ({ start: c.bodyStart + a, end: c.bodyStart + z }));
  }
  return chapters;
}

function chapterByNum(chapters, n) {
  return chapters.find((c) => c.num === n) || null;
}

function chapterAt(chapters, pos) {
  return chapters.find((c) => pos >= c.start && pos <= c.end) || chapters[chapters.length - 1];
}

// "Chapter 2, Scene 3" for the position, or null when the draft has no structure markers.
function locateCursor(doc, pos) {
  const chapters = parseStructure(doc);
  if (chapters.length === 1 && chapters[0].num === null && chapters[0].scenes.length === 1) return null;
  const c = chapterAt(chapters, pos);
  const sceneIdx = c.scenes.findIndex((sc) => pos >= sc.start && pos <= sc.end);
  const scenePart = c.scenes.length > 1 && sceneIdx >= 0 ? `, Scene ${sceneIdx + 1}` : '';
  return (c.label || 'the draft') + scenePart;
}

// Resolve "chapter 2, scene 3" style references in the direction text.
function resolveDirectionRef(doc, direction, cursor) {
  const cm = /chapter\s+(\d+)/i.exec(direction);
  const sm = /scene\s+(\d+)/i.exec(direction);
  if (!cm && !sm) return null;
  const chapters = parseStructure(doc);
  const chapter = cm ? chapterByNum(chapters, parseInt(cm[1], 10)) : chapterAt(chapters, cursor);
  const label = (cm ? `Chapter ${cm[1]}` : (chapter?.label || 'this chapter')) + (sm ? `, Scene ${sm[1]}` : '');
  if (!chapter) return { found: false, label };
  let start = chapter.start;
  let end = chapter.end;
  if (sm) {
    const sc = chapter.scenes[parseInt(sm[1], 10) - 1];
    if (!sc) return { found: false, label };
    start = sc.start;
    end = sc.end;
  }
  let text = doc.slice(start, end).trim();
  if (!text) return { found: false, label };
  if (text.length > 8000) text = text.slice(0, 8000) + '\n[… excerpt truncated]';
  return { found: true, label, text };
}

function updateDirRef() {
  const direction = els.direction.value.trim();
  const resolved = direction ? resolveDirectionRef(els.editor.value, direction, els.editor.selectionEnd) : null;
  els.dirRef.classList.remove('warn');
  if (!resolved) {
    els.dirRef.textContent = '';
  } else if (resolved.found) {
    els.dirRef.textContent = `\u21b3 ${resolved.label}, ~${countWords(resolved.text)} words`;
  } else {
    els.dirRef.textContent = `\u26a0 ${resolved.label} not found`;
    els.dirRef.classList.add('warn');
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

const LENGTHS = {
  sentence: 'Write exactly one sentence — a single beat — then stop.',
  few: 'Write two to four sentences, then stop.',
  para: 'Write one full paragraph, then stop.',
  couple: 'Write a natural stretch of one to three paragraphs, unless the form of the draft clearly calls for something else (dialogue, verse, a list, etc.).',
  long: 'Write an extended passage of four to six paragraphs, letting the scene develop fully before you stop.',
};

function lengthClause() {
  return '\n\nLength: ' + (LENGTHS[els.genLen.value] || LENGTHS.couple);
}

function formattingClause() {
  let out = '\n\nFormatting: Mark a scene break with a line containing only ***. Begin a chapter with a line like \u201cChapter 3\u201d.';
  if (els.dlgFmt.checked) {
    out += ' Dialogue gets its own paragraph: every change of speaker starts a new line, and spoken lines are never buried inside a narrative paragraph.';
  }
  return out;
}

function matureClause() {
  return els.matureOk.checked
    ? '\n\nThe author is an adult and this is their private fiction. Mature content — including explicit '
      + 'sexual content, graphic violence, and strong language — is permitted and should be written with the '
      + 'same craft and specificity as anything else when the story calls for it. Do not water down, fade to '
      + 'black, or moralize unless the author asks.'
    : '';
}

function systemPrompt(kind, loreText) {
  if (kind === 'lore-fill') {
    return 'You are an expert story editor maintaining a lorebook. Write a compact lorebook entry (2\u20136 '
      + 'sentences) about the requested subject, recording only what the draft establishes — traits, '
      + 'appearance, relationships, deeds, open questions. No speculation, no filler, no headings. '
      + 'Output only the entry text.' + matureClause();
  }
  if (kind === 'lore-invent') {
    return 'You are a creative worldbuilding partner. Expand the lorebook entry you are given with invented '
      + 'details that fit the tone of the draft and contradict nothing established — habits, history, quirks, '
      + 'stakes. Vivid and usable, under 120 words. Output only the complete new entry text, incorporating '
      + 'the existing facts.' + matureClause();
  }
  if (kind === 'lore-scan') {
    return 'You are an expert story editor. Identify recurring or important characters, places, factions, and '
      + 'objects in the draft that deserve lorebook entries, skipping every subject in the exclusion list.'
      + matureClause()
      + '\n\nReturn strict JSON only: an array of at most 6 objects, each '
      + '{"name": string, "tags": string of comma-separated trigger words, "content": string of 2\u20134 '
      + 'sentences recording what the draft establishes}. No commentary, no markdown fences.';
  }
  if (kind === 'summarize') {
    return 'You are an expert story editor building a working synopsis for the author\u2019s own reference. '
      + 'From the draft you are given, produce compact notes covering: the characters and their key traits and '
      + 'relationships; the setting; the plot events in order; and any open threads or unresolved questions. '
      + 'Be specific about names and facts, stay under 300 words, and output only the notes \u2014 no preamble, '
      + 'no commentary.';
  }
  const override = els.sysOverride.value.trim();
  const base = override || (kind === 'continue'
    ? 'You are an expert co-writer. Continue the draft seamlessly from exactly where it leaves off. '
      + 'Match the existing tone, voice, tense, point of view, and formatting. Never repeat or rephrase text '
      + 'that is already in the draft, never summarize, and never add commentary, headings, or quotation marks '
      + 'around your output. Write only the continuation itself.'
    : 'You are an expert editor. Rewrite the passage the user gives you according to their instruction. '
      + 'Preserve the meaning and any formatting (paragraph breaks, markdown) unless the instruction says otherwise, '
      + 'and match the tone of the surrounding draft. Output only the rewritten passage — no commentary, no quotation '
      + 'marks around it, no explanation of your changes.');
  let out = base + matureClause();
  if (kind === 'continue') out += lengthClause(); // applies over an override too
  out += formattingClause();
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

function continueUserMessage(before, after, direction, resolved, location) {
  let msg = 'Here is my draft, up to the point where I need you to continue:\n\n'
    + '<draft>\n' + before + '\n</draft>\n\n';
  if (after.trim()) {
    msg += 'The draft resumes AFTER the insertion point with the following text, so your continuation must '
      + 'bridge into it naturally without repeating it:\n\n<later_text>\n' + after + '\n</later_text>\n\n';
  }
  if (resolved?.found) {
    msg += 'The author\u2019s direction refers to this passage from earlier in the manuscript (' + resolved.label + '):\n\n<referenced>\n'
      + resolved.text + '\n</referenced>\n\n';
  }
  msg += 'Continue writing from the exact end of the draft.';
  if (location) msg += ` The insertion point is in ${location}.`;
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
  } else if (task.kind === 'lore-fill' || task.kind === 'lore-invent') {
    const entry = lore.find((x) => x.id === task.entryId);
    if (!entry) return;
    const tags = entryTags(entry).join(', ');
    const subject = `Subject: ${entry.name}${tags ? ` (tags: ${tags})` : ''}`;
    if (task.kind === 'lore-fill') {
      messages = [
        { role: 'system', content: systemPrompt('lore-fill') },
        { role: 'user', content: 'Here is the draft:\n\n<draft>\n' + doc.slice(0, SUMMARIZE_LIMIT) + '\n</draft>\n\n' + subject + '\n'
          + (entry.content.trim()
            ? 'Existing entry — keep what is still true and add what the draft establishes:\n' + entry.content
            : 'Write a new entry for this subject.') },
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt('lore-invent') },
        { role: 'user', content: 'For tone, the most recent stretch of the draft:\n\n<draft>\n' + doc.slice(-8000) + '\n</draft>\n\n'
          + subject + '\nExisting entry:\n' + (entry.content.trim() || '(empty)') + '\n\nExpand it.' },
      ];
    }
    openPanel(`Entry: ${entry.name} — accept to replace content`);
  } else if (task.kind === 'lore-scan') {
    const existing = lore.map((e) => e.name + (entryTags(e).length ? ` [${entryTags(e).join(', ')}]` : '')).join('; ') || '(none)';
    messages = [
      { role: 'system', content: systemPrompt('lore-scan') },
      { role: 'user', content: 'Here is the draft:\n\n<draft>\n' + doc.slice(0, SUMMARIZE_LIMIT) + '\n</draft>\n\nAlready covered — do not propose these: ' + existing },
    ];
    openPanel('Proposed entries — accept to add');
  } else if (task.kind === 'continue') {
    const limit = ctxLimit();
    const before = doc.slice(Math.max(0, task.cursor - Math.min(limit, task.cursor)), task.cursor);
    const after = doc.slice(task.cursor, task.cursor + CONTEXT_AFTER);
    const direction = els.direction.value.trim();
    const resolved = direction ? resolveDirectionRef(doc, direction, task.cursor) : null;
    const location = locateCursor(doc, task.cursor);
    // Direction and any referenced passage join the lore scan so their subjects' entries activate.
    const loreText = loreBlock(matchLore(before + '\n' + after + '\n' + direction + '\n' + (resolved?.found ? resolved.text : '')));
    if (!before.trim()) {
      // Nothing written yet — let the model open the piece instead of continuing it.
      let opening = 'The draft is currently empty. Write an opening that fits the style notes if any were given, or an engaging opening of your choice otherwise.';
      if (direction) opening += directionBlock(direction);
      messages = [
        { role: 'system', content: systemPrompt('continue', loreText) },
        { role: 'user', content: opening },
      ];
    } else {
      messages = [
        { role: 'system', content: systemPrompt('continue', loreText) },
        { role: 'user', content: continueUserMessage(before, after, direction, resolved, location) },
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

  if (lastTask.kind === 'lore-scan') {
    let added;
    try {
      const m = suggestion.match(/\[[\s\S]*\]/);
      const arr = JSON.parse(m ? m[0] : suggestion);
      added = arr
        .filter((x) => x && typeof x.name === 'string' && typeof x.content === 'string')
        .map((x) => ({ id: crypto.randomUUID(), name: x.name, tags: typeof x.tags === 'string' ? x.tags : '', content: x.content, enabled: true }));
    } catch {
      els.panelBody.classList.add('error');
      els.panelBody.textContent = 'Could not parse the response as entries — Retry usually fixes this.';
      els.btnAccept.hidden = true;
      return;
    }
    lore.push(...added);
    saveLore();
    closePanel();
    els.loreModal.hidden = false;
    renderLoreList();
    updateLoreUI();
    return;
  }

  if (lastTask.kind === 'lore-fill' || lastTask.kind === 'lore-invent') {
    const entry = lore.find((x) => x.id === lastTask.entryId);
    if (entry) {
      entry.content = suggestion.trim();
      saveLore();
    }
    closePanel();
    els.loreModal.hidden = false;
    selectLoreEntry(lastTask.entryId);
    updateLoreUI();
    return;
  }

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

function insertAtCursor(snippet) {
  const doc = els.editor.value;
  const pos = els.editor.selectionEnd;
  const before = doc.slice(0, pos);
  const prefix = before === '' || before.endsWith('\n\n') ? '' : before.endsWith('\n') ? '\n' : '\n\n';
  const text = prefix + snippet;
  els.editor.value = before + text + doc.slice(pos);
  const at = pos + text.length;
  els.editor.setSelectionRange(at, at);
  els.editor.focus();
  saveDoc();
  updateWordCount();
  updateCtxMeter();
  updateLoreUI();
  updateDirRef();
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

/* ---------- Project bundle (export / import / gist sync) ---------- */

const GIST_DESC = 'CoWriter sync';
const GIST_FILE = 'cowriter-project.json';

// Everything that defines the project — deliberately NOT the OpenRouter key.
function projectData() {
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    draft: els.editor.value,
    story: els.story.value,
    style: els.style.value,
    sys: els.sysOverride.value,
    direction: els.direction.value,
    lore,
    settings: {
      model: els.model.value,
      temp: els.temp.value,
      ctx: els.ctxSize.value,
      len: els.genLen.value,
      dlg: els.dlgFmt.checked,
      mature: els.matureOk.checked,
    },
  };
}

function applyProject(d) {
  els.editor.value = d.draft ?? '';
  els.story.value = d.story ?? '';
  els.style.value = d.style ?? '';
  els.sysOverride.value = d.sys ?? '';
  els.direction.value = d.direction ?? '';
  lore = Array.isArray(d.lore) ? d.lore : [];
  const st = d.settings || {};
  if (st.model) els.model.value = st.model;
  if (st.temp) { els.temp.value = st.temp; els.tempVal.textContent = st.temp; }
  if (st.ctx) els.ctxSize.value = st.ctx;
  if (st.len) els.genLen.value = st.len;
  els.dlgFmt.checked = st.dlg !== false;
  els.matureOk.checked = !!st.mature;
  localStorage.setItem(STORE.doc, els.editor.value);
  localStorage.setItem(STORE.story, els.story.value);
  localStorage.setItem(STORE.style, els.style.value);
  localStorage.setItem(STORE.sys, els.sysOverride.value);
  localStorage.setItem(STORE.dir, els.direction.value);
  localStorage.setItem(STORE.model, els.model.value);
  localStorage.setItem(STORE.temp, els.temp.value);
  localStorage.setItem(STORE.ctx, els.ctxSize.value);
  localStorage.setItem(STORE.len, els.genLen.value);
  localStorage.setItem(STORE.dlg, els.dlgFmt.checked ? '1' : '0');
  localStorage.setItem(STORE.mature, els.matureOk.checked ? '1' : '');
  saveLore();
  loreEditingId = null;
  els.loreEditor.hidden = true;
  updateWordCount();
  updateCtxMeter();
  renderLoreList();
  updateLoreUI();
  updateDirRef();
}

function confirmOverwrite(d) {
  if (!els.editor.value.trim()) return true;
  const words = countWords(d.draft || '');
  const when = d.savedAt ? new Date(d.savedAt).toLocaleString() : 'unknown time';
  return confirm(`Replace the project on THIS device with the loaded one? (${words} words, saved ${when}.) The current draft here will be overwritten.`);
}

async function gistRequest(path, opts = {}) {
  const token = els.ghToken.value.trim();
  if (!token) throw new Error('Add a GitHub token (gist scope) first.');
  const res = await fetch('https://api.github.com' + path, {
    ...opts,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      ...(opts.body ? { 'Content-Type': 'application/json' } : {}),
    },
  });
  if (!res.ok) {
    let msg = `GitHub returned ${res.status}`;
    try { msg += `: ${(await res.json()).message}`; } catch { /* ignore */ }
    if (res.status === 401) msg += ' — check the token.';
    if (res.status === 403) msg += ' — fine-grained tokens cannot use gists; create a CLASSIC token with the gist scope at github.com/settings/tokens/new.';
    if (res.status === 404) msg += ' — token may be missing the gist scope.';
    throw new Error(msg);
  }
  return res.status === 204 ? null : res.json();
}

async function findGistId() {
  const known = localStorage.getItem(STORE.gist);
  if (known) {
    try {
      await gistRequest(`/gists/${known}`);
      return known;
    } catch { localStorage.setItem(STORE.gist, ''); }
  }
  const list = await gistRequest('/gists?per_page=100');
  const hit = list.find((g) => g.description === GIST_DESC && g.files && g.files[GIST_FILE]);
  if (hit) localStorage.setItem(STORE.gist, hit.id);
  return hit ? hit.id : null;
}

function setSyncBusy(busy) {
  els.syncSave.disabled = busy;
  els.syncLoad.disabled = busy;
}

async function syncSave() {
  setSyncBusy(true);
  els.syncStatus.textContent = 'Saving to GitHub…';
  try {
    const body = JSON.stringify({
      description: GIST_DESC,
      public: false,
      files: { [GIST_FILE]: { content: JSON.stringify(projectData(), null, 1) } },
    });
    const id = await findGistId();
    const gist = id
      ? await gistRequest(`/gists/${id}`, { method: 'PATCH', body })
      : await gistRequest('/gists', { method: 'POST', body });
    localStorage.setItem(STORE.gist, gist.id);
    els.syncStatus.textContent = `Saved ${new Date(gist.updated_at).toLocaleString()}. Load this on your other device.`;
  } catch (err) {
    els.syncStatus.textContent = err.message;
  } finally {
    setSyncBusy(false);
  }
}

async function syncLoad() {
  setSyncBusy(true);
  els.syncStatus.textContent = 'Loading from GitHub…';
  try {
    const id = await findGistId();
    if (!id) throw new Error('No synced project found on this GitHub account yet — Save from the other device first.');
    const gist = await gistRequest(`/gists/${id}`);
    const f = gist.files[GIST_FILE];
    const content = f.truncated ? await (await fetch(f.raw_url)).text() : f.content;
    const d = JSON.parse(content);
    if (typeof d.draft !== 'string') throw new Error('The synced file is not a CoWriter project.');
    if (!confirmOverwrite(d)) {
      els.syncStatus.textContent = 'Load cancelled.';
      return;
    }
    applyProject(d);
    els.syncStatus.textContent = `Loaded (saved ${d.savedAt ? new Date(d.savedAt).toLocaleString() : 'unknown time'}).`;
  } catch (err) {
    els.syncStatus.textContent = err.message;
  } finally {
    setSyncBusy(false);
  }
}

/* ---------- Wiring ---------- */

loadState();

els.key.addEventListener('input', () => localStorage.setItem(STORE.key, els.key.value.trim()));
els.showKey.addEventListener('click', () => {
  els.key.type = els.key.type === 'password' ? 'text' : 'password';
});
els.model.addEventListener('input', () => localStorage.setItem(STORE.model, els.model.value.trim()));
els.refreshModels.addEventListener('click', fetchModels);
els.genLen.addEventListener('change', () => localStorage.setItem(STORE.len, els.genLen.value));
els.dlgFmt.addEventListener('change', () => localStorage.setItem(STORE.dlg, els.dlgFmt.checked ? '1' : '0'));
els.btnSceneBreak.addEventListener('click', () => insertAtCursor('***\n\n'));
els.btnChapterBreak.addEventListener('click', () => {
  const nums = [...els.editor.value.matchAll(/^[ \t]*chapter\s+(\d+)\b/gim)].map((m) => parseInt(m[1], 10));
  insertAtCursor(`Chapter ${nums.length ? Math.max(...nums) + 1 : 1}\n\n`);
});
els.temp.addEventListener('input', () => {
  els.tempVal.textContent = els.temp.value;
  localStorage.setItem(STORE.temp, els.temp.value);
});
els.style.addEventListener('input', () => localStorage.setItem(STORE.style, els.style.value));
els.story.addEventListener('input', () => localStorage.setItem(STORE.story, els.story.value));
els.sysOverride.addEventListener('input', () => localStorage.setItem(STORE.sys, els.sysOverride.value));
els.matureOk.addEventListener('change', () => localStorage.setItem(STORE.mature, els.matureOk.checked ? '1' : ''));
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
  updateDirRef();
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

els.loreScan.addEventListener('click', () => {
  if (controller || !els.editor.value.trim()) return;
  els.loreModal.hidden = true;
  runTask({ kind: 'lore-scan' });
});
els.loreFill.addEventListener('click', () => {
  if (controller || !loreEditingId || !els.editor.value.trim()) return;
  els.loreModal.hidden = true;
  runTask({ kind: 'lore-fill', entryId: loreEditingId });
});
els.loreInvent.addEventListener('click', () => {
  if (controller || !loreEditingId) return;
  els.loreModal.hidden = true;
  runTask({ kind: 'lore-invent', entryId: loreEditingId });
});

els.btnSummarize.addEventListener('click', () => {
  if (controller) return;
  if (!els.editor.value.trim()) return;
  runTask({ kind: 'summarize' });
});

els.editor.addEventListener('input', () => { saveDoc(); updateWordCount(); updateCtxMeter(); updateLoreUI(); updateDirRef(); });
document.addEventListener('selectionchange', () => {
  if (controller) return;
  // A textarea keeps its selection while blurred, so no focus check —
  // requiring focus here would disable a toolbar button mid-click.
  const enabled = hasSelection();
  for (const b of [els.btnImprove, els.btnShorten, els.btnExpand, els.btnCustom]) b.disabled = !enabled;
});

els.menuBtn.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));
els.scrim.addEventListener('click', () => document.body.classList.remove('sidebar-open'));
els.sidebarClose.addEventListener('click', () => document.body.classList.remove('sidebar-open'));

els.btnContinue.addEventListener('click', startContinue);
els.direction.addEventListener('input', () => { localStorage.setItem(STORE.dir, els.direction.value); updateDirRef(); });
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
els.btnDiscard.addEventListener('click', () => {
  controller?.abort();
  closePanel();
  if (lastTask?.kind?.startsWith('lore-')) {
    els.loreModal.hidden = false;
  } else {
    els.editor.focus();
  }
});

els.exportProj.addEventListener('click', () => {
  const blob = new Blob([JSON.stringify(projectData(), null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = 'cowriter-project.json';
  a.click();
  URL.revokeObjectURL(a.href);
});
els.importProj.addEventListener('click', () => els.importFile.click());
els.importFile.addEventListener('change', async () => {
  const file = els.importFile.files[0];
  els.importFile.value = '';
  if (!file) return;
  try {
    const d = JSON.parse(await file.text());
    if (typeof d.draft !== 'string') throw new Error('bad file');
    if (confirmOverwrite(d)) applyProject(d);
  } catch {
    alert('That file is not a CoWriter project export.');
  }
});
els.ghToken.addEventListener('input', () => localStorage.setItem(STORE.gh, els.ghToken.value.trim()));
els.showGh.addEventListener('click', () => {
  els.ghToken.type = els.ghToken.type === 'password' ? 'text' : 'password';
});
els.syncSave.addEventListener('click', syncSave);
els.syncLoad.addEventListener('click', syncLoad);

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
  } else if (e.key === 'Escape' && document.body.classList.contains('sidebar-open')) {
    document.body.classList.remove('sidebar-open');
  } else if (e.key === 'Escape' && !els.loreModal.hidden) {
    els.loreModal.hidden = true;
    updateLoreUI();
  } else if (e.key === 'Escape' && !els.panel.hidden) {
    controller?.abort();
    closePanel();
  }
});
