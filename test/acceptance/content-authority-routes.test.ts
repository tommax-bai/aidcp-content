// aidcp:test-owner=derived
// 它读的是**本仓手写的组装根**（`src/server.ts`），在 aidcp-cloud 里没有对应物；
// 没有这行标记，跨仓同步会把它当成「多出的文件」，`--prune` 一跑就没了。
/**
 * 本进程给 automation 开的两条属主端口在**组装根这一层**的接线
 * （change split-cloud-automation-production-runtime 任务 2.1）。
 *
 * 跨进程往返本身由共享包 `aidcp-transport` 自己的往返测试钉，这里不重复。本文件只钉两件那边看不见的事：
 *
 *   ① **组装根真的调了那两个注册函数，且两组各挂各的。** 注册函数保证路由表里每条都挂上，
 *      但没有任何东西保证组装根去调它。漏调的表现不是报错，是 automation 侧收到 404 →
 *      译成「对面不支持这个方法」：一个本该留给版本落后的具名原因，被一次纯接线遗漏冒名顶替。
 *   ② **本进程的两个属主存储结构上满足端口面。** 服务端注册那层带一个在场探针，属主缺方法就当场
 *      答「不支持这个方法」。精选库属主此前**根本没有** `selectSamplesForSearchTerms`
 *      ——三字段窄投影原先写在云端组装根里，不归位属主的话，评论侧的搜索词样本会永远读不到。
 */
import { readFile } from 'node:fs/promises';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import ts from 'typescript';

import {
  CONCEPT_POOL_AUTHORITY_ROUTES,
  CURATED_SELECTION_AUTHORITY_ROUTES,
} from 'aidcp-transport/transport/content-authority-http.js';

import { ConceptStore } from '../../src/cache/concept-store.js';
import { CuratedContentStore } from '../../src/cache/curated-content-store.js';

const CONCEPT_REGISTRAR = 'registerConceptPoolAuthorityRoutes';
const CURATED_REGISTRAR = 'registerCuratedSelectionAuthorityRoutes';

interface RegistrarSite {
  guardIdentifiers: Set<string>;
  innermostGuardHasElse: boolean;
}

function functionBody(file: ts.SourceFile, name: string): ts.Node {
  let found: ts.Node | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isFunctionDeclaration(node) && node.name?.text === name && node.body) {
      found = node.body;
    }
    ts.forEachChild(node, visit);
  };
  visit(file);
  assert.ok(found, `组装根里找不到函数 ${name}（改名了？先修本闸再改代码）`);
  return found;
}

function registrarSites(scope: ts.Node, registrar: string): RegistrarSite[] {
  const sites: RegistrarSite[] = [];
  const guards: ts.Expression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isIfStatement(node)) {
      guards.push(node.expression);
      ts.forEachChild(node.thenStatement, visit);
      guards.pop();
      if (node.elseStatement) ts.forEachChild(node.elseStatement, visit);
      return;
    }
    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === registrar
    ) {
      const identifiers = new Set<string>();
      for (const guard of guards) {
        const collect = (child: ts.Node): void => {
          if (ts.isIdentifier(child)) identifiers.add(child.text);
          ts.forEachChild(child, collect);
        };
        collect(guard);
      }
      let innermost: ts.Node | undefined = node;
      let hasElse = false;
      while (innermost) {
        if (ts.isIfStatement(innermost)) {
          hasElse = innermost.elseStatement !== undefined;
          break;
        }
        innermost = innermost.parent;
      }
      sites.push({ guardIdentifiers: identifiers, innermostGuardHasElse: hasElse });
    }
    ts.forEachChild(node, visit);
  };
  visit(scope);
  return sites;
}

