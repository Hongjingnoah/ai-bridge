#!/usr/bin/env node
/**
 * setup.mjs — 把互通桥适配到当前这台机器，并做真实冒烟测试。
 *
 * 做四件事（每件都打印结果，任何一步失败都会说明原因）：
 *   1. 探测 codex.exe（扫 bin 下所有版本目录，不写死 hash）
 *   2. 探测 dsh.cmd 与 DSH 自带 node
 *   3. 校验/生成 headless-account.patch.yml（账号路由覆盖层，不改 DSH 现有配置）
 *   4. 冒烟：Codex 握手（不耗额度） + DSH 无头真实问答
 *
 * 用法：node setup\setup.mjs [--skip-smoke]
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
const SKIP_SMOKE = process.argv.includes('--skip-smoke');
const line = (s = '') => console.log(s);
const ok = (s) => line(`  [OK]   ${s}`);
const warn = (s) => line(`  [WARN] ${s}`);
const bad = (s) => line(`  [FAIL] ${s}`);

let failures = 0;

line('=== DSH ↔ Codex 互通桥 · 环境适配 ===');
line(`仓库: ${REPO}`);
line();

// ---------------------------------------------------------------- 1. codex

line('[1/4] 定位 codex.exe');
function findCodex() {
  const env = process.env.CODEX_CLI;
  if (env && fs.existsSync(env)) return env;
  const roots = [
    path.join((process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')), 'OpenAI', 'Codex', 'bin'),
  ];
  for (const root of roots) {
    let dirs = [];
    try {
      dirs = fs.readdirSync(root, { withFileTypes: true });
    } catch {
      continue;
    }
    const found = [];
    for (const d of dirs) {
      if (!d.isDirectory()) continue;
      const p = path.join(root, d.name, 'codex.exe');
      try {
        found.push({ p, m: fs.statSync(p).mtimeMs });
      } catch {}
    }
    if (found.length) {
      found.sort((a, b) => b.m - a.m);
      return found[0].p;
    }
  }
  return null;
}
const CODEX = findCodex();
if (CODEX) ok(CODEX);
else {
  bad('找不到 codex.exe。请设置环境变量 CODEX_CLI 指向它。');
  failures++;
}
line();

// ------------------------------------------------------------------ 2. dsh

line('[2/4] 定位 dsh 与 DSH 自带 node');
const DSH_CANDIDATES = [
  process.env.DSH_CMD,
  path.join((process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
  path.join(process.env.LOCALAPPDATA || '', 'Programs', 'DeepSeek', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
].filter(Boolean);
const DSH = DSH_CANDIDATES.find((p) => fs.existsSync(p)) || null;
if (DSH) ok(DSH);
else {
  bad('找不到 dsh.cmd。请设置 DSH_CMD 指向它。');
  failures++;
}

const NODE_CANDIDATES = [
  process.env.DSH_NODE,
  path.join((process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'primary-runtime', 'dependencies', 'node', 'bin', 'node.exe'),
  process.execPath,
].filter(Boolean);
const NODE = NODE_CANDIDATES.find((p) => fs.existsSync(p)) || process.execPath;
ok(`node: ${NODE}`);
line();

// --------------------------------------------------------- 3. 账号路由覆盖层

line('[3/4] 校验账号路由覆盖层（不改 DSH 现有配置）');
const PATCH = path.join(REPO, 'work', 'headless-account.patch.yml');
const EXPECTED = `# 让 headless 走已登录的 deepseek-account 路由（不动用户的 profile 文件）
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
    reasoningEffort: high
`;
if (!fs.existsSync(PATCH)) {
  fs.mkdirSync(path.dirname(PATCH), { recursive: true });
  fs.writeFileSync(PATCH, EXPECTED);
  ok(`已生成 ${PATCH}`);
} else {
  ok(`已存在 ${PATCH}`);
}
if (/provider:\s*deepseek-account/.test(fs.readFileSync(PATCH, 'utf8'))) {
  ok('覆盖层指向 deepseek-account（用你的登录态，不需要 API key）');
} else {
  warn('覆盖层里没有 deepseek-account，headless 可能会报 MISSING_CREDENTIAL');
}
line();

// --------------------------------------------------------------- 4. 冒烟

line('[4/4] 冒烟测试');
if (SKIP_SMOKE) {
  warn('已跳过（--skip-smoke）');
} else {
  // 4a. Codex 握手：不消耗额度
  if (CODEX) {
    const r = await run(NODE, [path.join(REPO, 'bin', 'codex-bridge.mjs'), 'health'], 60000);
    if (r.code === 0 && /"ok":\s*true/.test(r.out)) {
      const plan = r.out.match(/"planType":\s*"([^"]+)"/)?.[1] ?? '未知';
      const ms = r.out.match(/"handshakeMs":\s*(\d+)/)?.[1];
      ok(`Codex 握手成功（${ms}ms，账号档位 ${plan}）`);
    } else {
      bad(`Codex 握手失败（exit=${r.code}）：${(r.err || r.out).slice(0, 300)}`);
      failures++;
    }
  }

  // 4b. DSH 无头真实问答：反向通道
  if (DSH) {
    const r = await run(
      NODE,
      [path.join(REPO, 'bin', 'dsh-bridge-mcp.mjs')],
      120000,
      // 直接驱动 MCP：initialize → tools/call
      [
        { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', clientInfo: { name: 'setup', version: '1' }, capabilities: {} } },
        { jsonrpc: '2.0', method: 'notifications/initialized', params: {} },
        { jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'dsh_ask', arguments: { task: '只回复两个字：通了' } } },
      ],
    );
    // 注意：MCP 把内层结果作为 content[].text 返回，里面的引号是被转义的，
    // 所以断言要容忍 \" 这种形式，否则会把成功判成失败。
    const unescaped = r.out.replace(/\\"/g, '"');
    if (/"ok":\s*true/.test(unescaped) && /"answer"/.test(unescaped)) {
      const ans = unescaped.match(/"answer":\s*"([^"]*)"/)?.[1];
      ok(`DSH 反向回答成功：「${ans}」`);
    } else {
      bad(`DSH 反向调用失败：${(r.err || r.out).slice(-400)}`);
      failures++;
    }
  }
}

line();
line('=== 结果 ===');
if (failures === 0) {
  line('全部通过。');
  line();
  line('下一步（二选一或都做）：');
  line('  A. 让 DSH 能调 Codex：把下面这段加进');
  line('     %USERPROFILE%\\.dsh\\profiles\\desktop\\cordis.patch.yml 的 insert 块（改前先备份）：');
  line();
  line(`    - id: mcp-codex-bridge`);
  line(`      name: '@deepseek-ai/dsh-mcp-client'`);
  line(`      config:`);
  line(`        serverName: codex-bridge`);
  line(`        transport: stdio`);
  line(`        command: '${NODE.replace(/\\/g, '\\\\')}'`);
  line(`        args:`);
  line(`          - '${path.join(REPO, 'bin', 'codex-bridge-mcp.mjs').replace(/\\/g, '\\\\')}'`);
  line(`        cwd: '${REPO.replace(/\\/g, '\\\\')}'`);
  line();
  line('  B. 让 Codex 能调 DSH（会写 ~/.codex/config.toml）：');
  line(`     codex mcp add dsh-bridge -- "${NODE}" "${path.join(REPO, 'bin', 'dsh-bridge-mcp.mjs')}"`);
  line();
  line('验收：node work\\verify-mcp-strict.mjs bin\\codex-bridge-mcp.mjs codex_ask "{\\"prompt\\":\\"回复OK\\"}"');
  line('      必须看到 strictOk: true 且 violations: []');
} else {
  line(`有 ${failures} 项失败，请先按上面的 FAIL 说明修好，再继续注册。`);
}
process.exit(failures === 0 ? 0 : 1);

// ------------------------------------------------------------------ 工具

function run(nodeExe, args, timeoutMs, mcpLines) {
  return new Promise((resolve) => {
    const child = spawn(nodeExe, args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let done = false;
    const finish = (code) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {}
      resolve({ code, out, err });
    };
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('close', (code) => finish(code));
    child.on('error', (e) => {
      err += String(e.message);
      finish(-1);
    });
    if (mcpLines) {
      setTimeout(() => {
        for (const l of mcpLines) child.stdin.write(JSON.stringify(l) + '\n');
        // 关掉 stdin，否则 MCP 服务会一直等下一行
        child.stdin.end();
      }, 200);
    }
    setTimeout(() => finish(null), timeoutMs);
  });
}
