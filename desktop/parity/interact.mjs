// 真点一遍界面，验证控件有行为而不只是存在。
// check.mjs 只能证明元素和文案在；这里证明点下去真的会变。
// 用法：先 `electron . --remote-debugging-port=9222`，再运行本脚本。
const endpoint = "http://127.0.0.1:9222/json";

async function connect() {
  for (let attempt = 0; attempt < 30; attempt++) {
    try {
      const targets = await (await fetch(endpoint)).json();
      const target = targets.find((item) => item.url.endsWith("index.html"));
      if (target) return new WebSocket(target.webSocketDebuggerUrl);
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  throw new Error("连不上 Electron 调试端口 9222");
}

const ws = await connect();
let id = 0;
const pending = new Map();
const send = (method, params = {}) =>
  new Promise((resolve) => { pending.set(++id, resolve); ws.send(JSON.stringify({ id, method, params })); });
ws.onmessage = (event) => { const message = JSON.parse(event.data); if (pending.has(message.id)) pending.get(message.id)(message.result); };
await new Promise((resolve) => { ws.onopen = resolve; });

const evaluate = async (expression) => {
  const result = await send("Runtime.evaluate", { expression: `(() => { ${expression} })()`, returnByValue: true, awaitPromise: true });
  if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  return result.result?.value;
};
const visible = (selector) => `!document.querySelector('${selector}').classList.contains('hidden')`;
const setField = (selector, value) => `const el=document.querySelector('${selector}'); el.value='${value}'; el.dispatchEvent(new Event('input',{bubbles:true}));`;
const check = (selector) => `const el=document.querySelector('${selector}'); el.checked=true; el.dispatchEvent(new Event('input',{bubbles:true}));`;

const checks = [
  ["开发代理页隐藏导航栏与检查器", `document.querySelector('nav [data-page=agent]').click(); return ${visible("#inspector")} === false && ${visible(".sidebar")} === false;`],
  ["概览页恢复导航栏", `document.querySelector('nav [data-page=overview]').click(); return ${visible(".sidebar")};`],
  ["概览页显示右栏检查器", `document.querySelector('nav [data-page=overview]').click(); return ${visible("#inspector")};`],
  ["设置页默认显示本地设置", `document.querySelector('nav [data-page=settings]').click(); return ${visible("#local-settings")} && ${visible("#cloud-settings")} === false;`],
  ["切到云 API 显示云配置", `${check("#settings-form [name=source][value=cloud]")} return ${visible("#cloud-settings")} && ${visible("#local-settings")} === false;`],
  ["切回本地恢复本地配置", `${check("#settings-form [name=source][value=local]")} return ${visible("#local-settings")};`],
  ["选自定义上下文显示 token 输入", `${setField("#settings-form [name=context]", "-1")} return ${visible("#custom-context-row")};`],
  ["超过 16K 弹出换页警告", `${setField("#settings-form [name=context]", "32768")} return ${visible("#context-warning")};`],
  ["改动后保存按钮变为可用", `return document.querySelector('#save-settings').disabled === false && document.querySelector('#save-settings').textContent === '保存' && ${visible("#dirty-hint")};`],
  ["KV 选 q8_0 写进草稿", `${check("#settings-form [name=kv][value=q8_0]")} return document.querySelector('#settings-form').elements.kv.value === 'q8_0';`],
  ["双击会话进入行内改名", `document.querySelector('nav [data-page=agent]').click(); document.querySelector('.session').dispatchEvent(new MouseEvent('dblclick',{bubbles:true})); return document.querySelector('.session-rename') !== null;`],
  ["Esc 取消改名还原标题", `const input=document.querySelector('.session-rename'); input.onblur=null; input.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); return document.querySelector('.session-rename') === null && document.querySelector('.session') !== null;`],
  ["项目分组可以折叠", `const head=document.querySelector('.project-head'); const before=document.querySelectorAll('.session-row').length; head.click(); const after=document.querySelectorAll('.session-row').length; head.click(); return before > 0 && after === 0;`],
  ["删除会话弹出确认框", `document.querySelector('.trash').click(); const d=document.querySelector('#confirm-dialog'); const open=d.open===true; d.close(''); return open;`],
  ["工具菜单能打开终端面板", `document.querySelector('#tool-toggle').click(); document.querySelector('#tool-menu [data-tool=terminal]').click(); return ${visible("#tool-pane")} && ${visible("#terminal-tool")};`],
  ["工具面板可以隐藏", `document.querySelector('#close-tool').click(); return ${visible("#tool-pane")} === false;`],
  ["发送按钮随运行状态切换", `return document.querySelector('#send-agent').textContent === '↑';`],
  ["工具栏胶囊反映推理来源", `return ['云 API','本机模型在线','模型未启动'].includes(document.querySelector('#source-pill').textContent);`],
  ["上下文仪表随状态更新", `return document.querySelector('#ctx-gauge').getAttribute('stroke-dasharray') !== null;`],
  ["速度折线有 28 个采样点", `return document.querySelector('#speed-chart polyline').getAttribute('points').split(' ').length === 28;`],
  ["运行配置随 KV 设置刷新", `return document.querySelector('#cfg-kv').textContent.startsWith('KV=');`],
];

let failed = 0;
for (const [name, expression] of checks) {
  try {
    const ok = await evaluate(expression);
    console.log(`${ok ? "  ok" : "FAIL"}  ${name}`);
    if (!ok) failed++;
  } catch (error) { console.log(`ERR   ${name}: ${String(error.message).split("\n")[0]}`); failed++; }
}
ws.close();
console.log(failed ? `\n界面交互失败 ${failed} 项` : `\n界面交互通过：${checks.length} 项`);
process.exit(failed ? 1 : 0);
