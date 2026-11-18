/**
 * codex app-server 协议客户端（DSH ↔ Codex 桥接共用层）
 *
 * 依据：codex app-server 官方协议（JSON-RPC 2.0 over stdio JSONL）
 *   https://learn.chatgpt.com/docs/app-server
 * 以及本机 codex.exe 生成的当版 schema：
 *   work/schema/codex_app_server_protocol.v2.schemas.json
 *
 * 关键点：
 *  - initialize {clientInfo, capabilities.experimentalApi} → initialized 通知
 *  - thread/start | thread/resume → turn/start → 流式 item/agentMessage/delta
 *  - turn/completed 的 status 可能是 completed / interrupted / failed，
 *    通知本身不等于成功，必须检查 status。
 */

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { progress } from './progress.mjs';

// ------------------------------------------------------------ codex 定位

const CODEX_BIN_ROOT = [path.join((process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')), 'OpenAI', 'Codex', 'bin')];

/** 探测 codex.exe：CODEX_CLI 优先，其次扫描 bin 下任意版本目录（不写死 hash）。 */
export function findCodex() {
  const env = process.env.CODEX_CLI;
  if (env && fs.existsSync(env)) return env;
  for (const root of CODEX_BIN_ROOT) {
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
        found.push({ p, mtime: fs.statSync(p).mtimeMs });
      } catch {}
    }
    if (found.length) {
      found.sort((a, b) => b.mtime - a.mtime); // 取最新版本
      return found[0].p;
    }
  }
  return null;
}

export const CODEX_HOME = process.env.CODEX_HOME || path.join(os.homedir(), '.codex');
const DEBUG = process.env.BRIDGE_DEBUG === '1';

// ------------------------------------------------------------ 防递归

export const DEPTH_ENV = 'AI_BRIDGE_DEPTH';

/**
 * 读当前调用深度。DSH→Codex→DSH→… 会在同一个环境变量上累加。
 * 没有它，两个 AI 互相调用会无限递归（A 问 B、B 又问 A）。
 */
export function bridgeDepth(env = process.env) {
  const n = Number.parseInt(env[DEPTH_ENV] ?? '0', 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 超限时抛错，调用方应把它作为“拒绝”返回而不是继续下钻。 */
export function assertDepth(max, env = process.env) {
  const d = bridgeDepth(env);
  if (d >= max) {
    const err = new Error(
      `递归保护：当前桥接深度 ${d} 已达上限 ${max}（${DEPTH_ENV}）。` +
        `这通常意味着两个 AI 在互相反复调用；请让本次由人决定，或提高上限。`,
    );
    err.code = 'BRIDGE_RECURSION_LIMIT';
    err.depth = d;
    throw err;
  }
  return d;
}

// ------------------------------------------------------- JSON-RPC 客户端

export class AppServer {
  constructor({ cwd, model, codexCli, extraEnv } = {}) {
    this.cwd = cwd || process.cwd();
    this.model = model || null;
    this.codexCli = codexCli || findCodex();
    this.extraEnv = extraEnv || {};
    this.proc = null;
    this.rl = null;
    this.nextId = 1;
    this.pending = new Map();
    this.handlers = new Set();
    this.serverReqHandlers = new Set();
    this.exitHandlers = new Set();
    this.exited = false;
    this.exitError = null;
    /** 分段计时：每一项 { label, at }，用于定位延迟到底花在哪。 */
    this.timeline = [];
    if (!this.codexCli) throw new Error('找不到 codex.exe，请设置 CODEX_CLI 环境变量');
  }

  /** 打一个时间点（相对进程启动的毫秒数）。 */
  mark(label) {
    this.timeline.push({ label, at: this.t0 ? Date.now() - this.t0 : 0, ts: Date.now() });
    return this;
  }

  /** 返回相邻时间点的间隔，便于直接读数。 */
  timelineReport() {
    const out = [];
    for (let i = 0; i < this.timeline.length; i++) {
      const cur = this.timeline[i];
      const prev = this.timeline[i - 1];
      out.push({ label: cur.label, at: cur.at, delta: prev ? cur.at - prev.at : cur.at });
    }
    return out;
  }

  async start() {
    this.t0 = Date.now();
    this.mark('start');
    this.proc = spawn(this.codexCli, ['app-server'], {
      cwd: this.cwd,
      env: { ...process.env, CODEX_HOME, ...this.extraEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.mark('spawned');

    this.proc.on('error', (e) => this.#failAll(e));
    this.proc.on('exit', (code, sig) => {
      this.exited = true;
      this.exitError = new Error(`codex app-server 退出 code=${code} sig=${sig}`);
      this.#failAll(this.exitError);
      for (const h of this.exitHandlers) {
        try {
          h(this.exitError);
        } catch {}
      }
    });

    let stderrBuf = '';
    this.proc.stderr.on('data', (b) => {
      stderrBuf += b.toString();
      if (DEBUG) process.stderr.write('[codex:err] ' + b.toString());
    });
    this.stderrText = () => stderrBuf;

    this.rl = readline.createInterface({ input: this.proc.stdout });
    this.rl.on('line', (line) => this.#onLine(line));

    await this.request('initialize', {
      clientInfo: { name: 'dsh_codex_bridge', title: 'DSH ↔ Codex Bridge', version: '1.0.0' },
      capabilities: { experimentalApi: true },
    });
    this.mark('initialized');
    this.notify('initialized', {});
  }

  get alive() {
    return !!this.proc && this.proc.exitCode === null && !this.exitError;
  }

  #onLine(line) {
    const s = line.trim();
    if (!s) return;
    if (DEBUG) process.stderr.write('[codex:out] ' + s + '\n');
    let msg;
    try {
      msg = JSON.parse(s);
    } catch {
      return;
    }

    if (msg.id !== undefined && msg.id !== null && (msg.result !== undefined || msg.error !== undefined)) {
      const p = this.pending.get(msg.id);
      if (p) {
        this.pending.delete(msg.id);
        if (msg.error) p.reject(new Error(`JSON-RPC ${msg.error.code}: ${msg.error.message}`));
        else p.resolve(msg.result);
      }
      return;
    }

    if (msg.id !== undefined && msg.method) {
      this.#handleServerRequest(msg);
      return;
    }

    if (msg.method) {
      for (const h of this.handlers) {
        try {
          h(msg.method, msg.params || {});
        } catch {}
      }
    }
  }

  #handleServerRequest(msg) {
    for (const h of this.serverReqHandlers) {
      try {
        const res = h(msg.method, msg.params || {});
        if (res !== undefined) {
          this.proc.stdin.write(JSON.stringify({ id: msg.id, result: res }) + '\n');
          return;
        }
      } catch {}
    }
    this.proc.stdin.write(
      JSON.stringify({ id: msg.id, error: { code: -32601, message: `bridge: unsupported ${msg.method}` } }) + '\n',
    );
  }

  request(method, params, timeoutMs = 120000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`请求超时 ${method} (${timeoutMs}ms)`));
      }, timeoutMs);
      this.pending.set(id, {
        sentAt: Date.now(),
        method,
        resolve: (v) => {
          clearTimeout(timer);
          this.mark(`resp:${method}`);
          resolve(v);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      try {
        this.proc.stdin.write(JSON.stringify({ id, method, params: params || {} }) + '\n');
      } catch (e) {
        this.pending.delete(id);
        clearTimeout(timer);
        reject(e);
      }
    });
  }

  notify(method, params) {
    try {
      this.proc.stdin.write(JSON.stringify({ method, params: params || {} }) + '\n');
    } catch {}
  }

  onNotification(fn) {
    this.handlers.add(fn);
    return () => this.handlers.delete(fn);
  }

  onServerRequest(fn) {
    this.serverReqHandlers.add(fn);
  }

  /** 订阅子进程退出。若已经退出，立即回调一次（避免错过早退事件）。 */
  onExit(fn) {
    this.exitHandlers.add(fn);
    if (this.exited) {
      try {
        fn(this.exitError);
      } catch {}
    }
    return () => this.exitHandlers.delete(fn);
  }

  #failAll(e) {
    for (const [, p] of this.pending) p.reject(e);
    this.pending.clear();
  }

  stop() {
    try {
      this.rl?.close();
    } catch {}
    try {
      this.proc?.stdin.end();
    } catch {}
    // 杀整棵进程树：只 kill 顶层可能留下 codex 派生的子进程。
    const p = this.proc;
    if (!p || p.exitCode !== null || p.killed) return;
    try {
      if (process.platform === 'win32' && p.pid) {
        spawn('taskkill', ['/pid', String(p.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
      } else {
        p.kill('SIGKILL');
      }
    } catch {
      try {
        p.kill();
      } catch {}
    }
  }
}

// ------------------------------------------------------------- 一轮对话

/**
 * 发一轮对话。
 * @returns {Promise<{threadId, turnId, text, usage, items, turn}>}
 */
export async function askTurn({
  prompt,
  threadId,
  cwd,
  model,
  sandbox = 'danger-full-access',
  approvalPolicy = 'never',
  /** 每轮推理强度覆盖（minimal/low/medium/high）——降低 TTFT 的主要旋钮。 */
  effort,
  timeoutMs = 600000,
  stream,
  onDelta,
  onThread,
  signal,
  codexCli,
  /** 透传给 thread/start 的 config 覆盖（例如精简工具/插件以缩小输入）。 */
  threadConfig,
  /** 进度事件方向标记：'dsh' 表示由 DSH 侧发起。 */
  side = 'dsh',
  /** 测试用注入点：允许外部提供 AppServer 实例，从而精确拿到本次 spawn 的 PID。
   *  默认 null → 走真实实现；不影响生产路径。 */
  serverFactory = null,
  /** 每个调用方包一层防递归：返回子进程应带的环境增量。 */
  wrapEnv,
}) {
  const srv = serverFactory
    ? serverFactory({ cwd, model, codexCli, extraEnv: wrapEnv ? wrapEnv(process.env) : undefined })
    : new AppServer({ cwd, model, codexCli, extraEnv: wrapEnv ? wrapEnv(process.env) : undefined });
  let turnTimer = null;
  let liveThreadId=threadId||null, liveTurnId=null;
  // 桥接会话属于助手内部往来，完成、失败或取消后都自动归档。
  // 保留 threadId 和完整历史，供下一轮程序续接。
  const visibility = { archived: false };
  // 进度上报包一层：任何异常都不能影响主流程
  const report = (phase, data) => {
    try {
      progress(phase, { callId, side, promptChars: prompt?.length ?? 0, ...data });
    } catch {}
  };

  // 本 CLI 无交互审批界面：不代替用户授权，一律 decline。
  srv.onServerRequest((method) => {
    if (method === 'item/commandExecution/requestApproval' || method === 'item/fileChange/requestApproval') {
      report('approval-declined', { method });
      return { decision: 'decline' };
    }
    if (/requestUserInput/i.test(method)) return { answers: {} };
    if (/elicitation/i.test(method)) return { action: 'decline', content: null };
    return undefined;
  });

  let text = '';
  const items = [];
  let usage = null;
  let tokenUsage = null;
  let turnDone = null;
  let startedTurnId = null;
  let firstDeltaAt = null;
  // 提到函数作用域：进度事件可能在 thread 建立前触发，
  // 若在 try 内用 let 声明会命中暂时性死区（实测 ReferenceError）。
  let tid = threadId || null;
  // 本次调用的关联 id：让进度事件可以按调用聚合
  const callId = `${side}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));

  srv.onNotification((method, params) => {
    if (method === 'item/agentMessage/delta') {
      const d = params.delta ?? params.text ?? '';
      if (d) {
        if (firstDeltaAt === null) {
          firstDeltaAt = Date.now();
          srv.mark('first-delta');
          report('first-delta', { threadId: tid, turnId: startedTurnId });
        }
        text += d;
        onDelta?.(d);
        if (stream) process.stdout.write(d);
      }
    } else if (method === 'item/completed') {
      items.push(params.item || params);
    } else if (method === 'thread/tokenUsage/updated') {
      tokenUsage = params.tokenUsage || params.usage || params;
    } else if (method === 'turn/completed') {
      usage = params.usage || params.turn?.usage || null;
      turnDone = params.turn || params;
      srv.mark('turn-completed');
      report('turn-done', { status: turnDone?.status, durationMs: turnDone?.durationMs });
      resolveDone();
    } else if (method === 'turn/started') {
      startedTurnId = params.turn?.id || params.turnId || null;
      srv.mark('turn-started');
      report('turn-started', { turnId: startedTurnId });
    }
  });

  try {
    if(signal?.aborted)throw new Error('task cancelled');
    await srv.start();
    report('spawned', { codex: path.basename(srv.codexCli || '') });

    if (!tid) {
      const r = await srv.request('thread/start', {
        cwd: cwd || process.cwd(),
        ...(model ? { model } : {}),
        approvalPolicy,
        sandbox,
        ...(threadConfig ? { config: threadConfig } : {}),
      });
      srv.mark('thread-started');
      tid = r?.thread?.id || r?.threadId;
      if (!tid) throw new Error('thread/start 未返回 thread id');
      report('thread-started', { threadId: tid });
    } else {
      const resumeParams = { threadId: tid, cwd: cwd || process.cwd() };
      try {
        await srv.request('thread/resume', resumeParams);
      } catch (e) {
        if (!/is archived/i.test(String(e?.message || e))) throw e;
        await srv.request('thread/unarchive', { threadId: tid });
        await srv.request('thread/resume', resumeParams);
      }
      srv.mark('thread-resumed');
    }

    liveThreadId=tid;
    onThread?.(tid);
    if(signal?.aborted)throw new Error('task cancelled');
    // 续接时也必须把本轮策略传给服务端：只传 threadId 会让
    // --model / --sandbox / --effort 在续接场景下被静默忽略。
    const turnParams = {
      threadId: tid,
      input: [{ type: 'text', text: prompt }],
      approvalPolicy,
      sandboxPolicy: sandbox === 'read-only' ? { type: 'readOnly' } : { type: 'dangerFullAccess' },
      ...(model ? { model } : {}),
      ...(effort ? { effort } : {}),
    };
    const turnStart = await srv.request('turn/start', turnParams, Math.min(timeoutMs, 120000));
    srv.mark('turn-start-accepted');
    const turnId = turnStart?.turn?.id || startedTurnId || null;
    liveTurnId=turnId;

    // 单结算路径：无论完成、超时还是子进程退出，只能有一个结果生效。
    // 之前的写法有竞态——超时回调里等 turn/interrupt 时，若同时收到
    // turn/completed，done.then 会先 resolve，超时的 reject 就失效了。
    await new Promise((resolve, reject) => {
      let settled = false;
      let timedOut = false;
      let guard = null;
      const settle = (fn, arg) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort',abort);
        if (guard) clearTimeout(guard);
        clearTimeout(turnTimer);
        fn(arg);
      };

      const abort=()=>settle(reject,new Error('task cancelled'));
      signal?.addEventListener('abort',abort,{once:true});
      if(signal?.aborted){abort();return;}

      turnTimer = setTimeout(async () => {
        if (settled) return;
        timedOut = true;
        report('turn-timeout', { timeoutMs, turnId });
        // 超时不硬杀：先优雅中断该 turn，再等它落地
        try {
          if (turnId) await srv.request('turn/interrupt', { threadId: tid, turnId }, 15000);
        } catch {}
        if (settled) return; // 中断期间已完成
        guard = setTimeout(
          () => settle(reject, new Error(`turn 超时且中断未落地 (${timeoutMs}ms)`)),
          20000,
        );
      }, timeoutMs);

      done.then(() => {
        if (timedOut) settle(reject, new Error(`turn 超时已中断 (${timeoutMs}ms)`));
        else settle(resolve);
      });

      // 子进程在 turn 进行中意外退出：立刻失败，不要挂到超时。
      srv.onExit(() => {
        report('agent-exit', { turnId });
        settle(reject, new Error(`codex app-server 在 turn 进行中退出`));
      });
    });

    if (turnDone?.status !== 'completed') {
      throw new Error(`turn ${turnDone?.status || 'unknown'}: ${turnDone?.error?.message || '未成功完成'}`);
    }

    // final_answer 优先；否则取最后一条 agentMessage；再否则用流式累积
    const messages = items.filter((it) => it?.type === 'agentMessage' && typeof it.text === 'string');
    const finals = messages.filter((it) => it.phase === 'final_answer');
    if (finals.length) text = finals.map((it) => it.text).join('\n');
    else if (messages.length) text = messages.at(-1).text;

    return {
      threadId: tid,
      turnId,
      text,
      usage: usage || tokenUsage,
      tokenUsage,
      items,
      turn: turnDone,
      timeline: srv.timelineReport(),
      visibility,
    };
  } catch (e) {
    e.threadId=liveThreadId;e.turnId=liveTurnId;
    report('error', { message: String(e?.message || e), threadId: liveThreadId || null });
    throw e;
  } finally {
    if (turnTimer !== null) clearTimeout(turnTimer);
    if(signal?.aborted && liveThreadId && liveTurnId && srv.alive){try{await srv.request('turn/interrupt',{threadId:liveThreadId,turnId:liveTurnId},5000);}catch{}}
    if (tid && srv.alive) {
      try {
        await srv.request('thread/archive', { threadId: tid }, 5000);
        visibility.archived = true;
        report('thread-archived', { threadId: tid });
      } catch (e) {
        visibility.error = String(e?.message || e);
        report('archive-failed', { threadId: tid, message: visibility.error });
      }
    }
    const pid = srv.proc?.pid ?? null;
    srv.stop();
    // 区分「生成完成」与「进程回收完成」：这里报告的是回收动作已发出，
    // 并附 pid 便于外部核对是否真的消失。
    report('cleanup-requested', {
      pid,
      threadId: liveThreadId || (tid ?? threadId) || null,
      // 显式 wall-clock：外部验收要以同一时基计算"从发出清理到进程消失"的延迟
      wallClockMs: Date.now(),
    });
  }
}

/** 握手自检（不发起对话、不消耗额度）。 */
export async function health({ cwd, codexCli } = {}) {
  const srv = new AppServer({ cwd, codexCli });
  const t0 = Date.now();
  try {
    await srv.start();
    const handshakeMs = Date.now() - t0;
    let account = null;
    try {
      account = await srv.request('account/read', { refreshToken: false });
    } catch (e) {
      account = { error: String(e.message) };
    }
    return { ok: true, codex: srv.codexCli, codexHome: CODEX_HOME, handshakeMs, account };
  } finally {
    srv.stop();
  }
}
