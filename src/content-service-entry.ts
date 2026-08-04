/**
 * 内容进程的可执行入口。**systemd 的 `ExecStart` 指这里**，不指 `server.ts`。
 *
 * ## 顺序是外壳的全部内容，且不可换
 *
 * 读配置 → **schema 契约门** → 建组装根 → **先监听** → 放行业务（注册路由）→ 优雅关停 → 信号。
 * 三个服务（api / automation / content）同形，理由不是整齐：不同形的直接后果是「某个服务在
 * 就绪之前就开始干活」。
 *
 * - **门在建池之前**，且 MUST NOT 被 try/catch 吞（enforce 模式下它自己抛，异常冒到这里 ⇒
 *   非 0 退出 ⇒ systemd 重启，这是设计）。
 * - **先监听后就绪**：本进程的装配很长（几十个角色 + 多个存储 init），监听若排在最后，
 *   这段时间里探活拿不到任何应答，「还在初始化」与「进程死了」从外面同形。
 *
 * ## 信号处理为什么从 `server.ts` 挪到这里
 *
 * 旧形态在装配中途就挂上 `process.once('SIGTERM')`，处理器直接 flush 用量然后 `process.exit(0)`：
 * 监听口与两个池都不关，且那一刻装配还没走完、真正该关的东西大多还不存在。
 * 现在关停动作收在 `startContentService()` 返回的 `close()` 里，入口只负责把信号接到它上面。
 */
import { pathToFileURL } from 'node:url';

import { runContentStartupSchemaGate } from './content-schema-gate-startup.js';
import { startContentService, type ContentService } from './server.js';

export interface ContentEntryOptions {
  /** 信号挂在哪。传 `null` 表示不挂（测试与嵌入式调用用）。缺省是 `process`。 */
  signals?: {
    on(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
    off(signal: 'SIGTERM' | 'SIGINT', handler: () => void): unknown;
  } | null;
  logger?: Pick<Console, 'log' | 'warn' | 'error'>;
  /** 进程退出。抽出来只为测试可观测；生产上就是 `process.exit`。 */
  exit?: (code: number) => never;
}

export async function runContentEntry(options: ContentEntryOptions = {}): Promise<void> {
  const logger = options.logger ?? console;
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const signalSource = options.signals === null ? null : (options.signals ?? process);

  // ① 门：入口的第一句，建池之前，**不包 try/catch**。
  const schemaGate = await runContentStartupSchemaGate();

  // ② 建根 + 先监听 + 注册路由（顺序在 startContentService 里已钉死）。
  let service: ContentService;
  try {
    service = await startContentService({ schemaGate });
  } catch (error) {
    logger.error('[aidcp-content] 启动失败：', error);
    return exit(1);
  }

  // ③ 优雅关停 + 信号。收到信号先摘掉自己 ⇒ 第二个信号落回 Node 默认处置（立刻结束）。
  let closing = false;
  const onSignal = (): void => {
    if (closing) return;
    closing = true;
    if (signalSource) {
      signalSource.off('SIGTERM', onSignal);
      signalSource.off('SIGINT', onSignal);
    }
    logger.log('[aidcp-content] 收到终止信号，开始优雅关停（flush token 用量后退出）');
    void service
      .close()
      .then(() => {
        logger.log('[aidcp-content] 已关停');
      })
      .catch((error: unknown) => {
        logger.error('[aidcp-content] 优雅关停失败：', error);
        exit(1);
      });
  };
  if (signalSource) {
    signalSource.on('SIGTERM', onSignal);
    signalSource.on('SIGINT', onSignal);
  }
}

/** 直接执行本文件时才启动（被 import 时不启动）。 */
export function isDirectExecution(metaUrl: string): boolean {
  const argv1 = process.argv[1];
  return Boolean(argv1) && pathToFileURL(argv1).href === metaUrl;
}

if (isDirectExecution(import.meta.url)) {
  void runContentEntry();
}