test('组装根真的挂上了概念池与精选召回两组，且一组起不来不连带关掉另一组', async () => {
  const source = await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8');
  const file = ts.createSourceFile(
    'src/server.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const body = functionBody(file, 'main');
  const concept = registrarSites(body, CONCEPT_REGISTRAR);
  const curated = registrarSites(body, CURATED_REGISTRAR);

  assert.equal(concept.length, 1, `${CONCEPT_REGISTRAR} MUST 在组装根里恰好注册一次`);
  assert.equal(curated.length, 1, `${CURATED_REGISTRAR} MUST 在组装根里恰好注册一次`);

  // 独立注册的机械判据：两组各自至少有一条对方没有的守卫。共用同一套守卫＝连体，
  // 属主 A 起不来会把属主 B 的路由一起带下去，而 automation 侧读到的是同一句「不支持这个方法」。
  const conceptOnly = [...concept[0]!.guardIdentifiers].filter(
    (id) => !curated[0]!.guardIdentifiers.has(id),
  );
  const curatedOnly = [...curated[0]!.guardIdentifiers].filter(
    (id) => !concept[0]!.guardIdentifiers.has(id),
  );
  assert.ok(conceptOnly.length > 0, '概念池那组必须有一条精选组没有的守卫，否则两组是连体的');
  assert.ok(curatedOnly.length > 0, '精选组必须有一条概念池组没有的守卫，否则两组是连体的');

  assert.ok(concept[0]!.innermostGuardHasElse, '概念池那组未注册时 MUST 有 else 分支明说');
  assert.ok(curated[0]!.innermostGuardHasElse, '精选组未注册时 MUST 有 else 分支明说');
});

test('两个属主存储结构上满足端口面：在场探针不会把接线遗漏冒充成能力缺口', () => {
  // 期望的方法名从路由表现算、不另抄一份：那两张表带 `satisfies Record<keyof Port, string>`，
  // 端口加了方法而表没跟上会在 typecheck 当场失败，于是表的键恒等于端口的方法集。
  const concept = new ConceptStore({ schemaEnsurer: async () => 'ready' as const, pool: {} as never });
  for (const method of Object.keys(CONCEPT_POOL_AUTHORITY_ROUTES)) {
    assert.equal(
      typeof (concept as unknown as Record<string, unknown>)[method],
      'function',
      `概念池属主缺方法 ${method}`,
    );
  }

  const curated = new CuratedContentStore({
    schemaEnsurer: async () => 'ready' as const,
    pool: {} as never,
    triggeredRefsReader: () => ({
      triggeredPublishRefs: async () => ({ curatedIds: [], sourceIds: [] }),
    }),
  });
  for (const method of Object.keys(CURATED_SELECTION_AUTHORITY_ROUTES)) {
    assert.equal(
      typeof (curated as unknown as Record<string, unknown>)[method],
      'function',
      `精选库属主缺方法 ${method}：真实原因是窄投影没有归位属主，而对面读到的是「不支持这个方法」`,
    );
  }
});

test('搜索词样本＝创作召回的三字段投影，且计数不被填成 0', async () => {
  const store = new CuratedContentStore({
    schemaEnsurer: async () => 'ready' as const,
    pool: {} as never,
    triggeredRefsReader: () => ({
      triggeredPublishRefs: async () => ({ curatedIds: [], sourceIds: [] }),
    }),
  });
  (store as unknown as { selectForCreation: unknown }).selectForCreation = async () => [
    { title: 'a', topics: ['x'], collectCount: 12, body: '大块正文', referenceImages: [1, 2, 3] },
    { title: 'b', topics: [], collectCount: null, body: '大块正文', referenceImages: [] },
  ];

  assert.deepEqual(await store.selectSamplesForSearchTerms('acc-1', 'source_post', 8), [
    { title: 'a', topics: ['x'], collectCount: 12 },
    // `null` 原样过去：「没记到收藏数」与「收藏数真是 0」在选词排序里不是一回事。
    { title: 'b', topics: [], collectCount: null },
  ]);
});

/**
 * 「本进程该服务哪些属主端口」的清单闸 —— **只许下降**。
 *
 * ## 它守的是一个真发生过的事故形态，而且是最难查的那种
 *
 * 单体里这七组路由是**全的**，且那份代码早就写下预言：
 * 「MUST NOT 因为『现在没人调』就不注册：那会让第 3 段写 main() 时才发现对面根本没有这条路由」。
 * 预言成真了，只是发生在**本仓这份手写入口**上：自动化进程的真装配把四个客户端接了上去，
 * 而本进程当时只在服务其中两组。
 *
 * **为什么没有任何既有机制会发现它**：客户端建得出来（构造函数只吃基址与令牌）、
 * 调用点编译得过（类型只描述形状、不描述「对面有没有这条路由」）、两仓的测试各自全绿 ——
 * 只有真把两个进程一起跑起来才 404，而那是**跨进程**的 404：调用方读到的是
 * 「对面不支持这个方法」，一个本该留给「对面版本落后」的具名原因，被一次纯接线遗漏冒名顶替。
 *
 * ## 判据形态
 *
 * 清单必须**穷举**共享包里所有内容属主 registrar：新加一个而不登记 ⇒ 当场红
 * （这条比「已登记的都注册了」更要紧 —— 漏登记才是静默的那一种）。
 * `pending` 那几条要写明缺什么、归哪个 task；它们**注册之后必须从 pending 里移走**，
 * 否则这条闸会自己红 —— 这就是「只许下降」的机械形态，不留空位给新的遗漏回填。
 */
/**
 * 一条登记：要么已注册，要么 pending 且**必须写清缺什么**。
 *
 * **刻意用具名类型标注、不写 `as const`**：pending 一条不剩时，`as const` 会把这个联合
 * 收窄成只有 `registered` 那一枝，于是下面读 `reason` 的那一支变成 `never`、只能靠一个
 * `as` 强转硬撑 —— 而那正是「清单只许下降」这条闸自己要防的东西（今天清零 ≠ 明天不会再加）。
 */
type ContentAuthorityRegistrarEntry =
  | { state: 'registered' }
  | { state: 'pending'; reason: string };

const CONTENT_AUTHORITY_REGISTRARS: Record<string, ContentAuthorityRegistrarEntry> = {
  registerConceptPoolAuthorityRoutes: { state: 'registered' },
  registerCuratedSelectionAuthorityRoutes: { state: 'registered' },
  registerCuratedTargetAuthorityRoutes: { state: 'registered' },
  registerCuratedWriteAuthorityRoutes: { state: 'registered' },
  registerFacebookPublishMediaAuthorityRoutes: { state: 'registered' },
  registerLlmUsageRecordingAuthorityRoutes: { state: 'registered' },
  // 2026-08-04：转写这条从 pending 移出。属主实例已在本进程建（判形档另起一个 sensor、
  // 视觉模型另起一档，逐条照单体），路由**无条件注册**——旗标关时属主答「未启用」并把取值
  // 回显给客户端对账，那是**答案**、不是缺席，所以旗标不该当注册条件。
  registerTextCardTranscriptionAuthorityRoutes: { state: 'registered' },
  registerReplyAiAuthorityRoutes: { state: 'registered' },
};

test('内容属主端口清单：共享包里的每一个 registrar 都已登记，且状态与组装根一致', async () => {
  const [source, transportAuthority, transportMedia] = await Promise.all([
    readFile(new URL('../../src/server.ts', import.meta.url), 'utf8'),
    import('aidcp-transport/transport/content-authority-http.js'),
    import('aidcp-transport/transport/content-media-usage-http.js'),
  ]);

  // ① 穷举：共享包导出的每一个内容属主 registrar 都 MUST 在清单里。
  //    **这一条是本闸的重点** —— 漏登记是静默的，而漏注册至少还会在真跑时 404。
  const exported = [
    ...Object.keys(transportAuthority),
    ...Object.keys(transportMedia),
  ].filter((name) => /^register.*AuthorityRoutes$/.test(name));
  assert.ok(exported.length > 0, '一个都没匹配到 ⇒ 命名口径变了，先修本闸');
  for (const name of exported) {
    assert.ok(
      name in CONTENT_AUTHORITY_REGISTRARS,
      `共享包新增了内容属主 registrar ${name} 而清单没登记 —— `
        + '这正是本闸存在的理由：没人登记它，就没人会发现本进程不在服务它',
    );
  }

  // ② 状态与组装根逐条一致。
  const file = ts.createSourceFile(
    'src/server.ts',
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const body = functionBody(file, 'main');
  for (const [name, entry] of Object.entries(CONTENT_AUTHORITY_REGISTRARS)) {
    const sites = registrarSites(body, name);
    if (entry.state === 'registered') {
      assert.equal(
        sites.length,
        1,
        `${name} 登记为已注册，组装根里却出现 ${sites.length} 次 —— `
          + '自动化侧已经在调它，缺了就是跨进程 404',
      );
    } else {
      assert.equal(
        sites.length,
        0,
        `${name} 已经在组装根里注册了，但清单还写着 pending（${entry.reason}）`
          + ' —— 接好了就把它从 pending 移走，清单只许下降',
      );
    }
  }
});

/** 结构断言一律读剥掉注释的源码：解释红线的注释本身就带着被断言的字面量。 */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/[^\n]*/g, '');
}

