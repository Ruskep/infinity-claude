const api = window.infinity;

const state = {
  settings: null,
  models: [],
  workspaces: [],
  activeWorkspace: null,
  activeChatId: null,
  collapsedWs: null,
  skills: [],
  skillEnabled: {},
  mcpServers: [],
  messages: [],
  pendingFiles: [],
  // сессии по чатам: каждый чат имеет собственный стрим, свои сообщения и DOM,
  // чтобы параллельные чаты не мешали друг другу
  sessions: {},
  activeSessionId: null
};

/* ---------- сессии по чатам ---------- */
// Каждый чат имеет свою сессию: собственные сообщения, DOM-контейнер, статус стрима
// и подписку на чанки. Это позволяет работать сразу с несколькими чатами: пока один
// стримит, в других можно читать историю и отправлять новые сообщения.

function currentSession() {
  return state.sessions[state.activeSessionId] || null;
}

function activeMessages() {
  const s = currentSession();
  return s ? s.messages : state.messages;
}

// ключ сессии = id чата + id воркспейса: чаты с одинаковым id в разных папках
// не должны делиться одной сессией (иначе открывается не тот чат)
function sessionKey(wsId, chatId) {
  return (chatId || '__new__') + '@' + (wsId || 'none');
}

function ensureSession(chatId, initialMessages, wsId) {
  const key = sessionKey(wsId, chatId);
  let sess = state.sessions[key];
  if (!sess) {
    sess = {
      id: key,
      chatId: chatId || null,
      wsId: wsId || null,
      streamKey: 's_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 8), // уникальный ключ для роутинга чанков/остановки стрима
      messages: initialMessages ? initialMessages.map((m) => ({ ...m })) : [],
      toolCards: [],
      lastAssistant: null,
      container: null, // создаётся при первом рендере
      unsubscribe: null,
      streaming: false,
      assistantEl: null,
      currentText: '',
      round: 0,
      dom: false // контейнер смонтирован в elMessages (сессия видна)
    };
    state.sessions[key] = sess;
  }
  return sess;
}

// вернуть DOM-контейнер сессии (создаёт при необходимости)
function sessionContainer(sess) {
  if (!sess.container) {
    sess.container = document.createElement('div');
    sess.container.className = 'msg-session';
  }
  return sess.container;
}

// при создании/сохранении чата переносим сессию под новый id
function renameSession(oldKey, newKey, chatId) {
  const s = state.sessions[oldKey];
  if (!s || oldKey === newKey) return s;
  delete state.sessions[oldKey];
  s.id = newKey;
  s.chatId = chatId || s.chatId;
  state.sessions[newKey] = s;
  if (state.activeSessionId === oldKey) state.activeSessionId = newKey;
  return s;
}

/* ---------- refs ---------- */
const $ = (id) => document.getElementById(id);
const elMessages = $('messages');
const elInput = $('input');
const elSend = $('send-btn');
const elStop = $('stop-btn');
const elModel = $('model-select');
const elStatusDot = $('status-dot');
const elStatusText = $('status-text');
const elWsScroll = $('ws-scroll');
const elCrumb = $('crumb-folder');
const elSkillsList = $('skills-list');
const elEmpty = $('empty-state');
const elAttach = $('attach-btn');
const elFileInput = $('file-input');
const elAttachments = $('attachments');

/* ---------- helpers ---------- */

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function prettyModel(id) {
  if (!id) return '';
  if (id === 'auto') return i18nT('autoRouting');
  let s = id;
  if (s.includes('/')) s = s.split('/').slice(1).join('/');
  s = s.replace(/claude[-_]?(sonnet|opus|haiku)?/i, (m) => m.replace(/^claude/i, 'Claude'));
  s = s.replace(/-/g, ' ');
  s = s.replace(/\b(opus)\b/gi, 'Opus').replace(/\b(sonnet)\b/gi, 'Sonnet').replace(/\b(haiku)\b/gi, 'Haiku');
  return s.trim() || id;
}

