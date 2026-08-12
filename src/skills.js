const fs = require('fs');
const path = require('path');
const { app } = require('electron');
const { run } = require('./shell');

const userSkillsDir = () => path.join(app.getPath('userData'), 'skills');
const bundledSkillsDir = () => path.join(__dirname, '..', 'skills');

function parseSkillMd(content) {
  const meta = { name: '', description: '', enabled: true };
  const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
  let body = content;
  if (match) {
    for (const line of match[1].split('\n')) {
      const sep = line.indexOf(':');
      if (sep > 0) {
        const key = line.slice(0, sep).trim();
        const value = line.slice(sep + 1).trim().replace(/^"|"$/g, '').replace(/^'|'$/g, '');
        if (key in meta && key !== 'enabled') meta[key] = value;
      }
    }
    body = content.slice(match[0].length).trim();
  }
  return { ...meta, body };
}

function collect(dir, editable) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(dir, entry.name, 'SKILL.md');
    if (!fs.existsSync(skillPath)) continue;
    try {
      const meta = parseSkillMd(fs.readFileSync(skillPath, 'utf8'));
      out.push({
        id: entry.name,
        title: meta.name || entry.name,
        description: meta.description || '',
        body: meta.body,
        enabled: meta.enabled !== false,
        editable,
        dir: skillPath
      });
    } catch (err) {
      console.error('skill parse failed:', entry.name, err.message);
    }
  }
  return out;
}

function list() {
  return collect(bundledSkillsDir(), false).concat(collect(userSkillsDir(), true));
}

function readBody(id) {
  const user = path.join(userSkillsDir(), id, 'SKILL.md');
  const bundled = path.join(bundledSkillsDir(), id, 'SKILL.md');
  const p = fs.existsSync(user) ? user : fs.existsSync(bundled) ? bundled : null;
  if (!p) return { error: 'Скил не найден' };
  return { content: fs.readFileSync(p, 'utf8'), editable: p === user };
}

function create(name, description) {
  const safeName = (name || '').trim().replace(/[^\w\-]+/g, '-').toLowerCase();
  if (!safeName) return { error: 'Нет имени' };
  const dir = path.join(userSkillsDir(), safeName);
  fs.mkdirSync(dir, { recursive: true });
  const p = path.join(dir, 'SKILL.md');
  if (fs.existsSync(p)) return { error: 'Скил с таким именем уже есть' };
  const content = [
    '---',
    `name: ${name}`,
    `description: ${description || ''}`,
    '---',
    '',
    'Опиши, что делает этот скил:',
    ''
  ].join('\n');
  fs.writeFileSync(p, content, 'utf8');
  return { id: safeName, path: p };
}

function updateBody(id, body) {
  const p = path.join(userSkillsDir(), id, 'SKILL.md');
  if (!fs.existsSync(p)) return { error: 'Скил не найден' };
  fs.writeFileSync(p, body, 'utf8');
  return { ok: true };
}

function removeSkill(id) {
  const dir = path.join(userSkillsDir(), id);
  if (!fs.existsSync(dir)) return { error: 'Скил не найден или встроенный' };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

/**
 * Устанавливает скил командой, скопировав SKILL.md-папку в userData/skills.
 * Поддерживает формат Claude: `npx install-skill@latest owner/repo/skill` или
 * команду, которая создаёт папку с SKILL.md. После выполнения ищет свежие
 * папки-скилы в ~/.claude/skills, а также в созданной директории.
 */
async function installSkill(command) {
  const target = path.join(app.getPath('userData'), 'skills', '_install');
  fs.mkdirSync(target, { recursive: true });

  const before = new Set(listInstalled());
  const result = await run(command, target);

  const installed = [];
  // рекурсивно ищем все папки с SKILL.md (в т.ч. глубоко вложенные: .agents/skills/x)
  const candidates = [];
  const scanDir = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === '.svn' || entry.name === '_install') continue;
      const p = path.join(dir, entry.name);
      if (fs.existsSync(path.join(p, 'SKILL.md'))) candidates.push(p);
      scanDir(p);
    }
  };
  const claudeSkills = path.join(app.getPath('home'), '.claude', 'skills');
  if (fs.existsSync(claudeSkills)) scanDir(claudeSkills);
  if (fs.existsSync(target)) scanDir(target);

  const seen = new Set();
  for (const dir of candidates) {
    const name = path.basename(dir);
    if (seen.has(name)) continue;
    seen.add(name);
    const dest = path.join(userSkillsDir(), name);
    if (fs.existsSync(dest)) {
      fs.cpSync(dir, dest, { recursive: true, force: true });
      installed.push({ name, updated: true });
      continue;
    }
    if (fs.existsSync(path.join(dest, 'SKILL.md'))) continue;
    fs.cpSync(dir, dest, { recursive: true });
    installed.push({ name, updated: false });
  }

  fs.rmSync(target, { recursive: true, force: true });
  try { fs.rmSync(path.join(userSkillsDir(), '_install'), { recursive: true, force: true }); } catch (_) {}

  const newly = installed.filter((i) => !before.has(i.name) && !i.updated);
  return {
    ok: true,
    output: result,
    installed,
    newly: newly.map((n) => n.name)
  };
}

function listInstalled() {
  return collect(userSkillsDir(), true).map((s) => s.id);
}

module.exports = { list, readBody, create, updateBody, removeSkill, installSkill, userSkillsDir };