const { app, BrowserWindow, ipcMain, Menu, dialog, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const settings = require('./src/settings');
const gateway = require('./src/gateway');
const skills = require('./src/skills');
const workspaces = require('./src/workspaces');
const fsx = require('./src/fsx');
const shell = require('./src/shell');
const texttools = require('./src/texttools');
const webtools = require('./src/webtools');
const mcp = require('./src/mcp');

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'bash',
      description: 'Выполнить команду в терминале (в папке проекта). Windows, cmd.exe. Возвращает stdout/stderr и код выхода.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'Команда для выполнения, например: dir, npm install, git status' }
        },
        required: ['command']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Прочитать содержимое файла внутри папки проекта (относительный путь).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь к файлу, например src/index.js' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Создать или полностью перезаписать файл внутри папки проекта (относительный путь). Создаёт недостающие папки.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь к файлу' },
          content: { type: 'string', description: 'Полное содержимое файла' }
        },
        required: ['path', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Заменить фрагмент текста в файле внутри папки проекта. old и new должны быть уникальными в файле.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь к файлу' },
          old_string: { type: 'string', description: 'Точный фрагмент для замены' },
          new_string: { type: 'string', description: 'Новый текст' }
        },
        required: ['path', 'old_string', 'new_string']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Удалить файл или пустую папку внутри проекта (относительный путь).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'Перечислить файлы и папки внутри проекта (относительный путь, пусто = корень).',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Относительный путь или пустая строка для корня' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Поиск в интернете (DuckDuckGo). Вернёт список результатов: заголовок, ссылка, сниппет. Используй, чтобы найти актуальную информацию, документацию, примеры.',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Поисковый запрос' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Прочитать веб-страницу по URL и вернуть её текстовое содержимое (заголовок, текст, ссылки). Подходит для документации, статей, сайтов.',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: 'Полный URL страницы, например https://example.com/page' }
        },
        required: ['url']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'ask_user',
      description: 'Задать пользователю вопрос с выбором вариантов (как анкета/опрос). Показывается интерактивная карточка: можно выбрать один вариант, несколько, или написать свой текст. Используй, когда нужно мнение/выбор пользователя, а не просто информация.',
      parameters: {
        type: 'object',
        properties: {
          question: { type: 'string', description: 'Текст вопроса' },
          title: { type: 'string', description: 'Заголовок опроса (короткое название темы, необязательно)' },
          options: { type: 'array', items: { anyOf: [ { type: 'string' }, { type: 'object', properties: { value: { type: 'string', description: 'Текст варианта' }, description: { type: 'string', description: 'Короткое пояснение к варианту (необязательно)' } }, required: ['value'] } ] }, description: 'Варианты ответа (2–10). Можно передать строки или объекты {value, description}' },
          multiple: { type: 'boolean', description: 'Разрешить выбирать несколько вариантов (по умолчанию false)' },
          allowCustom: { type: 'boolean', description: 'Показывать поле для своего варианта (по умолчанию true)' }
        },
        required: ['question', 'options']
      }
    }
  }
];

// Разрешения, запомненные на текущую сессию ("Always for this session")
const sessionRules = [];   // { tool, pathPrefix, allow }

// Набор инструментов, которые отдаём модели (учитывая настройку «веб-доступ»)
async function toolSet(cfg) {
  let tools = TOOLS.filter((t) => !['web_search', 'web_fetch'].includes(t.function.name));
  if (cfg.webTools !== false) {
    tools = TOOLS.slice();
  }
  if (cfg.agentMode && (cfg.mcpServers || []).length) {
    try {
      const mcpTools = await mcp.listTools(cfg.mcpServers);
      if (mcpTools.length) tools = tools.concat(mcpTools);
    } catch (err) {
      console.error('MCP tools load failed:', err.message);
    }
  }
  return tools;
}

let mainWindow = null;
let activeController = null;
let activeWorkspaceId = null;

