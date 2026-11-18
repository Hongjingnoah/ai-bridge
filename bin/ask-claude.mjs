#!/usr/bin/env node
/**
 * ask-claude — DSH / Codex → Claude 的一次性问答入口（只问答，不派活）
 *
 *   node bin/ask-claude.mjs < 问题.txt
 *   node bin/ask-claude.mjs "问题"
 *
 * Claude 以无工具模式运行（--tools ""、不加载 MCP、不保存会话）：
 * 只能返回文字，不能执行命令、改文件、开网页，也不能再去调用别的 AI。
 * 用户规定：DSH/Codex 只能问 Claude 问题，不能让 Claude 替它们干活。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';

const CLAUDE = process.env.CLAUDE_CLI || path.join(os.homedir(), '.local', 'bin', process.platform === 'win32' ? 'claude.exe' : 'claude');
const DEPTH_ENV = 'AI_BRIDGE_DEPTH';
const depth = Number.parseInt(process.env[DEPTH_ENV] || '0', 10) || 0;
if (depth >= 2) {
  console.error(`[ask-claude] 递归保护：桥接深度 ${depth} ≥ 2，拒绝继续下钻。`);
  process.exit(3);
}

// --out <文件>：答案写进文件（DSH 的 PowerShell 工具吞掉原生进程输出时用）
const args = process.argv.slice(2);
let outFile;
const oi = args.indexOf('--out');
if (oi >= 0) { outFile = args[oi + 1]; args.splice(oi, 2); }
let prompt = args.join(' ').trim();
if (!prompt && !process.stdin.isTTY) prompt = fs.readFileSync(0, 'utf8').trim();
if (!prompt) {
  console.error('用法: ask-claude.mjs "问题"  或  ask-claude.mjs < 问题.txt');
  process.exit(2);
}

const system = '你正在回答另一位 AI 助手（DeepSeek 或 Codex）的咨询，用户已同意。' +
  '你没有任何工具，只用文字给出你的最佳答案：直接、具体、用中文；不确定的地方说明。';

const p = spawn(CLAUDE, [
  '-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence',
  '--output-format', 'json', '--append-system-prompt', system,
], { cwd: os.tmpdir(), windowsHide: true, env: { ...process.env, [DEPTH_ENV]: String(depth + 1) } });

let out = '', err = '';
p.stdout.on('data', (d) => (out += d));
p.stderr.on('data', (d) => (err += d));
const timer = setTimeout(() => p.kill(), 300000);
p.on('close', (code) => {
  clearTimeout(timer);
  try {
    const j = JSON.parse(out);
    if (j.is_error) { console.error(`[ask-claude] 失败：${j.result || j.subtype}`); process.exit(1); }
    if (outFile) fs.writeFileSync(outFile, j.result, 'utf8');
    console.log(j.result);
  } catch {
    console.error(`[ask-claude] 失败（退出码 ${code}）：${(err || out).slice(-800)}`);
    process.exit(1);
  }
});
p.stdin.end(prompt);
