#!/usr/bin/env node
/**
 * progress — 查看桥接进度事件流（长任务可观测）
 *
 * 用法：
 *   node bin\progress.mjs            # 最近 40 条
 *   node bin\progress.mjs -n 100     # 最近 100 条
 *   node bin\progress.mjs --follow    # 持续跟踪（Ctrl+C 退出）
 *   node bin\progress.mjs --json      # 原样输出 JSONL
 *   node bin\progress.mjs --since 5m  # 只看最近 5 分钟
 */
import fs from 'node:fs';
import { PROGRESS_FILE, recent } from '../lib/progress.mjs';

const argv = process.argv.slice(2);
const n = Number.parseInt(argv[argv.indexOf('-n') + 1] || '40', 10) || 40;
const follow = argv.includes('--follow') || argv.includes('-f');
const asJson = argv.includes('--json');
const sinceIdx = argv.indexOf('--since');
const sinceArg = sinceIdx >= 0 ? argv[sinceIdx + 1] : null;

function parseSince(s) {
  if (!s) return null;
  const m = /^(\d+)(s|m|h)?$/.exec(s.trim());
  if (!m) return null;
  const v = Number.parseInt(m[1], 10);
  const unit = m[2] || 'm';
  const ms = unit === 's' ? v * 1000 : unit === 'h' ? v * 3600000 : v * 60000;
  return Date.now() - ms;
}

function show(rows) {
  const since = parseSince(sinceArg);
  const filtered = since ? rows.filter((r) => Date.parse(r.ts || 0) >= since) : rows;
  if (asJson) {
    for (const r of filtered) console.log(JSON.stringify(r));
    return filtered.length;
  }
  for (const r of filtered) {
    const t = (r.ts || '').slice(11, 19);
    const side = r.side ? `[${r.side}]` : '';
    const extra = Object.entries(r)
      .filter(([k]) => !['ts', 'phase', 'side', 'promptChars'].includes(k))
      .map(([k, v]) => `${k}=${v}`)
      .join(' ');
    console.log(`${t} ${side.padEnd(7)} ${String(r.phase).padEnd(16)} ${extra}`);
  }
  return filtered.length;
}

console.log(`# 进度文件: ${PROGRESS_FILE}`);
console.log(`# (不存在表示还没有事件；跑一次 bin\\codex-bridge.mjs ask 就会有)`);
console.log('');

if (!follow) {
  const rows = recent(n);
  if (!rows.length) {
    console.log('(暂无事件)');
    process.exit(0);
  }
  show(rows);
  process.exit(0);
}

let lastSize = 0;
try {
  lastSize = fs.statSync(PROGRESS_FILE).size;
} catch {}
const initial = recent(n);
show(initial);

setInterval(() => {
  let size = 0;
  try {
    size = fs.statSync(PROGRESS_FILE).size;
  } catch {
    return;
  }
  if (size < lastSize) lastSize = 0; // 轮转过，从头读
  if (size === lastSize) return;
  lastSize = size;
  const rows = recent(200);
  show(rows.slice(-40));
}, 1000);
