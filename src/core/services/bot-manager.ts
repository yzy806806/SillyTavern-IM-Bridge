import { Bot } from "grammy";
import type { AccountConfigRecord, AccountConfigRepository } from "../ports/repositories";
import { AppError } from "../../shared/errors/app-error";
import { nowIso } from "../../shared/utils/time";
import {
  BOT_COMMANDS,
  BOT_DESCRIPTION,
  BOT_SHORT_DESCRIPTION,
} from "../../delivery/telegram/commands";
import {
  registerHandlers,
  type BotInstanceContext,
  type BotRuntimeConfig,
} from "../../delivery/telegram/handlers";
import {
  TelegramSender,
} from "../../delivery/telegram/telegram-sender";
import {
  TelegramChatQueue,
  type TelegramChatQueueOptions,
} from "../../delivery/telegram/telegram-chat-queue";
import { buildBotFetchAgent } from "../../infra/proxy/proxy-agent";

export type BotStatus = "starting" | "running" | "stopping" | "stopped" | "error";

export interface BotEntry {
  accountId: string;
  handle: string | null;
  bot: Bot;
  sender: TelegramSender;
  queue: TelegramChatQueue;
  startedAt: string;
  username: string | null;
  lastError: string | null;
  status: BotStatus;
}

export interface BotManagerDependencies {
  configRepo: AccountConfigRepository;
  resolveHandle: (accountId: string) => string | null;
  buildRuntimeConfig: (cfg: AccountConfigRecord) => BotRuntimeConfig;
  buildQueueOptions: (cfg: AccountConfigRecord) => TelegramChatQueueOptions;
  registerBot: (
    bot: Bot,
    botCtx: BotInstanceContext,
    sender: TelegramSender,
    queue: TelegramChatQueue,
  ) => void;
}

export class BotManager {
  private readonly entries = new Map<string, BotEntry>();
  private readonly deps: BotManagerDependencies;

  public constructor(deps: BotManagerDependencies) {
    this.deps = deps;
  }

  public list(): BotEntry[] {
    return [...this.entries.values()];
  }

  public get(accountId: string): BotEntry | null {
    return this.entries.get(accountId) ?? null;
  }

  public async startBot(accountId: string): Promise<BotEntry> {
    if (this.entries.has(accountId)) {
      throw new AppError("BOT_ALREADY_RUNNING", "Bot 已在运行", 409);
    }
    const cfg = this.deps.configRepo.get(accountId);
    if (!cfg) {
      throw new AppError("ACCOUNT_CONFIG_MISSING", "账号配置缺失", 404);
    }
    if (!cfg.telegramBotToken) {
      throw new AppError("BOT_TOKEN_MISSING", "请先配置 bot token", 400);
    }
    const queue = new TelegramChatQueue(this.deps.buildQueueOptions(cfg));
    const sender = new TelegramSender(queue, { enableOutboundLogs: true });
    let botFetchInit: { agent?: unknown } | undefined;
    try {
      const agent = buildBotFetchAgent(cfg.proxy);
      botFetchInit = agent ? { agent } : undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new AppError("BOT_PROXY_INVALID", `代理配置无效: ${message}`, 400);
    }
    const bot = new Bot(cfg.telegramBotToken, botFetchInit ? { client: { baseFetchConfig: botFetchInit as never } } : undefined);
    const handle = this.deps.resolveHandle(accountId);
    const entry: BotEntry = {
      accountId,
      handle,
      bot,
      sender,
      queue,
      startedAt: nowIso(),
      username: null,
      lastError: null,
      status: "starting",
    };
    this.entries.set(accountId, entry);

    bot.catch((err) => {
      entry.lastError = err instanceof Error ? err.message : String(err);
      console.error(JSON.stringify({ scope: "bot_manager", accountId, event: "bot_error", message: entry.lastError }));
    });

    try {
      await bot.api.setMyCommands(BOT_COMMANDS);
      await bot.api.setMyDescription(BOT_DESCRIPTION);
      await bot.api.setMyShortDescription(BOT_SHORT_DESCRIPTION);
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      entry.status = "error";
      this.entries.delete(accountId);
      this.deps.configRepo.upsert(accountId, { botEnabled: false });
      throw new AppError("BOT_INIT_FAILED", `Bot 初始化失败: ${entry.lastError}`, 502);
    }

    const botCtx: BotInstanceContext = {
      accountId,
      config: this.deps.buildRuntimeConfig(cfg),
      sender,
    };

    this.deps.registerBot(bot, botCtx, sender, queue);

    void bot
      .start({
        onStart: ({ username }) => {
          entry.username = username;
          entry.status = "running";
        },
      })
      .catch((error) => {
        entry.lastError = error instanceof Error ? error.message : String(error);
        entry.status = "error";
        console.error(JSON.stringify({ scope: "bot_manager", accountId, event: "bot_start_failed", message: entry.lastError }));
      });

    this.deps.configRepo.upsert(accountId, { botEnabled: true });
    return entry;
  }

