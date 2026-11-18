// 延迟 A/B（修正版）：只认 item/agentMessage/delta 作为“首个 token”，
// 每轮检查 turn 状态，并清理计时器。修掉上一版把任意 item.completed 当首 token 的错误。
import fs from 'node:fs';
import path from 'node:path';
import { AppServer } from '../lib/appserver.mjs';

const CWD = process.cwd();
const PROMPT = '只回复两个字：收到';
const REPEAT = Number.parseInt(process.argv[2] || '3', 10);

// 由 model/list 实测得到：gpt-6.1-sol 支持 low/medium/high/xhigh/max/ultra（无 minimal）
const VARIANTS = [
  { label: 'gpt-6.1-sol / low（模型默认档）', model: 'gpt-6.1-sol', effort: 'low' },
  { label: 'gpt-6.1-sol / medium（本机现配置）', model: 'gpt-6.1-sol', effort: 'medium' },
  { label: 'gpt-6-sol / low（另一模型）', model: 'gpt-6-sol', effort: 'low' },
];

const srv = new AppServer({ cwd: CWD });
await srv.start();

const rows = [];
try {
for (const v of VARIANTS) {
  for (let i = 0; i < REPEAT; i++) {
    let firstDeltaAt = null;
    let turnStartedAt = null;
    let turnDone = null;
    let usage = null;
    let text = '';
    const items = [];
    let resolveDone;
    const done = new Promise((r) => (resolveDone = r));

    const off = srv.onNotification((method, params) => {
      if (method === 'turn/started') turnStartedAt = Date.now();
      else if (method === 'item/agentMessage/delta') {
        // 唯一认定的“首个 token”
        if (typeof params.delta === 'string' && params.delta.length && firstDeltaAt === null) firstDeltaAt = Date.now();
        text += params.delta ?? '';
      } else if (method === 'item/completed') items.push(params.item || params);
      else if (method === 'thread/tokenUsage/updated') usage = params.tokenUsage || usage;
      else if (method === 'turn/completed') {
        turnDone = params.turn || params;
        if (!usage) usage = params.usage || usage;
        resolveDone();
      }
    });

    const th = await srv.request('thread/start', {
      cwd: CWD,
      model: v.model,
      approvalPolicy: 'never',
      sandbox: 'danger-full-access',
    });
    const tid = th?.thread?.id;
    const t0 = Date.now();
    await srv.request('turn/start', {
      threadId: tid,
      model: v.model,
      effort: v.effort,
      input: [{ type: 'text', text: PROMPT }],
      approvalPolicy: 'never',
      sandboxPolicy: { type: 'dangerFullAccess' },
    }, 120000);

    let timer = null;
    try {
      await Promise.race([done, new Promise((_, rj) => { timer = setTimeout(() => rj(new Error('timeout')), 180000); })]);
    } finally {
      if (timer !== null) clearTimeout(timer);
      off();
    }

    const finalText = items.filter((x) => x.type === 'agentMessage' && x.phase === 'final_answer').at(-1)?.text
      ?? items.filter((x) => x.type === 'agentMessage').at(-1)?.text
      ?? text;
    rows.push({
      label: v.label,
      model: v.model,
      effort: v.effort,
      status: turnDone?.status ?? 'unknown',
      ttftMs: firstDeltaAt && turnStartedAt ? firstDeltaAt - turnStartedAt : null,
      totalMs: Date.now() - t0,
      answer: finalText,
      inputTokens: usage?.total?.inputTokens ?? usage?.inputTokens ?? null,
      cachedTokens: usage?.total?.cachedInputTokens ?? usage?.cachedInputTokens ?? null,
      reasoningTokens: usage?.total?.reasoningOutputTokens ?? usage?.reasoningOutputTokens ?? null,
    });
    console.log(JSON.stringify(rows.at(-1)));
  }
}

} finally {
srv.stop();
}

// 汇总：按变体取 TTFT 与总耗时中位数
const byLabel = new Map();
for (const r of rows) {
  if (r.status !== 'completed' || r.answer?.trim() !== '收到') continue;
  if (!byLabel.has(r.label)) byLabel.set(r.label, []);
  byLabel.get(r.label).push(r);
}
const med = (a) => {
  const s = [...a].filter((x) => x !== null && x !== undefined).sort((x, y) => x - y);
  return s.length ? s[Math.floor(s.length / 2)] : null;
};
const summary = [...byLabel.entries()].map(([label, rs]) => ({
  label,
  n: rs.length,
  statuses: [...new Set(rs.map((r) => r.status))],
  ttftMedian: med(rs.map((r) => r.ttftMs)),
  totalMedian: med(rs.map((r) => r.totalMs)),
  answers: rs.map((r) => r.answer),
  inputTokens: rs[0].inputTokens,
  cachedTokens: rs[0].cachedTokens,
}));

fs.writeFileSync(path.join(import.meta.dirname, 'latency-ab-v2.json'), JSON.stringify({ rows, summary }, null, 2));
console.log('\n=== A/B 汇总（修正版计时）===');
for (const s of summary) {
  console.log(`${String(s.ttftMedian).padStart(6)}ms TTFT中位 | ${String(s.totalMedian).padStart(6)}ms 总中位 | n=${s.n} status=${s.statuses} | ${s.label}`);
}