function renderMarkdown(text) {
  const preBlocks = [];
  let t = text.replace(/```(\w*)\n([\s\S]*?)```/g, (_m, _lang, code) => {
    const id = '\u0000PRE' + preBlocks.length + '\u0000';
    preBlocks.push(`<pre><code>${escapeHtml(code)}</code></pre>`);
    return '\n' + id + '\n';
  });

  t = t.replace(/`([^`\n]+)`/g, (_m, c) => `<code>${escapeHtml(c)}</code>`);
  t = t.replace(/^#{1,6}\s+(.+)$/gm, (_m, h) => {
    const lvl = Math.min(3, _m.match(/^#+/)[0].length);
    return `<h${lvl}>${escapeHtml(h)}</h${lvl}>`;
  });
  t = t.replace(/\*\*([^*]+)\*\*/g, (_m, b) => `<b>${escapeHtml(b)}</b>`);
  t = t.replace(/^>\s?(.+)$/gm, (_m, q) => `<blockquote>${escapeHtml(q)}</blockquote>`);
  t = t.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_m, txt, url) => `<a href="${escapeHtml(url)}">${escapeHtml(txt)}</a>`);
  t = t.replace(/^\s*[-*]\s+(.+)$/gm, (_m, li) => `• ${li}`);
  t = t.replace(/^\s*(\d+)[.)]\s+(.+)$/gm, (_m, n, li) => `${n}. ${li}`);

  const lines = t.split('\n').map((line) => line.trim());
  let out = '';
  let listStack = [];
  const closeLists = () => { while (listStack.length) { out += '</ul>'; listStack.pop(); } };

  for (const s of lines) {
    if (!s) { closeLists(); if (out.trim()) out += '<p></p>'; }
    else if (s.startsWith('• ')) {
      if (!listStack.length) { out += '<ul>'; listStack.push(1); }
      out += `<li>${s.slice(2)}</li>`;
    } else if (/^\d+\. /.test(s)) {
      const n = s.match(/^(\d+)\. /)[1];
      if (listStack.length) { }
      else { out += '<ol>'; listStack.push(2); }
      out += `<li><span class="ol-n">${n}.</span> ${s.slice(s.indexOf('.') + 2)}</li>`;
    } else {
      closeLists();
      const isBlock = s.startsWith('<pre>') || s === '</pre>' || s.startsWith('<blockquote>') || s === '</blockquote>' ||
        /^<\/?h[1-3]>/.test(s) || s.startsWith('\u0000PRE');
      out += isBlock ? s : `<p>${s}</p>`;
    }
  }
  closeLists();

  for (let i = 0; i < preBlocks.length; i++) out = out.split('\u0000PRE' + i + '\u0000').join(preBlocks[i]);
  return out;
}

function setStatus(cls, text) {
  elStatusDot.className = 'dot ' + cls;
  elStatusText.textContent = text;
}

function autosize() {
  elInput.style.height = 'auto';
  elInput.style.height = Math.min(elInput.scrollHeight, 220) + 'px';
}

function scrollToBottom(sess) {
  if (state.settings && state.settings.autoScroll === false) return;
  // скроллим только видимую (активную) сессию; фоновые сессии не трогают ленту
  if (sess && !sess.dom) return;
  // всегда прилипаем к низу: отправил сообщение — и сразу видно ответ,
  // ассистент пишет — лента сама едет вниз, крутить вручную не нужно
  elMessages.scrollTop = elMessages.scrollHeight;
}

function addMsgEl(sess) {
  elEmpty.classList.add('hidden');
  const target = sess ? sessionContainer(sess) : elMessages;
  const wrapper = document.createElement('div');
  wrapper.className = 'msg';
  const label = document.createElement('div');
  label.className = 'msg-label';
  const content = document.createElement('div');
  content.className = 'msg-content';
  wrapper.appendChild(label);
  wrapper.appendChild(content);
  target.appendChild(wrapper);
  scrollToBottom(sess);
  return { wrapper, label, content };
}

function addUserMsg(text, attachments, sess) {
  const m = addMsgEl(sess);
  m.label.textContent = i18nT('you');
  m.wrapper.classList.add('user');
  if (attachments && attachments.length) {
    const row = document.createElement('div');
    row.className = 'msg-attachments';
    for (const a of attachments) {
      const chip = document.createElement('div');
      chip.className = 'msg-att';
      if (a.kind === 'image' && a.dataUrl) {
        chip.innerHTML = '<img class="att-thumb" src="' + a.dataUrl + '" alt="">';
      } else {
        const icon = a.kind === 'image' ? '🖼️' : (a.kind === 'text' ? '📄' : '📎');
        chip.innerHTML = '<span class="att-ico">' + icon + '</span>';
      }
      const name = document.createElement('span');
      name.className = 'att-name';
      name.textContent = a.name;
      chip.appendChild(name);
      row.appendChild(chip);
    }
    m.content.appendChild(row);
  }
  const t = document.createElement('div');
  t.className = 'msg-text';
  t.textContent = text;
  m.content.appendChild(t);
  return m;
}

function addAssistantMsgStreamingLabel(round, sess) {
  const m = addMsgEl(sess);
  m.label.textContent = 'Claude';
  m.label.dataset.round = round;
  const md = document.createElement('div');
  md.className = 'markdown';
  m.content.appendChild(md);
  m.md = md;
  if (sess) sess.lastAssistant = m.wrapper;
  return m;
}

// троттлинг рендера markdown: пересоздаём innerHTML не чаще 1 раза в 60мс,
// чтобы не блокировать UI (в т.ч. сайдбар) на каждый символ стрима
const mdLastFlush = new Map();
function renderAssistant(m, text, opts, sess) {
  if (!m.md) return;
  const live = !opts || opts.live !== false; // live = ещё идёт стрим
  const now = performance.now();
  const last = mdLastFlush.get(m) || 0;
  if (live && now - last <= 60) return; // пропускаем «вспышку» — появится следующая серия чанков
  mdLastFlush.set(m, now);
  m.wrapper.classList.toggle('streaming', live);
  if (!text || !text.trim()) {
    if (live) {
      m.md.innerHTML = '<span class="thinking"><span class="typing"><span></span><span></span><span></span></span><span class="thinking-txt">' + i18nT('thinkingDots') + '</span></span>';
    } else {
      m.md.innerHTML = '<span class="empty-done">· ' + i18nT('doneThinking') + '</span>';
    }
  } else if (live) {
    // появление текста: прозрачность -> видимо. Пока стрим идёт — мерцающий курсор.
    m.md.innerHTML = renderMarkdown(text) + '<span class="caret"></span>';
  } else {
    m.md.innerHTML = renderMarkdown(text);
  }
  scrollToBottom(sess);
}
// принудительно дорисовать финальный текст после конца стрима
function flushMd(m) {
  mdLastFlush.delete(m);
}

function addToolCard(wrapper, stateIm, sess) {
  const el = document.createElement('div');
  el.className = 'tool-card';
  const t = stateIm.tool;
  const icon = t === 'bash'
    ? '<path d="M4 17l6-6-6-6M12 19h8" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>'
    : t === 'web_search'
    ? '<circle cx="11" cy="11" r="7" stroke="currentColor" stroke-width="2"/><path d="M21 21l-4.35-4.35M8.5 11h5M11 8.5v5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    : t === 'web_fetch'
    ? '<path d="M4 7a2 2 0 0 1 2-2h12a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="2" stroke-linejoin="round"/><path d="M8 11h8M8 15h5" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>'
    : '<path d="M12 3v18M3 12h18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/>';
  const cmdText = (stateIm.params && (stateIm.params.command || stateIm.params.path || stateIm.params.url || stateIm.params.query || stateIm.params._raw)) || '';
  el.innerHTML = `
    <div class="tool-head">
      <span class="tool-ic"><svg width="14" height="14" viewBox="0 0 24 24" fill="none">${icon}</svg></span>
      <span class="tool-name">${escapeHtml(humanTool(stateIm.tool))}</span>
      <span class="tool-state ${stateIm.state}">${stateSpinner(stateIm.state)}</span>
    </div>
    <div class="tool-cmd">${escapeHtml(cmdText)}</div>`;
  if (wrapper) wrapper.appendChild(el);
  else sessionContainer(sess).appendChild(el);
  scrollToBottom(sess);
  return el;
}

function humanTool(t) {
  const names = i18nDict().tools || {};
  return names[t] || t;
}

function stateSpinner(s) {
  if (s === 'running') return i18nT('running');
  if (s === 'done') return '✓';
  if (s === 'denied') return i18nT('denied');
  return '';
}

function setToolState(card, stateIm, sess) {
  if (!card) return;
  const elState = card.querySelector('.tool-state');
  if (elState) {
    elState.className = 'tool-state ' + stateIm.state;
    elState.textContent = stateSpinner(stateIm.state);
  }
  if (stateIm.state === 'done' && stateIm.resultText) {
    let old = card.querySelector('.tool-result');
    if (old) old.remove();
    const div = document.createElement('div');
    div.className = 'tool-result';
    div.textContent = stateIm.resultText.slice(0, 4000);
    card.appendChild(div);
  }
  scrollToBottom(sess);
}

/* ---------- workspaces ---------- */

async function loadWorkspaces() {
  const prevActiveId = state.activeWorkspace ? state.activeWorkspace.id : null;
  state.workspaces = await api.workspaceList();
  // синхронизируем активный воркспейс со свежим объектом из списка,
  // иначе saveChat() будет класть чаты в устаревший объект
  if (prevActiveId) {
    const cur = state.workspaces.find((w) => w.id === prevActiveId);
    if (cur) state.activeWorkspace = cur;
    else state.activeWorkspace = state.workspaces.find((w) => isNoneWs(w)) || state.workspaces[0] || null;
  } else if (state.workspaces.length) {
    state.activeWorkspace = state.workspaces[0];
  }
  renderWorkspaces();
  if (!state._uiRestored) {
    state._uiRestored = true;
    await restoreLastChat();
  }
}

function isNoneWs(ws) { return ws && ws.id === 'none'; }

function toggleWsCollapse(wsId) {
  if (!state.collapsedWs) state.collapsedWs = new Set();
  if (state.collapsedWs.has(wsId)) state.collapsedWs.delete(wsId);
  else state.collapsedWs.add(wsId);
  const g = elWsScroll.querySelector('.ws-group[data-ws-id="' + wsId + '"]');
  if (!g) { renderWorkspaces(); return; }
  const collapsed = state.collapsedWs.has(wsId);
  const chev = g.querySelector('.chev');
  if (chev) chev.classList.toggle('open', !collapsed);
  const chats = g.querySelector('.ws-chats');
  if (chats) chats.classList.toggle('collapsed', collapsed);
}

function persistUIState() {
  api.setSettings({
    lastWorkspaceId: state.activeWorkspace ? state.activeWorkspace.id : null,
    lastChatId: state.activeChatId || null
  }).catch(() => {});
}

// при старте открываем последний выбранный проект/чат
async function restoreLastChat() {
  if (state.settings && state.settings.restoreOnStart === false) {
    const noneWs = state.workspaces.find((w) => isNoneWs(w));
    if (noneWs) { await activateWorkspace(noneWs.id); return; }
  }
  const lastWsId = state.settings && state.settings.lastWorkspaceId;
  const lastChatId = state.settings && state.settings.lastChatId;
  if (lastWsId) {
    const ws = state.workspaces.find((w) => w.id === lastWsId);
    if (ws) {
      state.activeWorkspace = ws;
      if (lastChatId && ws.chats.some((c) => c.id === lastChatId)) {
        openChat(ws.id, lastChatId);
        return;
      }
      await activateWorkspace(ws.id);
      return;
    }
  }
  const noneWs = state.workspaces.find((w) => isNoneWs(w));
  if (noneWs) { await activateWorkspace(noneWs.id); return; }
  if (state.activeWorkspace) await activateWorkspace(state.activeWorkspace.id);
  else renderWorkspaces();
}

function chatPreview(chat) {
  const msgs = chat.messages || [];
  const last = msgs[msgs.length - 1];
  if (!last) return '';
  let s = String(last.content || '');
  if (s.length > 46) s = s.slice(0, 46) + '…';
  return s;
}

function chatTime(chat) {
  const t = chat.updatedAt || chat.createdAt || 0;
  if (!t) return '';
  const diff = Date.now() - t;
  const m = Math.floor(diff / 60000);
  if (m < 1) return i18nT('justNow');
  if (m < 60) return m + i18nT('min');
  const h = Math.floor(m / 60);
  if (h < 24) return h + i18nT('h');
  const d = Math.floor(h / 24);
  if (d < 7) return d + i18nT('d');
  return new Date(t).toLocaleDateString(i18nLang() === 'en' ? 'en-US' : 'ru-RU', { day: 'numeric', month: 'short' });
}

function renderWorkspaces() {
  elWsScroll.innerHTML = '';
  const realWs = state.workspaces.filter((w) => !isNoneWs(w));
  if (realWs.length === 0) {
    // Нет ни одного реального проекта — показываем компактную подсказку
    // + раздел «Без проекта» (в нём могут уже быть чаты).
    const hint = document.createElement('div');
    hint.className = 'ws-empty ws-empty-hint';
    const btn = document.createElement('button');
    btn.textContent = i18nT('addFolder');
    btn.onclick = () => pickWorkspace();
    hint.appendChild(document.createTextNode(i18nT('noProjects')));
    hint.appendChild(btn);
    elWsScroll.appendChild(hint);
  }

  const activeId = state.activeWorkspace && state.activeWorkspace.id;
  // состояние свёрнутости хранится в Set (стрелочка переключает любую папку,
  // открытыми могут быть сразу несколько)
  if (!state.collapsedWs) {
    state.collapsedWs = new Set();
    // по умолчанию реальные папки свёрнуты, кроме активной; «Без проекта» раскрыта
    for (const w of state.workspaces) {
      if (!isNoneWs(w) && w.id !== activeId) state.collapsedWs.add(w.id);
    }
  }
  for (const ws of state.workspaces) {
    const isNone = isNoneWs(ws);
    const collapsed = state.collapsedWs.has(ws.id);
    const group = document.createElement('div');
    group.className = 'ws-group';
    group.dataset.wsId = ws.id;

    const head = document.createElement('div');
    head.className = 'ws-head';
    head.innerHTML = `
      <span class="chev ${collapsed ? '' : 'open'}">
        <svg width="11" height="11" viewBox="0 0 24 24" fill="none"><path d="M9 5l7 7-7 7" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      </span>
      <span class="folder-ic">${isNone
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M22 12h-6l-2 3h-4l-2-3H2M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none"><path d="M3 7a2 2 0 0 1 2-2h4l2 3h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" stroke="currentColor" stroke-width="1.8" stroke-linejoin="round"/></svg>'}</span>
      <span class="ws-name" title="${escapeHtml(ws.path || '')}">${escapeHtml(ws.name)}</span>
      <span class="ws-count">${(ws.chats || []).length || ''}</span>
      ${isNone ? '' : '<button class="ws-del" title="' + i18nT('deleteProjectTitle') + '">✕</button>'}`;
    head.onclick = (e) => {
      if (e.target.closest('.ws-del')) return;
      if (e.target.closest('.chev')) {
        toggleWsCollapse(ws.id);
        return;
      }
      activateWorkspace(ws.id);
    };
    if (!isNone) {
      head.querySelector('.ws-del').onclick = async (e) => {
        e.stopPropagation();
        if (state.settings && state.settings.confirmDelete !== false) {
          if (!confirm(i18nT('removeProject', { name: ws.name }))) return;
        }
        await api.workspaceRemove(ws.id);
        await loadWorkspaces();
        if (state.activeWorkspace && state.activeWorkspace.id === ws.id) {
          state.activeWorkspace = state.workspaces.find((w) => isNoneWs(w)) || state.workspaces[0] || null;
          if (state.activeWorkspace) activateWorkspace(state.activeWorkspace.id);
          else newChat();
        }
      };
    }
    group.appendChild(head);

    const chats = document.createElement('div');
    chats.className = 'ws-chats' + (collapsed ? ' collapsed' : '');
    const chatsInner = document.createElement('div');
    chatsInner.className = 'ws-chats-inner';
    chats.appendChild(chatsInner);
    if (ws.chats && ws.chats.length) {
      for (const chat of ws.chats) {
        chatsInner.appendChild(buildChatItem(ws, chat));
      }
    } else if (!collapsed) {
      const e2 = document.createElement('div');
      e2.className = 'ws-empty';
      e2.textContent = i18nT('noChats');
      chatsInner.appendChild(e2);
    }
    group.appendChild(chats);
    elWsScroll.appendChild(group);
  }
  renderBreadcrumb();
}

function buildChatItem(ws, chat) {
  const item = document.createElement('div');
  const sess = state.sessions[sessionKey(ws.id, chat.id)];
  const streaming = !!(sess && sess.streaming);
  const isActive = chat.id === state.activeChatId && ws.id === (state.activeWorkspace ? state.activeWorkspace.id : null);
  item.className = 'chat-item' + (isActive ? ' active' : '') + (streaming ? ' streaming' : '');
  item.dataset.chatId = chat.id;
  item.innerHTML = `
    <div class="chat-main">
      <div class="chat-title">
        <span class="chat-name">${escapeHtml(chat.title || i18nT('chat'))}</span>
        ${streaming ? '<span class="chat-live" title="' + i18nT('chatLive') + '"><span class="chat-live-dot"></span></span>' : ''}
        ${chatTime(chat) ? `<span class="chat-time">${escapeHtml(chatTime(chat))}</span>` : ''}
      </div>
      ${chatPreview(chat) ? `<div class="chat-preview">${escapeHtml(chatPreview(chat))}</div>` : ''}
    </div>
    <div class="chat-actions">
      <button class="chat-rename" title="${i18nT('renameTitle')}">✎</button>
      <button class="chat-del" title="${i18nT('deleteTitle')}">✕</button>
    </div>`;
  const nameEl = item.querySelector('.chat-name');
  const renameChat = () => {
    const next = prompt(i18nT('renameChat'), chat.title || '');
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) return;
    api.workspaceRenameChat({ workspaceId: ws.id, chatId: chat.id, title: trimmed }).then(() => {
      const local = state.workspaces.find((w) => w.id === ws.id);
      const c = local && local.chats.find((x) => x.id === chat.id);
      if (c) { c.title = trimmed; c.manualTitle = true; }
      const el = elWsScroll.querySelector('.chat-item[data-chat-id="' + chat.id + '"] .chat-name');
      if (el) el.textContent = trimmed;
      else renderWorkspaces();
    });
  };
  nameEl.ondblclick = (e) => { e.stopPropagation(); renameChat(); };
  item.querySelector('.chat-del').onclick = async (e) => {
    e.stopPropagation();
    if (state.settings && state.settings.confirmDelete !== false) {
      if (!confirm(i18nT('removeChat', { name: (chat.title || i18nT('chat')) }))) return;
    }
    await api.workspaceDeleteChat({ workspaceId: ws.id, chatId: chat.id });
    // если удалили стримящий чат — останавливаем его стрим и убираем сессию
    const gone = state.sessions[sessionKey(ws.id, chat.id)];
    if (gone) {
      if (gone.streaming) api.stopAgent(gone.streamKey);
      if (gone.unsubscribe) { gone.unsubscribe(); gone.unsubscribe = null; }
      delete state.sessions[sessionKey(ws.id, chat.id)];
    }
    if (state.activeChatId === chat.id) newChat();
    await loadWorkspaces();
  };
  item.querySelector('.chat-rename').onclick = (e) => {
    e.stopPropagation();
    renameChat();
  };
  item.onclick = () => openChat(ws.id, chat.id);
  return item;
}

function renderBreadcrumb() {
  if (state.activeWorkspace) {
    elCrumb.textContent = state.activeWorkspace.name;
    elCrumb.title = state.activeWorkspace.path;
  } else {
    elCrumb.textContent = i18nT('noProject');
    elCrumb.title = '';
  }
}

async function pickWorkspace() {
  const ws = await api.workspaceSelect();
  if (ws) {
    state.activeWorkspace = ws;
    state.activeChatId = null;
    await loadWorkspaces();
    newChat();
  }
}

async function activateWorkspace(id) {
  const ws = await api.workspaceActivate(id);
  if (ws) {
    state.activeWorkspace = ws;
    // держим список сайдбара синхронизированным с активным объектом,
    // иначе upsertChatItem() читает старый снапшот без нового чата
    const idx = state.workspaces.findIndex((w) => w.id === ws.id);
    if (idx >= 0) state.workspaces[idx] = ws;
    else state.workspaces.unshift(ws);
    state.activeChatId = null;
    state.messages = [];
    // активную папку показываем раскрытой (если Set уже инициализирован)
    if (state.collapsedWs) state.collapsedWs.delete(id);
    const prev = currentSession();
    if (prev && prev.container) prev.container.remove();
    if (prev) prev.dom = false;
    state.activeSessionId = null;
    clearMessages();
    updateSidebarState();
    persistUIState();
    updateStreamUI();
    setStatus('green', i18nT('project') + ': ' + ws.name);
  }
}

/* ---------- conversations ---------- */

function chatTitle(sess) {
  if (state.settings && state.settings.autoTitle === false) return i18nT('chat');
  const msgs = sess ? sess.messages : activeMessages();
  const m0 = msgs.find((m) => m.role === 'user');
  if (!m0) return i18nT('chat');
  const c = m0.content;
  const t = typeof c === 'string' ? c : (Array.isArray(c) && c[0] && c[0].text) || '';
  return t.trim().slice(0, 42) || i18nT('chat');
}

// глобально уникальный id чата — проверяем по всем воркспейсам
function newChatId() {
  let id;
  do {
    id = 'chat_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
  } while (state.workspaces.some((w) => (w.chats || []).some((c) => c.id === id)));
  return id;
}

function saveChat(sess) {
  const src = sess || currentSession();
  // сессия может быть фоновой (стрим другого воркспейса завершился) —
  // сохраняем в её собственный воркспейс, а не в текущий активный
  const ws = src && src.wsId
    ? (state.workspaces.find((w) => w.id === src.wsId) || state.activeWorkspace)
    : state.activeWorkspace;
  if (!ws) return;
  const msgs = src ? src.messages : state.messages;
  const chatId = (src && src.chatId) || state.activeChatId;
  const newId = !chatId;
  // ручное название (переименовано карандашом) не затираем автозаголовком
  let title = chatTitle(src);
  let manualTitle = false;
  if (!newId && ws.chats) {
    const existing = ws.chats.find((c) => c.id === chatId);
    if (existing && existing.manualTitle) { title = existing.title; manualTitle = true; }
  }
  const chat = {
    id: chatId || newChatId(),
    title,
    manualTitle,
    messages: msgs,
    updatedAt: Date.now()
  };
  if (newId) {
    state.activeChatId = chat.id;
    // переносим сессию под новый id, чтобы следующие сообщения шли в неё же
    const cur = src || currentSession();
    if (cur && !cur.chatId) renameSession(cur.id, sessionKey(ws.id, chat.id), chat.id);
  }
  ws.chats = ws.chats || [];
  const idx = ws.chats.findIndex((c) => c.id === chat.id);
  if (idx >= 0) ws.chats[idx] = chat;
  else ws.chats.unshift(chat);
  api.workspaceSaveChat({ workspaceId: ws.id, chat: { ...chat, messages: chat.messages.map((m) => ({ ...m })) } });
  upsertChatItem(ws, chat);
}

// точечное обновление одного чата в списке сайдбара — без перерисовки всего сайдбара
function upsertChatItem(ws, chat) {
  const groups = elWsScroll.querySelectorAll('.ws-group');
  let group = null;
  for (const g of groups) {
    if (g.dataset.wsId === ws.id) { group = g; break; }
  }
  if (!group) { renderWorkspaces(); return; }
  const chatsInner = group.querySelector('.ws-chats-inner') || group.querySelector('.ws-chats');
  const existing = chatsInner.querySelector('.chat-item[data-chat-id="' + chat.id + '"]');
  if (existing) {
    existing.replaceWith(buildChatItem(ws, chat));
  } else {
    const empty = chatsInner.querySelector('.ws-empty');
    if (empty) empty.remove();
    chatsInner.insertBefore(buildChatItem(ws, chat), chatsInner.firstChild);
  }
}

// лёгкое обновление выделения и свёрнутости сайдбара — вместо полной renderWorkspaces()
function updateSidebarState() {
  const groups = elWsScroll.querySelectorAll('.ws-group');
  if (!groups.length) { renderWorkspaces(); return; }
  for (const g of groups) {
    const collapsed = !!(state.collapsedWs && state.collapsedWs.has(g.dataset.wsId));
    const chev = g.querySelector('.chev');
    if (chev) chev.classList.toggle('open', !collapsed);
    const chats = g.querySelector('.ws-chats');
    if (chats) chats.classList.toggle('collapsed', collapsed);
  }
  const items = elWsScroll.querySelectorAll('.chat-item');
  const activeWsId = state.activeWorkspace ? state.activeWorkspace.id : null;
  for (const it of items) {
    const g = it.closest('.ws-group');
    const inActiveWs = !activeWsId || (g && g.dataset.wsId === activeWsId);
    it.classList.toggle('active', inActiveWs && it.dataset.chatId === state.activeChatId);
  }
  renderBreadcrumb();
}

function openChat(wsId, chatId) {
  const ws = state.workspaces.find((w) => w.id === wsId);
  const chat = ws && ws.chats.find((c) => c.id === chatId);
  if (!chat) return;
  state.activeWorkspace = ws;
  state.activeChatId = chatId;
  const sess = ensureSession(chatId, chat.messages, ws.id);
  // подменяем контейнер видимой сессии в #messages
  mountSession(sess);
  state.messages = sess.messages;
  // если контейнер ещё не отрисован — рисуем историю чата
  if (!sess.container || sess.container.childElementCount === 0) {
    let i = 0;
    for (const m of sess.messages) {
      if (m.role === 'user') {
        const txt = typeof m.content === 'string' ? m.content : (m.content && Array.isArray(m.content) ? (m.content[0] && m.content[0].text || '') : '');
        addUserMsg(txt, m.attachments, sess).wrapper.style.setProperty('--msg-delay', Math.min(i * 45, 400) + 'ms');
      } else if (m.role === 'assistant') {
        const a = addAssistantMsgStreamingLabel(0, sess);
        a.wrapper.style.setProperty('--msg-delay', Math.min(i * 45, 400) + 'ms');
        finalizeAssistant(a, m.content, sess);
      }
      i++;
    }
  }
  updateStreamUI();
  updateSidebarState();
  persistUIState();
}

/* ---------- chat ---------- */

function newChat() {
  state.activeChatId = null;
  state.messages = [];
  // убираем видимую сессию — остаётся пустой экран
  const prev = currentSession();
  if (prev && prev.container) prev.container.remove();
  if (prev) prev.dom = false;
  // сессия «нового чата» больше не нужна — следующее сообщение начнёт новую
  delete state.sessions[sessionKey(state.activeWorkspace ? state.activeWorkspace.id : null, '__new__')];
  state.activeSessionId = null;
  clearMessages();
  updateStreamUI();
  updateSidebarState();
  persistUIState();
}

// монтирует контейнер сессии в #messages (делает сессию видимой)
function mountSession(sess) {
  const prev = currentSession();
  if (prev && prev !== sess) {
    if (prev.container) prev.container.remove();
    prev.dom = false;
  }
  state.activeSessionId = sess.id;
  const c = sessionContainer(sess);
  elMessages.innerHTML = '';
  elEmpty.classList.add('hidden');
  elMessages.appendChild(c);
  sess.dom = true;
  scrollToBottom(sess);
}

function clearMessages() {
  elMessages.innerHTML = '';
  elMessages.appendChild(elEmpty);
  elEmpty.classList.remove('hidden');
}

function buildSystemMessage() {
  let sys = state.settings.systemPrompt || '';
  if (!sys.trim()) {
    sys = 'Ты — полезный ассистент. Отвечай кратко и по делу, помогай пользователю с задачами.';
  }
  const lang = state.settings.language || 'ru';
  const langRule = {
    ru: 'Отвечай всегда на русском языке.',
    en: 'Always respond in English.',
    kk: 'Әрқашан қазақ тілінде жауап бер.',
    uk: 'Відповідай завжди українською мовою.'
  }[lang];
  if (langRule) sys += '\n\n' + langRule;
  sys += '\n\nВАЖНО: если пользователь прикрепил картинку — описывай ТОЛЬКО то, что реально видишь на ней. НЕ выдумывай детали, которых нет. Если изображение нечёткое/маленькое или ты не уверен — прямо скажи об этом и опиши только очевидное. Никогда не описывай окна, ошибки или интерфейсы, если их нет на скриншоте.';
  if (state.settings.identityOverride && state.settings.publicName) {
    sys += `\n\nТы — ${state.settings.publicName}. Так и представляйся. Используй имя «${state.settings.publicName}».`;
  }
  if (state.activeWorkspace) {
    sys += `\n\nРабочая папка проекта: ${state.activeWorkspace.path}. Все пути в инструментах — относительные к ней.`;
  }
  sys += '\n\nСегодня: ' + new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' }) + '.';
  const agentOn = !!(state.settings && state.settings.agentMode);
  sys += '\n\nУ тебя ' + (agentOn ? 'есть доступ к инструментам' : 'нет доступа к инструментам') + ' (bash, файлы, интернет).';
  if (state.settings && state.settings.webTools === false) sys += ' Веб-инструменты (поиск/чтение страниц) отключены.';
  return sys;
}

function enabledSkills() {
  return state.skills.filter((s) => state.skillEnabled[s.id]).map((s) => ({ ...s }));
}

// Скилы вставляем отдельным user-сообщением перед историей, а не в system,
// потому что многие провайдеры (Kiro и др.) перебивают system prompt.
function buildSkillPrompt() {
  const list = enabledSkills();
  if (!list.length) return '';
  const blocks = list.map((s) => `## ${s.title}\n${s.description ? s.description + '\n' : ''}${s.body || ''}`);
  return [
    'Доступные скилы (справочный материал):',
    '',
    blocks.join('\n\n'),
    '',
    'Скилы — это справочники, а не задания. Применяй их ТОЛЬКО если запрос пользователя прямо и явно совпадает с их описанием.',
    'НЕ предлагай активировать скил, НЕ рекламируй его и НЕ упоминай его в обычном разговоре или приветствии.',
    'Если пользователь просто общается или задача не подходит ни одному скилу — работай без скилов, как обычно.'
  ].join('\n');
}