  /**
   * 停止单个 bot。
   * @param opts.disable 是否把 account_configs.bot_enabled 写成 false。
   *   - true（默认）：用户主动停止 / 路由 stop，下次不应自动拉起
   *   - false：进程退出时的 stopAll，只停 polling，保留 enabled，便于下次 autostart
   */
  public async stopBot(accountId: string, opts: { disable?: boolean } = {}): Promise<void> {
    const disable = opts.disable !== false;
    const entry = this.entries.get(accountId);
    if (!entry) {
      // 进程里没在跑，但用户点了停止：仍要持久化 disabled。
      if (disable) {
        try { this.deps.configRepo.upsert(accountId, { botEnabled: false }); }
        catch (e) { console.error(JSON.stringify({ scope: "bot_manager", accountId, event: "config_disable_failed", message: e instanceof Error ? e.message : String(e) })); }
      }
      return;
    }
    entry.status = "stopping";
    try {
      await entry.bot.stop();
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : String(error);
      console.error(JSON.stringify({ scope: "bot_manager", accountId, event: "bot_stop_failed", message: entry.lastError }));
    } finally {
      this.entries.delete(accountId);
      if (disable) {
        try { this.deps.configRepo.upsert(accountId, { botEnabled: false }); }
        catch (e) { console.error(JSON.stringify({ scope: "bot_manager", accountId, event: "config_disable_failed", message: e instanceof Error ? e.message : String(e) })); }
      }
    }
  }

  public async restartBot(accountId: string): Promise<BotEntry> {
    // 重启是运维动作，不要把 enabled 清掉；startBot 成功后会再写成 true。
    await this.stopBot(accountId, { disable: false });
    return this.startBot(accountId);
  }

  public async autostartAll(): Promise<void> {
    const cfgs = this.deps.configRepo.listEnabledWithToken();
    console.log(JSON.stringify({
      scope: "bot_manager",
      event: "autostart_begin",
      count: cfgs.length,
      accountIds: cfgs.map((c) => c.accountId),
    }));
    const results = await Promise.allSettled(cfgs.map((cfg) => this.startBot(cfg.accountId)));
    for (const [index, result] of results.entries()) {
      if (result.status === "rejected") {
        const reason = result.reason instanceof Error ? result.reason.message : String(result.reason);
        console.error(JSON.stringify({
          scope: "bot_manager",
          event: "autostart_one_failed",
          accountId: cfgs[index]?.accountId,
          message: reason,
        }));
      }
    }
  }

  public async stopAll(): Promise<void> {
    const ids = [...this.entries.keys()];
    // 进程退出只停 polling，绝不能把 bot_enabled 打成 0，否则下次 autostartAll 会空跑。
    await Promise.allSettled(ids.map((id) => this.stopBot(id, { disable: false })));
  }
}
