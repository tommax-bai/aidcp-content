// aidcp:test-owner=derived
// 它读的是**共享包 aidcp-transport 的路由表**，而 aidcp-cloud 不依赖那个包；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 精选库跨进程之后，账号隔离仍然由**属主侧**保证
 * （change restore-panel-capability-wiring 任务 8.4）。
 *
 * ## 它守什么
 *
 * 拆仓之前，精选库的每个调用方都和存储在同一个进程里：`accountId` 是本地调用传下来的，
 * 越权只可能来自本仓自己的代码。拆完之后这条链变了形：
 * **`accountId` 变成了一个远端进程通过内部 HTTP 递进来的参数**。
 * 于是「谁来保证这次读写只碰到这个账号的行」这个问题第一次有了错误答案 ——
 * 「调用方会传对的」。它错在：属主这一侧一旦不约束，任何一个能打到内部口的调用方
 * （今天是面板与自动化，明天是第三个进程）都能靠换一个 `accountId`、
 * 或者干脆靠猜一个全局自增 `id`，读到或删掉别的账号的行。
 *
 * **这类回归不会报错**：SQL 照样跑通、路由照样 200、两仓的测试各自全绿。
 * 唯一的表现是数据串账，而串账在观察面上和「这个账号本来就有这些内容」完全同形。
 *
 * ## 判据（两条，缺一条闸就是空的）
 *
 *   ① **面必须穷举**：跨进程能碰到精选库的每一条路由都得在下面的覆盖表里。
 *      新开一条口而不登记 ⇒ 当场红。**漏登记比漏约束更静默** —— 漏约束还能靠 review 看出来，
 *      漏登记连「这条口没人管」这件事都没人知道。
 *   ② **约束必须真到达数据库**：属主发出的每一条打到精选表的语句，
 *      SQL 里要有对 `account_id` 的**等值约束**（不是 SELECT 投影里出现一下），
 *      并且调用方给的那个 `accountId` 值要真的绑在对应的占位符上。
 *      两半都要 —— 只查 SQL 文本，绑错参数照样过；只查参数，把 WHERE 删了照样过。
 *
 * ## 关于「给了才必须绑」这个口径
 *
 * 面板那两条聚合读（列表、筛选面）的 `accountId` 是**可选**的：不给＝全账号合并视图，
 * 那是运营控制台的正当用法，不是漏洞。所以本闸的口径是
 * **「调用方给了 accountId，属主就必须把它绑进去」**，不是「任何时候都必须过滤」。
 * 把口径写成后者会逼着下一个人去改一个正确的行为，那种闸迟早会被整条注释掉。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';

import { CURATED_CONTENT_ROUTES } from 'aidcp-transport/transport/curated-content-http.js';
import {
  CURATED_SELECTION_AUTHORITY_ROUTES,
  CURATED_TARGET_AUTHORITY_ROUTES,
  CURATED_WRITE_AUTHORITY_ROUTES,
} from 'aidcp-transport/transport/content-authority-http.js';
import { PANEL_CONTENT_ROUTES } from 'aidcp-transport/transport/panel-content-http.js';

import { CuratedContentStore } from '../../src/cache/curated-content-store.js';

/** 调用方递进来的账号。刻意取一个不会在任何 SQL 文本里偶然出现的串。 */
const CALLER_ACCOUNT = 'acct-caller-7f3a';

interface RecordedQuery {
  sql: string;
  params: unknown[];
}

/** 只记录、不执行。空结果集即可 —— 本闸判的是「发出去的语句长什么样」，不是结果。 */
function recordingPool(): { calls: RecordedQuery[]; pool: never } {
  const calls: RecordedQuery[] = [];
  const pool = {
    query: async (sql: string, params?: unknown[]) => {
      calls.push({ sql, params: params ?? [] });
      return { rows: [], rowCount: 0 };
    },
  };
  return { calls, pool: pool as never };
}

function newStore(pool: never): CuratedContentStore {
  return new CuratedContentStore({
    schemaEnsurer: async () => 'ready' as const,
    pool,
    executionTarget: 'dev',
    triggeredRefsReader: () => ({
      triggeredPublishRefs: async () => ({ curatedIds: [], sourceIds: [] }),
    }),
  });
}

/**
 * 判据②的实现。
 *
 * **投影里的 `account_id` 不算约束** —— 面板列表把它 SELECT 出来是为了展示，
 * 删掉 WHERE 之后那个词照样在。所以先把所有 `SELECT … FROM` 之间的投影段抹掉再判。
 * 表别名要放行（`listForClient` 用的是 `c.account_id = $1`）。
 */
