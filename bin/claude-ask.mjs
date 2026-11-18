#!/usr/bin/env node
/**
 * claude-ask — Claude → DeepSeek(DSH) / Codex 的一次性入口
 *
 * 问一次、拿答案、进程退出（通道即关闭）。只输出答案正文，省 Claude 的上下文。
 *   node bin/claude-ask.mjs deepseek < 问题.txt
 *   node bin/claude-ask.mjs codex    < 问题.txt
 *   node bin/claude-ask.mjs both     < 问题.txt     # 两个都问，分段输出
 * 可选：
 *   --cwd <目录>   工作目录（默认系统临时目录）
 *   --task         派活模式：允许对方用工具、在 --cwd 内写文件（Codex 用 workspace-write 沙箱）
 *                  不加则为咨询模式：只要答案，Codex 只读沙箱
 *   --out <文件>   把答案存进文件，只打印字数和开头几行（长文本用，省 Claude 上下文）
 *
 * 复用本项目已验收的 dispatch-dsh.mjs 与 codex-bridge.mjs，不另起协议。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { localConfig } from '../lib/local-config.mjs';

const bin = import.meta.dirname;
const argv = process.argv.slice(2);
const target = (argv.shift() || '').toLowerCase();
function takeOption(name) {
  const i = argv.indexOf(name);
  if (i < 0) return undefined;
  const v = argv[i + 1];
  argv.splice(i, 2);
  return v;
}
const cwd = takeOption('--cwd') || os.tmpdir();
const outFile = takeOption('--out');
const ti = argv.indexOf('--task');
const task = ti >= 0;
if (task) argv.splice(ti, 1);

let prompt = argv.join(' ').trim();
if (!prompt && !process.stdin.isTTY) prompt = fs.readFileSync(0, 'utf8').trim();
if (!['deepseek', 'codex', 'both'].includes(target) || !prompt) {
  console.error('用法: claude-ask.mjs deepseek|codex|both [--task] [--cwd 目录] [--out 文件] < 问题');
  process.exit(2);
}

const preface = task
  ? `【这是 Claude 派来的任务，用户已授权。请直接完成，工作目录 ${cwd}；只在该目录内建立或修改文件。` +
    (localConfig('BRIDGE_PYTHON') ? `需要 Python 时直接用本机已有的 ${path.normalize(localConfig('BRIDGE_PYTHON'))}，` : '需要 Python 时优先用本机已有的 Python，') +
    '不要另外下载运行时。完成后简要说明做了什么、产物在哪里。不要再去调用其他 AI。】\n\n'
  : '【这是 Claude 发来的一次性咨询，用户已授权。请直接给出你的最佳答案或改写结果，' +
    '简洁、不寒暄；除非问题确实需要，否则不要调用工具、不要修改任何文件，也不要再去调用其他 AI。】\n\n';

function run(args) {
  return new Promise((resolve) => {
    const p = spawn(process.execPath, args, { cwd, windowsHide: true });
    let out = '', err = '';
    p.stdout.on('data', (d) => (out += d));
    p.stderr.on('data', (d) => (err += d));
    p.on('close', (code) => resolve({ code, out, err }));
    p.stdin.end(preface + prompt);
  });
}

async function askDeepSeek() {
  const r = await run([path.join(bin, 'dispatch-dsh.mjs'), '--cwd', cwd]);
  try {
    const j = JSON.parse(r.out);
    if (j.ok) return j.answer;
    return `[DeepSeek 失败] status=${j.status} ${j.error || ''}`.trim();
  } catch { return `[DeepSeek 失败] ${(r.err || r.out).slice(-800)}`; }
}

async function askCodex() {
  const sandbox = task ? 'workspace-write' : 'read-only';
  const r = await run([path.join(bin, 'codex-bridge.mjs'), 'ask', '--json', '--cwd', cwd, '--sandbox', sandbox]);
  try {
    const j = JSON.parse(r.out);
    if (j.turn?.status === 'completed') return j.text;
    return `[Codex 失败] status=${j.turn?.status} ${j.turn?.error?.message || ''}`.trim();
  } catch { return `[Codex 失败] ${(r.err || r.out).slice(-800)}`; }
}

let text;
if (target === 'deepseek') text = await askDeepSeek();
else if (target === 'codex') text = await askCodex();
else {
  const [d, c] = await Promise.all([askDeepSeek(), askCodex()]);
  text = `===== DeepSeek =====\n${d}\n\n===== Codex =====\n${c}`;
}

if (outFile) {
  fs.mkdirSync(path.dirname(path.resolve(outFile)), { recursive: true });
  fs.writeFileSync(outFile, text, 'utf8');
  const head = text.split('\n').slice(0, 8).join('\n');
  console.log(`[已保存] ${path.resolve(outFile)}（${text.length} 字）\n--- 开头 ---\n${head}`);
} else {
  console.log(text);
}
