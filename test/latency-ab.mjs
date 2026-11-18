// 延迟 A/B：对“首个 token 时间(TTFT)”做参数对照 —— 找出能真正砍延迟的开关。
// 一次进程内起一个 app-server，复用连接，只改每轮的 effort/model，避免握手开销污染读数。
import fs from 'node:fs';
import path from 'node:path';
import { AppServer } from '../lib/appserver.mjs';

const CWD = process.cwd();
const PROMPT = '只回复两个字：收到';

const VARIANTS = [
  { label: '基线（现状：medium effort）', effort: null },
  { label: 'effort=low', effort: 'low' },
  { label: 'effort=minimal', effort: 'minimal' },
];

const results = [];

const srv = new AppServer({ cwd: CWD });
await srv.start();

try {
for (const v of VARIANTS) {
  const items = [];
  let firstDeltaAt = null;
  const t0 = Date.now();
  let usage = null;
  let completedTurn = null;
  let timer = null;
  let failure = null;
  let resolveDone;
  const done = new Promise((r) => (resolveDone = r));
  const turnStartedAt = { t: null };

  const off = srv.onNotification((method, params) => {
    if (method === 'turn/started') turnStartedAt.t = Date.now();
    else if (method === 'item/agentMessage/delta') {
      if (typeof params.delta === 'string' && params.delta.length && firstDeltaAt === null) firstDeltaAt = Date.now();
    } else if (method === 'item/completed') {
      items.push(params.item || params);
    } else if (method === 'thread/tokenUsage/updated') {
      usage = params.tokenUsage || params.usage || null;
    } else if (method === 'turn/completed') {
      completedTurn = params.turn || params;
      usage = params.usage || params.turn?.usage || usage;
      resolveDone();
    }
  });

  const th = await srv.request('thread/start', { cwd: CWD, approvalPolicy: 'never', sandbox: 'danger-full-access' });
  const tid = th?.thread?.id;
  const turnParams = { threadId: tid, input: [{ type: 'text', text: PROMPT }] };
  if (v.effort) turnParams.effort = v.effort;

  const acceptedAt = Date.now();
  try {
    await srv.request('turn/start', turnParams, 120000);
    await Promise.race([done, new Promise((_, rj) => { timer = setTimeout(() => rj(new Error('timeout')), 180000); })]);
  } catch (error) {
    failure = error.message;
  } finally {
    if (timer !== null) clearTimeout(timer);
    off();
  }

  const messages = items.filter((i) => i.type === 'agentMessage');
  const text = messages.filter((i) => i.phase === 'final_answer').at(-1)?.text ?? messages.at(-1)?.text ?? null;
  const ok = !failure && completedTurn?.status === 'completed' && text?.trim() === '收到';
  const rec = {
    label: v.label,
    effort: v.effort,
    setupMs: acceptedAt - t0,
    ok,
    status: completedTurn?.status || 'request_failed',
    error: failure || completedTurn?.error?.message || (!ok ? '未得到要求的完整回答' : null),
    ttftMs: ok && firstDeltaAt !== null ? firstDeltaAt - (turnStartedAt.t ?? acceptedAt) : null,
    totalMs: Date.now() - t0,
    answer: text,
    inputTokens: usage?.total?.inputTokens ?? null,
    cachedTokens: usage?.total?.cachedInputTokens ?? null,
    reasoningTokens: usage?.total?.reasoningOutputTokens ?? null,
  };
  results.push(rec);
  console.log(JSON.stringify(rec));
}

} finally {
srv.stop();
}
fs.writeFileSync(path.join(import.meta.dirname, 'latency-ab.json'), JSON.stringify(results, null, 2));
console.log('\n=== A/B 汇总（TTFT 越小越好）===');
for (const r of results) {
  if (!r.ok) console.log(`无效样本，不参与速度比较 | ${r.label} | ${r.error}`);
  else console.log(`${String(r.ttftMs).padStart(6)}ms TTFT | ${String(r.totalMs).padStart(6)}ms 总 | ${r.label}`);
}
console.log('每个参数仅一个样本，不足以证明稳定提速；请增加交错重复测试。');
