// aidcp:test-owner=derived
/**
 * 启动外壳的形状闸（change deploy-derived-services-to-dev，任务 2.3 / 2.4）。
 *
 * ① **公共出口不得承载启动副作用**——按正向写（出口只许出现在白名单里）。反向写法
 *    （「找不到 server.js 就算过」）在有人新增一个组装根文件时默认全绿。
 * ② **「未注册」与「已注册且空闲」MUST NOT 同形**：跨进程打到一条没注册的路由拿到的是 404，
 *    而 404 会被调用方读成「对面版本落后」——本仓已经为这件事连撞过多次。
 * ③ **先监听后注册**：本进程装配很长，监听若排在最后，这段时间里「还在初始化」与「进程死了」
 *    从外面完全同形。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { formatContentCapabilityRoster } from '../../src/server.js';

/** 本仓愿意被别人 import 的能力面。加一行 = 一次显式判断。 */
const ALLOWED_PUBLIC_EXPORTS = new Set([
  './llm/index.js',
  './publish-agent/index.js',
  './render/index.js',
  './cache/concept-store.js',
  './cache/curated-content-store.js',
  './metrics/token-usage-store.js',
  './storage/object-store.js',
]);

test('公共出口只列能力面：组装根与可执行入口 MUST NOT 在其中', async () => {
  const source = await readFile(new URL('../../src/index.ts', import.meta.url), 'utf8');
  const exported = [...source.matchAll(/export\s+\*\s+from\s+'([^']+)'/g)].map((m) => m[1]);
  assert.ok(exported.length > 0, 'index.ts 一条出口都没有，断言本身就该被质疑');
  for (const spec of exported) {
    assert.ok(
      ALLOWED_PUBLIC_EXPORTS.has(spec),
      `index.ts 出口了未经判断的模块：${spec}。`
        + '若它确实是能力面，把它加进本用例的白名单；若它是组装根或入口，'
        + 'import 本包就会顺带把装配（建池 / 起监听 / 注册退出钩子）拉起来。',
    );
  }
});

test('能力缺席在日志里具名说出，且与「已注册」不同形', () => {
  const text = formatContentCapabilityRoster([
    { name: 'persona-generator', registered: true },
    {
      name: 'facebook-publish-media-authority',
      registered: false,
      reason: 'FacebookPublishMediaStore 不可用',
    },
  ]);
  assert.match(text, /已注册=persona-generator/);
  assert.match(text, /未注册=facebook-publish-media-authority（FacebookPublishMediaStore 不可用）/);
  const registeredSide = text.slice(0, text.indexOf('；未注册='));
  assert.ok(!registeredSide.includes('facebook-publish-media-authority'));
});

test('全部就位时「未注册」明确答「无」', () => {
  const text = formatContentCapabilityRoster([{ name: 'persona-generator', registered: true }]);
  assert.match(text, /未注册=无/);
});

test('先监听、后注册业务路由：顺序倒过来时「还在初始化」与「进程死了」同形', async () => {
  const source = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const service = source.slice(source.indexOf('export async function startContentService('));
  const listen = service.indexOf('await httpServer.listen(');
  const firstBusinessRoute = service.indexOf("registerCapability('persona-generator'");
  assert.ok(listen >= 0, '找不到监听那一句');
  assert.ok(firstBusinessRoute > listen, '业务路由 MUST 注册在监听之后（探活口先可达）');
  // 探活口自己必须在 listen 之前注册，否则监听起来了也没人答得上。
  const readiness = service.indexOf('CONTENT_READINESS_ROUTE');
  assert.ok(readiness >= 0 && readiness < listen, '探活路由 MUST 在监听之前注册');
});
