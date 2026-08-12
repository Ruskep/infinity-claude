const path = require('path');

let clientMod = null;
let stdioMod = null;
let httpMod = null;

function loadModules() {
  if (clientMod) return;
  try {
    clientMod = require('@modelcontextprotocol/sdk/client/index.js');
    stdioMod = require('@modelcontextprotocol/sdk/client/stdio.js');
    httpMod = require('@modelcontextprotocol/sdk/client/streamableHttp.js');
  } catch (err) {
    console.error('MCP SDK load failed:', err.message);
  }
}

const connections = new Map(); // serverId -> { client, transport, tools, updatedAt }

function serverKey(s) {
  return (s.id || s.name || '') + '|' + (s.command || '') + '|' + (s.url || '');
}

function transportFor(s) {
  if (!s) return null;
  if (s.url && /^https?:\/\//i.test(String(s.url || '').trim())) {
    return new httpMod.StreamableHTTPClientTransport(new URL(s.url.trim()), {
      requestInit: s.headers ? { headers: s.headers } : undefined
    });
  }
  const command = String(s.command || '').trim();
  if (!command) return null;
  const parts = command.split(/\s+/);
  return new stdioMod.StdioClientTransport({
    command: parts[0],
    args: parts.slice(1),
    cwd: s.cwd ? path.resolve(s.cwd) : undefined,
    env: s.env ? { ...process.env, ...s.env } : undefined
  });
}

function toToolDef(tool) {
  return {
    type: 'function',
    function: {
      name: tool.name,
      description: tool.description || tool.title || '',
      parameters: tool.inputSchema || { type: 'object', properties: {}, required: [] }
    }
  };
}

/**
 * Подключается к серверу (если ещё не подключён или изменилась команда)
 * и возвращает список инструментов в OpenAI-формате с префиксом mcp__<имя>__<tool>.
 */
async function connect(server) {
  loadModules();
  if (!clientMod || !stdioMod || !httpMod) return { ok: false, error: 'MCP SDK не загружен' };

  const key = serverKey(server);
  const existing = connections.get(server.id);
  if (existing && existing.key === key && existing.client) {
    if (Date.now() - existing.connectedAt < 60000) {
      return { ok: true, tools: existing.tools };
    }
  }

  try {
    const transport = transportFor(server);
    if (!transport) return { ok: false, error: 'Укажи команду (напр. npx -y @mcp/server-filesystem) или URL сервера' };

    const run = new Promise((resolve, reject) => {
      const client = new clientMod.Client({ name: 'infinity-claude', version: '1.0.0' });
      const timer = setTimeout(() => { reject(new Error('Таймаут подключения к MCP-серверу (20с)')); }, 20000);
      client.connect(transport)
        .then(() => clearTimeout(timer))
        .then(() => client.listTools({}))
        .then((res) => {
          const raw = (res && res.tools) || [];
          const tools = raw.map(toToolDef).map((t) => ({
            type: 'function',
            function: {
              name: `mcp__${server.id}__${t.function.name}`,
              description: `[MCP:${server.id}] ${t.function.description}`,
              parameters: t.function.parameters
            }
          }));
          resolve({ client, transport, tools, connectedAt: Date.now(), key });
        })
        .catch((err) => {
          try { transport.close && transport.close(); } catch (_) {}
          reject(err);
        });
    });

    const result = await run;
    connections.set(server.id, { ...result, env: undefined, refCount: 0 });
    return { ok: true, tools: result.tools, name: server.id };
  } catch (err) {
    connections.delete(server.id);
    return { ok: false, error: err && err.message ? err.message : String(err) };
  }
}

async function listTools(servers) {
  const enabled = (servers || []).filter((s) => s && s.enabled !== false);
  const out = [];
  for (const s of enabled) {
    const res = await connect(s);
    if (res.ok && res.tools) out.push(...res.tools);
  }
  return out;
}

function parseCall(name) {
  if (typeof name !== 'string' || !name.startsWith('mcp__')) return null;
  const parts = name.split('__');
  if (parts.length < 3) return null;
  const serverId = parts.slice(1, -1).join('__');
  const toolName = parts.slice(-1)[0];
  return { serverId, toolName };
}

async function call(name, args) {
  const parsed = parseCall(name);
  if (!parsed) throw new Error('Неизвестный инструмент: ' + name);
  const conn = connections.get(parsed.serverId);
  if (!conn || !conn.client) throw new Error(`MCP-сервер "${parsed.serverId}" не подключён`);
  const res = await conn.client.callTool({ name: parsed.toolName, arguments: args || {} });
  return formatContent(res);
}

function formatContent(res) {
  const content = (res && res.content) || [];
  const parts = [];
  let hasText = false;
  for (const c of content) {
    if (!c) continue;
    if (c.type === 'text') {
      hasText = true;
      parts.push(c.text != null ? String(c.text) : '');
    } else if (c.type === 'image') {
      const data = c.data || '';
      const mime = c.mimeType || 'image/png';
      parts.push(`[Изображение (${mime}) — ${Math.round((data.length * 3) / 4 / 1024)} КБ, модель не видит картинки напрямую]`);
    } else if (c.type === 'resource') {
      parts.push((c.resource && c.resource.text) != null ? String(c.resource.text) : '[Ресурс]');
    } else if (c.type === 'toolResult') {
      const inner = formatContent(c);
      parts.push(inner.text);
    }
  }
  if (!hasText && parts.length === 0) {
    const direct = res && res.isError ? { error: typeof res.isError === 'string' ? res.isError : 'Ошибка MCP-сервера' } : { ok: true };
    return JSON.stringify(direct);
  }
  return JSON.stringify({ content: parts.join('\n'), isError: !!(res && res.isError) });
}

function disconnect(id) {
  const conn = connections.get(id);
  if (conn) {
    try { conn.client && conn.client.close && conn.client.close(); } catch (_) {}
    try { conn.transport && conn.transport.close && conn.transport.close(); } catch (_) {}
    connections.delete(id);
  }
}

function disconnectAll() {
  for (const id of [...connections.keys()]) disconnect(id);
}

/**
 * Тест подключения: подключается и возвращает количество найденных инструментов.
 */
async function test(server) {
  const res = await connect(server);
  if (!res.ok) return { ok: false, error: res.error };
  disconnect(server.id);
  return { ok: true, tools: (res.tools || []).length };
}

module.exports = { listTools, call, parseCall, connect, disconnect, disconnectAll, test };