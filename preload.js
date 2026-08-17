const { contextBridge, ipcRenderer } = require('electron');

function on(channel, cb) {
  const handler = (_e, data) => cb(data);
  ipcRenderer.on(channel, handler);
  return () => ipcRenderer.removeListener(channel, handler);
}

contextBridge.exposeInMainWorld('infinity', {
  // settings
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  resetSettings: () => ipcRenderer.invoke('settings:reset'),
  testConnection: (cfg) => ipcRenderer.invoke('settings:test', cfg),
  listModels: (cfg) => ipcRenderer.invoke('models:list', cfg),

  // app / locale / onboarding
  getLocale: () => ipcRenderer.invoke('app:locale'),
  setOnboarded: (value) => ipcRenderer.invoke('app:onboarded', value),

  // updates
  checkUpdates: () => ipcRenderer.invoke('update:check'),
  downloadUpdate: () => ipcRenderer.invoke('update:download'),
  getUpdateState: () => ipcRenderer.invoke('update:getState'),
  onUpdateState: (cb) => on('update:state', cb),

  // workspaces
  workspaceList: () => ipcRenderer.invoke('workspace:list'),
  workspaceSelect: () => ipcRenderer.invoke('workspace:select'),
  workspaceActivate: (id) => ipcRenderer.invoke('workspace:activate', id),
  workspaceRemove: (id) => ipcRenderer.invoke('workspace:remove', id),
  workspaceSaveChat: (payload) => ipcRenderer.invoke('workspace:saveChat', payload),
  workspaceDeleteChat: (payload) => ipcRenderer.invoke('workspace:deleteChat', payload),
  workspaceRenameChat: (payload) => ipcRenderer.invoke('workspace:renameChat', payload),

  // skills
  listSkills: () => ipcRenderer.invoke('skills:list'),
  readSkillBody: (id) => ipcRenderer.invoke('skills:readBody', id),
  createSkill: (payload) => ipcRenderer.invoke('skills:create', payload),
  updateSkillBody: (payload) => ipcRenderer.invoke('skills:updateBody', payload),
  removeSkill: (id) => ipcRenderer.invoke('skills:remove', id),
  installSkill: (payload) => ipcRenderer.invoke('skills:install', payload),

  // MCP
  mcpTest: (server) => ipcRenderer.invoke('mcp:test', server),

  // fsx helper
  fsxRead: (payload) => ipcRenderer.invoke('fsx:read', payload),
  fsxReadAttached: (payload) => ipcRenderer.invoke('fsx:readAttached', payload),

  // agent
  startAgent: (payload) => ipcRenderer.invoke('agent:start', payload),
  stopAgent: (sessionId) => ipcRenderer.invoke('agent:stop', sessionId),
  clearRules: () => ipcRenderer.invoke('agent:clearRules'),

  onAgentChunk: (cb) => on('agent:chunk', cb),
  onApproval: (cb) => on('agent:approval', cb),
  replyApproval: (res) => ipcRenderer.send('agent:approval:reply', res),
  onPoll: (cb) => on('agent:poll', cb),
  replyPoll: (res) => ipcRenderer.send('agent:poll:reply', res)
});