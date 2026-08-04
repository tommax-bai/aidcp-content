// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/server.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 稿件精修在**组装根这一层**的接线闸。
 *
 * 跨进程往返本身由 `aidcp-transport` 那侧的往返测试钉（AC-REFINE-01..08），这里只钉
 * 那边看不见的四件事 —— 它们的共同点是**漏了都不报错**：
 *
 *   ① 队列路由真的被注册了。漏调注册函数的表现不是编译错误，是 api 侧收到 404，
 *      而 404 会被读成「对面版本落后」——一个本该留给版本差异的具名原因被纯接线遗漏冒名顶替。
 *   ② worker 真的被构造 + 真的有泵在转。只注册路由不起 worker，作业会一直排在 queued 上：
 *      客户端的进度条永远停在第一格，而每一层都「正常」。
 *   ③ 泵是**有界**的（每轮最多 3 条）。无界 drain 会让单账号高频调整饿死事件循环。
 *   ④ 打向 api 的令牌是**启动期必需**的。回落到不带令牌只会一律 401，
 *      而 401 在 worker 眼里与「api 拒绝了这次改稿」同形：每条精修都失败、且指向错的地方。
 *
 * 本闸刻意用源码文本判而不是跑起来判：组装根要连真库、真模型、真对端进程才跑得起来，
 * 而这四件事全部是「那一行在不在」，跑起来反而更难证。
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const ASSEMBLY_FILE = join(HERE, '..', '..', 'src', 'server.ts');

async function assembly(): Promise<string> {
  return readFile(ASSEMBLY_FILE, 'utf8');
}

test('AC-REFINE-WIRE-01 队列路由真的在组装根里被注册', async () => {
  const source = await assembly();
  assert.match(
    source,
    /registerDraftRefinementQueueRoutes\(\s*httpServer,/,
    '漏调注册函数 ⇒ api 侧 404 ⇒ 被读成「对面版本落后」',
  );
  // 注册与「起不来时具名跳过」是同一个判断的两半：缺了 else 分支，
  // 初始化失败就成了一次没人知道的缺席（能力清单里既不是 registered 也不是 skipped）。
  assert.match(
    source,
    /skipCapability\(\s*'draft-refinement-queue'/,
    '存储起不来时 MUST 具名跳过，不许静默不注册',
  );
});

test('AC-REFINE-WIRE-02 worker 被构造，且泵在转', async () => {
  const source = await assembly();
  assert.match(source, /new DraftRefinementWorker\(\{/, '只开路由不起 worker：作业永远停在 queued');
  assert.match(source, /setInterval\(\(\) => void pump\(\), 1_500\)/, '缺泵 = 作业没人认领');
  assert.match(source, /draftRefinementTimer\.unref\?\.\(\)/, '定时器 MUST unref，别把进程钉住');
  assert.match(
    source,
    /clearInterval\(draftRefinementTimer\)/,
    '关停时 MUST 停泵，否则 close() 之后还会有一轮认领打到已关的池上',
  );
});

test('AC-REFINE-WIRE-03 泵是有界的（每轮最多 3 条）', async () => {
  const source = await assembly();
  assert.match(
    source,
    /for \(let i = 0; i < 3 && await worker\.processNext\(/,
    '无界 drain 会让单账号高频调整饿死事件循环',
  );
});

test('AC-REFINE-WIRE-04 打向 api 的内部令牌是启动期必需，不许回落', async () => {
  const source = await assembly();
  assert.match(source, /const apiInternalToken = requireApiInternalToken\(\);/);
  assert.match(
    source,
    /AIDCP_API_INTERNAL_TOKEN[\s\S]{0,400}?拒绝启动/,
    '缺令牌 MUST 拒绝启动：401 在 worker 眼里与「api 拒绝了这次改稿」同形',
  );
});

test('AC-REFINE-WIRE-05 本进程 MUST NOT 自己推预览（那份由 api 的写口产出）', async () => {
  const source = await assembly();
  // 预览重推绑在 api 那次属主写上。这边再推一份既没有连接也没有出口，
  // 只会变成又一次跨进程往返 —— 而且两份预览的先后顺序无人保证。
  assert.match(
    source,
    /refreshPreview: \(\) => \{\},/,
    '这一格 MUST 是显式的空实现 + 注释，不许省略（省略是静默缺席，读不出是决定还是遗漏）',
  );
});
