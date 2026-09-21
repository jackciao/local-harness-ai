// 用 contract.json 校验 Windows 版没有落下 Mac 版的功能。
// 上一版的 test-parity.mjs 只 grep 了 15 个手写 element id，元素存在但没行为也能通过，
// 功能就是这样丢的。这里改成三项真检查。
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const dir = resolve(import.meta.dirname, "..");
const read = (name) => readFileSync(resolve(dir, name), "utf8");
const contract = JSON.parse(read("parity/contract.json"));

const main = read("main.cjs");
const preload = read("preload.cjs");
const renderer = read("renderer.js");
const html = read("index.html");
// 用户可见的文字既可能写在界面里，也可能是主进程发出的日志/报错。
const ui = `${html}\n${renderer}\n${main}`;
const sources = `${main}\n${preload}\n${renderer}\n${html}`;

const failures = [];
const report = (title, missing) => {
  if (missing.length) failures.push(`${title}（缺 ${missing.length}）:\n  ${missing.join("\n  ")}`);
};

// 1. IPC 接线：渲染进程调用的每个通道都必须有 handler，反之每个 handler 都必须被用到。
// 这条能抓出"按钮在、点了没反应"的死界面。
const channels = (text, re) => new Set([...text.matchAll(re)].map((m) => m[1]));
const invoked = channels(preload, /ipcRenderer\.invoke\("([^"]+)"/g);
const handled = channels(main, /ipcMain\.handle\("([^"]+)"/g);
report("渲染进程调用了不存在的 IPC", [...invoked].filter((c) => !handled.has(c)));
report("主进程 handler 没有任何调用方", [...handled].filter((c) => !invoked.has(c)));

// 2. 覆盖台账：Swift 的每个状态字段和公开方法，都要被某处 `parity:` 注释认领。
// Mac 版新增功能后这里会立刻失败，逼着 Windows 版跟上，而不是等用户发现。
const claimed = new Set(
  [...sources.matchAll(/parity:\s*([^\n*]+)/g)].flatMap((m) => m[1].trim().split(/[\s,]+/)),
);
report("Swift 状态字段未在 Windows 版实现", contract.state.filter((name) => !claimed.has(name)));
report("Swift 公开动作未在 Windows 版实现", contract.actions.filter((name) => !claimed.has(name)));

// 3. 界面文案：Mac 版界面上的每句话，Windows 版界面上都要有对应说法。
// platform.json 列出有意为之的平台差异（Metal→CUDA 等）；没登记的缺失一律算丢功能。
const platform = JSON.parse(read("parity/platform.json"));
report(
  "Mac 版界面文案在 Windows 版缺失",
  contract.labels.filter((text) => {
    if (ui.includes(text)) return false;
    if (!(text in platform)) return true;
    const replacement = platform[text];
    return replacement !== null && !ui.includes(replacement);
  }),
);

if (failures.length) {
  console.error(`功能对齐失败：\n\n${failures.join("\n\n")}\n`);
  process.exit(1);
}
console.log(
  `功能对齐通过：${contract.state.length} 状态 · ${contract.actions.length} 动作 · ${contract.labels.length} 文案 · ${handled.size} IPC`,
);