const TEXT_EXTS = /\.(txt|md|markdown|js|jsx|ts|tsx|json|py|html|css|scss|xml|yml|yaml|sh|bat|ps1|cmd|cs|java|c|cpp|h|sql|log|ini|cfg|toml|env|gitignore|vue|svelte|php|rb|go|rs|swift|kt|dart|lua|r|pl|svg)$/i;

function classifyFile(name) {
  // картинки больше не отправляем в vision (провайдеры галлюцинируют) —
  // они становятся просто меткой-вложением
  if (TEXT_EXTS.test(name)) return 'text';
  return 'binary';
}

function addPendingFiles(fileList) {
  for (const f of fileList) {
    state.pendingFiles.push({ name: f.name, size: f.size, kind: classifyFile(f.name), path: f.path || '' });
  }
  renderPendingFiles();
}

function renderPendingFiles() {
  elAttachments.innerHTML = '';
  if (!state.pendingFiles.length) { elAttachments.classList.add('hidden'); updateSendState(); return; }
  elAttachments.classList.remove('hidden');
  state.pendingFiles.forEach((pf, idx) => {
    const chip = document.createElement('div');
    chip.className = 'att-chip';
    const icon = pf.kind === 'image' ? '🖼️' : (pf.kind === 'text' ? '📄' : '📎');
    const size = pf.size > 1024 * 1024 ? (pf.size / 1024 / 1024).toFixed(1) + ' МБ' : Math.max(1, Math.round(pf.size / 1024)) + ' КБ';
    chip.innerHTML = '<span class="att-ico">' + icon + '</span><span class="att-name">' + escapeHtml(pf.name) + '</span><span class="att-size">' + size + '</span><button class="att-x" data-i="' + idx + '" title="' + i18nT('removeAttach') + '">×</button>';
    elAttachments.appendChild(chip);
  });
  for (const b of elAttachments.querySelectorAll('.att-x')) {
    b.addEventListener('click', () => { state.pendingFiles.splice(+b.dataset.i, 1); renderPendingFiles(); });
  }
}