function assertAccountConstrained(where: string, call: RecordedQuery, accountId: string): void {
  const withoutProjection = call.sql.replace(/SELECT[\s\S]*?FROM/gi, 'SELECT FROM');
  const equality = withoutProjection.match(/(?:[A-Za-z_][A-Za-z0-9_]*\.)?account_id\s*=\s*\$(\d+)/);
  const insertsColumn = /INSERT\s+INTO\s+curated_content[\s\S]*?\(\s*account_id\b/i.test(call.sql);

  assert.ok(
    equality || insertsColumn,
    `${where}：这条打到精选表的语句既没有 account_id 的等值约束、也不是带 account_id 的写入 ——\n`
      + `跨进程之后它等于允许调用方读写任意账号的行。\nSQL: ${call.sql}`,
  );

  assert.ok(
    call.params.includes(accountId),
    `${where}：SQL 里写着按 account_id 约束，但调用方给的那个账号值根本没绑进参数 ——\n`
      + `约束绑到了别的东西上，等于没有。\nSQL: ${call.sql}\nparams: ${JSON.stringify(call.params)}`,
  );

  if (equality) {
    // 再钉一次「绑对了位置」：$N 对应 params[N-1]。绑到别的占位符上时上面那条 includes 仍会过。
    const idx = Number(equality[1]) - 1;
    assert.equal(
      call.params[idx],
      accountId,
      `${where}：account_id 约束的是 $${equality[1]}，而那一位绑的不是调用方给的账号。\n`
        + `SQL: ${call.sql}\nparams: ${JSON.stringify(call.params)}`,
    );
  }
}

/** 属主侧方法 → 一次真调用。返回值一律不看，只看它对数据库说了什么。 */
const INVOCATIONS: Record<string, (store: CuratedContentStore) => Promise<unknown>> = {
  // ── 面板 → 内容（PANEL_CONTENT_ROUTES 的 curated 那五条）────────────────────
  listForPanel: (s) => s.listForPanel(CALLER_ACCOUNT, { limit: 10, offset: 0 }),
  facetsForPanel: (s) => s.facetsForPanel(CALLER_ACCOUNT),
  deleteOne: (s) => s.deleteOne(CALLER_ACCOUNT, 42),
  clearEmptyBody: (s) => s.clearEmptyBody(CALLER_ACCOUNT),
  // ── 客户端取数（CURATED_CONTENT_ROUTES）──────────────────────────────────────
  listForClient: (s) => s.listForClient(CALLER_ACCOUNT, { creationStatus: 'all', limit: 10, offset: 0 }),
  // 面板/委托两侧共用；委托那条另包一层按码还原，落到属主仍是这一个方法。
  getOneForAccount: (s) => s.getOneForAccount(42, CALLER_ACCOUNT),
  // ── 自动化 → 内容：召回（CURATED_SELECTION_AUTHORITY_ROUTES）─────────────────
  selectForCreation: (s) => s.selectForCreation(CALLER_ACCOUNT, 'note', 5),
  selectSamplesForSearchTerms: (s) => s.selectSamplesForSearchTerms(CALLER_ACCOUNT, 'note', 5),
  // ── 自动化 → 内容：写入（CURATED_WRITE_AUTHORITY_ROUTES）────────────────────
  upsertObservation: (s) =>
    s.upsertObservation({
      accountId: CALLER_ACCOUNT,
      contentType: 'image_text',
      sourceId: 'src-1',
      body: '一段足够长的正文，避免被空正文分支提前返回。',
      topics: [],
      admitReason: 'test',
    }),
  refreshReferenceImages: (s) =>
    s.refreshReferenceImages(CALLER_ACCOUNT, 'src-1', 'image_text', [
      { index: 1, url: 'https://example.invalid/1.jpg' },
    ]),
  getTextCardContext: (s) => s.getTextCardContext(CALLER_ACCOUNT, 'src-1', 'image_text'),
  archiveComment: (s) =>
    s.archiveComment(CALLER_ACCOUNT, { sourceId: 'src-1', text: '一条评论', topics: [] }),
  markBotAction: (s) => s.markBotAction(CALLER_ACCOUNT, 'src-1', 'like'),
};

/**
 * 面板那五条路由名不是方法名（`curatedList` ↔ `listForPanel`），只能手写一张对照表。
 * 它自己被下面第一条 test 钉住：路由表里多出一条 `curated*` 而这里没有 ⇒ 红。
 */
const PANEL_ROUTE_TO_METHOD: Record<string, string> = {
  curatedList: 'listForPanel',
  curatedFacets: 'facetsForPanel',
  curatedDeleteOne: 'deleteOne',
  curatedClearEmptyBody: 'clearEmptyBody',
  curatedGetOne: 'getOneForAccount',
};

test('跨进程精选库的面是穷举的：新开一条口而没人管它，当场红', () => {
  // 三张属主路由表的**键就是属主方法名**（它们带 `satisfies Record<keyof Port, string>`，
  // 端口加方法而表没跟上会在 typecheck 当场失败），所以这里不另抄一份方法名。
  const fromRouteTables = [
    ...Object.keys(CURATED_CONTENT_ROUTES),
    ...Object.keys(CURATED_SELECTION_AUTHORITY_ROUTES),
    ...Object.keys(CURATED_WRITE_AUTHORITY_ROUTES),
    ...Object.keys(CURATED_TARGET_AUTHORITY_ROUTES),
  ];
  assert.ok(fromRouteTables.length > 0, '一条都没读到 ⇒ 路由表的形态变了，先修本闸');

  const panelCuratedRoutes = Object.keys(PANEL_CONTENT_ROUTES).filter((k) => k.startsWith('curated'));
  assert.ok(panelCuratedRoutes.length > 0, '面板侧一条 curated 路由都没读到 ⇒ 命名口径变了，先修本闸');
  for (const route of panelCuratedRoutes) {
    assert.ok(
      route in PANEL_ROUTE_TO_METHOD,
      `面板新开了一条精选库路由 ${route}，而本闸的对照表没登记它 —— `
        + '没人登记，就没人会发现它是否约束了账号',
    );
  }

  const surface = new Set([...fromRouteTables, ...Object.values(PANEL_ROUTE_TO_METHOD)]);
  for (const method of surface) {
    assert.ok(
      method in INVOCATIONS,
      `属主方法 ${method} 能被跨进程调到，但本闸没有覆盖它 —— `
        + '它是否把调用方给的 accountId 约束进 SQL，今天没有任何东西在看',
    );
  }
});

test('跨进程精选库：调用方给了 accountId，属主发出的每一条语句都真的绑住了它', async () => {
  for (const [method, invoke] of Object.entries(INVOCATIONS)) {
    const { calls, pool } = recordingPool();
    await invoke(newStore(pool));

    const touching = calls.filter((c) => /curated_content/.test(c.sql));
    assert.ok(
      touching.length > 0,
      `${method}：一条打到精选表的语句都没发出 —— 要么调用姿势不对（本闸自己坏了），`
        + '要么这个方法已经不碰精选表了；两种都得有人看一眼，不能默认通过',
    );
    for (const call of touching) {
      assertAccountConstrained(method, call, CALLER_ACCOUNT);
    }
  }
});

test('本闸不是恒真的：两半判据各自都能把违规拦下来', () => {
  // ① 把约束删了（`account_id` 只剩在 SELECT 投影里）——这是最像「无害重构」的那种改法。
  assert.throws(
    () =>
      assertAccountConstrained(
        '负对照·投影冒充约束',
        {
          sql: 'SELECT id, account_id, body FROM curated_content ORDER BY updated_at DESC LIMIT $1',
          params: [CALLER_ACCOUNT],
        },
        CALLER_ACCOUNT,
      ),
    /既没有 account_id 的等值约束/,
    '投影里出现 account_id 就算过 ⇒ 本闸对「删掉 WHERE」这种改法完全无感',
  );

  // ② 约束在、但绑的是别人的账号（跨进程之后这是真会发生的一种：从错的地方取了账号）。
  assert.throws(
    () =>
      assertAccountConstrained(
        '负对照·绑了别的账号',
        {
          sql: 'DELETE FROM curated_content WHERE id = $1 AND account_id = $2',
          params: [42, 'acct-somebody-else'],
        },
        CALLER_ACCOUNT,
      ),
    /根本没绑进参数/,
    '只看 SQL 文本 ⇒ 绑错账号照样过，而那正是跨进程之后最贵的一种错',
  );

  // ③ 绑对了值、但绑在别的占位符上（约束读的是另一位）。
  assert.throws(
    () =>
      assertAccountConstrained(
        '负对照·约束读错位',
        {
          sql: 'DELETE FROM curated_content WHERE id = $1 AND account_id = $2',
          params: [CALLER_ACCOUNT, 'acct-somebody-else'],
        },
        CALLER_ACCOUNT,
      ),
    /而那一位绑的不是调用方给的账号/,
    '只判「参数里有这个值」⇒ 约束读错位照样过',
  );
});
