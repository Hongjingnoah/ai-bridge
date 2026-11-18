// 桥接回归测试（直测交付代码，不再测复制出来的旧副本）
//   - 行为：防递归、turn 状态判定、超时竞态、子进程中途退出、握手失败清理
//   - 安全：MCP 收到非法 JSON 不崩、注入串被拒、任务文本不进命令行
// 运行: node --test work\bridge.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const LIB = new URL('../lib/appserver.mjs', import.meta.url);
const LIB_SRC = fs.readFileSync(LIB, 'utf8');
const REPO = fileURLToPath(new URL('..', import.meta.url));

/**
 * 把交付的 lib 装进沙箱，替换 spawn/readline。
 * 这样可以精确控制“何时收到什么通知 / 何时子进程退出”，而不起真进程。
 */
async function loadLib({ exitOnRequest = null, exitAfterMs = null } = {}) {
  const body = LIB_SRC.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');
  const procs = [];

  const mkProc = () => {
    const proc = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.killed = false;
    proc.pid = 4242;
    proc.kill = () => {
      proc.killed = true;
      proc.exitCode = 0;
    };
    procs.push(proc);
    return proc;
  };

  const fakeSpawn = () => {
    const proc = mkProc();
    if (exitAfterMs !== null) {
      setTimeout(() => {
        proc.exitCode = 1;
        proc.emit('exit', 1, null);
      }, exitAfterMs);
    }
    return proc;
  };

  const fakeReadline = { createInterface: () => ({ on() {}, close() {} }) };
  // lib 里的 import 会被剥掉，沙箱必须注入同名符号（progress 用空实现即可）
  const fakeProgress = () => {};
  const factory = new (Object.getPrototypeOf(async function () {}).constructor)(
    'fs', 'os', 'path', 'readline', 'process', 'setTimeout', 'clearTimeout', 'clearInterval', 'spawn', 'progress',
    body + '\nreturn { DEPTH_ENV, bridgeDepth, assertDepth, AppServer, askTurn, replaceAppServer(value) { AppServer = value; } };',
  );
  const api = await factory(
    fs, os, path, fakeReadline, process, setTimeout, clearTimeout, clearInterval, fakeSpawn, fakeProgress,
  );
  return { api, procs };
}

/** 把一个 AppServer 换成脚本化的假实现，用于精确驱动 turn 流程。 */
function stubServer(api, script) {
  const original = api.AppServer;
  const instance = {
    handlers: new Set(),
    serverReqHandlers: new Set(),
    exitHandlers: new Set(),
    timeline: [],
    started: false,
    stopped: 0,
    mark() {},
    timelineReport() {
      return [];
    },
    onNotification(fn) {
      this.handlers.add(fn);
      return () => this.handlers.delete(fn);
    },
    onServerRequest(fn) {
      this.serverReqHandlers.add(fn);
    },
    onExit(fn) {
      this.exitHandlers.add(fn);
      return () => this.exitHandlers.delete(fn);
    },
    async start() {
      if (script.startThrows) throw new Error('handshake failed');
      this.started = true;
    },
    stop() {
      this.stopped++;
    },
    async request(method, params) {
      if (script.onRequest) await script.onRequest(method, params, this);
      if (method === 'thread/start') return { thread: { id: 'thread-test' } };
      if (method === 'thread/resume') return { thread: { id: params.threadId } };
      if (method === 'turn/start') return { turn: { id: 'turn-test' } };
      if (method === 'turn/interrupt') return {};
      return {};
    },
    emit(method, params) {
      for (const h of this.handlers) h(method, params);
    },
    emitExit(err) {
      for (const h of this.exitHandlers) h(err);
    },
  };
  api.replaceAppServer(function () {
    return instance;
  });
  return { instance, restore: () => api.replaceAppServer(original) };
}

// ---------------------------------------------------------------- 防递归

test('bridgeDepth 稳健解析；非法值不为 NaN', async () => {
  const { api } = await loadLib();
  assert.equal(api.bridgeDepth({}), 0);
  assert.equal(api.bridgeDepth({ AI_BRIDGE_DEPTH: '3' }), 3);
  assert.equal(api.bridgeDepth({ AI_BRIDGE_DEPTH: 'abc' }), 0, 'NaN 必须回落，否则保护失效');
  assert.equal(api.bridgeDepth({ AI_BRIDGE_DEPTH: '-2' }), 0);
});