function updateSendState() {
  const sess = currentSession();
  const on = !!(sess && sess.streaming);
  elSend.disabled = on || (elInput.value.trim().length === 0 && !state.pendingFiles.length);
}

// отражает состояние активной сессии в кнопках отправки/остановки
function updateStreamUI() {
  const sess = currentSession();
  const on = !!(sess && sess.streaming);
  elSend.disabled = on || (elInput.value.trim().length === 0 && !state.pendingFiles.length);
  elSend.classList.toggle('hidden', on);
  elStop.classList.toggle('hidden', !on);
}

async function send() {
  let text = elInput.value.trim();
  const sess = currentSession();
  if (sess && sess.streaming) return;
  if (!text && !state.pendingFiles.length) return;

  // активный чат мог быть удалён/пересоздан — если id не существует, стартуем новый
  // в текущем проекте, чтобы сообщение не улетало в «Без проекта» со старым id.
  if (state.activeChatId && state.activeWorkspace) {
    const exists = (state.activeWorkspace.chats || []).some((c) => c.id === state.activeChatId);
    if (!exists) state.activeChatId = null;
  }

  const model = elModel.value;
  const attachments = [];

  for (const pf of state.pendingFiles) {
    if (pf.kind === 'image') continue; // vision отключён
    const maxBytes = ((state.settings && state.settings.maxTextKb) || 500) * 1024;
    if (pf.kind === 'text' && pf.size <= maxBytes) {
      const r = await api.fsxReadAttached({ filePath: pf.path });
      if (r && r.text !== null) {
        const block = '\n\n[Приложенный файл: ' + pf.name + ']\n```\n' + r.text.slice(0, 30000) + '\n```\n';
        text += block;
        attachments.push({ name: pf.name, kind: 'text' });
        continue;
      }
    }
    attachments.push({ name: pf.name, kind: 'binary' });
  }

  // если остался пустой текст и нет вложений (например, были только картинки) — не отправляем
  if (!text.trim() && !attachments.length) {
    clearPendingFiles();
    return;
  }

  const displayText = text;
  // сессия для текущего чата (или новая для «нового чата»)
  const target = ensureSession(state.activeChatId, state.messages, state.activeWorkspace ? state.activeWorkspace.id : null);
  target.messages = target.messages.slice();
  state.activeSessionId = target.id;
  state.messages = target.messages;
  if (!target.dom) mountSession(target);

  addUserMsg(displayText, attachments, target);
  elInput.value = '';
  autosize();
  clearPendingFiles();

  const userContent = text;
  target.messages.push({ role: 'user', content: userContent, attachments });
  // чат появляется в сайдбаре сразу при отправке, а не после ответа
  saveChat(target);
  const systemMsg = buildSystemMessage();

  let assistantEl = null;
  let currentText = '';
  let round = 0;

  setStreaming(true, target);
  setStatus('amber', i18nT('statusClaudeThinking'));

  const unsub = api.onAgentChunk((chunk) => {
    // чанк от другой сессии (другого чата) — игнорируем, он уже обрабатывается своим хендлером
    if (chunk.sessionId && chunk.sessionId !== target.streamKey) return;
    if (chunk.type === 'text') {
      round = chunk.round || round;
      if (!assistantEl || (assistantEl.round !== chunk.round)) {
        if (assistantEl) finalizeAssistant(assistantEl, currentText, target);
        round = chunk.round || 0;
        currentText = '';
        assistantEl = addAssistantMsgStreamingLabel(round, target);
        assistantEl.round = round;
        pullToolCardsTo(assistantEl.wrapper, target);
      }
      currentText += chunk.text;
      renderAssistant(assistantEl, currentText, undefined, target);
    } else if (chunk.type === 'text_replace') {
      // основной процесс распознал «текстовые» вызовы инструментов и убрал их из текста
      if (assistantEl && assistantEl.round === chunk.round) {
        currentText = chunk.text || '';
        finalizeAssistant(assistantEl, currentText, target);
      }
    } else if (chunk.type === 'round') {
      if (assistantEl && assistantEl.round !== chunk.round) {
        finalizeAssistant(assistantEl, currentText, target);
        round = chunk.round;
        currentText = '';
        assistantEl = addAssistantMsgStreamingLabel(chunk.round, target);
        assistantEl.round = chunk.round;
      }
    } else if (chunk.type === 'tool_start') {
      const targetEl = assistantEl ? assistantEl.wrapper : null;
      const card = addToolCard(targetEl, { tool: chunk.tool, params: chunk.params, state: chunk.allowed ? 'running' : 'denied' }, target);
      card.dataset.callId = chunk.callId;
      target.toolCards.push(card);
      if (chunk.allowed) setStatus('amber', i18nT('statusExec', { tool: humanTool(chunk.tool) }));
    } else if (chunk.type === 'tool_result') {
      const card = target.toolCards.find((c) => c.dataset.callId === chunk.callId);
      const stateIm = {
        tool: chunk.tool,
        state: chunk.result.includes('"approved": false') ? 'denied' : 'done',
        resultText: chunk.result
      };
      setToolState(card, stateIm, target);
      if (!chunk.result.includes('"approved": false')) setStatus('green', i18nT('statusToolDone'));
    } else if (chunk.type === 'done') {
      if (assistantEl) finalizeAssistant(assistantEl, currentText, target);
      else {
        assistantEl = addAssistantMsgStreamingLabel(0, target);
        finalizeAssistant(assistantEl, chunk.text, target);
      }
      target.messages.push({ role: 'assistant', content: chunk.text });
      finalize(target, unsub);
      if (state.settings && state.settings.showTokens !== false && chunk.usage) {
        const u = chunk.usage;
        setStatus('green', i18nT('statusDoneTokens', { n: ((u.prompt_tokens || 0) + (u.completion_tokens || 0)) }));
      } else {
        setStatus('green', i18nT('statusDone'));
      }
    } else if (chunk.type === 'error') {
      if (assistantEl) {
        assistantEl.md.innerHTML = '<p style="color: var(--danger)">⚠️ ' + escapeHtml(chunk.message) + '</p>';
      } else {
        const a = addAssistantMsgStreamingLabel(0, target);
        a.md.innerHTML = '<p style="color: var(--danger)">⚠️ ' + escapeHtml(chunk.message) + '</p>';
      }
      target.messages.push({ role: 'assistant', content: chunk.text || (i18nT('msgErrorBadge') + chunk.message) });
      finalize(target, unsub);
      setStatus('red', i18nT('statusError'));
    } else if (chunk.type === 'aborted') {
      if (assistantEl && currentText) {
        assistantEl.md.innerHTML = renderMarkdown(currentText) + '<p style="color: var(--text-dim); font-size: 12px">· ' + i18nT('stopped') + '</p>';
        target.messages.push({ role: 'assistant', content: currentText });
      }
      finalize(target, unsub);
      setStatus('green', i18nT('stopped'));
    }
  });
  target.unsubscribe = unsub;

  const history = target.messages.slice(0, -1).map((m) => ({ ...m }));
  // бюджет контекста: отбрасываем самые старые сообщения, если история слишком длинная
  const budget = (state.settings && state.settings.maxContextChars) || 120000;
  if (budget > 0 && history.length) {
    let total = 0;
    const kept = [];
    for (let i = history.length - 1; i >= 0; i--) {
      const len = (history[i].content || '').length;
      if (total + len > budget && kept.length) break;
      total += len;
      kept.unshift(history[i]);
    }
    history.length = 0;
    for (const k of kept) history.push(k);
  }
  const skillPrompt = buildSkillPrompt();
  const messages = [
    { role: 'system', content: systemMsg },
    ...(skillPrompt ? [{ role: 'user', content: skillPrompt }] : []),
    ...history,
    { role: 'user', content: userContent }
  ];

  let result = null;
  try {
    result = await api.startAgent({
      sessionId: target.streamKey,
      workspaceId: state.activeWorkspace ? state.activeWorkspace.id : null,
      model,
      messages
    });
  } catch (err) {
    // шлюз мог упасть без событий — снимаем блокировку и сообщаем об ошибке
    if (target.streaming) {
      target.messages.push({ role: 'assistant', content: i18nT('errorLaunch') + err.message });
      finalize(target, unsub);
      setStatus('red', i18nT('statusError'));
    }
    return;
  }

  if (!target.streaming) return;
  if (result && result.aborted && !currentText && !target.messages.some((m) => m.role === 'user' && m.content === userContent)) {
    finalize(target, unsub);
    setStatus('green', i18nT('stopped'));
  }
}

