#!/usr/bin/env node
/**
 * dsh-bridge-mcp — 反向通道：Codex（或任何 MCP 客户端）→ DSH
 *
 * 走 MCP stdio 协议注册给 Codex，工具内部调用 DSH 官方的无头模式：
 *   dsh --profile headless --patch <account 路由> headless "<task>"
 * 因此这是程序调用，不是屏幕输入。
 *
 * Codex 侧注册：
 *   codex mcp add dsh-bridge -- <node> <此文件绝对路径>
 *
 * 工具：
 *   dsh_ask(task, sessionId?, timeoutMs?)  — 让 DSH 回答一个问题/执行一个任务
 *   dsh_bridge_info()                      — 返回配置与递归深度
 *
 * 环境变量：
 *   DSH_CMD       环境变量或 local.config.json；默认 %LOCALAPPDATA%\Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd
 *                 （新版 DSH 命令行不允许后台调用账号登录时，在 local.config.json 里指向旧版运行时）
 *   DSH_PATCH     默认 <repo>/work/headless-account.patch.yml（已登录的 deepseek-account 路由）
 *   AI_BRIDGE_DEPTH / DSH_BRIDGE_MAX_DEPTH  防递归
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { bridgeDepth, DEPTH_ENV } from '../lib/appserver.mjs';
import { progress } from '../lib/progress.mjs';
import { localConfig } from '../lib/local-config.mjs';

const DSH_CMD = path.normalize(
  localConfig('DSH_CMD') ||
    path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'Programs', 'DeepSeek Harness', 'resources', 'runtime', 'cli', 'bin', 'dsh.cmd'),
);
const REPO = path.resolve(import.meta.dirname, '..');
const DSH_PATCH = process.env.DSH_PATCH || path.join(REPO, 'work', 'headless-account.patch.yml');
const MAX_DEPTH = (() => {
  const raw = process.env.DSH_BRIDGE_MAX_DEPTH ?? '1';
  // 必须显式校验：parseInt('abc') = NaN，而 depth >= NaN 恒为 false，
  // 会让防递归静默失效。非法配置直接拒绝启动。
  if (!/^\d+$/.test(String(raw).trim())) {
    console.error(`[dsh-bridge] DSH_BRIDGE_MAX_DEPTH 非法: ${raw}（应为非负整数）`);
    process.exit(2);
  }
  const n = Number.parseInt(raw, 10);
  if (n < 0) {
    console.error(`[dsh-bridge] DSH_BRIDGE_MAX_DEPTH 不能为负: ${raw}`);
    process.exit(2);
  }
  return n;
})();

/** session id 只允许安全字符，避免任何形式的参数注入。 */
const SESSION_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;

// 深度值必须显式校验：非法值若静默回落 0，等于把防递归关掉了。
// 缺失（未设置）才是合法的 0；设了但格式不对一律拒绝启动。
{
  const raw = process.env[DEPTH_ENV];
  if (raw !== undefined && !/^\d+$/.test(String(raw).trim())) {
    console.error(`[dsh-bridge] ${DEPTH_ENV} 非法: ${raw}（应为非负整数或留空）`);
    process.exit(2);
  }
}
const SERVER_NAME = 'dsh-bridge';
const SERVER_VERSION = '1.0.0';

// ------------------------------------------------------------------- 调用

/**
 * 解析出真正的可执行启动方式，避免把用户文本交给 cmd.exe 二次解析（命令注入）。
 *
 * dsh.cmd 的内容等价于：
 *   set ELECTRON_RUN_AS_NODE=1
 *   "<...>\DeepSeek Harness.exe" --expose-internals "<...>\app.asar\dsh\node_modules\
 *      @deepseek-ai\dsh-desktop-host\lib\cli.js" %*
 * 这里直接复刻它，任务文本由 argv 传给子进程，不经过任何 shell。
 *
 * 若解析不出（例如 DSH_CMD 已被改成 exe），就退回 exe 直启；
 * 两者都不成立时返回 null，由调用方走“任务经 stdin 送入”的安全退路。
 */
