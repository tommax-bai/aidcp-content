/**
 * aidcp-content 的组装根 —— **内容进程的 `main()`**（Block④ 三仓提取 · 批次 2）。
 *
 * 它取代了从 `aidcp-cloud` 整份搬过来的那个四段组合根。单体那份里，内容段是 `segBContent`：
 * 一个把上下文当公共黑板、从中解构 16 个句柄的函数。本文件把那 16 个句柄逐个落到**本进程自己能拿到的东西**上：
 *
 *   - **本地建（属内容域，连内容库或压根不连库）**：精选素材库 / FB 发帖素材池 / token 用量记账 /
 *     文本出口 / 图片出口 / 对象存储 / 厂商运行时。
 *   - **跨进程窄端口（属 api 或 automation）**：发布台账窄写 · 管线日志 · 卡片出口 · 候审卡投递判定 ·
 *     图片模型选择 · 角色模型解析 · 厂商密钥 · 账号平台读 · 参照稿触发去重。十条契约的定义在
 *     `aidcp-transport`（一份定义两端共用），本文件只是把客户端那一侧接上。
 *   - **恒缺席（属自动化段）**：界面推送口与审批后下发触发。两者经**响亮取用闸**，缺了记
 *     `cross_segment_drop:` 并点名后果 —— 绝不写成裸 `?.` 静默短路。
 *
 * ── 三条本文件必须守住的纪律 ────────────────────────────────────────────────────────
 *
 * ① **只对内容库开池。** 本进程不持有 api / automation 的任何连接。schema 契约门也只判 `content`
 *    一个属主 —— 本进程既然不连另外两个库，就没有立场声称它们的 schema 对或不对。
 *
 * ② **缺了跨进程通道就拒绝启动，不降级。** 没有 api 进程，内容域拿不到模型配置、写不了发布台账、
 *    发不出审批卡；没有 automation 进程，精选库判不了「这条参照稿用过没有」。这两种情况下
 *    「起来了但大部分不工作」比「没起来」危险得多 —— 后者一眼可见，前者要等到稿子被反复洗才发现。
 *
 * ③ **别把「查不到」和「没查成」混为一谈。** 这条纪律的实现全在 `aidcp-transport` 那十个客户端里
 *    （每条口的失败语义刻意各不相同，见各自文件头），本文件只负责**不去包一层 try/catch 把它们抹平**。
 *
 * ── 已知的两处 cross_segment_drop（批次 3/4 承接，不是遗漏）──────────────────────────
 * 审批通过后的**下发触发**与候审的**界面推送**都由自动化段承接。本进程里它们恒缺席、每次触发都会
 * 记一条点名后果的 error。前者后果最重（稿件记了「已批准」却不会被发出去），故此处刻意留响亮痕迹，
 * 而不是让它安静地什么都不做。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

import { parseDeploymentTarget } from 'aidcp-kernel/deployment-target.js';
import { resolveOwnerPgConfig } from 'aidcp-kernel/kernel/pg-owner-connection-resolver.js';
import { MODEL_CONFIG_DEFAULTS } from 'aidcp-kernel/kernel/model-config-defaults.js';
import type {
  CuratedSourceAdmission,
  CuratedReferenceImage,
} from 'aidcp-kernel/kernel/curated-content-types.js';
// 已解析的两态（'off' | 'on'）。以 as 别名导入，与 qwen.ts 里那处同一手法、同一理由：
// 下发路径上的类型绝不能换成含 'default' 的三值版本。
import type { LlmThinkingMode as ThinkingMode } from 'aidcp-kernel/kernel/llm-contract.js';
import type { PublishCardExitPort } from 'aidcp-kernel/kernel/publish-card-exit-port.js';

import { ensureCapabilitySchema } from 'aidcp-transport/schema/schema-capability.js';
import { runSchemaContractGate } from 'aidcp-transport/schema/schema-gate.js';
import { loadMigrationFiles } from 'aidcp-transport/schema/migration-files.js';
import {
  loadMigrationOwnerScopes,
  loadTableOwnership,
} from 'aidcp-transport/schema/migration-owners.js';
import { InternalHttpClient, InternalHttpServer } from 'aidcp-transport/transport/internal-http.js';
import { PublishLogHttpClient } from 'aidcp-transport/transport/publish-log-http.js';
import { PipelineLogHttpClient } from 'aidcp-transport/transport/pipeline-log-http.js';
import { PublishCardExitHttpClient } from 'aidcp-transport/transport/publish-card-exit-http.js';
import { ReviewCardDeliveryHttpClient } from 'aidcp-transport/transport/review-card-delivery-http.js';
import {
  ImageModelSelectionHttpClient,
  PollingImageModelSelectionMirror,
} from 'aidcp-transport/transport/image-model-selection-http.js';
import {
  RoleModelSelectionHttpClient,
  PollingRoleModelSelectionMirror,
} from 'aidcp-transport/transport/role-model-selection-http.js';
import { ProviderSecretHttpClient } from 'aidcp-transport/transport/provider-secret-http.js';
import { AccountPlatformHttpClient } from 'aidcp-transport/transport/account-platform-http.js';
import { TriggeredPublishRefsHttpClient } from 'aidcp-transport/transport/triggered-publish-refs-http.js';
import { registerCuratedContentRoutes } from 'aidcp-transport/transport/curated-content-http.js';
// automation → content 的两条属主端口的服务端一侧。客户端一侧在 automation 仓，路由名两端共一份。
import {
  registerConceptPoolAuthorityRoutes,
  registerCuratedSelectionAuthorityRoutes,
  registerCuratedWriteAuthorityRoutes,
} from 'aidcp-transport/transport/content-authority-http.js';
import {
  registerFacebookPublishMediaAuthorityRoutes,
  registerLlmUsageRecordingAuthorityRoutes,
} from 'aidcp-transport/transport/content-media-usage-http.js';
import { registerPublishStatusRoutes } from 'aidcp-transport/transport/publish-status-http.js';
import { registerPublishGenerationRoutes } from 'aidcp-transport/transport/publish-generation-http.js';
import { registerPersonaGeneratorCommandRoutes } from 'aidcp-transport/transport/paired-command-http.js';

import {
  QwenClient,
  type ChatLlmClient,
  TEXT_PROVIDERS,
  type TextProviderId,
  resolveProviderBaseUrl,
  resolveProviderEnvKey,
} from './llm/index.js';
import { OpenAiCompatVisionClient, type VisionCallInfo } from './llm/vision.js';
import { PersonaGeneratorCommandReceiver } from './llm/persona-generator-command-receiver.js';
import { PersonaGenerator } from './agents/persona-generator.js';
import { PERSONA_SOUL_CODEC } from './agents/persona-soul-codec.js';
import { TokenUsageStore } from './metrics/token-usage-store.js';
import { CuratedContentStore } from './cache/curated-content-store.js';
import { ConceptStore } from './cache/concept-store.js';
import { relocateImageToStore, type ObjectStore } from './storage/object-store.js';
import { PublishOrchestrator, FacebookPublishMediaStore } from './publish-agent/index.js';
import { RoutingImageProvider } from './publish-agent/image-providers.js';
import { WanxiangClient } from './publish-agent/wanxiang-client.js';
import { SeedreamClient } from './publish-agent/seedream-client.js';
import { PostProcessor } from './publish-agent/post-processor.js';
import { buildDeAiRewritePrompt } from './publish-agent/prompts.js';
import {
  createCoverFormSensor,
  resolveCoverFormModel,
  resolveCoverFormProvider,
} from './publish-agent/cover-form-sensor.js';
import {
  createVisualReferenceAnalyzer,
  resolveReferenceVisualModel,
  resolveReferenceVisualProvider,
} from './publish-agent/visual-reference-analyzer.js';
import {
  createVisualFidelityAuditor,
  resolveVisualAuditModel,
  resolveVisualAuditProvider,
} from './publish-agent/visual-fidelity-auditor.js';
import { createPostImageFormProfileService } from './publish-agent/post-image-form-profile.js';
import { createTextCardRenderer, type TextCardRenderer } from './render/text-card.js';
import type { FirstPostOnboardingCoordinator } from './onboarding/first-post-onboarding-coordinator.js';
import {
  ContentScoutRole,
  ContentTypeSelectorRole,
  ContentCreatorRole,
  ReferenceAnalyzerRole,
  FaithfulRewritePlannerRole,
  FaithfulDraftWriterRole,
  FidelityAuditorRole,
  CategoryClassifierRole,
  VisualReferenceAnalyzerRole,
  CoverCardWriterRole,
  ImageSetPlannerRole,
  ImagePromptComposerRole,
  FacebookMediaSelectorRole,
  ImageGeneratorRole,
  CoverSelectorRole,
  ContentCleanerRole,
  CLEAN_TIMEOUT_MS,
  AiFlavorScorerRole,
  QualityScorerRole,
  ContentAssemblerRole,
  TitleCreatorRole,
  TopicGeneratorRole,
  TopicEvaluatorRole,
  MentionStrategistRole,
  LocationStrategistRole,
  CollectionStrategistRole,
  VisibilityDeciderRole,
  PermissionDeciderRole,
  PublishModeDeciderRole,
  ComplianceDeciderRole,
  MetadataAggregatorRole,
} from './publish-agent/roles/index.js';
import { ApprovalGatekeeperRole } from './publish-agent/roles/approval-gatekeeper.js';
import { PublishExecutorRole } from './publish-agent/roles/publish-executor.js';

// ── 小工具（照抄单体组合根，本进程自持一份；它们是 env 解析而非业务逻辑）─────────────────

function readEnvString(name: string): string | undefined {
  const value = process.env[name];
  return value && value.trim() ? value : undefined;
}

function readEnvPort(name: string): number | undefined {
  const value = readEnvString(name);
  if (!value) return undefined;
  const port = Number(value);
  return Number.isInteger(port) && port > 0 ? port : undefined;
}

/** 解析毫秒超时 env：非有限数 / 低于 1s（surely misconfig）视为非法，回落 fallback（绝不 brick）。 */
function normalizeTimeoutMs(raw: string | undefined, fallback: number): number {
  const n = Number(raw);
  return Number.isFinite(n) && n >= 1_000 ? n : fallback;
}