function clearPendingFiles() {
  state.pendingFiles = [];
  renderPendingFiles();
}

function pullToolCardsTo(wrapper, sess) {
  const cards = sess ? sess.toolCards : [];
  for (const card of cards) {
    if (card.parentElement && card.parentElement !== wrapper) {
      card.remove();
      wrapper.appendChild(card);
    }
  }
}

function finalizeAssistant(el, text, sess) {
  if (!el) return;
  mdLastFlush.delete(el.md);
  renderAssistant(el, text || '', { live: false }, sess);
  mdLastFlush.delete(el.md);
}

function finalize(sess, unsub) {
  setStreaming(false, sess);
  if (unsub) { unsub(); sess.unsubscribe = null; }
  sess.toolCards = [];
  saveChat(sess);
}

function setStreaming(on, sess) {
  const target = sess || currentSession();
  if (target) target.streaming = on;
  updateChatLiveBadge(target);
  const active = currentSession();
  const isActive = !target || (active && active.id === target.id);
  if (isActive) {
    elSend.disabled = on || (elInput.value.trim().length === 0 && !state.pendingFiles.length);
    elSend.classList.toggle('hidden', on);
    elStop.classList.toggle('hidden', !on);
  }
}

// обновляет индикатор «работает» у чата в сайдбаре при старте/остановке стрима
function updateChatLiveBadge(sess) {
  if (!sess || !sess.chatId) return;
  const item = elWsScroll.querySelector('.ws-group[data-ws-id="' + (sess.wsId || 'none') + '"] .chat-item[data-chat-id="' + sess.chatId + '"]');
  if (!item) return;
  item.classList.toggle('streaming', !!sess.streaming);
  let dot = item.querySelector('.chat-live');
  if (sess.streaming && !dot) {
    const nameEl = item.querySelector('.chat-title');
    const badge = document.createElement('span');
    badge.className = 'chat-live';
    badge.title = i18nT('chatLive');
    badge.innerHTML = '<span class="chat-live-dot"></span>';
    nameEl.insertBefore(badge, nameEl.querySelector('.chat-time') || null);
  } else if (!sess.streaming && dot) {
    dot.remove();
  }
}

function stop() {
  const sess = currentSession();
  api.stopAgent(sess ? sess.streamKey : null);
}

/* ---------- models ---------- */

async function loadModels() {
  setStatus('amber', i18nT('loadingModels'));
  let models = [];
  try {
    const res = await api.listModels(state.settings);
    if (res && res.error) throw new Error(res.error);
    models = res || [];
  } catch (_) {
    setStatus('red', i18nT('noGateway'));
    elModel.innerHTML = '';
    const o = document.createElement('option');
    o.value = 'auto'; o.textContent = i18nT('gatewayDown');
    elModel.appendChild(o);
    return;
  }
  state.models = models;
  // вся палитра моделей, распределённая по категориям: Claude и всё остальное
  const ids = [...new Set(models.map((m) => m.id).filter(Boolean))];
  const claude = ids.filter((id) => /claude/i.test(id)).sort();
  const others = ids.filter((id) => !/claude/i.test(id)).sort();

  elModel.innerHTML = '';
  elModel.appendChild(op('auto', i18nT('smartRouting'), (!state.settings.model || state.settings.model === 'auto')));

  if (claude.length) {
    const g1 = document.createElement('optgroup');
    g1.label = 'Claude';
    for (const id of claude) g1.appendChild(op(id, prettyModel(id)));
    elModel.appendChild(g1);
  }
  if (others.length) {
    const g2 = document.createElement('optgroup');
    g2.label = i18nT('otherModels');
    for (const id of others) g2.appendChild(op(id, prettyModel(id)));
    elModel.appendChild(g2);
  }

  if (state.settings.model && Array.from(elModel.options).some((o) => o.value === state.settings.model)) {
    elModel.value = state.settings.model;
  }
  setStatus('green', i18nT('gatewayOk', { n: ids.length }));
}

function op(value, label, selected) {
  const o = document.createElement('option');
  o.value = value;
  o.textContent = label;
  if (selected) o.selected = true;
  return o;
}

/* ---------- skills ---------- */

function persistSkillToggles() {
  const enabled = state.skills.filter((s) => state.skillEnabled[s.id]).map((s) => s.id);
  api.setSettings({ enabledSkills: enabled }).catch(() => {});
}

async function loadSkills() {
  state.skills = await api.listSkills();
  const saved = state.settings && state.settings.enabledSkills;
  const savedSet = Array.isArray(saved) && saved.length ? new Set(saved) : null;
  state.skillEnabled = {};
  for (const s of state.skills) {
    state.skillEnabled[s.id] = savedSet ? savedSet.has(s.id) : s.enabled;
  }
  renderSkills();
}

function toggleSkill(id, el) {
  state.skillEnabled[id] = !state.skillEnabled[id];
  if (el) el.className = 'skill-toggle' + (state.skillEnabled[id] ? ' on' : '');
  persistSkillToggles();
}

function renderSkills() {
  elSkillsList.innerHTML = '';
  if (!state.skills.length) {
    const d = document.createElement('div');
    d.className = 'skill-empty';
    d.textContent = i18nT('skillsEmpty');
    elSkillsList.appendChild(d);
    return;
  }
  for (const skill of state.skills) {
    const item = document.createElement('div');
    item.className = 'skill-item';

    const toggle = document.createElement('div');
    toggle.className = 'skill-toggle' + (state.skillEnabled[skill.id] ? ' on' : '');
    toggle.onclick = () => toggleSkill(skill.id, toggle);
    item.appendChild(toggle);

    const meta = document.createElement('div');
    meta.className = 'skill-meta';
    const name = document.createElement('div');
    name.className = 'skill-name';
    name.textContent = skill.title;
    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    desc.textContent = skill.description || skill.id;
    meta.appendChild(name);
    meta.appendChild(desc);
    meta.onclick = () => openSkillEditor(skill);
    item.appendChild(meta);
    elSkillsList.appendChild(item);
  }
}

/* ---------- skill editor ---------- */

let skillEditing = null;

async function openSkillEditor(skill) {
  if (skill.editable === false) {
    const r = await api.readSkillBody(skill.id);
    $('skill-new-name').value = skill.title;
    $('skill-new-desc').value = skill.description;
    $('skill-body').value = r.error ? '' : dedentBody(r.content);
    skillEditing = { ...skill, readOnly: true };
  } else {
    const r = await api.readSkillBody(skill.id);
    $('skill-new-name').value = skill.title;
    $('skill-new-desc').value = skill.description;
    $('skill-body').value = r.error ? '' : dedentBody(r.content);
    skillEditing = skill;
  }
  $('skill-modal-title').textContent = i18nT('skillModalTitle', { name: skill.title });
  $('skill-form').classList.toggle('hidden', !!skillEditing.readOnly);
  $('skill-remove').classList.toggle('hidden', !!skillEditing.readOnly || !skill.id);
  $('skill-save').classList.toggle('hidden', !!skillEditing.readOnly);
  $('skill-modal').classList.remove('hidden');
}

function dedentBody(content) {
  const m = content.match(/^---\s*\n([\s\S]*?)\n---\s*/);
  return m ? content.slice(m[0].length).trim() : content;
}

async function saveSkill() {
  if (!skillEditing) return;
  const body = $('skill-body').value.trim();
  if (skillEditing.readOnly) {
    await api.updateSkillBody({ id: skillEditing.id, body: body });
  } else {
    // convert to full SKILL.md
    const full = `---\nname: ${$('skill-new-name').value.trim()}\ndescription: ${$('skill-new-desc').value.trim()}\n---\n\n${body}\n`;
    await api.updateSkillBody({ id: skillEditing.id, body: full });
  }
  $('skill-modal').classList.add('hidden');
  skillEditing = null;
  await loadSkills();
}

async function createSkill() {
  $('skill-new-name').value = '';
  $('skill-new-desc').value = '';
  $('skill-body').value = '';
  skillEditing = { isNew: true };
  $('skill-modal-title').textContent = i18nT('newSkill');
  $('skill-form').classList.remove('hidden');
  $('skill-remove').classList.add('hidden');
  $('skill-modal').classList.remove('hidden');
}

async function saveNewSkill() {
  const name = $('skill-new-name').value.trim();
  const desc = $('skill-new-desc').value.trim();
  const body = $('skill-body').value.trim();
  const res = await api.createSkill({ name, description: desc });
  if (res.error) { alert(res.error); return; }
  await api.updateSkillBody({ id: res.id, body: '---\nname: ' + name + '\ndescription: ' + desc + '\n---\n\n' + body + '\n' });
  $('skill-modal').classList.add('hidden');
  await loadSkills();
}

function onSkillSave() {
  if (skillEditing && skillEditing.isNew) saveNewSkill();
  else saveSkill();
}

async function removeSkill() {
  if (!skillEditing || skillEditing.readOnly) return;
  await api.removeSkill(skillEditing.id);
  $('skill-modal').classList.add('hidden');
  await loadSkills();
}

/* ---------- skill install ---------- */

function openSkillInstall() {
  $('skill-install-cmd').value = '';
  $('skill-install-output').classList.add('hidden');
  $('skill-install-output').textContent = '';
  $('skill-install-modal').classList.remove('hidden');
}

async function runSkillInstall() {
  const cmd = $('skill-install-cmd').value.trim();
  if (!cmd) return;
  const out = $('skill-install-output');
  out.classList.remove('hidden');
  out.textContent = i18nT('runningCmd', { cmd: cmd }) + '\n';
  const btn = $('skill-install-run');
  btn.disabled = true;
  try {
    const res = await api.installSkill({ command: cmd });
    let text = '';
    try {
      const r = JSON.parse(res?.output || '{}');
      text = r.stdout || r.stderr || '';
      if (r.error) text += '\n' + r.error;
    } catch (_) { text = String(res?.output || ''); }
    out.textContent = out.textContent + '--- output ---\n' + (text || i18nT('installationEmpty')) + '\n\n';
    if (res && Array.isArray(res.installed) && res.installed.length) {
      out.textContent += i18nT('installedList', { list: res.installed.map((i) => i.name + (i.updated ? i18nT('updated') : '')).join(', ') }) + '\n';
    } else {
      out.textContent += i18nT('noSkillsFound') + '\n';
    }
    await loadSkills();
  } catch (err) {
    out.textContent += '\n' + i18nT('errorPrefix') + err.message;
  } finally {
    btn.disabled = false;
  }
}

/* ---------- approval ---------- */

let approvalResolve = null;

