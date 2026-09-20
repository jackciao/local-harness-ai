import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";

const root = resolve(import.meta.dirname, "..");
const runtime = resolve(import.meta.dirname, "runtime");
const server = process.env.LH_SERVER_PATH || resolve(root, "llama_cpp_bonsai", "build", "bin", process.platform === "win32" ? "llama-server.exe" : "llama-server");

if (!existsSync(server)) throw new Error(`未找到 Windows llama-server：${server}`);
rmSync(runtime, { recursive: true, force: true });
mkdirSync(runtime, { recursive: true });
cpSync(server, resolve(runtime, process.platform === "win32" ? "llama-server.exe" : "llama-server"));
cpSync(resolve(root, "agent"), resolve(runtime, "agent"), {
  recursive: true,
  filter: (source) => !source.includes(".git") && !source.includes("npm-cache"),
});
console.log(`runtime ready: ${runtime}`);
