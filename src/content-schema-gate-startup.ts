/**
 * 内容进程的启动期 schema 契约门。
 *
 * ## 与此前那次裸调用的差别只有两点，但两点都在「失效时不出声」的那一类上
 *
 * 1. **服务名**：门此前没传 `serviceLabel`，于是打出来的前缀是 `[aidcp-cloud]`（那份实现的
 *    事实源在单体）。而这条日志恰好是门拒绝启动时 journal 里**唯一**的线索——门刻意跑在任何
 *    存储 init 之前、无 try/catch，之后什么都不会再打。打成别的服务名会把排查直接引偏。
 * 2. **回执**：门唯一的失效形态不是「判错了」，是「**没人调它**」，而「没调」在行为上什么都
 *    不表现。做成不可伪造的回执、由启动路径必填持有，就把「门必须先跑、且跑在建池之前」
 *    变成编译期可见的顺序约束。
 *
 * ## 只判 content 一个属主
 *
 * 判据是「本进程真正打开了哪些属主库连接」。本仓建两个池（业务池 + 用量记账小池），
 * 两处都是 `resolveOwnerPgConfig('content')` ⇒ 集合恒等于 `['content']`。
 * 传入集合之外的属主不读账本、不判定、不出现在结论里。
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import type { PgOwner } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import { loadMigrationFiles } from 'aidcp-transport/schema/migration-files.js';
import {
  LEGACY_OWNER_OVERRIDES_NAME,
  loadLegacyOwnerOverrides,
  loadMigrationOwnerScopes,
  loadTableOwnership,
  type MigrationOwnerScopes,
} from 'aidcp-transport/schema/migration-owners.js';
import {
  runSchemaContractGate,
  type LedgerQueryable,
  type SchemaGateResult,
} from 'aidcp-transport/schema/schema-gate.js';
import type { SchemaGateMode } from 'aidcp-transport/schema/schema-contract.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 本进程打开的属主库集合。**唯一定义处**——门的取值、回执的自检都从这里取。
 * 别在第二处手写一遍 `['content']`。
 */
export const CONTENT_PG_OWNERS = ['content'] as const satisfies readonly PgOwner[];

/** 只有本模块能造回执的凭据；`unique symbol` 不导出 ⇒ 外部无法拼一个字面量出来。 */
declare const CONTENT_SCHEMA_GATE_RECEIPT: unique symbol;

/** 门跑过了的**回执**。理由见文件头第 2 点。 */
export interface ContentSchemaGateReceipt {
  readonly [CONTENT_SCHEMA_GATE_RECEIPT]: true;
  /** 实际判定过的属主。恒为 {@link CONTENT_PG_OWNERS}。 */
  readonly owners: readonly PgOwner[];
  readonly mode: SchemaGateMode;
  readonly conclusion: string;
  /** warn 模式下可能为 false —— enforce 模式下 false 根本走不到这里（门自己抛）。 */
  readonly pass: boolean;
}

/**
 * `main()` 的**第一句**，建池之前。**MUST NOT 包 try/catch**。
 *
 * 迁移目录与属主清单显式传本仓的：门的实现从 `aidcp-transport` 这个包里 import，
 * 那份实现「往上两级」的默认基准指向包目录，那里没有 `migrations/`。
 */
export async function runContentStartupSchemaGate(options?: {
  client?: LedgerQueryable;
  clients?: Partial<Record<PgOwner, LedgerQueryable>>;
  mode?: SchemaGateMode;
  loadScopes?: () => Promise<MigrationOwnerScopes>;
}): Promise<ContentSchemaGateReceipt> {
  const result: SchemaGateResult = await runSchemaContractGate({
    ...options,
    owners: CONTENT_PG_OWNERS,
    loadScopes:
      options?.loadScopes
      ?? (() =>
        loadMigrationOwnerScopes(
          () => loadMigrationFiles(path.join(REPO_ROOT, 'migrations')),
          () => loadTableOwnership(path.join(REPO_ROOT, 'boundaries', 'table-ownership.json')),
          // 第三个输入与前两个同理、同一个坑：历史迁移执行范围的封闭名册也住在本仓 migrations/ 下，
          // 而这份实现来自共享包，它的默认基准指向**包自己的目录**。漏传的后果不是编译错——
          // 是启动时读不到名册 ⇒ 13 条历史迁移判不出执行范围 ⇒ 门判「判据不可用」拒绝启动。
          () => loadLegacyOwnerOverrides(path.join(REPO_ROOT, 'migrations', LEGACY_OWNER_OVERRIDES_NAME)),
        )),
    serviceLabel: 'aidcp-content',
  });
  // 先按去掉品牌位的完整形状构造，再只把品牌位强转上去（整体强转会把「字段写全没有」一起静音）。
  const receipt: Omit<ContentSchemaGateReceipt, typeof CONTENT_SCHEMA_GATE_RECEIPT> = {
    owners: result.owners.map((entry) => entry.owner),
    mode: result.mode,
    conclusion: result.conclusion,
    pass: result.pass,
  };
  return receipt as ContentSchemaGateReceipt;
}
