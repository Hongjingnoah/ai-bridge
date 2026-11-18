#!/usr/bin/env node
/**
 * codex-bridge — DSH → Codex 程序级调用（走官方 app-server 协议，非屏幕模拟）
 *
 * 用 DSH 自带 node 直接运行：
 *   node bin/codex-bridge.mjs ask "帮我看看这段 C 代码为什么越界"
 *   node bin/codex-bridge.mjs ask --thread <id> "继续，改成用函数封装"
 *   node bin/codex-bridge.mjs ask --stream "解释这个编译错误"
 *   node bin/codex-bridge.mjs ask --json "..."      # 含 threadId / 用量
 *   node bin/codex-bridge.mjs health                # 握手自检（不耗额度）
 *   node bin/codex-bridge.mjs threads 10            # 最近的 Codex 会话
 *
 * 管道用法（长文本）：
 *   Get-Content code.c -Raw | node bin/codex-bridge.mjs ask "解释这段代码"
 *
 * 环境变量：
 *   CODEX_CLI / CODEX_HOME / BRIDGE_DEBUG=1
 *   AI_BRIDGE_DEPTH   防递归深度（默认 0；上限由 --max-depth 控制）
 */
import fs from 'node:fs';
import { askTurn, health, bridgeDepth, DEPTH_ENV, AppServer } from '../lib/appserver.mjs';

const USAGE = `codex-bridge — DSH → Codex 程序级调用

  ask [--thread <id>] [--json] [--stream] [--model M] [--effort low|medium|high]
      [--cwd D] [--timeout ms] "问题"
  health
  threads [N]

延迟调优（实测）：
  --model / --effort 可覆盖本轮；gpt-6-sol+low 中位 TTFT 约 2.8s，
  gpt-6.1-sol 约 3.8s。也可用 CODEX_BRIDGE_MODEL / CODEX_BRIDGE_EFFORT。

说明：走 Codex 官方 app-server（JSON-RPC over stdio），不是往窗口里粘贴文本。`;

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  const takesValue = new Set(['thread', 'model', 'cwd', 'timeout', 'max-depth', 'sandbox', 'effort']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      if (takesValue.has(k)) out.flags[k] = argv[++i];
      else out.flags[k] = true;
    } else out._.push(a);
  }
  return out;
}

/** 要求非负整数：parseInt('abc') 会得到 NaN，让 `depth >= NaN` 恒假、保护失效。 */
function positiveInt(raw, name, fallback) {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const s = String(raw).trim();
  if (!/^\d+$/.test(s)) {
    console.error(`[bridge] ${name} 非法: ${raw}（应为非负整数）`);
    process.exit(2);
  }
  return Number.parseInt(s, 10);
}

function readStdin() {
  try {
    if (process.stdin.isTTY) return '';
    return fs.readFileSync(0, 'utf8');
  } catch {
    return '';
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const cmd = argv.shift();
  const { _, flags } = parseArgs(argv);

  if (cmd === 'health') {
    const r = await health({ cwd: process.cwd() });
    console.log(JSON.stringify({ ...r, bridgeDepth: bridgeDepth() }, null, 2));
    return;
  }

  if (cmd === 'threads') {
    const n = Number.parseInt(_[0] || '10', 10);
    const srv = new AppServer({ cwd: process.cwd() });
    try {
      await srv.start();
      const r = await srv.request('thread/list', { limit: n, useStateDbOnly: true });
      for (const t of r?.data || []) {
        console.log(`${t.id}\t${t.name || t.title || '(未命名)'}\t${t.updatedAt || t.createdAt || ''}`);
      }
    } finally {
      srv.stop();
    }
    return;
  }

  if (cmd === 'ask') {
    let prompt = _.join(' ').trim();
    const piped = readStdin().trim();
    if (piped) prompt = prompt ? `${prompt}\n\n<stdin>\n${piped}\n</stdin>` : piped;
    if (!prompt) {
      console.error(USAGE);
      process.exit(2);
    }

    const maxDepth = positiveInt(flags['max-depth'] ?? process.env.CODEX_BRIDGE_MAX_DEPTH, '--max-depth', 2);
    const depth = bridgeDepth();
    if (depth >= maxDepth) {
      console.error(
        `[bridge] 递归保护：桥接深度 ${depth} ≥ 上限 ${maxDepth}（${DEPTH_ENV}）。` +
          `已拒绝继续下钻，避免两个 AI 无限互相调用。`,
      );
      process.exit(3);
    }

    const res = await askTurn({
      prompt,
      threadId: flags.thread,
      cwd: flags.cwd || process.cwd(),
      // 默认模型/档位可用环境变量覆盖：实测 gpt-6-sol/low 比 gpt-6.1-sol 快约 1.1s
      model: flags.model || process.env.CODEX_BRIDGE_MODEL || undefined,
      effort: flags.effort || process.env.CODEX_BRIDGE_EFFORT || undefined,
      sandbox: flags.sandbox || 'danger-full-access',
      stream: !!flags.stream,
      timeoutMs: positiveInt(flags.timeout, '--timeout', 600000),
      // 子进程环境带上 +1 深度，供下游再次桥接时判断
      wrapEnv: () => ({ [DEPTH_ENV]: String(depth + 1) }),
    });

    if (flags.json) {
      console.log(JSON.stringify(res, null, 2));
    } else {
      if (flags.stream) process.stdout.write('\n');
      console.log(res.text);
      if (!flags.quiet) console.error(`[bridge] threadId=${res.threadId} turnId=${res.turnId} status=${res.turn?.status}`);
    }
    return;
  }

  console.error(USAGE);
  process.exit(2);
}

main().catch((e) => {
  console.error('[bridge] 失败: ' + (e?.message || e));
  if (process.env.BRIDGE_DEBUG === '1') console.error(e?.stack || '');
  process.exit(1);
});