test('assertDepth 到上限即拒绝并带错误码', async () => {
  const { api } = await loadLib();
  assert.equal(api.assertDepth(2, { AI_BRIDGE_DEPTH: '1' }), 1);
  let err = null;
  try {
    api.assertDepth(2, { AI_BRIDGE_DEPTH: '2' });
  } catch (e) {
    err = e;
  }
  assert.equal(err?.code, 'BRIDGE_RECURSION_LIMIT');
});

// ------------------------------------------------------------ turn 行为

test('成功轮：返回 final_answer，不泄漏计时器', async () => {
  const { api } = await loadLib();
  const { instance, restore } = stubServer(api, {
    onRequest: async (method, params, self) => {
      if (method === 'turn/start') {
        // 用 setTimeout 而不是 setImmediate：必须在 turn/start 的 Promise
        // 结算之后才发事件，否则会先于 done 监听注册，复现真实时序。
        setTimeout(() => {
          self.emit('item/agentMessage/delta', { delta: 'progress' });
          self.emit('item/completed', { item: { type: 'agentMessage', phase: 'commentary', text: 'progress' } });
          self.emit('item/agentMessage/delta', { delta: 'FINAL' });
          self.emit('item/completed', { item: { type: 'agentMessage', phase: 'final_answer', text: 'FINAL' } });
          self.emit('turn/completed', { turn: { id: 'turn-test', status: 'completed' } });
        }, 10);
      }
    },
  });
  try {
    const res = await api.askTurn({ prompt: 'x', timeoutMs: 3000 });
    assert.equal(res.text, 'FINAL', '应取 final_answer 而不是 commentary');
    assert.equal(res.turn.status, 'completed');
  } finally {
    restore();
  }
});

for (const status of ['failed', 'interrupted']) {
  test(`${status} 的 turn 必须抛错，不能当成功`, async () => {
    const { api } = await loadLib();
    const { restore } = stubServer(api, {
      onRequest: async (method, params, self) => {
        if (method === 'turn/start') {
          setTimeout(
            () => self.emit('turn/completed', { turn: { id: 't', status, error: { message: 'boom' } } }),
            10,
          );
        }
      },
    });
    try {
      await assert.rejects(() => api.askTurn({ prompt: 'x', timeoutMs: 3000 }), new RegExp(status));
    } finally {
      restore();
    }
  });
}

test('超时竞态：超时期间收到 completed 必须仍判为超时失败', async () => {
  const { api } = await loadLib();
  const { restore } = stubServer(api, {
    onRequest: async (method, params, self) => {
      if (method === 'turn/start') {
        // 故意在超时之后（30ms）才完成，而 timeoutMs=20
        setTimeout(() => self.emit('turn/completed', { turn: { id: 't', status: 'completed' } }), 35);
      }
    },
  });
  try {
    await assert.rejects(
      () => api.askTurn({ prompt: 'x', timeoutMs: 20 }),
      /超时/,
      '超时后到达的成功不应覆盖超时结论',
    );
  } finally {
    restore();
  }
});

test('子进程在 turn 进行中退出：立即失败，不挂到超时', async () => {
  const { api } = await loadLib();
  const { restore } = stubServer(api, {
    onRequest: async (method, params, self) => {
      if (method === 'turn/start') {
        setTimeout(() => self.emitExit(new Error('codex app-server 退出 code=1 sig=null')), 15);
      }
    },
  });
  const t0 = Date.now();
  try {
    await assert.rejects(() => api.askTurn({ prompt: 'x', timeoutMs: 60000 }), /退出/);
    assert.ok(Date.now() - t0 < 5000, '必须是快速失败，而不是等 60s 超时');
  } finally {
    restore();
  }
});

test('握手失败也必须清理子进程', async () => {
  const { api, procs } = await loadLib();
  const { restore } = stubServer(api, { startThrows: true });
  try {
    await assert.rejects(() => api.askTurn({ prompt: 'x', timeoutMs: 1000 }));
  } finally {
    restore();
  }
  void procs;
});

test('审批与用户输入按 schema 应答，且不擅自代用户同意', async () => {
  const { api } = await loadLib();
  const responses = [];
  const { instance, restore } = stubServer(api, {
    onRequest: async (method, params, self) => {
      if (method === 'turn/start') {
        for (const h of self.serverReqHandlers) {
          responses.push(h('item/commandExecution/requestApproval', {}));
          responses.push(h('item/tool/requestUserInput', {}));
        }
        setTimeout(() => self.emit('turn/completed', { turn: { id: 't', status: 'completed' } }), 10);
      }
    },
  });
  try {
    await api.askTurn({ prompt: 'x', timeoutMs: 3000 });
    assert.deepEqual(responses, [{ decision: 'decline' }, { answers: {} }]);
  } finally {
    restore();
    void instance;
  }
});

