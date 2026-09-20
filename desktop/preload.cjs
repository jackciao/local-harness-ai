const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("harness", {
  config: { get: () => ipcRenderer.invoke("config:get"), save: (value) => ipcRenderer.invoke("config:save", value) },
  dialog: { file: (kind) => ipcRenderer.invoke("dialog:file", kind), directory: () => ipcRenderer.invoke("dialog:directory") },
  server: { start: () => ipcRenderer.invoke("server:start"), stop: () => ipcRenderer.invoke("server:stop"), state: () => ipcRenderer.invoke("server:state") },
  chat: (message) => ipcRenderer.invoke("chat:send", message),
  agent: { send: (payload) => ipcRenderer.invoke("agent:send", payload), stop: () => ipcRenderer.invoke("agent:stop") },
  files: { list: (path) => ipcRenderer.invoke("files:list", path), read: (path) => ipcRenderer.invoke("files:read", path) },
  sessions: { load: () => ipcRenderer.invoke("sessions:load"), save: (items) => ipcRenderer.invoke("sessions:save", items) },
  open: { workspace: (path) => ipcRenderer.invoke("workspace:open", path), browser: (url) => ipcRenderer.invoke("browser:open", url) },
  tools: { run: (command, cwd) => ipcRenderer.invoke("tools:run", command, cwd) },
  pathForFile: (file) => webUtils.getPathForFile(file),
  on: (channel, listener) => ipcRenderer.on(channel, (_, value) => listener(value)),
});