async function setupApproval() {
  api.onApproval((payload) => {
    $('approval-label').textContent = i18nT('approveNeed', { label: payload.humanized.label });
    $('approval-title').textContent = payload.humanized.title || '';
    $('approval-code').textContent = payload.humanized.code || '';
    $('approval-remember').checked = false;
    $('approval-global').checked = false;
    $('approval').classList.remove('hidden');
    approvalResolve = (res) => {
      $('approval').classList.add('hidden');
      api.replyApproval(Object.assign({ sessionId: payload.sessionId }, res));
    };
  });

  $('approval-allow').onclick = () => {
    const r = approvalResolve; approvalResolve = null;
    if (r) r({ allow: true, remember: $('approval-remember').checked, globally: $('approval-global').checked });
  };
  $('approval-deny').onclick = () => {
    const r = approvalResolve; approvalResolve = null;
    if (r) r({ allow: false, remember: $('approval-remember').checked, globally: $('approval-global').checked });
  };
}

/* ---------- surveys/polls ---------- */

function showPollCard(payload) {
  const poll = payload.poll || {};
  const callId = payload.callId;
  const sessionId = payload.sessionId;
  const title = poll.title || '';
  const question = poll.question || i18nT('pollQuestion');
  const options = Array.isArray(poll.options) ? poll.options : [];
  const multiple = !!poll.multiple;
  const allowCustom = poll.allowCustom !== false;

  let sess = null;
  if (sessionId) {
    for (const key in state.sessions) {
      const s = state.sessions[key];
      if (s.streamKey === sessionId) { sess = s; break; }
    }
  }
  sess = sess || currentSession();
  const wrapper = (sess && sess.lastAssistant) || (sess ? sessionContainer(sess) : elMessages);
  const card = document.createElement('div');
  card.className = 'poll-card';
  card.dataset.callId = callId;
  const id = 'poll' + String(callId).replace(/\W/g, '') + Date.now();

  let optionsHtml = '';
  options.forEach((opt, i) => {
    let value = opt, desc = '';
    if (opt && typeof opt === 'object') { value = opt.value ?? opt.name ?? opt.text ?? ''; desc = opt.description || opt.desc || ''; }
    value = String(value).trim();
    if (!value) return;
    optionsHtml += `
      <label class="poll-opt">
        <input type="${multiple ? 'checkbox' : 'radio'}" name="${id}" value="${escapeHtml(value)}" data-i="${i}">
        <span class="poll-box"></span>
        <span class="poll-opt-txt">${escapeHtml(value)}${desc ? '<span class="poll-opt-desc">' + escapeHtml(desc) + '</span>' : ''}</span>
      </label>`;
  });

  if (allowCustom) {
    optionsHtml += `
      <label class="poll-opt poll-custom">
        <input type="${multiple ? 'checkbox' : 'radio'}" name="${id}" value="__custom__">
        <span class="poll-box"></span>
        <span class="poll-opt-txt">${i18nT('pollCustom')}</span>
        <input type="text" class="poll-custom-input" placeholder="${i18nT('pollCustomPh')}">
      </label>`;
  }

  card.innerHTML = `
    <div class="poll-body">
      ${title ? '<div class="poll-title">' + escapeHtml(title) + '</div>' : ''}
      <div class="poll-q">${escapeHtml(question)}</div>
      <div class="poll-opts">${optionsHtml}</div>
      <div class="poll-actions">
        <button class="poll-send" disabled>${i18nT('pollAnswer')}</button>
        <button class="poll-skip">${i18nT('pollSkip')}</button>
      </div>
      <div class="poll-answer hidden"></div>
    </div>`;

  const sendBtn = card.querySelector('.poll-send');
  const optsBox = card.querySelector('.poll-opts');
  const answerBox = card.querySelector('.poll-answer');
  const customInput = card.querySelector('.poll-custom-input');

  const hasCustomText = () => customInput && customInput.value.trim().length > 0;
  const checkedCount = () => optsBox.querySelectorAll('input:checked').length;
  const refreshSend = () => {
    if (!sendBtn) return;
    sendBtn.disabled = checkedCount() === 0 && !hasCustomText();
  };

  const submit = (viaCustom) => {
    const picks = [];
    let custom = '';
    optsBox.querySelectorAll('input:checked').forEach((i) => {
      if (i.value === '__custom__') custom = hasCustomText() ? customInput.value.trim() : '';
      else picks.push(i.value);
    });
    if (viaCustom && hasCustomText()) custom = customInput.value.trim();
    if (!picks.length && !custom) { refreshSend(); return; }
    card.classList.add('answered');
    optsBox.querySelectorAll('input').forEach((i) => (i.disabled = true));
    if (sendBtn) sendBtn.disabled = true;
    if (customInput) customInput.disabled = true;
    const parts = [];
    if (picks.length) parts.push(picks.join(', '));
    if (custom) parts.push('✍️ ' + custom);
    answerBox.textContent = i18nT('pollReplied', { answer: (parts.join(' · ') || '—') });
    answerBox.classList.remove('hidden');
    api.replyPoll({ sessionId, callId, picks, custom });
    scrollToBottom(sess);
  };

  optsBox.querySelectorAll('input').forEach((i) => {
    i.addEventListener('change', () => {
      if (!multiple && i.checked && i.value !== '__custom__') submit(false);
      else refreshSend();
    });
  });
  if (customInput) {
    customInput.addEventListener('input', refreshSend);
    customInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        const radio = optsBox.querySelector('input[value="__custom__"]');
        if (radio && !multiple) radio.checked = true;
        submit(true);
      }
    });
  }
  sendBtn.addEventListener('click', () => submit(false));
  card.querySelector('.poll-skip').addEventListener('click', () => {
    api.replyPoll({ sessionId, callId, picks: [], custom: '' });
    card.classList.add('answered');
    optsBox.querySelectorAll('input').forEach((i) => (i.disabled = true));
    if (customInput) customInput.disabled = true;
    answerBox.textContent = i18nT('pollSkipped');
    answerBox.classList.remove('hidden');
    scrollToBottom(sess);
  });
  refreshSend();

  wrapper.appendChild(card);
  scrollToBottom(sess);
}

function setupPoll() {
  api.onPoll((payload) => showPollCard(payload));
}

/* ---------- settings ---------- */

function openSettings() {
  api.getSettings().then((s) => {
    $('cfg-baseurl').value = s.baseUrl;
    $('cfg-apikey').value = s.apiKey;
    $('cfg-idle').value = Math.round((Number(s.streamIdleMs) || 45000) / 1000);
    $('cfg-idle-val').textContent = Math.round((Number(s.streamIdleMs) || 45000) / 1000) + 'с';
    $('cfg-req-timeout').value = Math.round((Number(s.requestTimeoutMs) || 120000) / 1000);
    $('cfg-temperature').value = s.temperature;
    $('cfg-temperature-val').textContent = s.temperature;
    $('cfg-topp').value = s.topP;
    $('cfg-topp-val').textContent = s.topP;
    $('cfg-frequency').value = s.frequencyPenalty;
    $('cfg-frequency-val').textContent = s.frequencyPenalty;
    $('cfg-presence').value = s.presencePenalty;
    $('cfg-presence-val').textContent = s.presencePenalty;
    $('cfg-max-tokens').value = s.maxTokens;
    $('cfg-max-rounds').value = s.maxToolRounds;
    $('cfg-empty-retries').value = s.maxEmptyRetries != null ? s.maxEmptyRetries : 4;
    $('cfg-seed').value = s.seed != null ? s.seed : '';
    $('cfg-context').value = Math.round((s.maxContextChars || 120000) / 1000);
    $('cfg-agent').checked = s.agentMode;
    $('cfg-approve').value = s.autoApprove || 'ask';
    $('cfg-webtools').checked = s.webTools !== false;
    $('cfg-loopguard').checked = s.loopProtection !== false;
    $('cfg-accent').value = s.accent || 'terracotta';
    $('cfg-theme').value = s.theme === 'dark' ? 'dark' : 'light';
    $('cfg-font-size').value = s.fontSize || 14;
    $('cfg-font-size-val').textContent = (s.fontSize || 14) + 'px';
    $('cfg-density').value = s.density || 'comfortable';
    $('cfg-animations').checked = s.animations !== false;
    $('cfg-autoscroll').checked = s.autoScroll !== false;
    $('cfg-radius').value = s.radius != null ? s.radius : 14;
    $('cfg-radius-val').textContent = (s.radius != null ? s.radius : 14) + 'px';
    $('cfg-msgwidth').value = s.messageWidth || 780;
    $('cfg-msgwidth-val').textContent = (s.messageWidth || 780) + 'px';
    $('cfg-codewrap').checked = s.codeWrap === true;
    $('cfg-showtokens').checked = s.showTokens !== false;
    $('cfg-enter').checked = s.enterToSend !== false;
    $('cfg-confirmdel').checked = s.confirmDelete !== false;
    $('cfg-maxtext').value = s.maxTextKb || 500;
    $('cfg-restore').checked = s.restoreOnStart !== false;
    $('cfg-autotitle').checked = s.autoTitle !== false;
    $('cfg-language').value = s.language || 'ru';
    $('cfg-ui-language').value = s.uiLanguage || 'auto';
    $('cfg-autoupdate').checked = s.autoUpdate !== false;
    $('cfg-publicname').value = s.publicName || 'Claude';
    $('cfg-identity').checked = s.identityOverride !== false;
    $('cfg-sysprompt').value = s.systemPrompt || '';
    $('conn-test-result').classList.add('hidden');
    fillSettingsModelSelect(s.model || 'auto');
    renderSettingsSkills();
    state.mcpServers = JSON.parse(JSON.stringify(s.mcpServers || []));
    renderMcpList();
    $('settings-modal').classList.remove('hidden');
  });
}

