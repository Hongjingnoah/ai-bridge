#!/usr/bin/env node
/**
 * bridge-mailbox — 异步反向消息：Codex 留话 → DSH 下一回合取件并回复
 *
 * 为什么需要它：DSH 是回合制的，它不可能在被别人调用的同时接消息。
 * 所以文档本身不实现「同步推送」，而是让 Codex 把留言写进信箱；
 * DSH 每次开始新回合时先取件，从而闭环。这与 dsh_ask 的同步回调互补。
 *
 * 用法：
 *   node bin/bridge-mailbox.mjs send --from codex "留言内容"
 *   node bin/bridge-mailbox.mjs list [--json]
 *   node bin/bridge-mailbox.mjs read <id>
 *   node bin/bridge-mailbox.mjs reply <id> "回复内容"
 *   node bin/bridge-mailbox.mjs pending            # 还有几条未处理
 *
 * 存储：<repo>/state/mailbox.jsonl（每条一行 JSON，追加写，人可读可审计）
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const REPO = path.resolve(import.meta.dirname, '..');
const STATE_DIR = path.join(REPO, 'state');
const BOX = path.join(STATE_DIR, 'mailbox.jsonl');

function ensure() {
  fs.mkdirSync(STATE_DIR, { recursive: true });
  if (!fs.existsSync(BOX)) fs.writeFileSync(BOX, '');
}

function readAll() {
  ensure();
  return fs
    .readFileSync(BOX, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function append(rec) {
  ensure();
  fs.appendFileSync(BOX, JSON.stringify(rec) + '\n');
}

/** 按 id 折叠出每个线程的最新状态。 */
function threads() {
  const all = readAll();
  const byId = new Map();
  for (const r of all) {
    byId.set(r.id, r);
  }
  return [...byId.values()];
}

function parseArgs(argv) {
  const out = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--from' || a === '--to') out.flags[a.slice(2)] = argv[++i];
    else if (a === '--json') out.flags.json = true;
    else out._.push(a);
  }
  return out;
}

const cmd = process.argv[2];
const { _, flags } = parseArgs(process.argv.slice(3));

switch (cmd) {
  case 'send': {
    const body = _.join(' ').trim();
    if (!body) {
      console.error('用法: bridge-mailbox send [--from codex] "留言"');
      process.exit(2);
    }
    const rec = {
      id: crypto.randomUUID(),
      ts: new Date().toISOString(),
      from: flags.from || 'codex',
      to: flags.to || 'dsh',
      status: 'open',
      body,
    };
    append(rec);
    console.log(JSON.stringify({ ok: true, ...rec }, null, 2));
    break;
  }
  case 'list': {
    const rows = threads().filter((r) => r.status === 'open');
    if (flags.json) console.log(JSON.stringify(rows, null, 2));
    else if (!rows.length) console.log('(没有未处理的留言)');
    else for (const r of rows) console.log(`${r.id}\t${r.ts}\t${r.from}→${r.to}\t${r.body.slice(0, 120)}`);
    break;
  }
  case 'read': {
    const id = _[0];
    const r = threads().find((x) => x.id === id || x.id.startsWith(id || ''));
    if (!r) {
      console.error('找不到该留言');
      process.exit(1);
    }
    console.log(JSON.stringify(r, null, 2));
    break;
  }
  case 'reply': {
    const id = _[0];
    const body = _.slice(1).join(' ').trim();
    const target = threads().find((x) => x.id === id || x.id.startsWith(id || ''));
    if (!target) {
      console.error('找不到该留言');
      process.exit(1);
    }
    if (!body) {
      console.error('用法: bridge-mailbox reply <id> "回复内容"');
      process.exit(2);
    }
    append({
      id: target.id,
      ts: new Date().toISOString(),
      from: flags.from || 'dsh',
      to: target.from,
      status: 'answered',
      replyTo: target.id,
      body,
    });
    console.log(JSON.stringify({ ok: true, id: target.id, status: 'answered' }, null, 2));
    break;
  }
  case 'pending': {
    const n = threads().filter((r) => r.status === 'open').length;
    console.log(String(n));
    process.exit(0);
    break;
  }
  default:
    console.error(
      [
        'bridge-mailbox — Codex ↔ DSH 异步留言信箱',
        '',
        '  send [--from codex] "留言"',
        '  list [--json]',
        '  read <id>',
        '  reply <id> "回复"',
        '  pending',
      ].join('\n'),
    );
    process.exit(2);
}