/**
 * 跨段**前向引用**闸（与单体组合根同形、同措辞）。
 *
 * 形状：内容段在装配期构造一个回调，回调体里读一个由**别的段**赋值的句柄。单体里那一段恒跑，
 * 于是永远读得到；拆成独立进程后同一行就变成读 `undefined`。
 * 此前一律写成 `ctx.X?.doSomething()` —— **缺了就静默短路，调用方照样拿到「成功」**。
 * 本闸不改变有实现时的行为，只把「没实现」那一支从静默改成响亮。
 *
 * MUST NOT 退回裸 `?.`。
 */
function crossSegment<T>(
  handle: T | null | undefined,
  droppedAction: string,
  ownerSegment: string,
  consequence: string,
): T | undefined {
  if (handle !== undefined && handle !== null) return handle;
  console.error(
    `[aidcp-content] cross_segment_drop: ${droppedAction} 未执行` +
      `（该能力由${ownerSegment}构造，本进程未运行该段）—— ${consequence}`,
  );
  return undefined;
}

/**
 * 两个由**别的段**赋值的句柄。本进程不运行那两段，故它们恒为 `undefined`。
 *
 * 显式声明成一组、而不是在各调用点写 `undefined as ...`：那样每个调用点都要重复一遍类型，
 * 也看不出「这是同一批待接的跨段依赖」。批次 3/4 把它们换成真正的跨进程调用时改这里一处。
 */
const uiSnapshot:
  | { pushPublishState(accountId: string, recordId: number, state: string, title?: string): void }
  | undefined = undefined;
const firstPostCoordinator: FirstPostOnboardingCoordinator | undefined = undefined;

function objectKeyPart(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 96) || 'unknown';
}

function createCuratedReferenceImageRelocator(store: ObjectStore) {
  return async (ctx: {
    accountId: string;
    sourceId: string;
    images: CuratedReferenceImage[];
  }): Promise<CuratedReferenceImage[]> => {
    const account = objectKeyPart(ctx.accountId);
    const source = objectKeyPart(ctx.sourceId);
    const out: CuratedReferenceImage[] = [];
    for (let i = 0; i < ctx.images.length; i++) {
      const img = ctx.images[i];
      try {
        const relocated = await relocateImageToStore(
          img.sourceUrl,
          `curated-reference/${account}/${source}/${String(i + 1).padStart(2, '0')}`,
          { store, logger: console },
        );
        if (!relocated) throw new Error('relocation returned empty url');
        out.push({ ...img, ossUrl: relocated, captureStatus: 'stored', capturedAt: Date.now() });
      } catch (err) {
        console.warn(
          '[aidcp-content] curated reference image relocation failed:',
          (err as Error).message,
        );
        out.push({ ...img, captureStatus: 'fetch_failed', capturedAt: img.capturedAt ?? Date.now() });
      }
    }
    return out;
  };
}

