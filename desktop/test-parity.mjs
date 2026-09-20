import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const read = (path) => readFileSync(new URL(path, import.meta.url), "utf8");
const html = read("index.html");
const main = read("main.cjs");
const renderer = read("renderer.js");
const pkg = JSON.parse(read("package.json"));

assert.equal(pkg.version, "1.0.0");
for (const id of [
  "agent", "overview", "routes", "logs", "settings", "sessions", "attachments",
  "files-tool", "browser-tool", "terminal-tool", "cloud-profile", "generation-tps",
  "prompt-tps", "ttft", "context-used", "route-result",
]) assert.match(html, new RegExp(`id=["']${id}["']`), `missing UI: ${id}`);
for (const handler of [
  "server:restart", "route:test", "clipboard:image", "tools:stop", "sessions:save",
]) assert.match(main, new RegExp(`ipcMain\\.handle\\(["']${handler}["']`), `missing IPC: ${handler}`);
for (const feature of [
  "normalizeSession", "renameSession", "deleteSession", "addAttachments", "runRouteTest",
  "renderCloudProfiles", "showTool", "supportsVision",
]) assert.match(renderer, new RegExp(`function ${feature}\\b`), `missing behavior: ${feature}`);
for (const contract of [
  /server === child/, /agent !== child/, /isAbsolute\(rel\)/,
  /window-all-closed/, /canControlServer/,
]) assert.match(main, contract, `missing process/security contract: ${contract}`);

console.log("Windows/macOS feature contract ok");
