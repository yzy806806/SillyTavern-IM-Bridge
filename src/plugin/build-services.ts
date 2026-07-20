import { CharacterService } from "../core/services/character-service";
import { ChatEditService } from "../core/services/chat-edit-service";
import { CompressionService } from "../core/services/compression-service";
import { ConversationService } from "../core/services/conversation-service";
import { ModelService } from "../core/services/model-service";
import { SessionService } from "../core/services/session-service";
import { SessionTaskQueue } from "../core/services/session-task-queue";
import { AccountConfigService } from "../core/services/account-config-service";
import { BindCodeService } from "../core/services/bind-code-service";
import { BotManager } from "../core/services/bot-manager";
import { CompressionClient } from "../infra/llm/compression-client";
import { createSqlitePersistence } from "../infra/persistence/sqlite-store";
import { StClient } from "../infra/st/st-client";
import {
  type BotInstanceContext,
  type BotRuntimeConfig,
  registerHandlers,
} from "../delivery/telegram/handlers";
import type { TelegramSender } from "../delivery/telegram/telegram-sender";
import type { TelegramChatQueue, TelegramChatQueueOptions } from "../delivery/telegram/telegram-chat-queue";
import { loadRuntimeContext, type RuntimeContext } from "./runtime-context";
import { SseRegistry } from "./sse-registry";

const DEFAULT_BOT_RUNTIME_CONFIG: BotRuntimeConfig = {
  pageSize: 8,
  tgStreamMinRenderIntervalMs: 5000,
  tgStreamMinDeltaChars: 700,
  tgStreamFirstRenderMinChars: 300,
  tgStreamHardChunkSize: 3200,
  tgStreamProgressSingleMessageOnly: true,
  tgDisableProgressWhenDegraded: true,
};

export interface AppServices {
  runtime: RuntimeContext;
  stClient: StClient;
  characterService: CharacterService;
  sessionService: SessionService;
  conversationService: ConversationService;
  chatEditService: ChatEditService;
  modelService: ModelService;
  compressionService: CompressionService;
  accountConfigService: AccountConfigService;
  bindCodeService: BindCodeService;
  botManager: BotManager;
  repositories: ReturnType<typeof createSqlitePersistence>;
  sseRegistry: SseRegistry;
}

export function buildServices(): AppServices {
  const runtime = loadRuntimeContext();
  const repositories = createSqlitePersistence(runtime.databasePath);
  const stClient = new StClient({
    baseUrl: runtime.stInternalBaseUrl,
    hostHeader: runtime.stHostHeader,
    timeoutMs: runtime.stTimeoutMs,
    generateTimeoutMs: runtime.stGenerateTimeoutMs,
    generateIdleTimeoutMs: runtime.stGenerateIdleTimeoutMs,
  });
  const sessionService = new SessionService(repositories.sessionRepository);
  const sessionTaskQueue = new SessionTaskQueue();
  const conversationService = new ConversationService(stClient, sessionTaskQueue);
  const chatEditService = new ChatEditService(stClient, conversationService, sessionTaskQueue, repositories.historySyncRepository);
  const modelService = new ModelService(stClient, repositories.sessionRepository);

  const compressionClient = new CompressionClient(stClient, {
    timeoutMs: 60000,
    batchSize: 5,
    retryCount: 3,
    retryDelayMs: 1500,
  });
  const compressionService = new CompressionService(
    stClient,
    compressionClient,
    sessionTaskQueue,
    repositories.historySyncRepository,
    repositories.accountConfigRepository,
    { keepRecent: 15, batchSize: 5, timeoutMs: 60000, retryCount: 3, retryDelayMs: 1500 },
  );

  const accountConfigService = new AccountConfigService(
    repositories.accountRepository,
    repositories.accountConfigRepository,
  );
  const bindCodeService = new BindCodeService(
    repositories.bindCodeRepository,
    accountConfigService,
  );

  const services: Omit<AppServices, "botManager"> & { botManager?: BotManager } = {
    runtime,
    stClient,
    characterService: new CharacterService(stClient),
    sessionService,
    conversationService,
    chatEditService,
    modelService,
    compressionService,
    accountConfigService,
    bindCodeService,
    repositories,
    sseRegistry: new SseRegistry(),
  };

  const botManager = new BotManager({
    configRepo: repositories.accountConfigRepository,
    resolveHandle: (accountId) => repositories.accountRepository.getSTUserAccount(accountId)?.stUserHandle ?? null,
    buildRuntimeConfig: (cfg): BotRuntimeConfig => ({
      ...DEFAULT_BOT_RUNTIME_CONFIG,
      pageSize: runtime.pageSize,
      tgStreamMinRenderIntervalMs: cfg.tg.streamMinIntervalMs ?? DEFAULT_BOT_RUNTIME_CONFIG.tgStreamMinRenderIntervalMs,
      tgStreamMinDeltaChars: cfg.tg.streamMinDeltaChars ?? DEFAULT_BOT_RUNTIME_CONFIG.tgStreamMinDeltaChars,
    }),
    buildQueueOptions: (cfg): TelegramChatQueueOptions => ({
      interMessageDelayMs: cfg.tg.interMessageDelayMs,
      ...(cfg.tg.advanced as Partial<TelegramChatQueueOptions>),
    }),
    registerBot: (bot, botCtx: BotInstanceContext, sender: TelegramSender, _queue: TelegramChatQueue) => {
      botCtx.sender = sender;
      registerHandlers(bot, services as AppServices, botCtx);
    },
  });
  services.botManager = botManager;
  return services as AppServices;
}
