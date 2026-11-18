#!/usr/bin/env node
/**
 * codex-bridge-mcp — 正向通道 MCP 封装：让 DSH（本会话）把 Codex 当原生工具调用
 *
 * 注册到 DSH profile 的 cordis.patch.yml（insert mcp-client），或直接作为
 * MCP 客户端的目标。工具内部走 Codex 官方 app-server 协议。
 *
 * 工具：
 *   codex_ask(prompt, threadId?, timeoutMs?, stream?) — 问 Codex，返回回答与 threadId
 *   codex_health()                                    — 握手/账号自检
 *
 * 长任务使用 codex_start / codex_result / codex_cancel。
 * 工具加载以客户端实际列表与调用为准；本机 DSH 已验证原生调用，无需重启宿主。
 */

import readline from 'node:readline';
import path from 'node:path';
import { askTurn, health, bridgeDepth, DEPTH_ENV } from '../lib/appserver.mjs';
import {CodexJobs} from '../lib/codex-jobs.mjs';

const SERVER_NAME = 'codex-bridge';
const SERVER_VERSION = '1.0.0';
const jobs=new CodexJobs({runner:askTurn,stateDir:path.resolve(import.meta.dirname,'../state/codex-jobs')});
const requests=new Map();
const MAX_DEPTH = (() => {
  const raw = process.env.CODEX_BRIDGE_MAX_DEPTH ?? '2';
  // NaN 会让 depth >= NaN 恒为 false，防递归静默失效 → 非法配置直接拒绝启动
  if (!/^\d+$/.test(String(raw).trim())) {
    console.error(`[codex-bridge] CODEX_BRIDGE_MAX_DEPTH 非法: ${raw}（应为非负整数）`);
    process.exit(2);
  }
  return Number.parseInt(raw, 10);
})();

const TOOLS = [
  {
    name: 'codex_ask',
    description:
      '把问题交给 Codex（本机已登录的 OpenAI Codex app-server）执行并取回答复。' +
      '适用于短问答。代码修改、审查等较长任务优先 codex_start + codex_result，助手自行获取结果后继续；用户无需传话或轮询。传 threadId 可续接。',
    inputSchema: {
      type: 'object',
      properties: {
        prompt: { type: 'string', description: '给 Codex 的完整指令。' },
        threadId: { type: 'string', description: '可选：续接已有 Codex 会话 id。' },
        cwd: { type: 'string', description: '可选：Codex 的工作目录。' },
        model: { type: 'string', description: '可选：覆盖模型。' },
        timeoutMs: { type: 'number', description: '可选：超时毫秒，默认 600000。' },
      },
      required: ['prompt'],
    },
  },
  {name:'codex_start',description:'立即派发代码执行/审查任务并返回 jobId。任务在程序后台运行，助手接着使用 codex_result 取得结果并继续，不要求用户轮询。',inputSchema:{type:'object',properties:{prompt:{type:'string'},threadId:{type:'string'},cwd:{type:'string'},model:{type:'string'},timeoutMs:{type:'number'}},required:['prompt']}},
  {name:'codex_result',description:'获取任务实际状态、进度和结果。queued/running 时可 waitMs=25000 等待；completed 时检查 result.answer 并继续自己的工作，failed/cancelled 时如需续接使用返回的 threadId。',inputSchema:{type:'object',properties:{jobId:{type:'string'},waitMs:{type:'number',maximum:25000}},required:['jobId']}},
  {name:'codex_cancel',description:'停止此桥派发的指定任务；不自动撤销已完成的文件修改。',inputSchema:{type:'object',properties:{jobId:{type:'string'}},required:['jobId']}},
  {
    name: 'codex_health',
    description: '检查 Codex app-server 握手与账号状态（不消耗额度）。',
    inputSchema: { type: 'object', properties: {} },
  },
];

async function callTool(name, args, signal) {
  if(name==='codex_result')return await jobs.result(args?.jobId,Number(args?.waitMs)||0);
  if(name==='codex_cancel')return jobs.cancel(args?.jobId);
  if (name === 'codex_health') {
    const r = await health({ cwd: args?.cwd || process.cwd() });
    return { ...r, depth: bridgeDepth() };
  }
  if (name !== 'codex_ask' && name !== 'codex_start') throw new Error(`未知工具: ${name}`);

  const a = args && typeof args === 'object' ? args : {};
  const prompt = String(a.prompt ?? '').trim();
  if (!prompt) throw new Error('prompt 不能为空');

  const depth = bridgeDepth();
  if (depth >= MAX_DEPTH) {
    return {
      ok: false,
      rejected: 'recursion_limit',
      message:
        `递归保护：桥接深度 ${depth} ≥ 上限 ${MAX_DEPTH}。Codex 与 DSH 可能在互相反复调用，已停止下钻。`,
    };
  }

  const options={
    prompt,
    threadId: args?.threadId,
    cwd: args?.cwd || process.cwd(),
    model: args?.model,
    timeoutMs: Number(args?.timeoutMs) > 0 ? Number(args.timeoutMs) : 600000,
    wrapEnv: () => ({ [DEPTH_ENV]: String(depth + 1) }),
  };
  if(name==='codex_start')return jobs.submit(options);
  if(jobs.running || jobs.queue.length)return {ok:false,rejected:'busy',message:'已有后台任务；使用 codex_result 获取结果后再派发，或用 codex_start 排队。'};
  const res = await askTurn({...options,signal});

  return {
    ok: true,
    threadId: res.threadId,
    turnId: res.turnId,
    status: res.turn?.status,
    usage: res.usage ?? null,
    answer: res.text,
  };
}

const rl = readline.createInterface({ input: process.stdin });
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\n');

rl.on('line', async (line) => {
  const s = line.trim();
  if (!s) return;
  let msg;
  try {
    msg = JSON.parse(s);
  } catch {
    return;
  }
  // 合法 JSON 也可能是 null / 数组 / 字符串：解构前先确认是对象
  if (msg === null || typeof msg !== 'object' || Array.isArray(msg)) return;
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  if(method==='notifications/cancelled'){requests.get(params.requestId)?.abort();return;}
  if (id === undefined || id === null) return;

  try {
    if (method === 'initialize') {
      send({
        id,
        result: {
          protocolVersion: params?.protocolVersion || '2024-11-05',
          capabilities: { tools: {listChanged:true} },
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
      const controller=new AbortController();requests.set(id,controller);
      let r;try{r=await callTool(params?.name, params?.arguments || {},controller.signal);}finally{requests.delete(id);}
      send({
        id,
        result: { content: [{ type: 'text', text: JSON.stringify(r, null, 2) }], isError: r?.ok === false },
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

let closing=false;
async function close(){if(closing)return;closing=true;for(const controller of requests.values())controller.abort();await jobs.close();process.exit(0);}
rl.on('close',()=>void close());
for(const sig of ['SIGTERM','SIGINT'])process.on(sig,()=>void close());
