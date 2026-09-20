const { app, BrowserWindow, dialog, ipcMain, safeStorage, shell } = require("electron");
const { spawn } = require("node:child_process");
const { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, statSync } = require("node:fs");
const { join, resolve, extname, relative } = require("node:path");

const defaults = {
  source: "local", model: "", mmproj: "", chatTemplate: "", context: 8192, kv: "q4_0",
  compatibility: false, ngram: false, reasoning: false, cloudBaseUrl: "https://api.openai.com/v1",
  cloudModel: "gpt-4.1-mini", cloudApiKey: "", workspace: "", allowWrites: true,
};
let config = { ...defaults };
let server;
let agent;
let window;
let agentBuffer = "";

const dataDir = () => join(app.getPath("userData"), "local-harness-ai");
const configPath = () => join(dataDir(), "settings.json");
const sessionsPath = () => join(dataDir(), "sessions.json");
const runtimeRoot = () => app.isPackaged ? join(process.resourcesPath, "runtime") : join(__dirname, "runtime");
const serverPath = () => join(runtimeRoot(), process.platform === "win32" ? "llama-server.exe" : "llama-server");
const agentPath = () => join(runtimeRoot(), "agent", "local-harness-agent.mjs");
const emit = (channel, value) => window?.webContents.send(channel, value);
const endpoint = "http://127.0.0.1:7890";