function fillSettingsModelSelect(current) {
  const sel = $('cfg-model');
  sel.innerHTML = '';
  sel.appendChild(op('auto', i18nT('smartRouting'), current === 'auto'));
  const claude = state.models.map((m) => m.id).filter((id) => /claude/i.test(id)).sort();
  const seen = new Set();
  const prefs = ['kr/claude-sonnet-4.5', 'kr/claude-sonnet-5', 'kr/claude-opus', 'kiro/claude-sonnet-5'];
  for (const p of prefs) if (claude.includes(p)) addOptTo(sel, p, current, seen);
  for (const m of claude) if (!/no-think|low|medium|high|xhigh/.test(m)) addOptTo(sel, m, current, seen);
  const others = state.models.map((m) => m.id).filter((id) => !/claude/i.test(id) && !/^(auto|kr|kiro)\//.test(id)).sort();
  for (const m of others) addOptTo(sel, m, current, seen);
}

function addOptTo(sel, id, current, seen) {
  if (seen.has(id)) return;
  seen.add(id);
  const o = op(id, prettyModel(id), current === id);
  sel.appendChild(o);
}

function renderSettingsSkills() {
  const listEl = $('settings-skills-list');
  listEl.innerHTML = '';
  if (!state.skills.length) {
    const d = document.createElement('div');
    d.className = 'skill-empty';
    d.textContent = i18nT('skillsEmptySettings');
    listEl.appendChild(d);
    return;
  }
  const frag = document.createDocumentFragment();
  for (const skill of state.skills) {
    const item = document.createElement('div');
    item.className = 'skills-nav-item';
    const toggle = document.createElement('div');
    toggle.className = 'skill-toggle' + (state.skillEnabled[skill.id] ? ' on' : '');
    toggle.onclick = (e) => {
      e.stopPropagation();
      toggleSkill(skill.id, toggle);
    };
    item.appendChild(toggle);
    const meta = document.createElement('div');
    meta.className = 'skill-meta';
    const name = document.createElement('div');
    name.className = 'skill-name';
    name.textContent = skill.title;
    const desc = document.createElement('div');
    desc.className = 'skill-desc';
    desc.textContent = skill.description || skill.id;
    meta.appendChild(name);
    meta.appendChild(desc);
    meta.onclick = () => openSkillEditor(skill);
    item.appendChild(meta);
    frag.appendChild(item);
  }
  listEl.appendChild(frag);
}

function closeSettings() {
  $('settings-modal').classList.add('hidden');
}

/* ---------- MCP servers ---------- */

function renderMcpList() {
  const listEl = $('mcp-list');
  listEl.innerHTML = '';
  if (!state.mcpServers.length) {
    const d = document.createElement('div');
    d.className = 'skill-empty';
    d.textContent = i18nT('mcpEmpty');
    listEl.appendChild(d);
    return;
  }
  const frag = document.createDocumentFragment();
  state.mcpServers.forEach((srv, idx) => {
    const item = document.createElement('div');
    item.className = 'mcp-item';

    const head = document.createElement('div');
    head.className = 'mcp-item-head';

    const toggle = document.createElement('label');
    toggle.className = 'chk';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = srv.enabled !== false;
    cb.onchange = () => { srv.enabled = cb.checked; renderMcpList(); };
    toggle.appendChild(cb);
    const labelSpan = document.createElement('span');
    labelSpan.textContent = i18nT('mcpEnabled');
    toggle.appendChild(labelSpan);
    head.appendChild(toggle);

    const nameInput = document.createElement('input');
    nameInput.type = 'text';
    nameInput.placeholder = i18nT('mcpNamePh');
    nameInput.value = srv.id || '';
    nameInput.spellcheck = false;
    nameInput.onchange = () => { srv.id = nameInput.value.trim().replace(/\s+/g, '_'); if (srv.id !== nameInput.value) nameInput.value = srv.id; };
    head.appendChild(nameInput);

    const badge = document.createElement('span');
    badge.className = 'mcp-item-badge' + (srv.enabled === false ? ' disabled' : '');
    badge.textContent = /^https?:\/\//i.test((srv.url || '').trim()) ? 'HTTP' : i18nT('modeCommand');
    head.appendChild(badge);

    const del = document.createElement('button');
    del.className = 'del';
    del.textContent = '✕';
    del.title = i18nT('deleteServerTitle');
    del.onclick = () => { state.mcpServers.splice(idx, 1); renderMcpList(); };
    head.appendChild(del);

    item.appendChild(head);

    const cmd = document.createElement('textarea');
    cmd.rows = 2;
    cmd.spellcheck = false;
    cmd.placeholder = i18nT('mcpCmdPh');
    if (/^https?:\/\//i.test((srv.url || '').trim())) {
      cmd.value = srv.url;
    } else {
      cmd.value = srv.command || '';
    }
    cmd.onchange = () => {
      const v = cmd.value.trim();
      if (/^https?:\/\//i.test(v)) { srv.url = v; srv.command = ''; }
      else { srv.command = v; srv.url = ''; }
      badge.textContent = /^https?:\/\//i.test(v) ? 'HTTP' : i18nT('modeCommand');
    };
    item.appendChild(cmd);

    const testBtn = document.createElement('button');
    testBtn.className = 'btn';
    testBtn.textContent = i18nT('mcpTest');
    testBtn.onclick = async () => {
      testBtn.disabled = true;
      resultEl.className = 'mcp-test-result';
      resultEl.textContent = i18nT('mcpTesting');
      const server = currentServer();
      const res = await api.mcpTest(server);
      testBtn.disabled = false;
      if (res && res.ok) {
        resultEl.className = 'mcp-test-result ok';
        resultEl.textContent = i18nT('mcpOk', { n: res.tools });
      } else {
        resultEl.className = 'mcp-test-result bad';
        resultEl.textContent = i18nT('mcpBad', { e: ((res && res.error) || i18nT('unknownErr')) });
      }
    };

    const resultEl = document.createElement('div');
    resultEl.className = 'mcp-test-result';
    item.appendChild(testBtn);
    item.appendChild(resultEl);

    const currentServer = () => {
      const v = cmd.value.trim();
      const enabled = cb.checked;
      if (/^https?:\/\//i.test(v)) return { id: nameInput.value.trim().replace(/\s+/g, '_') || `mcp_${idx + 1}`, url: v, command: '', enabled };
      return { id: nameInput.value.trim().replace(/\s+/g, '_') || `mcp_${idx + 1}`, command: v, url: '', enabled };
    };

    frag.appendChild(item);
  });
  listEl.appendChild(frag);
}

function addMcpServer() {
  state.mcpServers.push({ id: 'mcp_' + (state.mcpServers.length + 1), command: '', url: '', enabled: true });
  renderMcpList();
}

async function testConnection() {
  const box = $('conn-test-result');
  box.classList.remove('hidden');
  box.className = 'conn-result';
  box.textContent = i18nT('checking');
  const res = await api.testConnection({
    baseUrl: $('cfg-baseurl').value.trim(),
    apiKey: $('cfg-apikey').value.trim()
  });
  box.classList.remove('hidden');
  if (res && res.ok) {
    box.className = 'conn-result ok';
    box.textContent = i18nT('connOk', { n: res.count, ms: res.timeMs });
  } else {
    box.className = 'conn-result fail';
    box.textContent = i18nT('connBad', { e: ((res && res.error) || i18nT('unknownErr')) });
  }
}

async function resetSettings() {
  if (!confirm(i18nT('confirmReset'))) return;
  state.settings = await api.resetSettings();
  closeSettings();
  applyUiSettings();
  loadModels();
}

async function saveSettings() {
  const patch = {
    baseUrl: $('cfg-baseurl').value.trim(),
    apiKey: $('cfg-apikey').value.trim(),
    streamIdleMs: (parseInt($('cfg-idle').value, 10) || 45) * 1000,
    requestTimeoutMs: (parseInt($('cfg-req-timeout').value, 10) || 120) * 1000,
    temperature: parseFloat($('cfg-temperature').value),
    topP: parseFloat($('cfg-topp').value),
    frequencyPenalty: parseFloat($('cfg-frequency').value),
    presencePenalty: parseFloat($('cfg-presence').value),
    maxTokens: parseInt($('cfg-max-tokens').value, 10) || 8192,
    maxToolRounds: parseInt($('cfg-max-rounds').value, 10) || 40,
    maxEmptyRetries: parseInt($('cfg-empty-retries').value, 10) || 4,
    seed: $('cfg-seed').value === '' ? null : parseInt($('cfg-seed').value, 10) || null,
    maxContextChars: (parseInt($('cfg-context').value, 10) || 120) * 1000,
    agentMode: $('cfg-agent').checked,
    autoApprove: $('cfg-approve').value,
    webTools: $('cfg-webtools').checked,
    loopProtection: $('cfg-loopguard').checked,
    accent: $('cfg-accent').value,
    theme: $('cfg-theme').value,
    fontSize: parseInt($('cfg-font-size').value, 10) || 14,
    density: $('cfg-density').value,
    animations: $('cfg-animations').checked,
    autoScroll: $('cfg-autoscroll').checked,
    radius: parseInt($('cfg-radius').value, 10) || 14,
    messageWidth: parseInt($('cfg-msgwidth').value, 10) || 780,
    codeWrap: $('cfg-codewrap').checked,
    showTokens: $('cfg-showtokens').checked,
    enterToSend: $('cfg-enter').checked,
    confirmDelete: $('cfg-confirmdel').checked,
    maxTextKb: parseInt($('cfg-maxtext').value, 10) || 500,
    restoreOnStart: $('cfg-restore').checked,
    autoTitle: $('cfg-autotitle').checked,
    language: $('cfg-language').value,
    uiLanguage: $('cfg-ui-language').value,
    autoUpdate: $('cfg-autoupdate').checked,
    publicName: $('cfg-publicname').value.trim() || 'Claude',
    identityOverride: $('cfg-identity').checked,
    systemPrompt: $('cfg-sysprompt').value,
    model: $('cfg-model').value,
    mcpServers: state.mcpServers.map((s) => ({
      id: (s.id || '').trim().replace(/\s+/g, '_') || 'mcp',
      command: s.command || '',
      url: s.url || '',
      enabled: s.enabled !== false
    })).filter((s) => s.id && (s.command || s.url))
  };
  state.settings = await api.setSettings(patch);
  applyUiLanguage(patch.uiLanguage);
  closeSettings();
  smoothThemeSwitch();
  applyUiSettings();
  const off = $('agent-tip');
  if (off) off.textContent = patch.agentMode
    ? i18nT('agentTipOn')
    : i18nT('agentTipOff');
  loadModels();
}

function applyUiSettings() {
  const s = state.settings;
  document.body.classList.toggle('dark', s.theme === 'dark');
  document.body.classList.toggle('light', s.theme !== 'dark');
  document.body.dataset.accent = s.accent || 'terracotta';
  document.body.dataset.density = s.density || 'comfortable';
  document.body.dataset.anim = s.animations === false ? 'off' : 'on';
  document.body.dataset.codewrap = s.codeWrap === true ? 'on' : 'off';
  const appEl = $('app');
  if (appEl) {
    appEl.style.zoom = (Number(s.fontSize) || 14) / 14;
    const root = document.documentElement;
    root.style.setProperty('--ui-radius', (s.radius != null ? s.radius : 14) + 'px');
    root.style.setProperty('--msg-max-width', (s.messageWidth || 780) + 'px');
  }
}

async function applyUiLanguage(pref) {
  const want = pref || (state.settings && state.settings.uiLanguage) || 'auto';
  let lang = 'ru';
  if (want !== 'auto') {
    lang = /^ru/i.test(want) ? 'ru' : 'en';
  } else {
    try {
      const loc = await api.getLocale();
      lang = /^(ru|uk|be|kk|ky|uz|tg|az|hy|ka|bg|bg-BG|sr)/i.test(loc) ? 'ru' : 'en';
    } catch (_) { lang = 'ru'; }
  }
  i18nSet(lang);
  i18nApplyStatic();
}

function smoothThemeSwitch() {
  document.body.classList.add('theme-anim');
  clearTimeout(smoothThemeSwitch._t);
  smoothThemeSwitch._t = setTimeout(() => document.body.classList.remove('theme-anim'), 350);
}

function setupSettingsTabs() {
  const nav = document.querySelectorAll('#settings-nav .stab');
  for (const btn of nav) {
    btn.onclick = () => {
      for (const b of nav) b.classList.remove('active');
      btn.classList.add('active');
      for (const p of document.querySelectorAll('.spanel')) p.classList.remove('active');
      $('spanel-' + btn.dataset.tab).classList.add('active');
    };
  }

  const bindVal = (rangeId, valId, suffix) => {
    const r = $(rangeId), v = $(valId);
    if (!r || !v) return;
    r.addEventListener('input', () => { v.textContent = r.value + (suffix || ''); });
  };
  bindVal('cfg-temperature', 'cfg-temperature-val');
  bindVal('cfg-topp', 'cfg-topp-val');
  bindVal('cfg-frequency', 'cfg-frequency-val');
  bindVal('cfg-presence', 'cfg-presence-val');
  bindVal('cfg-idle', 'cfg-idle-val', 'с');
  bindVal('cfg-font-size', 'cfg-font-size-val', 'px');
  bindVal('cfg-radius', 'cfg-radius-val', 'px');
  bindVal('cfg-msgwidth', 'cfg-msgwidth-val', 'px');
}

/* ---------- init ---------- */

async function init() {
  state.settings = await api.getSettings();
  applyUiSettings();
  await applyUiLanguage();
  setupOnboarding();
  const off = $('agent-tip');
  if (off) off.textContent = state.settings.agentMode
    ? i18nT('agentTipOn')
    : i18nT('agentTipOff');

  elInput.addEventListener('input', () => { autosize(); updateSendState(); });
  elInput.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter') return;
    const enterToSend = state.settings && state.settings.enterToSend !== false;
    if (e.shiftKey) return; // Shift+Enter всегда новая строка
    if (enterToSend ? true : e.ctrlKey) { e.preventDefault(); send(); }
  });
  elSend.addEventListener('click', send);
  elStop.addEventListener('click', stop);
  elModel.addEventListener('change', () => {
    state.settings = Object.assign({}, state.settings, { model: elModel.value });
    api.setSettings({ model: elModel.value }).catch(() => {});
  });
  if (elAttach) elAttach.addEventListener('click', () => elFileInput && elFileInput.click());
  if (elFileInput) elFileInput.addEventListener('change', () => { addPendingFiles(Array.from(elFileInput.files || [])); elFileInput.value = ''; });
  const dropZone = $('composer');
  if (dropZone) {
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.classList.remove('drag-over'); addPendingFiles(e.dataTransfer ? Array.from(e.dataTransfer.files || []) : []); });
  }
  $('new-chat-btn').addEventListener('click', newChat);
  $('add-ws-btn').addEventListener('click', pickWorkspace);
  $('empty-add-ws').addEventListener('click', pickWorkspace);
  $('empty-new-chat').addEventListener('click', newChat);
  $('settings-btn').addEventListener('click', openSettings);
  $('theme-btn').addEventListener('click', toggleTheme);
  $('modal-close').addEventListener('click', closeSettings);
  $('save-settings').addEventListener('click', saveSettings);
  $('skill-add-btn').addEventListener('click', createSkill);
  $('skill-save').addEventListener('click', onSkillSave);
  $('skill-remove').addEventListener('click', removeSkill);
  $('skill-modal-close').addEventListener('click', () => $('skill-modal').classList.add('hidden'));
  $('skill-install-btn').addEventListener('click', openSkillInstall);
  $('skill-install-close').addEventListener('click', () => $('skill-install-modal').classList.add('hidden'));
  $('skill-install-run').addEventListener('click', runSkillInstall);
  setupSettingsTabs();
  $('refresh-models-panel').addEventListener('click', loadModels);
  $('test-conn-panel').addEventListener('click', testConnection);
  $('reset-settings-panel').addEventListener('click', resetSettings);
  $('clear-rules-panel').addEventListener('click', async () => { await api.clearRules(); setStatus('green', i18nT('resetDone')); });
  $('settings-skill-install').addEventListener('click', openSkillInstall);
  $('settings-skill-add').addEventListener('click', createSkill);
  $('mcp-add').addEventListener('click', addMcpServer);

  setupApproval();
  setupPoll();
  setupUpdates();
  setStreaming(false);

  await Promise.all([loadWorkspaces(), loadModels(), loadSkills()]);
}

