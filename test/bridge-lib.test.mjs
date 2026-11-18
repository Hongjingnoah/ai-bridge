// 桥接库回归测试：防递归、版本探测不写死、子进程早退快速失败
// 运行: node --test work/bridge-lib.test.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { test } from 'node:test';

const LIB_SRC = fs.readFileSync(new URL('../lib/appserver.mjs', import.meta.url), 'utf8');

/**
 * 把库体加载进一个沙箱，替换 spawn / readline，避免真实起进程、消耗额度。
 * exitAfterStart: 模拟子进程在握手完成前意外退出。
 */
async function loadLib({ exitAfterStart = false } = {}) {
  const body = LIB_SRC.replace(/^import .*;\r?\n/gm, '').replace(/^export /gm, '');

  const fakeSpawn = () => {
    const proc = new EventEmitter();
    proc.stdin = { write() {}, end() {} };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.exitCode = null;
    proc.kill = () => {};
    if (exitAfterStart) {
      setTimeout(() => {
        proc.exitCode = 1;
        proc.emit('exit', 1, null);
      }, 5);
    }
    return proc;
  };

  const fakeReadline = { createInterface: () => ({ on() {}, close() {} }) };

  const factory = new (Object.getPrototypeOf(async function () {}).constructor)(
    'fs',
    'os',
    'path',
    'readline',
    'process',
    'setTimeout',
    'clearTimeout',
    'spawn',
    body + '\nreturn { DEPTH_ENV, bridgeDepth, assertDepth, AppServer };',
  );

  return await factory(fs, os, path, fakeReadline, process, setTimeout, clearTimeout, fakeSpawn);
}

test('bridgeDepth 稳健解析环境变量', async () => {
  const lib = await loadLib();
  assert.equal(lib.bridgeDepth({}), 0, '缺省应为 0');
  assert.equal(lib.bridgeDepth({ AI_BRIDGE_DEPTH: '3' }), 3);
  assert.equal(lib.bridgeDepth({ AI_BRIDGE_DEPTH: 'abc' }), 0, '非数字应回落到 0');
  assert.equal(lib.bridgeDepth({ AI_BRIDGE_DEPTH: '-2' }), 0, '负数应回落到 0');
});

test('assertDepth 到上限必须拒绝，并带可识别错误码', async () => {
  const lib = await loadLib();
  assert.equal(lib.assertDepth(2, { AI_BRIDGE_DEPTH: '0' }), 0);
  assert.equal(lib.assertDepth(2, { AI_BRIDGE_DEPTH: '1' }), 1);
  let err = null;
  try {
    lib.assertDepth(2, { AI_BRIDGE_DEPTH: '2' });
  } catch (e) {
    err = e;
  }
  assert.ok(err, '深度到上限时应抛错');
  assert.equal(err.code, 'BRIDGE_RECURSION_LIMIT');
  assert.equal(err.depth, 2);
});

test('codex 探测不写死版本 hash 目录', () => {
  assert.ok(
    !/Codex[\\/]+bin[\\/]+[0-9a-f]{12,}/i.test(LIB_SRC),
    '不应把某个版本 hash 目录写死在源码里',
  );
  assert.ok(/readdirSync\(\s*root/.test(LIB_SRC), '应扫描 bin 下的目录来发现版本');
});

test('子进程握手完成前退出：请求快速失败，而不是挂到超时', async () => {
  const lib = await loadLib({ exitAfterStart: true });
  const srv = new lib.AppServer({ cwd: process.cwd(), codexCli: process.execPath });
  const t0 = Date.now();
  await assert.rejects(
    async () => {
      await srv.start();
      await srv.request('thread/start', {}, 30000);
    },
    (e) => /退出|exit/i.test(String(e.message)),
  );
  const ms = Date.now() - t0;
  assert.ok(ms < 5000, `应快速失败（实测 ${ms}ms），不应等到 30s 超时`);
  srv.stop();
});