function loadConfig() {
  try {
    config = { ...defaults, ...JSON.parse(readFileSync(configPath(), "utf8")) };
    if (config.cloudApiKey?.encrypted && safeStorage.isEncryptionAvailable()) {
      config.cloudApiKey = safeStorage.decryptString(Buffer.from(config.cloudApiKey.encrypted, "base64"));
    }
  } catch {}
}
function saveConfig(next) {
  config = { ...config, ...next };
  mkdirSync(dataDir(), { recursive: true });
  const stored = { ...config };
  if (stored.cloudApiKey && safeStorage.isEncryptionAvailable()) {
    stored.cloudApiKey = { encrypted: safeStorage.encryptString(stored.cloudApiKey).toString("base64") };
  }
  writeFileSync(configPath(), JSON.stringify(stored, null, 2));
  return publicConfig();
}
function publicConfig() {
  return { ...config, cloudApiKey: config.cloudApiKey ? "configured" : "" };
}
function emitLog(text, kind = "info") {
  emit("server-log", { id: `${Date.now()}-${Math.random()}`, text, kind, time: new Date().toLocaleTimeString() });
}
function splitLines(data) {
  for (const line of String(data).split(/\r?\n/)) if (line) emitLog(line, /error|failed|not found/i.test(line) ? "error" : "info");
}
async function api(path, options = {}) {
  const response = await fetch(`${endpoint}${path}`, { ...options, headers: { "Content-Type": "application/json", ...(options.headers || {}) } });
  if (!response.ok) throw new Error(`${response.status} ${await response.text()}`);
  return response.json();
}
async function state() {
  try {
    const [health, models, slots] = await Promise.all([api("/health"), api("/v1/models"), api("/slots")]);
    return { phase: server ? "online" : "external", health, models, slots };
  } catch {
    return { phase: server ? "starting" : "offline" };
  }
}
function stopServer() {
  if (server && !server.killed) server.kill();
  server = undefined;
}
function startServer() {
  if (config.source === "cloud") return;
  if (!config.model || !existsSync(config.model)) throw new Error("请选择有效的 GGUF 主模型。");
  if (config.mmproj && !existsSync(config.mmproj)) throw new Error("视觉投影文件不存在。");
  stopServer();
  const args = ["-m", config.model, "-ngl", config.compatibility ? "auto" : "99", "-c", String(config.compatibility ? Math.min(config.context, 4096) : config.context),
    "-ctk", config.kv, "-ctv", config.kv, "-t", "1", "-tb", "8", "-b", "512", "-ub", "512",
    "--host", "127.0.0.1", "--port", "7890", "-a", "qwen", "--jinja", "--reasoning", config.reasoning ? "auto" : "off"];
  if (config.mmproj) args.push("-mm", config.mmproj);
  if (config.chatTemplate) args.push("--chat-template", config.chatTemplate);
  if (config.ngram) args.push("--spec-type", "ngram-mod", "--spec-ngram-mod-n-min", "2", "--spec-ngram-mod-n-max", "4", "--spec-ngram-mod-n-match", "16");
  server = spawn(serverPath(), args, { cwd: runtimeRoot(), windowsHide: true });
  server.stdout.on("data", splitLines);
  server.stderr.on("data", splitLines);
  server.on("exit", (code) => { emitLog(`llama.cpp 已退出（code ${code ?? "signal"}）`, code ? "error" : "info"); server = undefined; });
  emitLog(`启动 llama.cpp · ${config.context / 1024}K context · KV ${config.kv}`);
}
function stopAgent() {
  if (agent && !agent.killed) agent.kill();
  agent = undefined;
  agentBuffer = "";
}
function startAgent(payload) {
  const workspace = payload.workspace || config.workspace;
  if (!workspace || !existsSync(workspace)) throw new Error("请选择有效工作区。");
  const env = { ...process.env, ELECTRON_RUN_AS_NODE: "1", HARNESS_PROVIDER: config.source === "cloud" ? "openai-compatible" : "openai-compatible",
    HARNESS_MODEL: config.source === "cloud" ? config.cloudModel : "qwen", HARNESS_BASE_URL: config.source === "cloud" ? config.cloudBaseUrl : `${endpoint}/v1`,
    HARNESS_API_KEY: config.source === "cloud" ? config.cloudApiKey : "local-harness", HARNESS_CTX: String(config.context) };
  if (!agent || agent.killed) {
    agent = spawn(process.execPath, [agentPath(), "--workspace", workspace, ...(payload.allowWrites ? ["--allow-writes"] : [])], { cwd: join(runtimeRoot(), "agent"), env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    agent.stdout.on("data", (data) => {
      agentBuffer += data;
      const lines = agentBuffer.split(/\r?\n/);
      agentBuffer = lines.pop();
      for (const line of lines) try { emit("agent-event", JSON.parse(line)); } catch {}
    });
    agent.stderr.on("data", (data) => emit("agent-event", { type: "error", text: String(data) }));
    agent.on("exit", (code) => { emit("agent-event", { type: "status", text: `代理已退出（${code ?? "signal"}）` }); agent = undefined; });
  }
  agent.stdin.write(`${JSON.stringify({ type: "prompt", prompt: payload.prompt, history: payload.history || [], images: payload.images || [], contextSize: config.context })}\n`);
}
function listDirectory(path) {
  return readdirSync(path, { withFileTypes: true }).map((entry) => ({ name: entry.name, path: join(path, entry.name), directory: entry.isDirectory() })).sort((a, b) => Number(b.directory) - Number(a.directory) || a.name.localeCompare(b.name));
}

app.whenReady().then(() => {
  loadConfig();
  window = new BrowserWindow({ width: 1440, height: 920, minWidth: 1080, minHeight: 720, webPreferences: { preload: join(__dirname, "preload.cjs"), contextIsolation: true, sandbox: false } });
  window.loadFile(join(__dirname, "index.html"));
  setInterval(() => state().then((value) => emit("server-state", value)), 1500);
});
app.on("before-quit", () => { stopAgent(); stopServer(); });

ipcMain.handle("config:get", () => publicConfig());
ipcMain.handle("config:save", (_, value) => saveConfig(value));
ipcMain.handle("dialog:file", async (_, kind) => {
  const result = await dialog.showOpenDialog(window, { properties: ["openFile", ...(kind === "attachment" ? ["multiSelections"] : [])], filters: kind === "image" ? [{ name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp"] }] : [{ name: "GGUF", extensions: ["gguf"] }, { name: "All files", extensions: ["*"] }] });
  return result.canceled ? [] : result.filePaths;
});
ipcMain.handle("dialog:directory", async () => { const result = await dialog.showOpenDialog(window, { properties: ["openDirectory"] }); return result.canceled ? "" : result.filePaths[0]; });
ipcMain.handle("server:start", () => startServer());
ipcMain.handle("server:stop", () => stopServer());
ipcMain.handle("server:state", () => state());
ipcMain.handle("chat:send", async (_, message) => {
  const baseUrl = config.source === "cloud" ? config.cloudBaseUrl : `${endpoint}/v1`;
  const apiKey = config.source === "cloud" ? config.cloudApiKey : "local-harness";
  const content = [{ type: "text", text: message.text }];
  for (const image of message.images || []) content.push({ type: "image_url", image_url: { url: `data:image/${extname(image).slice(1) || "png"};base64,${readFileSync(image).toString("base64")}` } });
  const response = await fetch(`${baseUrl}/chat/completions`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${apiKey}` }, body: JSON.stringify({ model: config.source === "cloud" ? config.cloudModel : "qwen", messages: [{ role: "user", content }], stream: false }) });
  if (!response.ok) throw new Error(await response.text());
  return (await response.json()).choices?.[0]?.message?.content || "";
});
ipcMain.handle("agent:send", (_, payload) => startAgent(payload));
ipcMain.handle("agent:stop", () => agent?.stdin.write('{"type":"stop"}\n'));
ipcMain.handle("files:list", (_, path) => listDirectory(path));
ipcMain.handle("files:read", (_, path) => readFileSync(path, "utf8"));
ipcMain.handle("workspace:open", (_, path) => shell.openPath(path));
ipcMain.handle("browser:open", (_, url) => shell.openExternal(url));
ipcMain.handle("tools:run", (_, command, cwd) => new Promise((resolveRun) => {
  const child = spawn("powershell.exe", ["-NoProfile", "-Command", command], { cwd: cwd || config.workspace, windowsHide: true });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  child.on("exit", (code) => resolveRun({ code, output }));
}));
ipcMain.handle("sessions:load", () => { try { return JSON.parse(readFileSync(sessionsPath(), "utf8")); } catch { return []; } });
ipcMain.handle("sessions:save", (_, sessions) => { mkdirSync(dataDir(), { recursive: true }); writeFileSync(sessionsPath(), JSON.stringify(sessions)); });