/** 本进程内部读 API 的默认端口。与 `aidcp-cloud` 网关侧的 `DEFAULT_CONTENT_READ_API_PORT` 同值。 */
const DEFAULT_CONTENT_READ_API_PORT = 8092;

/** 本仓根目录（迁移目录与边界清单都在这里，MUST 显式传给共享包，见 migration-files.ts 文件头）。 */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 取一条跨进程通道的基址。**缺了直接抛**：内容进程没有它就不成立，
 * 「起来了但大部分不工作」比「没起来」危险得多。
 */
function requireInternalBaseUrl(envName: string, purpose: string): string {
  const url = readEnvString(envName);
  if (!url) {
    throw new Error(
      `${envName}_missing: 内容进程经该地址${purpose}。缺了它本进程无法成立 —— ` +
        '拒绝启动，绝不以「起来了但大部分不工作」的形态运行。',
    );
  }
  return url;
}

function requirePublishApprovalInternalToken(): string {
  const envName = 'AIDCP_PUBLISH_APPROVAL_INTERNAL_TOKEN';
  const token = readEnvString(envName);
  if (!token || /\s/.test(token)) {
    throw new Error(
      `${envName}_missing_or_invalid: content 经内部 HTTP 写 publish approval 必须显式鉴权。` +
        '拒绝启动，绝不回落到未鉴权调用。',
    );
  }
  return token;
}

function requireContentInternalToken(): string {
  const envName = 'AIDCP_CONTENT_INTERNAL_TOKEN';
  const token = readEnvString(envName);
  if (!token || /\s/.test(token)) {
    throw new Error(
      `${envName}_missing_or_invalid: content PersonaGenerator command 必须显式鉴权。` +
        '拒绝启动，绝不回落到未鉴权调用。',
    );
  }
  return token;
}

