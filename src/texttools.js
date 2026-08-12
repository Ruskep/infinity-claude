// Распознавание «текстовых» вызовов инструментов в формате Claude Code / антропных скилов:
//   <tool_calls> <invoke name="Bash"> <parameter name="command">dir</parameter> </invoke> </tool_calls>
//   а также antml: префикс, <|tool_calls|>, fullwidth ＜＞｜亖 и БЕЗ закрывающих тегов
//   (модели часто обрывают блок, не дописав </invoke></tool_calls>).
// Возвращает { calls: [{name, args}], cleanText } — текст без блоков вызовов.

function unescapeHtml(s) {
  return String(s)
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;|&#39;/g, "'");
}

function mapToolName(raw) {
  const key = String(raw || '').trim();
  const map = {
    bash: 'bash', shell: 'bash', terminal: 'bash', cmd: 'bash', powershell: 'bash', 'Bash': 'bash', 'Shell': 'bash',
    read: 'read_file', read_file: 'read_file', Read: 'read_file', 'ReadFile': 'read_file',
    write: 'write_file', write_file: 'write_file', Write: 'write_file', 'WriteFile': 'write_file',
    edit: 'edit_file', edit_file: 'edit_file', Edit: 'edit_file', 'EditFile': 'edit_file', 'MultiEdit': 'edit_file',
    delete: 'delete_file', delete_file: 'delete_file', Delete: 'delete_file', 'DeleteFile': 'delete_file', rm: 'delete_file', 'Rm': 'delete_file',
    list_dir: 'list_dir', ls: 'list_dir', 'ListDir': 'list_dir', 'List': 'list_dir', 'LS': 'list_dir', list: 'list_dir', glob: 'list_dir', 'Glob': 'list_dir'
  };
  return map[key] || null;
}

// приводит параметры антропного формата к параметрам наших функций
function normalizeParams(tool, params) {
  const p = { ...params };
  if (tool === 'bash') {
    if (!p.command && p.cmd) p.command = p.cmd;
    delete p.description;
    return p;
  }
  if (tool === 'read_file' || tool === 'delete_file') {
    if (!p.path && p.file_path) p.path = p.file_path;
    if (p.path && p.path.startsWith('.') && p.path !== './') p.path = p.path.replace(/^\.\//, '');
    return p;
  }
  if (tool === 'write_file') {
    if (!p.path && p.file_path) p.path = p.file_path;
    if (!p.content) p.content = p.body || p.text || '';
    return p;
  }
  if (tool === 'edit_file') {
    if (!p.path && p.file_path) p.path = p.file_path;
    if (!p.old_string) p.old_string = p.old || p.search || '';
    if (!p.new_string) p.new_string = p.new || p.replacement || p.replace || '';
    return p;
  }
  if (tool === 'list_dir') {
    if (!p.path) p.path = p.directory || p.dir || '';
    return p;
  }
  return p;
}

function parseTextToolCalls(text) {
  if (!text || typeof text !== 'string') return { calls: [], cleanText: text || '' };

  // нормализация: fullwidth ＜＞｜亖 → ASCII, убираем antml: и | обёртки
  let t = String(text)
    .replace(/[＜＞]/g, (m) => (m === '＜' ? '<' : '>'))
    .replace(/[｜]/g, '|')
    .replace(/亖/gi, '#')
    .replace(/<\s*\|?\s*antml:\s*/gi, '<')
    .replace(/<\/\s*\|?\s*antml:\s*/gi, '</')
    .replace(/<\|/g, '<')
    .replace(/<\/\|/g, '</')
    .replace(/\|>/g, '>')
    .replace(/\|\s*>/g, '>');

  // позиции открывающих <invoke ... name="X">
  const invokes = [];
  const invokeOpenRe = /<\s*invoke\s+name\s*=\s*["']?([^\s"'|>]+)["']?\s*(?:>|$)/gi;
  let m;
  while ((m = invokeOpenRe.exec(t)) !== null) {
    invokes.push({ name: m[1].trim(), index: m.index, rawEnd: m.index + m[0].length });
  }
  if (!invokes.length) return { calls: [], cleanText: t.trim() };

  // разделим t на сегменты по открывающим тегам
  const segments = [];
  for (let i = 0; i <= invokes.length; i++) {
    const start = i === 0 ? 0 : invokes[i - 1].rawEnd;
    const end = i === invokes.length ? t.length : invokes[i].index;
    segments.push({ text: t.slice(start, end) });
  }

  const calls = [];
  let firstRemove = null;
  let lastRemove = -1;

  for (let i = 0; i < invokes.length; i++) {
    const inv = invokes[i];
    const body = segments[i + 1].text;
    const rawName = inv.name;
    const name = mapToolName(rawName);
    if (!name) continue;

    if (firstRemove === null) firstRemove = inv.index;

    // параметры: <parameter name="K" ...>value</parameter> либо value до следующего <parameter/<invoke/</...>
    const params = {};
    const paramRe = /<\s*parameter\s+name\s*=\s*["']?([^\s"'|>]+)["']?(?:\s+[^>]*?)?\s*>([\s\S]*?)(?=<\s*\/\s*parameter\b|<\s*parameter\b|<\s*\/\s*invoke\b|<\s*\/\s*tool_calls\b|<\s*invoke\b|$)/gi;
    let pm;
    while ((pm = paramRe.exec(body)) !== null) {
      const key = pm[1].trim().toLowerCase();
      let val = unescapeHtml(pm[2]).trim();
      val = val.replace(/<\s*\/?\s*(?:antml:)?(?:parameter|invoke|tool_calls|function_calls)\b[^>]*>/gi, ' ').trim();
      params[key] = val;
    }

    // граница удаления блока: закрывающий тег после этого invoke, либо следующий invoke, либо конец
    const closeMatch = body.match(/<\s*\/\s*(?:invoke|tool_calls|function_calls)\b/i);
    if (closeMatch) {
      lastRemove = Math.max(lastRemove, inv.index + body.indexOf(closeMatch[0]) + closeMatch[0].length);
    } else if (i + 1 < invokes.length) {
      lastRemove = Math.max(lastRemove, invokes[i + 1].index);
    } else {
      lastRemove = Math.max(lastRemove, inv.index + body.length);
    }

    calls.push({ name, args: normalizeParams(name, params) });
  }

  if (firstRemove === null) return { calls, cleanText: t.trim() };

  let cleanText = t.slice(0, firstRemove) + t.slice(lastRemove);
  cleanText = cleanText
    .replace(/^\s*[\r\n]+/, '')
    .replace(/\s*$/, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return { calls, cleanText };
}

module.exports = { parseTextToolCalls, mapToolName, normalizeParams };