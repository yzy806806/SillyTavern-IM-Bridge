import type { AccountConfigRepository, AccountConfigRecord, AccountConfigPatch, AccountRepository } from "../ports/repositories";
import { AppError } from "../../shared/errors/app-error";
import { normalizeProxyUrl, ProxyConfigError } from "../../infra/proxy/proxy-agent";

export class AccountConfigService {
  private readonly accountRepo: AccountRepository;
  private readonly configRepo: AccountConfigRepository;

  public constructor(accountRepo: AccountRepository, configRepo: AccountConfigRepository) {
    this.accountRepo = accountRepo;
    this.configRepo = configRepo;
  }

  public ensure(accountId: string): AccountConfigRecord {
    if (!this.accountRepo.getAccount(accountId)) {
      throw new AppError("ACCOUNT_NOT_FOUND", "账号不存在", 404);
    }
    return this.configRepo.ensure(accountId);
  }

  public get(accountId: string): AccountConfigRecord | null {
    return this.configRepo.get(accountId);
  }

  public update(accountId: string, patch: AccountConfigPatch): AccountConfigRecord {
    this.ensure(accountId);
    return this.configRepo.upsert(accountId, patch);
  }

  public setBotToken(accountId: string, token: string): AccountConfigRecord {
    const trimmed = token.trim();
    if (!trimmed) {
      throw new AppError("BOT_TOKEN_EMPTY", "bot token 不能为空", 400);
    }
    return this.update(accountId, { telegramBotToken: trimmed });
  }

  public clearBotToken(accountId: string): AccountConfigRecord {
    return this.update(accountId, { telegramBotToken: null, botEnabled: false });
  }

  /**
   * 设置代理配置。
   * - enabled=true：url 必填且校验通过
   * - enabled=false 且 url 未提供（undefined）：保留已存 URL，便于 UI 重新启用
   * - enabled=false 且 url=null：显式清空
   */
  public setProxy(accountId: string, proxy: { enabled: boolean; url?: string | null }): AccountConfigRecord {
    if (proxy.enabled) {
      const url = (proxy.url ?? "").trim();
      if (!url) {
        throw new AppError("PROXY_URL_EMPTY", "启用代理时代理 URL 不能为空", 400);
      }
      try {
        normalizeProxyUrl(url);
      } catch (error) {
        if (error instanceof ProxyConfigError) {
          throw new AppError("PROXY_URL_INVALID", error.message, 400);
        }
        throw error;
      }
      return this.update(accountId, { proxy: { enabled: true, url } });
    }
    if (proxy.url === undefined) {
      const current = this.ensure(accountId);
      return this.update(accountId, { proxy: { enabled: false, url: current.proxy.url } });
    }
    return this.update(accountId, { proxy: { enabled: false, url: proxy.url } });
  }

  public clearProxy(accountId: string): AccountConfigRecord {
    return this.update(accountId, { proxy: { enabled: false, url: null } });
  }

  public setAllowedUsers(accountId: string, userIds: string[]): AccountConfigRecord {
    const cleaned = Array.from(new Set(userIds.map((id) => String(id).trim()).filter(Boolean)));
    return this.update(accountId, { telegramAllowedUserIds: cleaned });
  }

  public addAllowedUser(accountId: string, telegramUserId: string): AccountConfigRecord {
    const id = String(telegramUserId).trim();
    if (!id) {
      throw new AppError("ALLOWED_USER_EMPTY", "TG 用户 ID 不能为空", 400);
    }
    const cfg = this.ensure(accountId);
    if (cfg.telegramAllowedUserIds.includes(id)) {
      return cfg;
    }
    return this.update(accountId, { telegramAllowedUserIds: [...cfg.telegramAllowedUserIds, id] });
  }

  public removeAllowedUser(accountId: string, telegramUserId: string): AccountConfigRecord {
    const id = String(telegramUserId).trim();
    const cfg = this.ensure(accountId);
    const next = cfg.telegramAllowedUserIds.filter((existing) => existing !== id);
    if (next.length === cfg.telegramAllowedUserIds.length) {
      return cfg;
    }
    return this.update(accountId, { telegramAllowedUserIds: next });
  }

  public isTelegramUserAllowed(accountId: string, telegramUserId: string): boolean {
    const cfg = this.configRepo.get(accountId);
    if (!cfg) return false;
    if (cfg.telegramAllowedUserIds.length === 0) return false;
    return cfg.telegramAllowedUserIds.includes(String(telegramUserId));
  }

  public linkTelegramIdentity(accountId: string, telegramUserId: string): void {
    this.accountRepo.linkExternalIdentity(accountId, "telegram", String(telegramUserId));
  }
}