async function main(): Promise<void> {
  const deploymentTarget = parseDeploymentTarget(readEnvString('AIDCP_DEPLOY_ENV'));
  if (!deploymentTarget) {
    throw new Error(
      'AIDCP_DEPLOY_ENV_missing_or_invalid: content 内部 command 必须绑定 dev/ol target。',
    );
  }
  const contentInternalToken = requireContentInternalToken();
  const publishApprovalInternalToken = requirePublishApprovalInternalToken();

  // ── ① schema 契约门（只判 content 一个属主）──────────────────────────────────────────
  // MUST 跑在任何存储 init() 之前；MUST NOT 包 try/catch（吞掉它等于恢复静默假成功）。
  // 迁移目录与属主清单**显式传本仓的**：共享包被装进 node_modules 之后，它自己那个「往上两级」
  // 的默认基准指向的是包目录，那里没有 migrations/（漏传会撞上包里那道空目录守卫，如实抛错）。
  await runSchemaContractGate({
    owners: ['content'],
    loadScopes: () =>
      loadMigrationOwnerScopes(
        () => loadMigrationFiles(path.join(REPO_ROOT, 'migrations')),
        () => loadTableOwnership(path.join(REPO_ROOT, 'boundaries', 'table-ownership.json')),
      ),
  });

  // ── ② 只对内容库开池 ──────────────────────────────────────────────────────────────
  // 本进程不持有 api / automation 的任何连接 —— 这就是「一个域绝不直连另一个域的数据库」在本仓的形态。
  // token 用量记账用专用小池（热路径隔离 max:4），与单体一致。
  const contentPool = new pg.Pool({ ...resolveOwnerPgConfig('content'), max: 30 });
  const tokenUsagePool = new pg.Pool({ ...resolveOwnerPgConfig('content'), max: 4 });

  // ── ③ 跨进程通道 ─────────────────────────────────────────────────────────────────
  const apiHttp = new InternalHttpClient(
    requireInternalBaseUrl('AIDCP_API_URL', '取模型配置与厂商密钥、写发布台账与管线日志、发审批卡'),
  );
  const automationHttp = new InternalHttpClient(
    requireInternalBaseUrl('AIDCP_AUTOMATION_URL', '判定参照稿是否已被触发过（精选库去重守卫）'),
  );

  // 十条契约的客户端一侧。每条的失败语义**刻意各不相同**，定义在 aidcp-transport 各自文件头：
  // 投递判定 fail-open ／ 台账写原样抛 ／ 管线日志吵闹放过 ／ 卡片出口一律原样抛 ／ 镜像保留上一份好值。
  // 本文件 MUST NOT 在外面再包一层 try/catch 把它们抹平。
  const providerSecretReader = new ProviderSecretHttpClient(apiHttp);
  const publishLogWriter = new PublishLogHttpClient(apiHttp);
  const pipelineLogSink = new PipelineLogHttpClient(apiHttp);
  const publishCardExit: PublishCardExitPort = new PublishCardExitHttpClient(
    apiHttp,
    publishApprovalInternalToken,
  );
  const reviewCardDelivery = new ReviewCardDeliveryHttpClient(apiHttp);
  const resolveReviewCardDelivery = (accountId: string) =>
    reviewCardDelivery.resolveReviewCardDelivery(accountId);
  const accountPlatformReader = new AccountPlatformHttpClient(apiHttp);
  const triggeredPublishRefs = new TriggeredPublishRefsHttpClient(automationHttp);

  // 两条**同步读**改成「异步取源 + 本地镜像」：调用点在热闭包里（每次取图模型 / 每次解析角色模型），
  // 包成 await 一次 HTTP 会改掉每个调用点的签名、还给热路径加一跳网络。
  // 保守默认与属主侧配置存储同源（同一个 kernel 常量），绝不各写一份字面量。
  const imageModelSelection = new PollingImageModelSelectionMirror({
    source: new ImageModelSelectionHttpClient(apiHttp),
    fallback: {
      imageProvider: MODEL_CONFIG_DEFAULTS.imageProvider,
      imageModel: MODEL_CONFIG_DEFAULTS.imageModel,
    },
    logger: console,
  });
  const roleModelSelection = new PollingRoleModelSelectionMirror({
    source: new RoleModelSelectionHttpClient(apiHttp),
    fallback: {
      provider: MODEL_CONFIG_DEFAULTS.textProvider,
      model: MODEL_CONFIG_DEFAULTS.textModel,
    },
    logger: console,
  });
  // start() 内含一次立即刷新：启动期就把两份镜像喂上真值，而不是等第一个轮询周期。
  // 取不到不拒绝启动（保留保守默认 + warn），但下面这行自证会如实说明本次拿到的是真值还是默认。
  await imageModelSelection.start();
  await roleModelSelection.start();
  console.log(
    `[aidcp-content] 模型镜像已就绪：图片=${imageModelSelection.loaded() ? '真值' : '保守默认（取源未成功）'}` +
      ` 角色=${roleModelSelection.loaded() ? '真值' : '保守默认（取源未成功）'}`,
  );

  /**
   * 候审预览读。它唯一的消费者是界面推送口，而那个口由**自动化段**赋值 ⇒ 本进程里恒缺席 ⇒
   * 这条读恒不可达。注入一个**必然拒绝**的实现、而不是删掉它：万一哪天可达性假设被改坏，
   * 要当场响亮失败，而不是悄悄发一次跨进程读。
   */
  const pendingPublishPreviewForAccount = (): Promise<never> =>
    Promise.reject(new Error('pendingPublishPreviewForAccount_unavailable_in_content_service'));

  // ── ④ 本地建：属内容域的出口与存储 ─────────────────────────────────────────────────
  // 密钥经窄读端口向属主域取（provider_credentials 是 api 属主表）。
  // 「读不到 ≠ 没配」：端口契约里缺凭据回 null、读失败必须抛。
  //
  // 下面这个包装是**全进程唯一**允许接住那个抛的地方，代价是必须把两种 null 分开记账：
  // 裸 `.catch(() => null)` 会把「属主侧根本没注册这条 route」这类接线错误，
  // 长期伪装成「库里本来就没配」——链路悄悄走 env 回退、零信号。
  // （这正是本 change A-3 修的活缺口：api 手写 main 此前漏注册这两条 route。）
  const secretReadFailures: string[] = [];
  let secretReadHits = 0;
  const readOwnerSecret = async (provider: string, field: string): Promise<string | null> => {
    try {
      const value = await providerSecretReader.getSecretForRuntime(provider, field);
      if (value) secretReadHits += 1;
      return value;
    } catch (error) {
      secretReadFailures.push(`${provider}/${field}`);
      console.warn(
        `[aidcp-content] 厂商密钥读失败（${provider}/${field}）⇒ 本次回落 env；` +
          `这**不代表**库里没配：${(error as Error).message}`,
      );
      return null;
    }
  };

  const dashscopeApiKey =
    (await readOwnerSecret('dashscope', 'dashscope_api_key')) ?? readEnvString('DASHSCOPE_API_KEY');

  const ossAccessKeyId =
    (await readOwnerSecret('oss', 'access_key_id')) ?? readEnvString('OSS_ACCESS_KEY_ID');
  const ossAccessKeySecret =
    (await readOwnerSecret('oss', 'access_key_secret')) ?? readEnvString('OSS_ACCESS_KEY_SECRET');
  const ossRegion = readEnvString('OSS_REGION') ?? 'oss-cn-beijing';
  const ossBucket = readEnvString('OSS_BUCKET') ?? 'aidcp';
  const ossInternal = readEnvString('OSS_INTERNAL') === 'true';
  let ossUploader: ObjectStore | undefined;
  if (ossAccessKeyId && ossAccessKeySecret) {
    try {
      // 动态载入：仅在配了 OSS 凭据时才把 ali-oss 依赖树拉进进程（未配置时零加载、零回归）。
      const { createOssObjectStore } = await import('./storage/oss-client-factory.js');
      ossUploader = createOssObjectStore({
        accessKeyId: ossAccessKeyId,
        accessKeySecret: ossAccessKeySecret,
        bucket: ossBucket,
        region: ossRegion,
        internal: ossInternal,
      });
      console.log(
        `[aidcp-content] OSS 对象存储已就绪（bucket=${ossBucket} region=${ossRegion} internal=${ossInternal}）：配图将转存到稳定公网链接`,
      );
    } catch (err) {
      console.warn(
        '[aidcp-content] OSS 客户端构造失败（配图回退 provider 临时 URL、零回归）:',
        (err as Error).message,
      );
    }
  } else {
    console.log('[aidcp-content] 未配置 OSS 凭据，配图沿用 provider 临时 URL');
  }

  // provider 运行时映射：每文本厂商 key 启动期一次性取（属主域优先、回退 env），
  // baseUrl 取注册表默认或 env 覆盖。明文只用于构造文本出口，绝不日志化、绝不回前端。
  const providerRuntime: Record<string, { baseUrl: string; apiKey: string }> = {};
  for (const id of Object.keys(TEXT_PROVIDERS) as TextProviderId[]) {
    const meta = TEXT_PROVIDERS[id];
    const remoteKey = await readOwnerSecret(id, meta.credentialField);
    providerRuntime[id] = {
      baseUrl: resolveProviderBaseUrl(id),
      apiKey: remoteKey ?? resolveProviderEnvKey(id) ?? '',
    };
  }
  // 自证行，与上面两份模型镜像那行同形：把「库内取到了几项」与「读失败了几项」当场分开说清。
  // 读失败**不拒绝启动**（属主域抖一下就停掉整个内容进程是过度反应），但绝不许静默。
  console.log(
    `[aidcp-content] 库内厂商密钥读：命中 ${secretReadHits} 项` +
      (secretReadFailures.length === 0
        ? '，无读失败'
        : `，读失败 ${secretReadFailures.length} 项（${secretReadFailures.join(' ')}）` +
          ' ⇒ 这些项本次走的是 env 回退，不是「库里没配」，请查属主侧这两条 route 是否可达'),
  );

  // 四层回落在属主侧已经算完，本进程只查本地镜像（**不复刻回落逻辑** —— 复刻正是两侧悄悄不一致的来源）。
  const resolveModelForRole = (role?: string): string => roleModelSelection.forRole(role).model;
  const resolveProviderForRole = (role?: string): string => roleModelSelection.forRole(role).provider;
  const resolveTempForRole = (role?: string): number | undefined =>
    roleModelSelection.forRole(role).temperature;
  const resolveThinkingForRole = (role?: string): ThinkingMode | undefined =>
    roleModelSelection.forRole(role).thinkingMode;

  const tokenUsageStore = new TokenUsageStore({
    pool: tokenUsagePool,
    schemaEnsurer: ensureCapabilitySchema,
  });
  try {
    await tokenUsageStore.init();
    console.log(
      '[aidcp-content] token 用量记账已就绪（llm_token_usage，按账号/角色/模型/10分钟桶预聚合）',
    );
  } catch (err) {
    console.warn(
      '[aidcp-content] token 用量记账初始化失败（用量将不落库，绝不影响 LLM 调用）:',
      (err as Error).message,
    );
  }

  const flushTokenUsageOnExit = (sig: string): void => {
    console.log(`[aidcp-content] 收到 ${sig}，flush token 用量后退出`);
    imageModelSelection.stop();
    roleModelSelection.stop();
    void Promise.race([
      tokenUsageStore.close().catch(() => {}),
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]).finally(() => process.exit(0));
  };
  process.once('SIGTERM', () => flushTokenUsageOnExit('SIGTERM'));
  process.once('SIGINT', () => flushTokenUsageOnExit('SIGINT'));

  const llm = new QwenClient({
    apiKey: dashscopeApiKey, // 构造默认（仅未注入 providerRuntime 的旧路径用；生产恒走 providerRuntime）
    timeoutMs: normalizeTimeoutMs(process.env.AIDCP_LLM_TIMEOUT_MS, 180_000),
    getModel: resolveModelForRole,
    getTemperature: resolveTempForRole,
    getProvider: resolveProviderForRole,
    getThinking: resolveThinkingForRole,
    providerRuntime,
    onStart: (info) => {
      console.log(
        `[llm.start] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} timeoutMs=${info.timeoutMs}`,
      );
    },
    onCall: (info) => {
      console.log(
        `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0} stage=${info.stage} timedOut=${info.timedOut} requestId=${info.requestId ?? '-'}`,
      );
      try {
        tokenUsageStore.add(info);
      } catch {
        /* metrics never breaks llm */
      }
    },
  });
  const personaGeneratorAuthority = new PersonaGeneratorCommandReceiver(
    new PersonaGenerator({
      llm,
      soulCodec: PERSONA_SOUL_CODEC,
    }),
  );

  // 精选灵感语料（内容属主表）。去重守卫经 automation 域的窄端口问；读不到时属主侧契约是**抛**，
  // 绝不回空集合冒充「一条都没用过」（那会让每条用过的参照稿重新变成可用、同一份来稿被反复洗）。
  //
  // `onSourceAdmitted` 走响亮闸：首作进度协调器本体建在 **api 段**（它要读首作状态表与发布台账的
  // 待审计数，两张都是 api 属主表），本进程里恒缺席。保留这个回调而不是干脆省掉它 ——
  // 省掉会让「首作进度停住」完全没有痕迹。
  let curatedContentStore: CuratedContentStore | undefined;
  try {
    const ccs = new CuratedContentStore({
      schemaEnsurer: ensureCapabilitySchema,
      pool: contentPool,
      triggeredRefsReader: () => triggeredPublishRefs,
      ...(ossUploader
        ? { referenceImageRelocator: createCuratedReferenceImageRelocator(ossUploader) }
        : {}),
      onSourceAdmitted: (source: CuratedSourceAdmission) =>
        void crossSegment(
          firstPostCoordinator,
          `账号 ${source.accountId} 的首作进度推进（精选源准入）`,
          'api 段',
          '该账号的「首次人设 → 首条精选 → 参照创作」进度会停在旧值，须由 api 进程侧承接',
        )?.onSourceAdmitted(source),
      logger: console,
      ...(deploymentTarget ? { executionTarget: deploymentTarget } : {}),
    });
    await ccs.init();
    curatedContentStore = ccs;
    console.log('[aidcp-content] CuratedContentStore 已就绪（curated_content 表）');
  } catch (err) {
    console.warn(
      '[aidcp-content] CuratedContentStore 初始化失败，精选灵感语料退化:',
      (err as Error).message,
    );
  }

  // FB 发帖素材池（内容属主表）。账号校验经 api 域的账号平台窄读口（缺账号返 null 是**答案**）。
  let facebookPublishMediaStore: FacebookPublishMediaStore | undefined;
  try {
    const store = new FacebookPublishMediaStore({
      schemaEnsurer: ensureCapabilitySchema,
      pool: contentPool,
      accountPlatformReader: () => accountPlatformReader,
      objectStore: ossUploader,
    });
    await store.init();
    facebookPublishMediaStore = store;
    console.log(
      '[aidcp-content] FacebookPublishMediaStore 已就绪（account_facebook_publish_image_set / image）',
    );
  } catch (err) {
    console.warn(
      '[aidcp-content] FacebookPublishMediaStore 初始化失败，FB 发帖素材池不可用:',
      (err as Error).message,
    );
  }

  // 概念池（内容属主表 concepts）。本进程自己**不消费**它——浏览闭环与发帖调度器都在自动化进程里，
  // 它在这里存在的唯一理由就是给下面那组跨属主路由当属主实例。
  // init 失败留 undefined：只关掉概念池那一组路由，automation 侧会读到具名的「不支持这个方法」而不是空池。
  let conceptStore: ConceptStore | undefined;
  try {
    const cs = new ConceptStore({ schemaEnsurer: ensureCapabilitySchema, pool: contentPool });
    await cs.init();
    conceptStore = cs;
    console.log('[aidcp-content] ConceptStore 已就绪（concepts 表）');
  } catch (err) {
    console.warn('[aidcp-content] ConceptStore 初始化失败，概念池跨进程读写不可用:', (err as Error).message);
  }

  // 图片总开关：任一图片厂商密钥就绪即启用（选中厂商若缺密钥，其客户端会诚实失败 → 该张记 M 少一张、不假成功）。
  const arkRuntime = providerRuntime['volcengine'];
  const anyImageKeyPresent =
    !!(readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey) || !!arkRuntime?.apiKey;

  // ── ⑤ 内容管线装配（原 segBContent 逐字搬）──────────────────────────────────────────

  // 发布链 token 账号归属：每个发布角色的 LLM 调用从当轮黑板显式带 accountId，并发生成各轮各归各账。
  // 红线：MUST NOT 重新引入共享可变槽推断当前账号（并发轮互踩记账）。
  const roleLlm = (roleId: string): ChatLlmClient => ({
    complete: (prompt, opts) => llm.complete(prompt, { ...opts, role: opts?.role ?? roleId }),
    chat: (messages, opts) => llm.chat(messages, { ...opts, role: opts?.role ?? roleId }),
  });

  // 去 AI 味后处理器。带 role 使该重写按后台模型/温度配置解析（否则配了是静默 no-op）；
  // 与 ContentCleaner 角色闸共用同一超时（外层秒表绝不短于所包裹的模型预算）。
  const postProcessor = new PostProcessor({
    rewrite: async (content, flagged, accountId) =>
      llm.complete(buildDeAiRewritePrompt(content, flagged), {
        role: 'publish:ContentCleaner',
        timeoutMs: CLEAN_TIMEOUT_MS,
        accountId,
      }),
  });

  // 通义万相客户端（图片生成）。万相文生图与 Qwen 同属阿里云百炼、同一 DashScope key。
  const wanxiangClient = new WanxiangClient({
    apiKey: readEnvString('WANXIANG_API_KEY') ?? dashscopeApiKey,
    getModel: () => imageModelSelection.current().imageModel,
    maxPollAttempts: Number(process.env.AIDCP_WANXIANG_MAX_POLL ?? 34),
  });

  // 即梦-Seedream 客户端（图片生成，火山方舟 Ark 同步）：复用启动期已载入的火山 key+base；imageModel 热加载。
  const seedreamClient = new SeedreamClient({
    apiKey: arkRuntime?.apiKey || undefined,
    baseUrl: arkRuntime?.baseUrl || undefined,
    getModel: () => imageModelSelection.current().imageModel,
    timeoutMs: Number(process.env.AIDCP_SEEDREAM_TIMEOUT_MS ?? 60_000),
  });

  // 图片出口：按全局 image_provider 路由，热加载、缺密钥诚实失败不跨厂商兜底。
  const imageProvider = new RoutingImageProvider({
    getProvider: () => imageModelSelection.current().imageProvider,
    providers: { dashscope: wanxiangClient, volcengine: seedreamClient },
  });

  // 发布编排器：只跑生成候审段（生成终稿 + 落库待审 + 发审批卡）。
  // 总闸须 ≥ 关键路径各模型角色预算之和（容器不得小于内容物）。
  const publishOrchestrator = new PublishOrchestrator({
    logger: console,
    pipelineTimeoutMs: normalizeTimeoutMs(process.env.AIDCP_PUBLISH_PIPELINE_TIMEOUT_MS, 600_000),
    pipelineLogSink,
  });

  // 用量上报接线点②（视觉 LLM 出口）。
  const recordVisionCall = (info: VisionCallInfo): void => {
    console.log(
      `[llm] account=${info.accountId ?? '-'} role=${info.role ?? '-'} provider=${info.provider ?? '-'} model=${info.model} ms=${info.ms} ok=${info.ok} tokens=${info.totalTokens ?? 0}`,
    );
    try {
      tokenUsageStore.add(info);
    } catch {
      /* metrics never breaks llm */
    }
  };

  // ── 封面形态链路装配：双旗标默认关，全关=与现版逐字一致 ──
  const coverFormVision = new OpenAiCompatVisionClient({
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
    providerRuntime,
    onCall: recordVisionCall,
  });
  const coverFormSensor = createCoverFormSensor({
    vision: coverFormVision,
    enabled: () => process.env.AIDCP_COVER_FORM_SENSING === 'true',
    ...(curatedContentStore
      ? { annotate: curatedContentStore.annotateReferenceImageFormGuess.bind(curatedContentStore) }
      : {}),
    getModel: resolveCoverFormModel,
    getProvider: resolveCoverFormProvider,
  });
  const referenceVisualVision = new OpenAiCompatVisionClient({
    getModel: resolveReferenceVisualModel,
    getProvider: resolveReferenceVisualProvider,
    providerRuntime,
    onCall: recordVisionCall,
    timeoutMs: Number(process.env.AIDCP_REFERENCE_VISUAL_TIMEOUT_MS ?? 120_000),
  });
  const visualReferenceAnalyzer = createVisualReferenceAnalyzer({
    vision: referenceVisualVision,
    enabled: () => process.env.AIDCP_REFERENCE_VISUAL_ANALYSIS === 'true',
    getModel: resolveReferenceVisualModel,
    getProvider: resolveReferenceVisualProvider,
    ...(curatedContentStore
      ? { annotate: curatedContentStore.annotateReferenceVisualAnalysis.bind(curatedContentStore) }
      : {}),
    logger: console,
  });
  const visualAuditVision = new OpenAiCompatVisionClient({
    getModel: resolveVisualAuditModel,
    getProvider: resolveVisualAuditProvider,
    providerRuntime,
    onCall: recordVisionCall,
    timeoutMs: Number(process.env.AIDCP_VISUAL_AUDIT_TIMEOUT_MS ?? 60_000),
  });
  const visualFidelityAuditor = createVisualFidelityAuditor({ vision: visualAuditVision });
  const postFormProfileService = createPostImageFormProfileService({
    senseAt: (ref, arrayIndex) => coverFormSensor.senseAt!(ref, arrayIndex),
    enabled: () => process.env.AIDCP_POST_FORM_PROFILE === 'true',
    logger: console,
  });
  // 渲染出口：lazy 工厂只在渲染旗标开时初始化（关=零加载零成本）；工厂失败→null，text_card 请求诚实降级生成式。
  let textCardRenderer: TextCardRenderer | null = null;
  if (
    process.env.AIDCP_PUBLISH_TEXTCARD_COVER === 'true' ||
    process.env.AIDCP_PUBLISH_TEXTCARD_CAROUSEL === 'true'
  ) {
    void createTextCardRenderer({ logger: console })
      .then((r) => {
        textCardRenderer = r;
        console.log(
          r
            ? '[aidcp-content] 文字卡渲染出口已就绪（satori+resvg+字体校验通过）'
            : '[aidcp-content] 文字卡渲染出口不可用（工厂返回 null），封面按生成式降级',
        );
      })
      .catch((err) => {
        console.warn('[aidcp-content] 文字卡渲染工厂异常（封面按生成式降级）:', (err as Error).message);
      });
  }

  // 注册发布编排器的生产段角色。注册顺序无关正确性（黑板靠键就绪触发），按拓扑排列便于阅读。
  publishOrchestrator.registerRole(new ContentScoutRole({ llmClient: roleLlm('publish:ContentScout') }));
  publishOrchestrator.registerRole(new ContentTypeSelectorRole());
  publishOrchestrator.registerRole(
    new ContentCreatorRole({ llmClient: roleLlm('publish:ContentCreator') }),
  );
  publishOrchestrator.registerRole(
    new ReferenceAnalyzerRole({ llmClient: roleLlm('publish:ReferenceAnalyzer') }),
  );
  publishOrchestrator.registerRole(
    new FaithfulRewritePlannerRole({ llmClient: roleLlm('publish:FaithfulRewritePlanner') }),
  );
  publishOrchestrator.registerRole(
    new FaithfulDraftWriterRole({ llmClient: roleLlm('publish:FaithfulDraftWriter') }),
  );
  publishOrchestrator.registerRole(
    new FidelityAuditorRole({ llmClient: roleLlm('publish:FidelityAuditor') }),
  );
  publishOrchestrator.registerRole(
    new CategoryClassifierRole({ llmClient: roleLlm('publish:CategoryClassifier') }),
  );
  publishOrchestrator.registerRole(
    new VisualReferenceAnalyzerRole(visualReferenceAnalyzer, { logger: console }),
  );
  publishOrchestrator.registerRole(
    new CoverCardWriterRole({
      llmClient: roleLlm('publish:CoverCardWriter'),
      sensor: coverFormSensor,
      profileService: postFormProfileService,
      renderEnabled: () =>
        process.env.AIDCP_PUBLISH_TEXTCARD_COVER === 'true' ||
        process.env.AIDCP_PUBLISH_TEXTCARD_CAROUSEL === 'true',
      carouselEnabled: () => process.env.AIDCP_PUBLISH_TEXTCARD_CAROUSEL === 'true',
      rendererAvailable: () => textCardRenderer !== null,
      getTextCardRenderer: () => textCardRenderer,
      ossAvailable: () => !!ossUploader,
    }),
  );
  publishOrchestrator.registerRole(
    new ImageSetPlannerRole({ llmClient: roleLlm('publish:ImageSetPlanner') }),
  );
  publishOrchestrator.registerRole(
    new ImagePromptComposerRole({ llmClient: roleLlm('publish:ImagePromptComposer') }),
  );
  if (facebookPublishMediaStore) {
    publishOrchestrator.registerRole(
      new FacebookMediaSelectorRole({ mediaStore: facebookPublishMediaStore, logger: console }),
    );
  }
  publishOrchestrator.registerRole(
    new ImageGeneratorRole({
      imageProvider,
      getProvider: () => imageModelSelection.current().imageProvider,
      getModel: () => imageModelSelection.current().imageModel,
      // 用量上报接线点③（图片生成出口）：经 TokenUsageStore 单一接口写归 llm_token_usage，MUST NOT 直写。
      usageRecorder: (info) => {
        console.log(
          `[image] account=${info.accountId} role=publish:ImageGenerator provider=${info.provider} model=${info.model} ok=${info.ok}`,
        );
        try {
          tokenUsageStore.add({
            accountId: info.accountId,
            role: 'publish:ImageGenerator',
            provider: info.provider,
            model: info.model,
            ok: info.ok,
            promptTokens: 0,
            completionTokens: 0,
            totalTokens: 0,
          });
        } catch {
          /* metrics never breaks image generation */
        }
      },
      enableImageGeneration: anyImageKeyPresent,
      ossUploader,
      getTextCardRenderer: () => textCardRenderer,
      visualAuditor: visualFidelityAuditor,
      auditEnabled: () => process.env.AIDCP_VISUAL_FIDELITY_AUDIT === 'true',
      autonomousAuditEnabled: () => process.env.AIDCP_AUTONOMOUS_VISUAL_AUDIT === 'true',
    }),
  );
  publishOrchestrator.registerRole(new CoverSelectorRole());
  publishOrchestrator.registerRole(new ContentCleanerRole({ postProcessor }));
  publishOrchestrator.registerRole(new AiFlavorScorerRole());
  publishOrchestrator.registerRole(
    new QualityScorerRole({ llmClient: roleLlm('publish:QualityScorer') }),
  );
  publishOrchestrator.registerRole(new ContentAssemblerRole());
  publishOrchestrator.registerRole(new TitleCreatorRole({ llmClient: roleLlm('publish:TitleCreator') }));
  publishOrchestrator.registerRole(
    new TopicGeneratorRole({ llmClient: roleLlm('publish:TopicGenerator') }),
  );
  publishOrchestrator.registerRole(
    new TopicEvaluatorRole({ llmClient: roleLlm('publish:TopicEvaluator') }),
  );
  publishOrchestrator.registerRole(new MentionStrategistRole());
  publishOrchestrator.registerRole(new LocationStrategistRole());
  publishOrchestrator.registerRole(new CollectionStrategistRole());
  publishOrchestrator.registerRole(new VisibilityDeciderRole());
  publishOrchestrator.registerRole(new PermissionDeciderRole());
  publishOrchestrator.registerRole(new PublishModeDeciderRole());
  publishOrchestrator.registerRole(new ComplianceDeciderRole());
  publishOrchestrator.registerRole(new MetadataAggregatorRole());
  publishOrchestrator.registerRole(
    new ApprovalGatekeeperRole({ llmClient: roleLlm('publish:ApprovalGatekeeper') }),
  );
  publishOrchestrator.registerRole(
    new PublishExecutorRole({
      store: {
        async insert(record) {
          return publishLogWriter.insert({
            title: record.title,
            content: record.content,
            // 真血缘：用 executor 计算的真概念/真点赞 id（无则空数组），不再用 tags / [] 充数。
            sourceConcepts: record.sourceConcepts ?? [],
            sourceLikedIds: record.sourceLikedIds ?? [],
            status: record.status as
              | 'draft'
              | 'pending_approval'
              | 'scheduled'
              | 'submitted'
              | 'published'
              | 'failed'
              | 'needs_review',
            // 审计用 image_url（封面=首张）+ 多图全集；真实附着数插入时 0，上传成功后由 markImagesAttached 置真实 K。
            imageUrl: record.imageUrl,
            imageUrls: record.images,
            accountId: record.accountId,
            platform: record.platform,
            sourceReference: record.sourceReference ?? null,
          });
        },
        async updateStatus(id, status) {
          await publishLogWriter.updateStatus!(
            id,
            status as
              | 'draft'
              | 'pending_approval'
              | 'scheduled'
              | 'submitted'
              | 'published'
              | 'failed'
              | 'needs_review',
          );
        },
        async recordMetadata(id, metadata, aiEnforced) {
          await publishLogWriter.recordMetadata!(id, metadata, aiEnforced);
        },
        async markImagesAttached(id, count) {
          await publishLogWriter.markImagesAttached!(id, count);
        },
      },
      // 卡片出口：发卡 / 默认群 / 落点解析 / 免审预授权四样是同一个端口，实现全在属主域。
      messenger: publishCardExit,
      botChatStore: publishCardExit,
      resolveCardChatId: publishCardExit.resolveCardChatId,
      resolveReviewCardDelivery,
      writeApprovalSignal: publishCardExit.writeApprovalSignal,
      /** 陪伴界面推送同理由自动化段承接；一次通知里共用一次取用 —— 缺席只喊一次，别把同一个事实记两条。 */
      notifyPublishPending: (accountId, recordId, title) => {
        const snapshot = crossSegment(
          uiSnapshot,
          `账号 ${accountId} 稿件 ${recordId} 的候审界面推送`,
          '自动化段',
          '客户端不会自动展开到「等你确认」，须由自动化进程侧承接推送',
        );
        snapshot?.pushPublishState(accountId, recordId, 'pending', title);
        // 取用不到就到此为止，**不再去读那次预览**：预览的唯一消费者就是上面这个推送口，
        // 它缺席时读回来的东西没有任何去处，而那会是一次跨进程读。为恒缺席的消费者开契约是纯亏。
        if (!snapshot) return;
        void pendingPublishPreviewForAccount();
      },
      roleTimeoutMs: Number(process.env.AIDCP_PUBLISH_ROLE_TIMEOUT_MS ?? 30_000),
    }),
  );
  console.log(
    `[aidcp-content] PublishOrchestrator 已就绪，角色: ${publishOrchestrator.getRoles().join(', ')}`,
  );

  // ── ⑥ 对外：内部 HTTP API ──────────────────────────────────────────────────────────
  // Persona command + 精选库只读端点 + 发布队列状态读 + 发布生成触发。
  // 每项 capability 独立注册：精选库缺失不得连带关闭 persona 或 publish。
  const httpServer = new InternalHttpServer();
  const registered: string[] = [];
  registerPersonaGeneratorCommandRoutes(
    httpServer,
    personaGeneratorAuthority,
    contentInternalToken,
    deploymentTarget,
  );
  registered.push('persona-generator');
  if (curatedContentStore) {
    registerCuratedContentRoutes(httpServer, curatedContentStore);
    registered.push('curated-content');
  } else {
    console.warn('[aidcp-content] curated-content 路由未注册（精选库初始化失败）');
  }
  // automation → content 的两条属主端口。**各注册各的**：概念池表缺了不该连带关掉精选召回，反之亦然。
  // 两组共用 content 的内部令牌与本进程的部署 target（DEV/OL 长期共库，target 由服务端这一侧钉死，
  // 调用方没有任何入口能挑它）。
  if (conceptStore) {
    registerConceptPoolAuthorityRoutes(
      httpServer,
      conceptStore,
      contentInternalToken,
      deploymentTarget,
    );
    registered.push('concept-pool-authority');
  } else {
    console.warn('[aidcp-content] concept-pool-authority 路由未注册（ConceptStore 初始化失败）');
  }
  if (curatedContentStore) {
    registerCuratedSelectionAuthorityRoutes(
      httpServer,
      curatedContentStore,
      contentInternalToken,
      deploymentTarget,
    );
    registered.push('curated-selection-authority');
  } else {
    console.warn('[aidcp-content] curated-selection-authority 路由未注册（精选库初始化失败）');
  }
  // ── automation → content 的另外三条属主端口 ────────────────────────────────────
  // **它们的服务端一侧此前只活在单体里。** 单体那份注释早就预言过后果：
  // 「MUST NOT 因为『现在没人调』就不注册：那会让第 3 段写 main() 时才发现对面根本没有这条路由」——
  // 而这件事真的发生了，只是发生在**本仓这份手写入口**上，不是单体上：
  // 自动化进程的真装配（批 H 第 5 片）把这三个客户端接了上去，本进程却一条都没在服务。
  // 客户端建得出来、调用编译得过、跑起来才 404，且那是**跨进程**的 404 —— 最难查的一种。
  //
  // 形态照单体逐条办：**各注册各的 + 缺实例即具名 warn**。
  // 绝不注册一条「属主不在就静默成功」的空路由：那会把「素材没被回收」画成「素材本来就没有」。
  if (curatedContentStore) {
    registerCuratedWriteAuthorityRoutes(
      httpServer,
      curatedContentStore,
      contentInternalToken,
      deploymentTarget,
    );
    registered.push('curated-write-authority');
  } else {
    console.warn('[aidcp-content] curated-write-authority 路由未注册（精选库初始化失败）');
  }
  if (facebookPublishMediaStore) {
    registerFacebookPublishMediaAuthorityRoutes(
      httpServer,
      facebookPublishMediaStore,
      contentInternalToken,
      deploymentTarget,
    );
    registered.push('facebook-publish-media-authority');
  } else {
    console.warn(
      '[aidcp-content] facebook-publish-media-authority 路由未注册'
        + '（FacebookPublishMediaStore 不可用）—— 预留释放 / 标记已用 / 隔离三个写在三进程形态下会 404',
    );
  }
  // 用量记账：**今天还没有调用方**（自动化侧的合并缓冲属 tasks 2.4d-用量，未开工）。
  // 照样注册，理由同上那段：让「对面接得住」先成立，别等写调用方时才发现路由不存在。
  registerLlmUsageRecordingAuthorityRoutes(
    httpServer,
    tokenUsageStore,
    contentInternalToken,
    deploymentTarget,
  );
  registered.push('llm-usage-recording-authority');
  registerPublishStatusRoutes(httpServer, {
    getStatus: () => Promise.resolve(publishOrchestrator.getStatus()),
  });
  registerPublishGenerationRoutes(httpServer, publishOrchestrator);
  registered.push('publish-status', 'publish-generation');
  const actual = await httpServer.listen(
    readEnvPort('AIDCP_CONTENT_PORT') ?? DEFAULT_CONTENT_READ_API_PORT,
  );
  console.log(`[aidcp-content] 内部读 API 已监听 127.0.0.1:${actual}（${registered.join(' + ')} 端点）`);
}

main().catch((err) => {
  console.error('[aidcp-content] 启动失败:', err);
  process.exit(1);
});
