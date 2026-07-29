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
