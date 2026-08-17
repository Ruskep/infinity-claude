const { app } = require('electron');
const fs = require('fs');
const path = require('path');

const lib = path.join(app.getPath('userData'), 'workspaces.json');

// виртуальный воркспейс для чатов без выбранного проекта
const NONE_ID = 'none';

let wsCache = null;

function load() {
  if (wsCache) return wsCache;
  try {
    wsCache = JSON.parse(fs.readFileSync(lib, 'utf8'));
  } catch (_) {
    wsCache = [];
  }
  if (!Array.isArray(wsCache)) wsCache = [];
  ensureNoneWorkspace();
  dedupeChatIds();
  return wsCache;
}

// чаты должны иметь глобально уникальные id — иначе чат с одинаковым id
// в двух папках подсвечивается как «выбранный» и открывается не тот чат
function uniqueChatId() {
  let id;
  do {
    id = 'chat_' + Date.now() + '_' + Math.floor(Math.random() * 9999);
  } while (wsCache.some((w) => (w.chats || []).some((c) => c.id === id)));
  return id;
}

function dedupeChatIds() {
  const seen = new Set();
  let changed = false;
  for (const w of wsCache) {
    for (const c of (w.chats || [])) {
      if (!c.id || seen.has(c.id)) {
        c.id = uniqueChatId();
        seen.add(c.id);
        changed = true;
      } else {
        seen.add(c.id);
      }
    }
  }
  if (changed) save();
}

function ensureNoneWorkspace() {
  if (!wsCache.some((w) => w.id === NONE_ID)) {
    wsCache.unshift({ id: NONE_ID, name: 'Без проекта', path: null, chats: [] });
    save();
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(lib), { recursive: true });
    fs.writeFileSync(lib, JSON.stringify(wsCache, null, 2), 'utf8');
  } catch (err) {
    console.error('workspaces save failed:', err.message);
  }
}

function init() { load(); }

function list() { return load(); }

function get(id) {
  return load().find((w) => w.id === id) || null;
}

function add(folderPath) {
  load();
  const resolved = path.resolve(folderPath);
  let existing = wsCache.find((w) => w.path === resolved);
  if (existing) return existing;

  const ws = {
    id: 'ws_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
    name: path.basename(resolved) || resolved,
    path: resolved,
    chats: []
  };
  wsCache.unshift(ws);
  save();
  return ws;
}

function remove(id) {
  load();
  if (id === NONE_ID) return;
  wsCache = wsCache.filter((w) => w.id !== id);
  save();
}

function saveChat(workspaceId, chat) {
  load();
  const ws = wsCache.find((w) => w.id === workspaceId);
  if (!ws) return null;
  let id = chat.id;
  // защита от дубликатов: если id уже занят чатом в ДРУГОМ воркспейсе,
  // а в этом его нет — сохраняем под новым id
  const inThis = ws.chats.some((c) => c.id === id);
  const inOther = !inThis && wsCache.some((w) => w.id !== workspaceId && (w.chats || []).some((c) => c.id === id));
  if (inOther) {
    id = uniqueChatId();
    chat = { ...chat, id };
  }
  const idx = ws.chats.findIndex((c) => c.id === id);
  if (idx >= 0) ws.chats[idx] = chat;
  else ws.chats.unshift(chat);
  save();
  return ws;
}

function deleteChat(workspaceId, chatId) {
  load();
  const ws = wsCache.find((w) => w.id === workspaceId);
  if (!ws) return [];
  ws.chats = ws.chats.filter((c) => c.id !== chatId);
  save();
  return ws.chats;
}

function renameChat(workspaceId, chatId, title) {
  load();
  const ws = wsCache.find((w) => w.id === workspaceId);
  if (!ws) return null;
  const chat = ws.chats.find((c) => c.id === chatId);
  if (!chat) return null;
  chat.title = String(title || '').trim() || chat.title;
  save();
  return ws.chats;
}

module.exports = { init, list, get, add, remove, saveChat, deleteChat, renameChat, NONE_ID };