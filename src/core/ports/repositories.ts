import type {
  Account,
  AccountProxyConfig,
  ActiveSession,
  ExternalIdentity,
  HistorySyncRecord,
  IdentityChannel,
  RecentSession,
  TurnRecord,
  TurnOperation,
  TurnStatus,
} from "../models/index";

export type AccountRole = "user" | "admin";

export interface STUserAccount extends Account {
  stUserHandle: string | null;
  role: AccountRole;
}

export interface AccountRepository {
  getAccount(accountId: string): Account | null;
  listAccounts(): Account[];
  getIdentity(channel: IdentityChannel, externalUserId: string): ExternalIdentity | null;
  getAccountByIdentity(channel: IdentityChannel, externalUserId: string): Account | null;
  ensureAccount(accountId: string, displayName?: string | null): Account;
  ensureIdentityAccount(params: {
    channel: IdentityChannel;
    externalUserId: string;
    preferredAccountId?: string | null;
    displayName?: string | null;
  }): Account;
  ensureSTUserAccount(params: {
    handle: string;
    displayName?: string | null;
    role: AccountRole;
  }): STUserAccount;
  getSTUserAccount(accountId: string): STUserAccount | null;
  listSTUserAccounts(): STUserAccount[];
  linkExternalIdentity(accountId: string, channel: IdentityChannel, externalUserId: string): void;
}

export interface AccountConfigRecord {
  accountId: string;
  telegramBotToken: string | null;
  telegramAllowedUserIds: string[];
  botEnabled: boolean;
  compress: {
    keepRecent: number;
    batchSize: number;
    timeoutMs: number;
    retryCount: number;
    retryDelayMs: number;
  };
  tg: {
    interMessageDelayMs: number;
    streamMinIntervalMs: number;
    streamMinDeltaChars: number;
    advanced: Record<string, unknown>;
  };
  proxy: AccountProxyConfig;
  createdAt: string;
  updatedAt: string;
}

export type AccountConfigPatch = Partial<{
  telegramBotToken: string | null;
  telegramAllowedUserIds: string[];
  botEnabled: boolean;
  compress: Partial<AccountConfigRecord["compress"]>;
  tg: Partial<AccountConfigRecord["tg"]>;
  proxy: Partial<AccountConfigRecord["proxy"]>;
}>;

export interface AccountConfigRepository {
  get(accountId: string): AccountConfigRecord | null;
  ensure(accountId: string): AccountConfigRecord;
  upsert(accountId: string, patch: AccountConfigPatch): AccountConfigRecord;
  listEnabledWithToken(): AccountConfigRecord[];
  listAll(): AccountConfigRecord[];
  remove(accountId: string): void;
}

export interface BindCodeRecord {
  accountId: string;
  code: string;
  createdAt: string;
  expiresAt: string;
}

export interface BindCodeRepository {
  upsert(accountId: string, code: string, expiresAt: string): BindCodeRecord;
  getByAccount(accountId: string): BindCodeRecord | null;
  consume(accountId: string, code: string, nowIso: string): BindCodeRecord | null;
  deleteByAccount(accountId: string): void;
  deleteExpired(nowIso: string): void;
}

export interface SessionRepository {
  getActiveSession(accountId: string): ActiveSession | null;
  setActiveCharacter(accountId: string, avatar: string, name: string): void;
  setActiveSession(accountId: string, avatar: string, characterName: string, chatFile: string): void;
  setActiveModelOverride(accountId: string, modelId: string): void;
  clearActiveModelOverride(accountId: string): void;
  setCompressionModelOverride(accountId: string, modelId: string): void;
  clearCompressionModelOverride(accountId: string): void;
  setCurrentModel(accountId: string, modelId: string | null): void;
  listRecentSessions(accountId: string, limit?: number): RecentSession[];
}

export interface TurnRepository {
  createTurnRecord(params: {
    accountId: string;
    channel: IdentityChannel;
    sessionKey: string;
    clientTurnId?: string | null;
    requestId?: string | null;
    traceId?: string | null;
    operation?: TurnOperation | null;
    status?: TurnStatus;
    errorMessage?: string | null;
    externalRefs?: Record<string, unknown>;
  }): number;
  getTurnRecordById(id: number): TurnRecord | null;
  getLatestActiveTurnRecord(params: {
    accountId: string;
    channel: IdentityChannel;
    sessionKey: string;
    externalRefMatches?: Record<string, string | number>;
  }): TurnRecord | null;
  updateTurnExternalRefs(id: number, externalRefs: Record<string, unknown>): void;
  updateTurnRecord(id: number, params: {
    requestId?: string | null;
    traceId?: string | null;
    operation?: TurnOperation | null;
    status?: TurnStatus;
    errorMessage?: string | null;
    externalRefs?: Record<string, unknown>;
  }): void;
  markTurnRevoked(id: number): void;
}

export interface HistorySyncSnapshot {
  sessionKey: string;
  avatar: string;
  chatFile: string;
  historyRevision: number;
  messageCount: number;
  lastMessageAt: string | null;
  previewMessage: string;
  updatedAt: string;
  items: HistorySyncRecord[];
}

export interface HistorySyncRepository {
  getSnapshot(sessionKey: string): HistorySyncSnapshot | null;
  replaceSnapshot(params: {
    sessionKey: string;
    avatar: string;
    chatFile: string;
    messageCount: number;
    lastMessageAt: string | null;
    previewMessage: string;
    items: HistorySyncRecord[];
    incrementRevision: boolean;
  }): HistorySyncSnapshot;
}
