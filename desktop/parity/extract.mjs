// 从 macOS 版 Swift 源码抽取功能清单，生成 contract.json。
// 生成而非手写：Mac 版新增功能时契约自动变化，check.mjs 会立刻报出 Windows 版的缺口。
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const launcher = resolve(import.meta.dirname, "../../launcher");
const read = (name) => readFileSync(resolve(launcher, name), "utf8");
const all = (text, re) => [...text.matchAll(re)].map((m) => m[1]);
const unique = (items) => [...new Set(items)].sort();

const store = read("LauncherStore.swift");
const views = ["DashboardView.swift", "AgentWorkspaceView.swift", "ToolWorkspaceView.swift"].map(read).join("\n");

// 状态面：驱动界面的每一个可观察字段。
const state = unique(all(store, /@Published\s+(?:private\(set\)\s+)?var\s+(\w+)/g));

// 行为面：只取非 private 的方法，即用户可触发的动作；private 是实现细节。
const actions = unique(
  [...store.matchAll(/^\s*(private\s+)?func\s+(\w+)/gm)].filter((m) => !m[1]).map((m) => m[2]),
);

// 界面面：按 SwiftUI 构造抽取，而不是按语言过滤。
// 早期版本只留中文且截断 40 字，把 "Server Status:"、"Turbo KV"、各种说明长句全漏了。
const S = `"((?:[^"\\\\]|\\\\.)*)"`;
const labelPatterns = [
  `\\bText\\(${S}\\)`,
  `\\bButton\\(${S}\\)`,
  `\\bLabel\\(${S}`,
  `\\bPicker\\(${S}`,
  `\\bTextField\\(${S}`,
  `\\bSecureField\\(${S}`,
  `\\bCodeLine\\(${S}`,
  `\\.help\\(${S}\\)`,
  `\\blabeledField\\(${S}`,
  // 具名参数构成的自定义卡片：InfoCell/MetricCard/RouteRow/OptimizationRow/DetailCard/PanelHeader/Page 等。
  // 刻意排除 symbol:/systemImage:/icon:，那些是 SF Symbol 名不是文案。
  `\\b(?:title|subtitle|label|value|detail|state|unit|text|placeholder):\\s*${S}`,
];
// 枚举 rawValue 就是导航项与下拉项的显示名。
const enumCases = `case\\s+\\w+\\s*=\\s*${S}`;
const source = `${views}\n${store}`;

// 三元表达式里的两个分支也是真文案，例如 Label(isOnline ? "重启" : "启动")。
const ternary = [...source.matchAll(new RegExp(`\\?\\s*${S}\\s*:\\s*${S}`, "g"))].flatMap((m) => [m[1], m[2]]);

const labels = unique(
  [...[...labelPatterns, enumCases].flatMap((pattern) => all(source, new RegExp(pattern, "g"))), ...ternary]
    // 含插值的字符串是动态拼接的，逐字比对没有意义；纯标点/空白的也不是文案。
    // 必须用 \p{L} 判断有无文字：JS 的 \W 把中文也算作非单词字符，用它过滤会把整套中文界面丢光。
    .filter((text) => text && !text.includes("\\(") && /[\p{L}\p{N}]/u.test(text))
    // 三元分支会混进 SF Symbol 名（play.fill、chevron.down）和枚举值，它们不是界面文案。
    .filter((text) => !/^[a-z0-9]+([.\-_][a-z0-9]+)*$/.test(text) && !/^\d+$/.test(text)),
);

const contract = { state, actions, labels };
writeFileSync(resolve(import.meta.dirname, "contract.json"), `${JSON.stringify(contract, null, 2)}\n`);
console.log(`contract: ${state.length} state · ${actions.length} actions · ${labels.length} labels`);
