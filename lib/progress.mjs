/**
 * progress.mjs — 跨进程可观测性事件流
 *
 * 解决的问题：长任务（一轮审查可能跑 75 秒以上）在对面看来是完全静默的，
 * 只能"看着它在跑"却不知道跑到哪一步。这里把关键节点写成一行一条的
 * JSONL 事件流，任何一方都能 tail 它看到实时进度。
 *
 * 设计约束：
 *  - 追加写、单行 JSON，人可读、可 grep；
 *  - 写失败绝不能影响主流程（可观测性不能成为新的故障点）；
 *  - 文件自动截断，避免无限增长。
 */
import fs from 'node:fs';
import path from 'node:path';

const REPO = path.resolve(import.meta.dirname, '..');
export const STATE_DIR = path.join(REPO, 'state');
export const PROGRESS_FILE = process.env.AI_BRIDGE_PROGRESS || path.join(STATE_DIR, 'progress.jsonl');

const MAX_BYTES = 4 * 1024 * 1024; // 超过就轮转一半，避免无限增长

function ensure() {
  fs.mkdirSync(path.dirname(PROGRESS_FILE), { recursive: true });
  try {
    const st = fs.statSync(PROGRESS_FILE);
    if (st.size > MAX_BYTES) {
      // 简单轮转：保留后半段
      const buf = fs.readFileSync(PROGRESS_FILE, 'utf8');
      const half = buf.slice(Math.floor(buf.length / 2));
      const nl = half.indexOf('\n');
      fs.writeFileSync(PROGRESS_FILE, nl >= 0 ? half.slice(nl + 1) : '');
    }
  } catch {
    // 文件不存在等情况：无需处理
  }
}

/**
 * 追加一条进度事件。
 * @param {string} phase 事件名，建议：turn-start / first-delta / turn-done / error / timeout / cleanup
 * @param {object} data  附加字段（side: 'dsh'|'codex' 用于区分方向）
 */
export function progress(phase, data = {}) {
  try {
    ensure();
    const rec = { ts: new Date().toISOString(), phase, ...data };
    fs.appendFileSync(PROGRESS_FILE, JSON.stringify(rec) + '\n');
  } catch {
    // 可观测性失败不得影响主流程
  }
}

/** 读最近 n 条事件（供 tail 工具使用）。 */
export function recent(n = 40) {
  try {
    const lines = fs.readFileSync(PROGRESS_FILE, 'utf8').split('\n').filter(Boolean);
    return lines.slice(-n).map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return { raw: l };
      }
    });
  } catch {
    return [];
  }
}
