/**
 * aidcp-content 的公共出口。
 *
 * 单体那份出口列的是四块**云端整体**的能力（文本客户端 / 规划 / 锚点缓存 / 边-云协议），
 * 其中只有第一块属内容域 —— 其余三处的目标文件在本仓根本不存在（它们随属主去了 automation）。
 * 这里按本仓真实持有的东西重列：
 *
 * - `llm`          ：文本与视觉模型出口（Qwen 兼容 / OpenAI 兼容视觉）。
 * - `publish-agent`：发布生成管线（编排器 + 全部生产段角色 + 图片出口 + 后处理）。
 * - `render`       ：文字卡渲染（satori + resvg）。
 * - `cache`        ：精选灵感语料 / 概念池两个内容属主存储。
 * - `metrics`      ：token 与图片用量记账。
 * - `storage`      ：对象存储出口（OSS 转存）。
 *
 * **组装根不在这里出口。** `server.ts` 是本进程的 `main()`、有顶层副作用（起监听、建池、
 * 注册退出钩子）；把它挂进公共出口意味着任何 `import 'aidcp-content'` 都会顺带把整个服务拉起来。
 */
export * from './llm/index.js';
export * from './publish-agent/index.js';
export * from './render/index.js';
export * from './cache/concept-store.js';
export * from './cache/curated-content-store.js';
export * from './metrics/token-usage-store.js';
export * from './storage/object-store.js';