function resolveDirectLauncher() {
  // 显式指定优先
  const exeOverride = process.env.DSH_EXE;
  const cmdPath = DSH_CMD;

  // 1) DSH_CMD 本身不是 .cmd/.bat（例如直接给了 exe）→ 直接启动
  if (!/\.(cmd|bat)$/i.test(cmdPath)) {
    return fs.existsSync(cmdPath) ? { exe: cmdPath, pre: [] } : null;
  }

  if (!fs.existsSync(cmdPath)) return null;
  const cmdDir = path.dirname(cmdPath); // ...\runtime\cli\bin
  const runtimeDir = path.resolve(cmdDir, '..', '..'); // ...\resources\runtime
  const resourcesDir = path.resolve(runtimeDir, '..'); // ...\resources
  const appRoot = path.resolve(resourcesDir, '..'); // ...\DeepSeek

  const exeCandidates = [
    exeOverride,
    path.join(appRoot, 'DeepSeek Harness.exe'),
    path.join(resourcesDir, '..', 'DeepSeek Harness.exe'),
  ].filter(Boolean);

  const cliCandidates = [
    path.join(resourcesDir, 'app.asar', 'dsh', 'node_modules', '@deepseek-ai', 'dsh-desktop-host', 'lib', 'cli.js'),
  ];

  const exe = exeCandidates.find((p) => fs.existsSync(p));
  // Node 的普通 fs 不认识 app.asar 内部路径；入口由 Electron 读取。
  const cli = cliCandidates.find((p) => fs.existsSync(p) || fs.existsSync(path.join(resourcesDir, 'app.asar')));
  if (exe && cli) {
    return { exe, pre: ['--expose-internals', cli], env: { ELECTRON_RUN_AS_NODE: '1' } };
  }
  return null;
}

const DIRECT = resolveDirectLauncher();

const ACTIVE = new Set();
const MAX_CONCURRENCY = 1; // 一次只允许一个 DSH 任务在飞：防止无限并发与输出累积
const MAX_OUTPUT_BYTES = 2 * 1024 * 1024; // 单次回答上限 2MB

/** 杀掉整棵进程树，避免只杀 cmd 而留下 DSH 子进程（孤儿进程）。 */
function killTree(child) {
  if (!child || child.killed) return;
  try {
    if (process.platform === 'win32' && child.pid) {
      const k = spawn('taskkill', ['/pid', String(child.pid), '/T', '/F'], {
        stdio: 'ignore',
        windowsHide: true,
      });
      // taskkill 自己也可能起不来（被策略拦截等），失败时退回直接 kill
      k.on('error', () => {
        try {
          child.kill();
        } catch {}
      });
    } else {
      child.kill('SIGKILL');
    }
  } catch {
    try {
      child.kill();
    } catch {}
  }
}

/** 回收全部活动子进程：进程退出、收到取消/终止信号、stdin 关闭时都要调用。 */
function killAllActive() {
  for (const c of ACTIVE) killTree(c);
  ACTIVE.clear();
}

// 统一生命周期清理：任何一条路径退出都不能留下 DSH 孤儿进程
process.on('exit', killAllActive);
for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP', 'SIGBREAK']) {
  try {
    process.on(sig, () => {
      killAllActive();
      process.exit(0);
    });
  } catch {}
}

function parseDshRun(out, code) {
  const events=[];
  for(const line of out.split(/\r?\n/)) {
    try { const event=JSON.parse(line); if(event && typeof event.type==='string')events.push(event); } catch {}
  }
  if(!events.length)return code===0 && out.trim()?{ok:true,answer:out.trim(),status:'completed'}:{ok:false,error:`DSH 退出码 ${code}`};
  const session=events.find(e=>e.type==='session');
  const final=events.filter(e=>e.type==='final').at(-1);
  const end=events.filter(e=>e.type==='status' && e.phase==='turn_end').at(-1);
  const error=events.find(e=>e.type==='error');
  const meta={sessionId:session?.sessionId,cwd:session?.cwd,toolCalls:events.filter(e=>e.type==='tool_call').map(e=>e.tool),usage:events.filter(e=>e.type==='status' && e.phase==='step_end' && e.usage).map(e=>e.usage)};
  if(code!==0 || error || end?.reason?.kind!=='completed' || typeof final?.text!=='string')return {...meta,ok:false,status:end?.reason?.kind||'failed',error:error?.message||end?.reason?.error?.message||`DSH 未成功完成（退出码 ${code}）`};
  return {...meta,ok:true,status:'completed',answer:final.text};
}