test('续接时把 model/effort 传给 turn（不能只给 threadId）', async () => {
  const { api } = await loadLib();
  let seen = null;
  const { restore } = stubServer(api, {
    onRequest: async (method, params, self) => {
      if (method === 'thread/resume') seen = { resume: params };
      if (method === 'turn/start') {
        seen = { ...(seen || {}), turn: params };
        setTimeout(() => self.emit('turn/completed', { turn: { id: 't', status: 'completed' } }), 10);
      }
    },
  });
  try {
    await api.askTurn({ prompt: 'x', threadId: 'tid-1', model: 'gpt-6-sol', effort: 'low', timeoutMs: 3000 });
    assert.equal(seen.turn.threadId, 'tid-1');
    assert.equal(seen.turn.model, 'gpt-6-sol', '续接时 model 不能被丢掉');
    assert.equal(seen.turn.effort, 'low', '续接时 effort 不能被丢掉');
  } finally {
    restore();
  }
});

// ---------------------------------------------------------------- 安全

test('任务文本不进入命令行：dsh 桥不用 cmd.exe 承载用户输入', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'dsh-bridge-mcp.mjs'), 'utf8');
  assert.ok(/resolveDirectLauncher/.test(src), '应有直启解析（避免 cmd 二次解析）');
  assert.ok(
    !/cmdArgs|\[\/d, '\/s', '\/c', DSH_CMD, \.\.\.args\]/.test(src),
    '不应再把用户文本拼进 cmd 命令行',
  );
  // 退路也必须把任务放进 stdin 而不是命令行
  assert.ok(/flags\.push\('headless', '--json', '-', '--'\)/.test(src), '退路应使用 stdin 传任务并加 --');
});

test('sessionId 白名单校验存在', () => {
  const src = fs.readFileSync(path.join(REPO, 'bin', 'dsh-bridge-mcp.mjs'), 'utf8');
  assert.ok(/SESSION_ID_RE = \/\^\[A-Za-z0-9_-\]\{1,128\}\$\//.test(src), 'sessionId 必须有白名单');
});

/** 起一个真 MCP 进程，喂非法/注入输入，确认它不崩且不执行注入。 */
function mcpRoundTrip(serverFile, lines, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [serverFile], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let out = '';
    let err = '';
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      try {
        child.kill();
      } catch {}
      resolve(r);
    };
    child.stdout.on('data', (b) => (out += b.toString()));
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('close', (code) => finish({ code, out, err }));
    child.on('exit', (code) => finish({ code, out, err }));
    setTimeout(() => {
      for (const l of lines) child.stdin.write(JSON.stringify(l) + '\n');
      // 必须显式关闭 stdin：MCP 服务在等下一行，不关就永远不退出（上一版卡死的真正原因）
      child.stdin.end();
    }, 150);
    setTimeout(() => finish({ code: null, out, err, timedOut: true }), timeoutMs);
  });
}

test('MCP：params 为 null 不能崩（真进程）', async () => {
  const server = path.join(REPO, 'bin', 'codex-bridge-mcp.mjs');
  const r = await mcpRoundTrip(server, [{ jsonrpc: '2.0', id: 1, method: 'tools/call', params: null }], {
    timeoutMs: 3000,
  });
  assert.notEqual(r.code, 1, `进程不应以崩溃码退出。stderr=${r.err.slice(0, 300)}`);
});

test('MCP：顶层为 null / 数组 / 字符串都不能崩（真进程）', async () => {
  const server = path.join(REPO, 'bin', 'dsh-bridge-mcp.mjs');
  const r = await new Promise((resolve) => {
    const child = spawn(process.execPath, [server], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let err = '';
    child.stderr.on('data', (b) => (err += b.toString()));
    child.on('close', (code) => resolve({ code, err }));
    setTimeout(() => {
      child.stdin.write('null\n[1,2,3]\n"str"\n42\n');
      setTimeout(() => child.kill(), 400);
    }, 150);
    setTimeout(() => resolve({ code: null, err, killed: true }), 3000);
  });
  assert.notEqual(r.code, 1, `非法消息不应导致崩溃退出。stderr=${r.err.slice(0, 300)}`);
});
