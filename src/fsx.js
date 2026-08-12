const fs = require('fs');
const path = require('path');

function resolveSafe(wsPath, relPath) {
  const root = path.resolve(wsPath);
  const target = path.resolve(root, relPath || '');
  if (target !== root && !target.startsWith(root + path.sep)) {
    throw new Error('Путь вне проекта: ' + relPath);
  }
  return target;
}

function assertWithin(wsPath, relPath) {
  resolveSafe(wsPath, relPath);
}

async function read(wsPath, relPath) {
  assertWithin(wsPath, relPath);
  const target = resolveSafe(wsPath, relPath);
  return await fs.promises.readFile(target, 'utf8');
}

async function write(wsPath, relPath, content) {
  assertWithin(wsPath, relPath);
  const target = resolveSafe(wsPath, relPath);
  await fs.promises.mkdir(path.dirname(target), { recursive: true });
  await fs.promises.writeFile(target, content, 'utf8');
}

async function edit(wsPath, relPath, oldString, newString) {
  assertWithin(wsPath, relPath);
  const target = resolveSafe(wsPath, relPath);
  let content = await fs.promises.readFile(target, 'utf8');
  const count = content.split(oldString).length - 1;
  if (count === 0) throw new Error('Фрагмент для замены не найден в файле');
  if (count > 1) throw new Error('Фрагмент найден несколько раз (' + count + '), уточните old_string');
  content = content.replace(oldString, newString);
  await fs.promises.writeFile(target, content, 'utf8');
}

async function remove(wsPath, relPath) {
  assertWithin(wsPath, relPath);
  const target = resolveSafe(wsPath, relPath);
  const stat = await fs.promises.lstat(target);
  if (stat.isDirectory()) {
    await fs.promises.rmdir(target);
  } else {
    await fs.promises.unlink(target);
  }
}

async function list(wsPath, relPath) {
  assertWithin(wsPath, relPath);
  const target = resolveSafe(wsPath, relPath);
  const raw = await fs.promises.readdir(target, { withFileTypes: true });
  return raw.map((e) => ({
    name: e.name,
    type: e.isDirectory() ? 'dir' : 'file'
  }));
}

module.exports = { read, write, edit, remove, list };