async function toggleTheme() {
  const next = state.settings.theme === 'dark' ? 'light' : 'dark';
  state.settings = await api.setSettings({ theme: next });
  smoothThemeSwitch();
  applyUiSettings();
}

/* ---------- updates ---------- */

function setupUpdates() {
  const banner = $('upd-banner');
  const statusEl = $('upd-status');
  const progressEl = $('upd-progress');
  const progressFill = $('upd-progress-fill');

  const applyState = (st) => {
    const status = (st && st.status) || 'idle';
    const installBtn = $('upd-install-btn');
    const checkBtn = $('upd-check-btn');

    if (statusEl) {
      const map = {
        idle: 'updIdle',
        checking: 'updChecking',
        available: 'updAvailable',
        uptodate: 'updUpToDate',
        downloading: 'updDownloading',
        downloaded: 'updDownloaded',
        error: 'updError'
      };
      statusEl.textContent = i18nT(map[status] || 'updIdle');
      if (status === 'available' || status === 'downloaded') {
        statusEl.textContent = statusEl.textContent.replace('{v}', (st && st.version) || '');
      }
      if (status === 'error') {
        statusEl.textContent = (st && st.message) ? i18nT('updError') + ': ' + st.message : i18nT('updError');
      }
    }
    if (progressEl) {
      progressEl.classList.toggle('hidden', status !== 'downloading');
      if (progressFill) progressFill.style.width = ((st && st.progress) || 0) + '%';
    }
    if (installBtn) installBtn.classList.toggle('hidden', !(status === 'downloaded' || status === 'available'));
    if (checkBtn) checkBtn.disabled = status === 'checking' || status === 'downloading';

    if (banner) {
      const show = status === 'available' || status === 'downloaded';
      banner.classList.toggle('hidden', !show);
      const sub = $('upd-banner-sub');
      if (sub && st && st.version) {
        sub.setAttribute('data-i18n', 'updBannerSubV');
        sub.textContent = i18nT('updBannerSubV').replace('{v}', st.version);
      }
    }
  };

  api.getUpdateState().then(applyState).catch(() => {});
  const off = api.onUpdateState(applyState);
  if (off) window.__updateOff = off;

  const checkBtn = $('upd-check-btn');
  if (checkBtn) checkBtn.addEventListener('click', () => api.checkUpdates());
  const installBtn = $('upd-install-btn');
  if (installBtn) installBtn.addEventListener('click', () => api.downloadUpdate());
  const bannerBtn = $('upd-banner-btn');
  if (bannerBtn) bannerBtn.addEventListener('click', () => api.downloadUpdate());
  const bannerClose = $('upd-banner-close');
  if (bannerClose) bannerClose.addEventListener('click', () => {
    banner.classList.add('hidden');
  });
}

init().catch((err) => {
  elStatusText.textContent = i18nT('errorPrefix') + err.message;
  elStatusDot.className = 'dot red';
});

/* ---------- onboarding ---------- */

function setupOnboarding() {
  const root = $('ob-welcome');
  if (!root || state.settings.onboarded === true) return;
  root.classList.remove('hidden');

  const slides = Array.prototype.slice.call(root.querySelectorAll('.ob-slide'));
  const showSlide = (i) => {
    slides.forEach((s, idx) => s.classList.toggle('active', idx === i));
    if (i === 2) {
      i18nApplyStaticFor(modelLang, $('ob-demo-slide'));
      runDemo();
    }
  };
  showSlide(0);
  runBoot();

  let uiLang = state.settings.uiLanguage || 'auto';
  let modelLang = state.settings.language || 'ru';

  const pick = (group, cls, datasetKey, val) => {
    group.forEach((c) => c.classList.toggle('ob-card-active', c.dataset[datasetKey] === val));
  };
  const uiCards = Array.prototype.slice.call(root.querySelectorAll('.ob-lang-card'));
  const modelCards = Array.prototype.slice.call(root.querySelectorAll('.ob-model-card'));
  uiCards.forEach((c) => c.addEventListener('click', () => {
    uiLang = c.dataset.uiLang;
    pick(uiCards, 'ob-card-active', 'uiLang', uiLang);
  }));
  modelCards.forEach((c) => c.addEventListener('click', () => {
    modelLang = c.dataset.modelLang;
    pick(modelCards, 'ob-card-active', 'modelLang', modelLang);
    i18nApplyStaticFor(modelLang, $('ob-demo-slide'));
  }));

  $('ob-start').addEventListener('click', () => {
    i18nApplyStatic(root);
    showSlide(1);
  });
  $('ob-ai-next').addEventListener('click', () => {
    applyUiLanguage(uiLang).then(() => i18nApplyStatic());
    api.setSettings({ uiLanguage: uiLang, language: modelLang }).catch(() => {});
    state.settings = Object.assign({}, state.settings, { uiLanguage: uiLang, language: modelLang });
    showSlide(2);
  });
  $('ob-demo-next').addEventListener('click', () => showSlide(3));
  $('ob-feat-next').addEventListener('click', () => showSlide(4));
  $('ob-skill-install').addEventListener('click', () => {
    exitOnboarding(() => openSkillInstall());
  });
  const finish = async () => {
    exitOnboarding(async () => {
      try {
        await api.setOnboarded(true);
        state.settings = Object.assign({}, state.settings, { onboarded: true });
      } catch (_) { /* ignore */ }
    });
  };
  $('ob-finish').addEventListener('click', finish);
  $('ob-enter-app').addEventListener('click', finish);
}

function exitOnboarding(after) {
  const root = $('ob-welcome');
  if (!root) { if (after) after(); return; }
  root.classList.add('ob-exit');
  setTimeout(() => {
    root.classList.add('hidden');
    root.classList.remove('ob-exit');
    if (after) after();
  }, 480);
}

function runBoot() {
  const boot = $('ob-boot');
  const hero = $('ob-hero');
  const fill = $('ob-boot-fill');
  const pct = $('ob-boot-pct');
  const lines = Array.prototype.slice.call(boot.querySelectorAll('.ob-boot-line'));
  const stepMs = 620;
  const total = lines.length;
  let idx = 0;
  const step = () => {
    if (idx > 0) lines[idx - 1].classList.remove('ob-active');
    if (idx > 0) lines[idx - 1].classList.add('ob-done');
    if (idx < total) {
      lines[idx].classList.add('ob-active');
      fill.style.width = Math.round(((idx + 1) / (total + 1)) * 100) + '%';
      pct.textContent = Math.round(((idx + 1) / (total + 1)) * 100) + '%';
      idx++;
      setTimeout(step, stepMs);
    } else {
      fill.style.width = '100%';
      pct.textContent = '100%';
      setTimeout(() => {
        boot.classList.add('ob-boot-hide');
        hero.classList.remove('hidden');
        hero.classList.add('show');
      }, 350);
    }
  };
  setTimeout(step, 400);
}

function runDemo() {
  const tools = Array.prototype.slice.call(document.querySelectorAll('.ob-demo-tool'));
  const ans = document.querySelector('.ob-demo-ans');
  tools.forEach((t) => t.classList.remove('ob-in'));
  if (ans) ans.classList.remove('ob-in');
  const timers = [];
  tools.forEach((t, i) => {
    timers.push(setTimeout(() => t.classList.add('ob-in'), 1400 + i * 1100));
  });
  timers.push(setTimeout(() => ans && ans.classList.add('ob-in'), 1400 + tools.length * 1100 + 400));
  document.addEventListener('obDemoAbort', () => timers.forEach(clearTimeout), { once: true });
}