function runDsh(task, { sessionId, cwd, timeoutMs = 600000 } = {}) {
  // 进度事件：让发起方（Codex）能 tail state\progress.jsonl 看到长任务走到哪一步，
  // 而不是全程静默地盯着"它在跑"。
  const callId = `codex-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const report = (phase, data = {}) => {
    try {
      progress(phase, { callId, side: 'codex', taskChars: task.length, ...data });
    } catch {}
  };
  report('spawned', { sessionId: sessionId || null, launcher: DIRECT ? 'direct' : 'cmd-stdin' });

  return new Promise((resolve) => {
    const args = ['--profile', 'headless'];
    if (fs.existsSync(DSH_PATCH)) args.push('--patch', DSH_PATCH);
    args.push('headless', '--json');
    if (sessionId) args.push('--session-id', sessionId);
    args.push(task);

    let child;
    try {
      if (DIRECT) {
        // 首选：直启，无 shell，任务作为独立 argv 传入
        child = spawn(DIRECT.exe, [...DIRECT.pre, ...args], {
          cwd: cwd || process.cwd(),
          env: { ...process.env, ...(DIRECT.env || {}), [DEPTH_ENV]: String(bridgeDepth() + 1) },
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true,
        });
      } else {
        // 退路：仍经 cmd，但任务内容改走 stdin（命令行里只有纯 ASCII 开关），
        // 并在最前面加 -- 终止开关解析，元字符不进命令行。
        const isCmd = /\.(cmd|bat)$/i.test(DSH_CMD);
        const flags = ['--profile', 'headless'];
        if (fs.existsSync(DSH_PATCH)) flags.push('--patch', DSH_PATCH);
        flags.push('headless', '--json', '-', '--');
        child = isCmd
          ? spawn(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', DSH_CMD, ...flags], {
              cwd: cwd || process.cwd(),
              env: { ...process.env, [DEPTH_ENV]: String(bridgeDepth() + 1) },
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            })
          : spawn(DSH_CMD, flags, {
              cwd: cwd || process.cwd(),
              env: { ...process.env, [DEPTH_ENV]: String(bridgeDepth() + 1) },
              stdio: ['pipe', 'pipe', 'pipe'],
              windowsHide: true,
            });
        child.stdin.end(task);
      }
    } catch (e) {
      resolve({ ok: false, error: `无法启动 DSH: ${e.message}` });
      return;
    }

    let out = '';
    let err = '';
    let outBytes = 0;
    let truncated = false;
    let settled = false;
    ACTIVE.add(child);

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      ACTIVE.delete(child);
      resolve(r);
    };

    const timer = setTimeout(() => {
      killTree(child);
      finish({ ...parseDshRun(out,124),ok:false,status:'timeout',error:`DSH 调用超时 (${timeoutMs}ms)` });
    }, timeoutMs);

    // 显式按 UTF-8 解码，避免多字节字符被 chunk 边界拆坏
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (s) => {
      // 输出上限：防止请求无界累积把内存吃光
      outBytes += Buffer.byteLength(s, 'utf8');
      if (outBytes > MAX_OUTPUT_BYTES) {
        if (!truncated) {
          truncated = true;
          killTree(child);
        }
        return;
      }
      out += s;
    });
    child.stderr.on('data', (s) => {
      if (err.length < 64 * 1024) err += s; // stderr 同样限长
    });
    child.on('error', (e) => {
      report('error', { message: String(e.message) });
      finish({ ok: false, error: `DSH 进程错误: ${e.message}` });
    });
    // 用 close 而不是 exit：确保 stdout 已读干，末尾输出不丢
    child.on('close', (code) => {
      if (truncated) {
        report('output-truncated', { bytes: outBytes });
        finish({
          ok: false,
          error: `DSH 输出超过上限（${MAX_OUTPUT_BYTES} 字节），已终止并回收子进程`,
        });
        return;
      }
      const result = parseDshRun(out, code);
      if (!result.ok && !out.trim()) result.error += err.trim() ? `: ${err.trim().slice(-1000)}` : '';
      // 区分「生成完成」与「进程回收完成」：close 意味着子进程已退出
      report(result.ok ? 'turn-done' : 'turn-failed', {
        status: result.status,
        sessionId: result.sessionId,
        toolCalls: result.toolCalls?.length ?? 0,
        exitCode: code,
      });
      finish(result);
    });
  });
}

// --------------------------------------------------------------- MCP 协议

const TOOLS = [
  {
    name: 'dsh_ask',
    description:
      '把问题或任务交给 DeepSeek Harness (DSH) 去回答/执行，返回它的最终答复。' +
      '当 Codex 需要 DSH 侧的信息、本机上下文或第二意见时使用。',
    inputSchema: {
      type: 'object',
      properties: {
        task: { type: 'string', description: '要交给 DSH 的完整任务描述或问题。' },
        cwd: { type: 'string', description: '任务的原项目目录；续接时保持相同目录。' },
        sessionId: {
          type: 'string',
          description: '可选：传上一次返回的 sessionId 自动续接上下文，用户不需要手动传话。',
        },
        timeoutMs: { type: 'number', description: '可选：超时毫秒数，默认 600000。超时返回 sessionId 供助手自动续接。' },
      },
      required: ['task'],
    },
  },
  {
    name: 'dsh_bridge_info',
    description: '返回 DSH 桥的配置状态与当前递归深度（排查用）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args) {
  if (name === 'dsh_bridge_info') {
    return {
      server: SERVER_NAME,
      version: SERVER_VERSION,
      dshCmd: DSH_CMD,
      dshCmdExists: fs.existsSync(DSH_CMD),
      patch: DSH_PATCH,
      patchExists: fs.existsSync(DSH_PATCH),
      depth: bridgeDepth(),
      maxDepth: MAX_DEPTH,
      depthEnv: DEPTH_ENV,
    };
  }

  if (name !== 'dsh_ask') throw new Error(`未知工具: ${name}`);

  // 并发上限：一次只跑一个 DSH 任务，避免请求堆积把内存/进程吃光
  if (ACTIVE.size >= MAX_CONCURRENCY) {
    return {
      ok: false,
      rejected: 'busy',
      message: `已有 ${ACTIVE.size} 个 DSH 任务在执行（上限 ${MAX_CONCURRENCY}）。请等上一个完成再试。`,
    };
  }

  const a = args && typeof args === 'object' ? args : {};
  const task = String(a.task ?? '').trim();
  if (!task) throw new Error('task 不能为空');

  if (a.sessionId !== undefined && a.sessionId !== null && a.sessionId !== '') {
    if (!SESSION_ID_RE.test(String(a.sessionId))) {
      return {
        ok: false,
        rejected: 'invalid_session_id',
        message: 'sessionId 只允许字母、数字、下划线与连字符，且不超过 128 字符。',
      };
    }
  }

  const depth = bridgeDepth();
  if (depth >= MAX_DEPTH) {
    // 不抛异常：以结构化结果告诉模型“被拒”，避免它反复重试
    return {
      ok: false,
      rejected: 'recursion_limit',
      message:
        `递归保护：桥接深度 ${depth} ≥ 上限 ${MAX_DEPTH}。` +
        `说明 Codex 与 DSH 正在互相反复调用；已停止下钻。请由人决定下一步，` +
        `或设置 ${DEPTH_ENV} 提高上限。`,
    };
  }
  if (!fs.existsSync(DSH_CMD)) {
    return { ok: false, message: `找不到 DSH 命令: ${DSH_CMD}` };
  }

  return await runDsh(task, {
    sessionId: args?.sessionId,
    cwd: args?.cwd,
    timeoutMs: Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 600000,
  });
}

// ------------------------------------------------------- JSON-RPC over stdio

const rl = readline.createInterface({ input: process.stdin });
const send = (msg) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...msg }) + '\n');

rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }

  // 合法 JSON 也可能是 null / 数组 / 字符串：解构前必须先确认是对象，
  // 否则一个 null 就能让整个 MCP 进程崩溃。
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;

  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};

  // 通知：不回
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {} },
          serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
        },
      });
      return;
    }
    if (method === 'tools/list') {
      send({ id, result: { tools: TOOLS } });
      return;
    }
    if (method === 'tools/call') {
      const r = await callTool(params?.name, params?.arguments || {});
      send({
        id,
        result: {
          content: [{ type: 'text', text: JSON.stringify(r, null, 2) }],
          isError: r?.ok === false,
        },
      });
      return;
    }
    if (method === 'ping') {
      send({ id, result: {} });
      return;
    }
    send({ id, error: { code: -32601, message: `未实现的方法: ${method}` } });
  } catch (e) {
    send({ id, error: { code: -32603, message: String(e?.message || e) } });
  }
});

process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