test('文字卡转写：判形那一档是另起的 sensor，旗标与回写都与封面那档分开', async () => {
  // 这条守的是一次看着最自然的「简化」：把转写器的判形口接到上面那个封面 sensor 上。
  // 两个后果都不报错——① 旗标被绑在一起（开转写必须连带开封面感知，反之亦然）；
  // ② 转写的判形结果会被写进精选行的形态缓存，而那份缓存是给封面链路用的。
  const source = stripComments(
    await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8'),
  );
  assert.match(
    source,
    /createTextCardTranscriber\(\{[\s\S]*?formSensor: admissionFormSensor/,
    '转写器的判形口 MUST 吃自己那个 sensor',
  );
  const start = source.indexOf('const admissionFormSensor = createCoverFormSensor(');
  assert.ok(start > 0, '转写准入的判形 sensor MUST 在本进程建');
  const block = source.slice(start, start + 400);
  assert.match(block, /enabled: textCardOcrEnabled/, '它的旗标 MUST 是文字卡那一个');
  assert.doesNotMatch(block, /annotate/, '它 MUST NOT 回写封面链路的形态缓存');
  assert.match(
    source,
    /const coverFormSensor = createCoverFormSensor\(\{[\s\S]*?AIDCP_COVER_FORM_SENSING/,
    '封面那档 MUST 仍由自己的旗标控',
  );
});

test('文字卡转写：那条路由 MUST 无条件注册，别拿旗标当注册条件', async () => {
  // 上面那条清单闸只数「注册函数被调了几次」，把调用塞进 `if (旗标)` 它一样过 —— 实测过。
  // 而拿旗标当注册条件的后果不是「关掉这个能力」，是**换一种谎**：
  // 客户端收到的不再是属主答的「未启用」（带取值回显、可对账），而是跨进程 404 →
  // 被译成「对面不支持这个方法」，一个本该留给「对面版本落后」的具名原因。
  // 所以这里按**顶层语句**判：main 体内 2 空格缩进、独占一行。
  const source = stripComments(
    await readFile(new URL('../../src/server.ts', import.meta.url), 'utf8'),
  );
  assert.match(
    source,
    /\n {2}registerTextCardTranscriptionAuthorityRoutes\(\n {4}httpServer,/,
    '注册 MUST 是 main 体内的顶层语句，不许挂在任何条件下',
  );
});