/* ---------- window ---------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 860,
    minWidth: 1024,
    minHeight: 640,
    title: 'InfinityClaude',
    icon: path.join(__dirname, 'build', 'icon.ico'),
    backgroundColor: '#f9f7f4',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false
    }
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (process.platform === 'win32') {
    mainWindow.setIcon(nativeImage.createFromPath(path.join(__dirname, 'build', 'icon.ico')));
  }
}

app.whenReady().then(() => {
  Menu.setApplicationMenu(null); // блокирует меню на Alt полностью
  if (process.platform === 'win32') {
    app.setAppUserModelId('infinityclaude.desktop');
  }
  settings.init();
  workspaces.init();
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

/* ---------- settings ---------- */

ipcMain.handle('settings:get', () => settings.get());
ipcMain.handle('settings:set', (_e, patch) => settings.set(patch));
ipcMain.handle('settings:reset', () => settings.reset());

ipcMain.handle('settings:test', async (_e, cfg) => {
  try {
    const start = Date.now();
    const models = await gateway.listModels(cfg || settings.get());
    return { ok: true, timeMs: Date.now() - start, count: (models || []).length };
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

/* ---------- models ---------- */

ipcMain.handle('models:list', async (_e, cfg) => {
  try {
    return await gateway.listModels(cfg || settings.get());
  } catch (err) {
    return { error: err.message };
  }
});

/* ---------- workspaces ---------- */

ipcMain.handle('workspace:list', () => workspaces.list());

ipcMain.handle('workspace:select', async () => {
  const res = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Выберите папку проекта'
  });
  if (res.canceled || !res.filePaths[0]) return null;
  const ws = workspaces.add(res.filePaths[0]);
  activeWorkspaceId = ws.id;
  return ws;
});

ipcMain.handle('workspace:activate', (_e, id) => {
  activeWorkspaceId = id;
  return workspaces.get(id);
});

ipcMain.handle('workspace:remove', (_e, id) => workspaces.remove(id));

ipcMain.handle('workspace:saveChat', (_e, { workspaceId, chat }) => {
  const ws = workspaces.saveChat(workspaceId, chat);
  return ws ? ws.chats : [];
});

ipcMain.handle('workspace:deleteChat', (_e, { workspaceId, chatId }) => {
  return workspaces.deleteChat(workspaceId, chatId);
});

ipcMain.handle('workspace:renameChat', (_e, { workspaceId, chatId, title }) => {
  return workspaces.renameChat(workspaceId, chatId, title);
});

/* ---------- skills ---------- */

ipcMain.handle('skills:list', () => skills.list());
ipcMain.handle('skills:readBody', (_e, id) => skills.readBody(id));
ipcMain.handle('skills:create', async (_e, { name, description }) => skills.create(name, description));
ipcMain.handle('skills:updateBody', (_e, { id, body }) => skills.updateBody(id, body));
ipcMain.handle('skills:remove', (_e, id) => skills.removeSkill(id));
ipcMain.handle('skills:install', async (_e, { command }) => skills.installSkill(command));

/* ---------- MCP ---------- */

ipcMain.handle('mcp:test', async (_e, server) => {
  try {
    return await mcp.test(server);
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('app:locale', () => app.getLocale());
ipcMain.handle('app:onboarded', (_e, value) => {
  settings.set({ onboarded: value === true });
  return true;
});

app.on('will-quit', () => {
  try { mcp.disconnectAll(); } catch (_) { }
});

/* ---------- fsx helpers for renderer (direct calls, no agent) ---------- */

ipcMain.handle('fsx:read', async (_e, { workspaceId, relPath }) => {
  try {
    const ws = workspaces.get(workspaceId);
    if (!ws) return { error: 'нет воркспейса' };
    return { content: await fsx.read(ws.path, relPath) };
  } catch (err) { return { error: err.message }; }
});

ipcMain.handle('fsx:readAttached', async (_e, { filePath }) => {
  try {
    const fs = require('fs');
    const buf = fs.readFileSync(filePath);
    const isText = /\.(txt|md|js|ts|jsx|tsx|json|py|html|css|xml|yml|yaml|sh|bat|ps1|cs|java|c|cpp|h|sql|log|ini|toml|cfg|env|gitignore|vue|rs|go|rb|php|swift|kt)$/i.test(filePath);
    if (isText) {
      return { text: buf.toString('utf8'), size: buf.length };
    }
    return { text: null, size: buf.length, base64: buf.toString('base64') };
  } catch (err) { return { error: err.message }; }
});

/* ---------- agent ---------- */

async function requestApproval(sender, { workspaceId, tool, params }) {
  const ws = workspaces.get(workspaceId);
  const wsPath = ws ? ws.path : null;
  const argPath = params.path || '';
  const auto = settings.get().autoApprove;

  const isReadOnly = tool === 'read_file' || tool === 'list_dir';

  if (auto === 'all' || (auto === 'read' && isReadOnly)) {
    return { allow: true };
  }

  const remembered = sessionRules.find((r) => r.tool === tool && (r.pathPrefix === '*' || r.pathPrefix === argPath) && r.allow);
  if (remembered) return { allow: remembered.allow };

  const humanize = {
    bash: 'Команда в терминале',
    write_file: 'Запись в файл',
    edit_file: 'Правка файла',
    delete_file: 'Удаление файла',
    read_file: 'Чтение файла',
    list_dir: 'Список папки'
  };

  const description =
    tool === 'bash'
      ? { title: 'Выполнить команду', code: params.command }
      : { title: `${humanize[tool] || tool}: ${params.path}`, code: tool === 'edit_file' ? params.old_string : (params.content || '') };

  const answer = await dispatchApproval(sender, {
    tool, argPath, humanized: { label: humanize[tool] || tool, ...description }
  });

  if (answer && answer.remember) {
    sessionRules.push({ tool, pathPrefix: answer.globally ? '*' : argPath, allow: answer.allow });
  }
  return { allow: !!answer.allow };
}

function dispatchApproval(sender, payload) {
  return new Promise((resolve) => {
    const channel = 'agent:approval';
    const once = (_e, res) => {
      ipcMain.removeListener('agent:approval:reply', once);
      resolve(res);
    };
    ipcMain.on('agent:approval:reply', once);
    if (!sender.isDestroyed()) sender.send(channel, payload);
  });
}

let pendingPoll = null;

ipcMain.on('agent:poll:reply', (_e, res) => {
  if (pendingPoll) { pendingPoll(res); pendingPoll = null; }
});

function dispatchPoll(sender, payload) {
  return new Promise((resolve) => {
    pendingPoll = resolve;
    if (!sender.isDestroyed()) sender.send('agent:poll', payload);
  });
}

async function runAgent(sender, { workspaceId, model, messages }) {
  const ws = workspaces.get(workspaceId);
  const cfg = settings.get();
  const baseUrl = cfg.baseUrl;
  const apiKey = cfg.apiKey;
  const hasTools = cfg.agentMode; // инструменты доступны всегда в режиме агента
  const workingDir = (ws && ws.path) || app.getPath('documents'); // без проекта работаем в Документах

  const push = (chunk) => {
    if (!sender.isDestroyed()) sender.send('agent:chunk', chunk);
  };

  const controller = new AbortController();
  activeController = controller;

  const ctx = { messages: messages.slice(), workingDir: workingDir };
  let emptyRetries = 0;
  let finalText = '';

  try {
    for (let round = 0; round < cfg.maxToolRounds; round++) {
      push({ type: 'round', round, own: true });

      const streamResult = await gateway.streamChat({
        baseUrl, apiKey,
        model,
        messages: ctx.messages,
        tools: hasTools ? await toolSet(cfg) : undefined,
        temperature: cfg.temperature,
        maxTokens: cfg.maxTokens,
        topP: cfg.topP,
        presencePenalty: cfg.presencePenalty,
        frequencyPenalty: cfg.frequencyPenalty,
        seed: cfg.seed,
        streamIdleMs: cfg.streamIdleMs,
        requestTimeoutMs: cfg.requestTimeoutMs,
        signal: controller.signal,
        onContent: (text, snapshot) => {
          push({ type: 'text', text, snapshot, round });
        }
      });

      if (streamResult.aborted) {
        push({ type: 'aborted' });
        return { ok: false, aborted: true };
      }
      if (!streamResult.ok) {
        push({ type: 'error', message: streamResult.message || 'Ошибка шлюза' });
        return { ok: false, message: streamResult.message };
      }

      finalText = streamResult.text || finalText;

      // Если шлюз не вернул структурированные вызовы, проверяем «текстовый» формат
      let toolCalls = streamResult.toolCalls || [];
      let assistantText = streamResult.text || '';

      if (!toolCalls.length && hasTools) {
        const parsed = texttools.parseTextToolCalls(assistantText);
        if (parsed.calls.length) {
          toolCalls = parsed.calls.map((c, i) => ({
            id: `txt_${Date.now()}_${i}`,
            name: c.name,
            arguments: JSON.stringify(c.args || {})
          }));
          assistantText = parsed.cleanText;
          // обновляем текст у рендерера: убираем блоки вызовов из отображения
          push({ type: 'text_replace', text: assistantText, round });
          finalText = assistantText;
        }
      }

      // Модель может «молча» вернуть пустой ответ (ни текста, ни вызовов) —
      // особенно на продолжении после инструментов. Тогда не завершаемся,
      // а просим её продолжить, чтобы задача реально пошла дальше.
      if (!toolCalls.length && !assistantText.trim()) {
        if (emptyRetries < Math.max(0, cfg.maxEmptyRetries || 0)) {
          emptyRetries++;
          push({ type: 'text_replace', text: assistantText, round });
          ctx.messages.push({ role: 'assistant', content: '' });
          ctx.messages.push({
            role: 'user',
            content: '[Твой предыдущий ответ был пустым. Продолжай выполнение задачи: скажи, что делаешь дальше, и используй инструменты, если нужно. Не пиши пустых ответов.]'
          });
          continue;
        }
        push({ type: 'error', message: 'Модель несколько раз вернула пустой ответ. Попробуй ещё раз или смени модель.' });
        return { ok: false, message: 'empty response' };
      }

      if (assistantText.trim() || toolCalls.length) emptyRetries = 0;

      // OmniRoute/Kiro на продолжении «молчит», если tool_calls в истории
      // заданы плоской структурой {id,name,arguments}. Всегда отправляем
      // вложенный OpenAI-формат {id,type,function:{name,arguments}}.
      const historyCalls = toolCalls.map((tc, i) => ({
        id: tc.id || `call_${Date.now()}_${i}`,
        type: 'function',
        function: { name: tc.name, arguments: typeof tc.arguments === 'string' ? tc.arguments : JSON.stringify(tc.arguments || {}) }
      }));

      ctx.messages.push({
        role: 'assistant',
        content: assistantText || null,
        tool_calls: historyCalls.length ? historyCalls : undefined
      });

      if (!toolCalls.length) {
        push({ type: 'done', text: finalText, usage: streamResult.usage });
        return { ok: true, text: finalText };
      }

      // выполняем инструменты
      let lastCallSig = null;
      let callRepeat = 0;
      for (const call of toolCalls) {
        let params = {};
        if (typeof call.arguments === 'object' && call.arguments !== null) {
          params = call.arguments;
        } else if (call.arguments) {
          try { params = JSON.parse(call.arguments); } catch (_) { params = { _raw: call.arguments }; }
        }

        // защита от зацикливания (если включена): одна и та же команда/файл подряд 3+ раз — стоп
        const sig = call.name + '|' + (typeof call.arguments === 'string' ? call.arguments : JSON.stringify(call.arguments || {}));
        if (cfg.loopProtection !== false) {
          if (sig === lastCallSig) callRepeat++; else { lastCallSig = sig; callRepeat = 1; }
          if (callRepeat >= 3) {
            const names = { bash: 'команда', read_file: 'чтение файла', write_file: 'запись файла', edit_file: 'правка файла', delete_file: 'удаление', list_dir: 'список папки', web_search: 'поиск', web_fetch: 'чтение страницы', ask_user: 'опрос' };
            push({
              type: 'error',
              message: 'Модель зациклилась: ' + (names[call.name] || call.name) + ' повторяется без результата. Остановлено, попробуй уточнить задачу или смени модель.'
            });
            return { ok: false, message: 'loop detected: ' + sig };
          }
        }

        if (call.name === 'ask_user') {
          // карточка-опрос: показываем рендереру и ждём ответ пользователя
          push({ type: 'tool_start', tool: 'ask_user', params, callId: call.id, allowed: true });
          push({ type: 'poll', callId: call.id, poll: params });
          const answer = await dispatchPoll(sender, { callId: call.id, poll: params });
          let result;
          if (answer && answer.aborted) {
            result = JSON.stringify({ approved: false, error: 'Пользователь прервал опрос' });
          } else {
            result = JSON.stringify({ approved: true, picks: answer ? answer.picks : [], custom: answer ? answer.custom : '' });
          }
          push({ type: 'tool_result', tool: 'ask_user', params, callId: call.id, result });
          ctx.messages.push({ role: 'tool', tool_call_id: call.id, content: result });
          continue;
        }

        const approval = await requestApproval(sender, { workspaceId, tool: call.name, params });
        push({ type: 'tool_start', tool: call.name, params, callId: call.id, allowed: approval.allow });

        let result;
        if (!approval.allow) {
          result = JSON.stringify({ approved: false, error: 'Пользователь запретил действие' });
        } else {
          try {
            result = await executeTool(call.name, params, workingDir);
          } catch (err) {
            result = JSON.stringify({ approved: true, error: err.message });
          }
        }

        push({ type: 'tool_result', tool: call.name, params, callId: call.id, result });

        ctx.messages.push({
          role: 'tool',
          tool_call_id: call.id,
          content: result
        });
      }
    }

    push({ type: 'error', message: 'Достигнут лимит раундов инструментов' });
    return { ok: false, message: 'Достигнут лимит раундов' };
  } catch (err) {
    push({ type: 'error', message: err.message });
    return { ok: false, message: err.message };
  } finally {
    if (activeController === controller) activeController = null;
  }
}

async function executeTool(name, params, wsPath) {
  switch (name) {
    case 'bash':
      return await shell.run(params.command, wsPath);
    case 'read_file':
      return JSON.stringify({ content: await fsx.read(wsPath, params.path) });
    case 'write_file':
      await fsx.write(wsPath, params.path, params.content);
      return JSON.stringify({ ok: true, wrote: params.path });
    case 'edit_file':
      await fsx.edit(wsPath, params.path, params.old_string, params.new_string);
      return JSON.stringify({ ok: true, edited: params.path });
    case 'delete_file':
      await fsx.remove(wsPath, params.path);
      return JSON.stringify({ ok: true, deleted: params.path });
    case 'list_dir':
      return JSON.stringify({ entries: await fsx.list(wsPath, params.path || '') });
    case 'web_search':
      return await webtools.webSearch(params.query);
    case 'web_fetch':
      return await webtools.webFetch(params.url);
    default:
      if (typeof name === 'string' && name.startsWith('mcp__')) {
        return await mcp.call(name, params);
      }
      throw new Error('Неизвестный инструмент: ' + name);
  }
}

ipcMain.handle('agent:start', async (event, payload) => {
  return await runAgent(event.sender, payload);
});

ipcMain.handle('agent:stop', () => {
  if (activeController) activeController.abort();
  if (pendingPoll) { pendingPoll({ aborted: true }); pendingPoll = null; }
  return true;
});

ipcMain.handle('agent:clearRules', () => {
  sessionRules.length = 0;
  return true;
});

module.exports = { executeTool, TOOLS };