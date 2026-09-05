import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  Account,
  ActiveSession,
  ExternalIdentity,
  HistorySyncRecord,
  IdentityChannel,
  MessageLink,
  RecentSession,
  TurnRecord,
  TurnOperation,
  TurnStatus,
  UserState,
} from "../../core/models/index";
import type {
  AccountConfigPatch,
  AccountConfigRecord,
  AccountConfigRepository,
  AccountRepository,
  AccountRole,
  BindCodeRecord,
  BindCodeRepository,
  HistorySyncRepository,
  HistorySyncSnapshot,
  STUserAccount,
  SessionRepository,
  TurnRepository,
} from "../../core/ports/repositories";
import { safeJsonParse, safeJsonStringify } from "../../shared/utils/safe-json";
import { buildSessionKey, buildTelegramAccountId } from "../../shared/utils/ids";
import { nowIso } from "../../shared/utils/time";

function parseTurnRecord(row: Record<string, unknown>): TurnRecord {
  return {
    id: Number(row.id),
    accountId: String(row.account_id),
    channel: String(row.channel) as IdentityChannel,
    sessionKey: String(row.session_key),
    clientTurnId: row.client_turn_id ? String(row.client_turn_id) : null,
    requestId: row.request_id ? String(row.request_id) : null,
    traceId: row.trace_id ? String(row.trace_id) : null,
    operation: row.operation ? String(row.operation) as TurnOperation : null,
    status: row.status ? String(row.status) as TurnStatus : "completed",
    errorMessage: row.error_message ? String(row.error_message) : null,
    externalRefs: safeJsonParse<Record<string, unknown>>(String(row.external_refs ?? "{}"), {}),
    createdAt: String(row.created_at),
    updatedAt: row.updated_at ? String(row.updated_at) : String(row.created_at),
    revokedAt: row.revoked_at ? String(row.revoked_at) : null,
  };
}

function parseHistorySyncRecord(row: Record<string, unknown>): HistorySyncRecord {
  return {
    sortIndex: Number(row.sort_index ?? 0),
    messageId: String(row.message_id),
    turnId: row.turn_id ? String(row.turn_id) : null,
    speaker: String(row.speaker ?? ""),
    text: String(row.text ?? ""),
    sendDate: row.send_date ? String(row.send_date) : null,
    isUser: Boolean(Number(row.is_user ?? 0)),
  };
}

export class SqliteAccountRepository implements AccountRepository {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
  }

  public getAccount(accountId: string): Account | null {
    const row = this.db.prepare(`
      SELECT account_id, display_name, created_at
      FROM accounts
      WHERE account_id = ?
    `).get(accountId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      accountId: String(row.account_id),
      displayName: row.display_name ? String(row.display_name) : null,
      createdAt: String(row.created_at),
    };
  }

  public listAccounts(): Account[] {
    const rows = this.db.prepare(`
      SELECT account_id, display_name, created_at
      FROM accounts
      ORDER BY created_at ASC
    `).all() as Record<string, unknown>[];

    return rows.map((row) => ({
      accountId: String(row.account_id),
      displayName: row.display_name ? String(row.display_name) : null,
      createdAt: String(row.created_at),
    }));
  }

  public getIdentity(channel: IdentityChannel, externalUserId: string): ExternalIdentity | null {
    const row = this.db.prepare(`
      SELECT account_id, channel, external_user_id, created_at
      FROM external_identities
      WHERE channel = ? AND external_user_id = ?
    `).get(channel, externalUserId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      accountId: String(row.account_id),
      channel: String(row.channel) as IdentityChannel,
      externalUserId: String(row.external_user_id),
      createdAt: String(row.created_at),
    };
  }

  public getAccountByIdentity(channel: IdentityChannel, externalUserId: string): Account | null {
    const identity = this.getIdentity(channel, externalUserId);
    if (!identity) {
      return null;
    }

    return this.getAccount(identity.accountId);
  }

  public ensureAccount(accountId: string, displayName: string | null = null): Account {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO accounts (account_id, display_name, created_at)
      VALUES (?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        display_name = COALESCE(accounts.display_name, excluded.display_name)
    `).run(accountId, displayName, now);

    return this.getAccount(accountId)!;
  }

  public ensureIdentityAccount(params: {
    channel: IdentityChannel;
    externalUserId: string;
    preferredAccountId?: string | null;
    displayName?: string | null;
  }): Account {
    const existing = this.getAccountByIdentity(params.channel, params.externalUserId);
    if (existing) {
      return existing;
    }

    const accountId = params.preferredAccountId?.trim() || `${params.channel}:${params.externalUserId}`;
    const account = this.ensureAccount(accountId, params.displayName ?? null);
    this.db.prepare(`
      INSERT OR IGNORE INTO external_identities (account_id, channel, external_user_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(account.accountId, params.channel, params.externalUserId, nowIso());

    return this.getAccountByIdentity(params.channel, params.externalUserId) ?? account;
  }

  public linkExternalIdentity(accountId: string, channel: IdentityChannel, externalUserId: string): void {
    this.db.prepare(`
      INSERT OR IGNORE INTO external_identities (account_id, channel, external_user_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(accountId, channel, externalUserId, nowIso());
  }

  public ensureSTUserAccount(params: {
    handle: string;
    displayName?: string | null;
    role: AccountRole;
  }): STUserAccount {
    const handle = params.handle.trim();
    if (!handle) {
      throw new Error("ensureSTUserAccount: empty handle");
    }
    const accountId = `handle:${handle}`;
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO accounts (account_id, display_name, created_at, st_user_handle, role)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        display_name = COALESCE(accounts.display_name, excluded.display_name),
        st_user_handle = excluded.st_user_handle,
        role = excluded.role
    `).run(accountId, params.displayName ?? null, now, handle, params.role);
    return this.getSTUserAccount(accountId)!;
  }

  public getSTUserAccount(accountId: string): STUserAccount | null {
    const row = this.db.prepare(`
      SELECT account_id, display_name, created_at, st_user_handle, role
      FROM accounts
      WHERE account_id = ?
    `).get(accountId) as Record<string, unknown> | undefined;
    if (!row) {
      return null;
    }
    return {
      accountId: String(row.account_id),
      displayName: row.display_name ? String(row.display_name) : null,
      createdAt: String(row.created_at),
      stUserHandle: row.st_user_handle ? String(row.st_user_handle) : null,
      role: (row.role === "admin" ? "admin" : "user") as AccountRole,
    };
  }

  public listSTUserAccounts(): STUserAccount[] {
    const rows = this.db.prepare(`
      SELECT account_id, display_name, created_at, st_user_handle, role
      FROM accounts
      WHERE st_user_handle IS NOT NULL
      ORDER BY created_at ASC
    `).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      accountId: String(row.account_id),
      displayName: row.display_name ? String(row.display_name) : null,
      createdAt: String(row.created_at),
      stUserHandle: row.st_user_handle ? String(row.st_user_handle) : null,
      role: (row.role === "admin" ? "admin" : "user") as AccountRole,
    }));
  }
}

export class SqliteSessionRepository implements SessionRepository {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
  }

  public getActiveSession(accountId: string): ActiveSession | null {
    const row = this.db.prepare(`
      SELECT account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at
      FROM active_sessions
      WHERE account_id = ?
    `).get(accountId) as Record<string, unknown> | undefined;

    if (!row) {
      return null;
    }

    return {
      accountId: String(row.account_id),
      activeCharacterAvatar: row.active_character_avatar ? String(row.active_character_avatar) : null,
      activeCharacterName: row.active_character_name ? String(row.active_character_name) : null,
      activeChatFile: row.active_chat_file ? String(row.active_chat_file) : null,
      activeModelOverride: row.active_model_override ? String(row.active_model_override) : null,
      compressionModelOverride: row.compression_model_override ? String(row.compression_model_override) : null,
      currentModel: row.current_model ? String(row.current_model) : null,
      updatedAt: String(row.updated_at),
    };
  }

  public setActiveCharacter(accountId: string, avatar: string, name: string): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO active_sessions (account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at)
      VALUES (?, ?, ?, NULL, COALESCE((SELECT active_model_override FROM active_sessions WHERE account_id = ?), NULL), COALESCE((SELECT current_model FROM active_sessions WHERE account_id = ?), NULL), COALESCE((SELECT compression_model_override FROM active_sessions WHERE account_id = ?), NULL), ?)
      ON CONFLICT(account_id) DO UPDATE SET
        active_character_avatar = excluded.active_character_avatar,
        active_character_name = excluded.active_character_name,
        active_chat_file = NULL,
        updated_at = excluded.updated_at
    `).run(accountId, avatar, name, accountId, accountId, accountId, now);
  }

  public setActiveSession(accountId: string, avatar: string, characterName: string, chatFile: string): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO active_sessions (account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at)
      VALUES (?, ?, ?, ?, COALESCE((SELECT active_model_override FROM active_sessions WHERE account_id = ?), NULL), COALESCE((SELECT current_model FROM active_sessions WHERE account_id = ?), NULL), COALESCE((SELECT compression_model_override FROM active_sessions WHERE account_id = ?), NULL), ?)
      ON CONFLICT(account_id) DO UPDATE SET
        active_character_avatar = excluded.active_character_avatar,
        active_character_name = excluded.active_character_name,
        active_chat_file = excluded.active_chat_file,
        updated_at = excluded.updated_at
    `).run(accountId, avatar, characterName, chatFile, accountId, accountId, accountId, now);

    this.db.prepare(`
      INSERT INTO recent_sessions (account_id, character_avatar, character_name, chat_file, active_model_override, last_used_at)
      VALUES (?, ?, ?, ?, COALESCE((SELECT active_model_override FROM active_sessions WHERE account_id = ?), NULL), ?)
      ON CONFLICT(account_id, character_avatar, chat_file) DO UPDATE SET
        character_name = excluded.character_name,
        active_model_override = excluded.active_model_override,
        last_used_at = excluded.last_used_at
    `).run(accountId, avatar, characterName, chatFile, accountId, now);
  }

  public setActiveModelOverride(accountId: string, modelId: string): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO active_sessions (account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at)
      VALUES (?, NULL, NULL, NULL, ?, COALESCE((SELECT current_model FROM active_sessions WHERE account_id = ?), NULL), COALESCE((SELECT compression_model_override FROM active_sessions WHERE account_id = ?), NULL), ?)
      ON CONFLICT(account_id) DO UPDATE SET
        active_model_override = excluded.active_model_override,
        updated_at = excluded.updated_at
    `).run(accountId, modelId, accountId, accountId, now);

    this.db.prepare(`
      UPDATE recent_sessions
      SET active_model_override = ?,
          last_used_at = ?
      WHERE account_id = ?
        AND character_avatar = (SELECT active_character_avatar FROM active_sessions WHERE account_id = ?)
        AND chat_file = (SELECT active_chat_file FROM active_sessions WHERE account_id = ?)
    `).run(modelId, now, accountId, accountId, accountId);
  }

  public clearActiveModelOverride(accountId: string): void {
    this.db.prepare(`
      UPDATE active_sessions
      SET active_model_override = NULL,
          updated_at = ?
      WHERE account_id = ?
    `).run(nowIso(), accountId);

    this.db.prepare(`
      UPDATE recent_sessions
      SET active_model_override = NULL,
          last_used_at = ?
      WHERE account_id = ?
        AND character_avatar = (SELECT active_character_avatar FROM active_sessions WHERE account_id = ?)
        AND chat_file = (SELECT active_chat_file FROM active_sessions WHERE account_id = ?)
    `).run(nowIso(), accountId, accountId, accountId);
  }

  public setCompressionModelOverride(accountId: string, modelId: string): void {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO active_sessions (account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at)
      VALUES (?, NULL, NULL, NULL, COALESCE((SELECT active_model_override FROM active_sessions WHERE account_id = ?), NULL), COALESCE((SELECT current_model FROM active_sessions WHERE account_id = ?), NULL), ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        compression_model_override = excluded.compression_model_override,
        updated_at = excluded.updated_at
    `).run(accountId, accountId, accountId, modelId, now);
  }

  public clearCompressionModelOverride(accountId: string): void {
    this.db.prepare(`
      UPDATE active_sessions
      SET compression_model_override = NULL,
          updated_at = ?
      WHERE account_id = ?
    `).run(nowIso(), accountId);
  }

  public setCurrentModel(accountId: string, modelId: string | null): void {
    this.db.prepare(`
      INSERT INTO active_sessions (account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at)
      VALUES (?, NULL, NULL, NULL, COALESCE((SELECT active_model_override FROM active_sessions WHERE account_id = ?), NULL), ?, COALESCE((SELECT compression_model_override FROM active_sessions WHERE account_id = ?), NULL), ?)
      ON CONFLICT(account_id) DO UPDATE SET
        current_model = excluded.current_model,
        updated_at = excluded.updated_at
    `).run(accountId, accountId, modelId, accountId, nowIso());
  }

  public listRecentSessions(accountId: string, limit = 5): RecentSession[] {
    const rows = this.db.prepare(`
      SELECT account_id, character_avatar, character_name, chat_file, active_model_override, last_used_at
      FROM recent_sessions
      WHERE account_id = ?
      ORDER BY last_used_at DESC
      LIMIT ?
    `).all(accountId, limit) as Record<string, unknown>[];

    return rows.map((row) => ({
      accountId: String(row.account_id),
      characterAvatar: String(row.character_avatar),
      characterName: String(row.character_name),
      chatFile: String(row.chat_file),
      activeModelOverride: row.active_model_override ? String(row.active_model_override) : null,
      lastUsedAt: String(row.last_used_at),
    }));
  }
}

export class SqliteTurnRepository implements TurnRepository {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
  }

  public createTurnRecord(params: {
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
  }): number {
    const now = nowIso();
    const result = this.db.prepare(`
      INSERT INTO turn_records (
        account_id, channel, session_key, client_turn_id, request_id, trace_id, operation, status, error_message, external_refs, created_at, updated_at, revoked_at, legacy_message_link_id
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
    `).run(
      params.accountId,
      params.channel,
      params.sessionKey,
      params.clientTurnId ?? null,
      params.requestId ?? null,
      params.traceId ?? null,
      params.operation ?? null,
      params.status ?? "completed",
      params.errorMessage ?? null,
      safeJsonStringify(params.externalRefs ?? {}),
      now,
      now,
    ) as { lastInsertRowid?: number | bigint };

    return Number(result.lastInsertRowid ?? 0);
  }

  public getTurnRecordById(id: number): TurnRecord | null {
    const row = this.db.prepare(`
      SELECT id, account_id, channel, session_key, client_turn_id, request_id, trace_id, operation, status, error_message, external_refs, created_at, updated_at, revoked_at
      FROM turn_records
      WHERE id = ?
    `).get(id) as Record<string, unknown> | undefined;

    return row ? parseTurnRecord(row) : null;
  }

  public getLatestActiveTurnRecord(params: {
    accountId: string;
    channel: IdentityChannel;
    sessionKey: string;
    externalRefMatches?: Record<string, string | number>;
  }): TurnRecord | null {
    const rows = this.db.prepare(`
      SELECT id, account_id, channel, session_key, client_turn_id, request_id, trace_id, operation, status, error_message, external_refs, created_at, updated_at, revoked_at
      FROM turn_records
      WHERE account_id = ?
        AND channel = ?
        AND session_key = ?
        AND revoked_at IS NULL
        AND status != 'failed'
      ORDER BY id DESC
      LIMIT 50
    `).all(params.accountId, params.channel, params.sessionKey) as Record<string, unknown>[];

    for (const row of rows) {
      const record = parseTurnRecord(row);
      const matches = Object.entries(params.externalRefMatches ?? {}).every(([key, value]) => record.externalRefs[key] === value);
      if (matches) {
        return record;
      }
    }

    return null;
  }

  public updateTurnExternalRefs(id: number, externalRefs: Record<string, unknown>): void {
    this.db.prepare(`
      UPDATE turn_records
      SET external_refs = ?,
          updated_at = ?
      WHERE id = ?
    `).run(safeJsonStringify(externalRefs), nowIso(), id);
  }

  public updateTurnRecord(id: number, params: {
    requestId?: string | null;
    traceId?: string | null;
    operation?: TurnOperation | null;
    status?: TurnStatus;
    errorMessage?: string | null;
    externalRefs?: Record<string, unknown>;
  }): void {
    const existing = this.getTurnRecordById(id);
    if (!existing) {
      return;
    }

    this.db.prepare(`
      UPDATE turn_records
      SET request_id = ?,
          trace_id = ?,
          operation = ?,
          status = ?,
          error_message = ?,
          external_refs = ?,
          updated_at = ?
      WHERE id = ?
    `).run(
      params.requestId === undefined ? existing.requestId : params.requestId,
      params.traceId === undefined ? existing.traceId : params.traceId,
      params.operation === undefined ? existing.operation : params.operation,
      params.status === undefined ? existing.status : params.status,
      params.errorMessage === undefined ? existing.errorMessage : params.errorMessage,
      safeJsonStringify(params.externalRefs === undefined ? existing.externalRefs : params.externalRefs),
      nowIso(),
      id,
    );
  }

  public markTurnRevoked(id: number): void {
    this.db.prepare(`
      UPDATE turn_records
      SET revoked_at = ?
      WHERE id = ?
    `).run(nowIso(), id);
  }
}

export class SqliteHistorySyncRepository implements HistorySyncRepository {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
  }

  public getSnapshot(sessionKey: string): HistorySyncSnapshot | null {
    const header = this.db.prepare(`
      SELECT session_key, avatar, chat_file, history_revision, message_count, last_message_at, preview_message, updated_at
      FROM history_sync_snapshots
      WHERE session_key = ?
    `).get(sessionKey) as Record<string, unknown> | undefined;

    if (!header) {
      return null;
    }

    const items = this.db.prepare(`
      SELECT session_key, sort_index, message_id, turn_id, speaker, text, send_date, is_user
      FROM history_sync_messages
      WHERE session_key = ?
      ORDER BY sort_index ASC
    `).all(sessionKey) as Record<string, unknown>[];

    return {
      sessionKey: String(header.session_key),
      avatar: String(header.avatar),
      chatFile: String(header.chat_file),
      historyRevision: Number(header.history_revision ?? 1),
      messageCount: Number(header.message_count ?? 0),
      lastMessageAt: header.last_message_at ? String(header.last_message_at) : null,
      previewMessage: String(header.preview_message ?? ""),
      updatedAt: String(header.updated_at),
      items: items.map((row) => parseHistorySyncRecord(row)),
    };
  }

  public replaceSnapshot(params: {
    sessionKey: string;
    avatar: string;
    chatFile: string;
    messageCount: number;
    lastMessageAt: string | null;
    previewMessage: string;
    items: HistorySyncRecord[];
    incrementRevision: boolean;
  }): HistorySyncSnapshot {
    const existing = this.getSnapshot(params.sessionKey);
    const historyRevision = existing ? existing.historyRevision + (params.incrementRevision ? 1 : 0) : 1;
    const now = nowIso();

    this.db.exec("BEGIN");
    try {
      this.db.prepare(`
        INSERT INTO history_sync_snapshots (
          session_key, avatar, chat_file, history_revision, message_count, last_message_at, preview_message, updated_at
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(session_key) DO UPDATE SET
          avatar = excluded.avatar,
          chat_file = excluded.chat_file,
          history_revision = excluded.history_revision,
          message_count = excluded.message_count,
          last_message_at = excluded.last_message_at,
          preview_message = excluded.preview_message,
          updated_at = excluded.updated_at
      `).run(
        params.sessionKey,
        params.avatar,
        params.chatFile,
        historyRevision,
        params.messageCount,
        params.lastMessageAt,
        params.previewMessage,
        now,
      );

      this.db.prepare(`
        DELETE FROM history_sync_messages
        WHERE session_key = ?
      `).run(params.sessionKey);

      const insertMessage = this.db.prepare(`
        INSERT INTO history_sync_messages (
          session_key, sort_index, message_id, turn_id, speaker, text, send_date, is_user
        )
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `);
      for (const item of params.items) {
        insertMessage.run(
          params.sessionKey,
          item.sortIndex,
          item.messageId,
          item.turnId,
          item.speaker,
          item.text,
          item.sendDate,
          item.isUser ? 1 : 0,
        );
      }

      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }

    return this.getSnapshot(params.sessionKey)!;
  }
}

function hasTable(db: DatabaseSync, table: string): boolean {
  const row = db.prepare(`
    SELECT 1 AS present
    FROM sqlite_master
    WHERE type = 'table' AND name = ?
  `).get(table) as Record<string, unknown> | undefined;
  return Boolean(row?.present);
}

function getTableColumns(db: DatabaseSync, table: string): string[] {
  if (!hasTable(db, table)) {
    return [];
  }

  return (db.prepare(`PRAGMA table_info(${table})`).all() as Array<Record<string, unknown>>)
    .map((item) => String(item.name));
}

function isLegacyRecentSessionsTable(db: DatabaseSync, table: string): boolean {
  const columns = getTableColumns(db, table);
  return columns.includes("telegram_user_id") && !columns.includes("account_id");
}

function renameLegacyTables(db: DatabaseSync): void {
  if (hasTable(db, "recent_sessions") && isLegacyRecentSessionsTable(db, "recent_sessions") && !hasTable(db, "legacy_recent_sessions")) {
    db.exec(`ALTER TABLE recent_sessions RENAME TO legacy_recent_sessions`);
  }
}

function getMetadataValue(db: DatabaseSync, key: string): string | null {
  const row = db.prepare(`
    SELECT value
    FROM app_metadata
    WHERE key = ?
  `).get(key) as Record<string, unknown> | undefined;
  return row?.value ? String(row.value) : null;
}

function setMetadataValue(db: DatabaseSync, key: string, value: string): void {
  db.prepare(`
    INSERT INTO app_metadata (key, value, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT(key) DO UPDATE SET
      value = excluded.value,
      updated_at = excluded.updated_at
  `).run(key, value, nowIso());
}

function ensureLegacySchema(db: DatabaseSync): void {
  if (!hasTable(db, "user_state")) {
    return;
  }

  const columns = db.prepare(`PRAGMA table_info(user_state)`).all() as Array<Record<string, unknown>>;
  const hasActiveModelOverride = columns.some((item) => String(item.name) === "active_model_override");
  if (!hasActiveModelOverride) {
    db.exec(`ALTER TABLE user_state ADD COLUMN active_model_override TEXT`);
  }
}

function ensureCurrentSchema(db: DatabaseSync): void {
  const accountColumns = getTableColumns(db, "accounts");
  if (accountColumns.length > 0 && !accountColumns.includes("st_user_handle")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN st_user_handle TEXT`);
  }
  if (accountColumns.length > 0 && !accountColumns.includes("role")) {
    db.exec(`ALTER TABLE accounts ADD COLUMN role TEXT NOT NULL DEFAULT 'user'`);
  }
  if (accountColumns.length > 0) {
    db.exec(`CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_st_handle ON accounts(st_user_handle) WHERE st_user_handle IS NOT NULL`);
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS account_configs (
      account_id                TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
      telegram_bot_token        TEXT,
      telegram_allowed_user_ids TEXT NOT NULL DEFAULT '[]',
      bot_enabled               INTEGER NOT NULL DEFAULT 0,
      compress_keep_recent      INTEGER NOT NULL DEFAULT 15,
      compress_batch_size       INTEGER NOT NULL DEFAULT 5,
      compress_timeout_ms       INTEGER NOT NULL DEFAULT 60000,
      compress_retry_count      INTEGER NOT NULL DEFAULT 3,
      compress_retry_delay_ms   INTEGER NOT NULL DEFAULT 1500,
      tg_inter_message_delay_ms INTEGER NOT NULL DEFAULT 1400,
      tg_stream_min_interval_ms INTEGER NOT NULL DEFAULT 5000,
      tg_stream_min_delta_chars INTEGER NOT NULL DEFAULT 700,
      tg_advanced_json          TEXT NOT NULL DEFAULT '{}',
      proxy_enabled             INTEGER NOT NULL DEFAULT 0,
      proxy_url                 TEXT,
      created_at                TEXT NOT NULL,
      updated_at                TEXT NOT NULL
    );
  `);

  db.exec(`
    CREATE TABLE IF NOT EXISTS bind_codes (
      account_id TEXT PRIMARY KEY REFERENCES accounts(account_id) ON DELETE CASCADE,
      code       TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_bind_codes_code ON bind_codes(code);
  `);

  const activeSessionColumns = getTableColumns(db, "active_sessions");
  if (activeSessionColumns.length > 0 && !activeSessionColumns.includes("current_model")) {
    db.exec(`ALTER TABLE active_sessions ADD COLUMN current_model TEXT`);
  }
  if (activeSessionColumns.length > 0 && !activeSessionColumns.includes("compression_model_override")) {
    db.exec(`ALTER TABLE active_sessions ADD COLUMN compression_model_override TEXT`);
  }

  const recentSessionColumns = getTableColumns(db, "recent_sessions");
  if (recentSessionColumns.length > 0 && !recentSessionColumns.includes("active_model_override")) {
    db.exec(`ALTER TABLE recent_sessions ADD COLUMN active_model_override TEXT`);
  }

  const turnRecordColumns = getTableColumns(db, "turn_records");
  if (turnRecordColumns.length > 0 && !turnRecordColumns.includes("request_id")) {
    db.exec(`ALTER TABLE turn_records ADD COLUMN request_id TEXT`);
  }
  if (turnRecordColumns.length > 0 && !turnRecordColumns.includes("trace_id")) {
    db.exec(`ALTER TABLE turn_records ADD COLUMN trace_id TEXT`);
  }
  if (turnRecordColumns.length > 0 && !turnRecordColumns.includes("operation")) {
    db.exec(`ALTER TABLE turn_records ADD COLUMN operation TEXT`);
  }
  if (turnRecordColumns.length > 0 && !turnRecordColumns.includes("status")) {
    db.exec(`ALTER TABLE turn_records ADD COLUMN status TEXT`);
  }
  if (turnRecordColumns.length > 0 && !turnRecordColumns.includes("error_message")) {
    db.exec(`ALTER TABLE turn_records ADD COLUMN error_message TEXT`);
  }
  if (turnRecordColumns.length > 0 && !turnRecordColumns.includes("updated_at")) {
    db.exec(`ALTER TABLE turn_records ADD COLUMN updated_at TEXT`);
  }
  const accountConfigColumns = getTableColumns(db, "account_configs");
  if (accountConfigColumns.length > 0 && !accountConfigColumns.includes("proxy_enabled")) {
    db.exec(`ALTER TABLE account_configs ADD COLUMN proxy_enabled INTEGER NOT NULL DEFAULT 0`);
  }
  if (accountConfigColumns.length > 0 && !accountConfigColumns.includes("proxy_url")) {
    db.exec(`ALTER TABLE account_configs ADD COLUMN proxy_url TEXT`);
  }

  if (turnRecordColumns.length > 0) {
    db.exec(`
      UPDATE turn_records
      SET status = COALESCE(status, 'completed'),
          updated_at = COALESCE(updated_at, created_at)
    `);
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_turn_records_request_id
      ON turn_records (request_id);
      CREATE INDEX IF NOT EXISTS idx_turn_records_trace_id
      ON turn_records (trace_id);
    `);
  }
}

function migrateLegacyState(db: DatabaseSync): void {
  if (getMetadataValue(db, "legacy_migration_v1") === "done") {
    return;
  }

  db.exec("BEGIN");

  try {
    if (hasTable(db, "user_state")) {
      const rows = db.prepare(`
        SELECT telegram_user_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, updated_at
        FROM user_state
      `).all() as Record<string, unknown>[];

      for (const row of rows) {
        const telegramUserId = String(row.telegram_user_id);
        const accountId = buildTelegramAccountId(telegramUserId);
        db.prepare(`
          INSERT OR IGNORE INTO accounts (account_id, display_name, created_at)
          VALUES (?, NULL, ?)
        `).run(accountId, String(row.updated_at ?? nowIso()));
        db.prepare(`
          INSERT OR IGNORE INTO external_identities (account_id, channel, external_user_id, created_at)
          VALUES (?, 'telegram', ?, ?)
        `).run(accountId, telegramUserId, String(row.updated_at ?? nowIso()));
        db.prepare(`
          INSERT INTO active_sessions (account_id, active_character_avatar, active_character_name, active_chat_file, active_model_override, current_model, compression_model_override, updated_at)
          VALUES (?, ?, ?, ?, ?, NULL, NULL, ?)
          ON CONFLICT(account_id) DO UPDATE SET
            active_character_avatar = excluded.active_character_avatar,
            active_character_name = excluded.active_character_name,
            active_chat_file = excluded.active_chat_file,
            active_model_override = excluded.active_model_override,
            updated_at = excluded.updated_at
        `).run(
          accountId,
          row.active_character_avatar ? String(row.active_character_avatar) : null,
          row.active_character_name ? String(row.active_character_name) : null,
          row.active_chat_file ? String(row.active_chat_file) : null,
          row.active_model_override ? String(row.active_model_override) : null,
          String(row.updated_at ?? nowIso()),
        );
      }
    }

    const legacyRecentSessionsTable = hasTable(db, "legacy_recent_sessions")
      ? "legacy_recent_sessions"
      : (isLegacyRecentSessionsTable(db, "recent_sessions") ? "recent_sessions" : null);

    if (legacyRecentSessionsTable) {
      const rows = db.prepare(`
        SELECT telegram_user_id, character_avatar, character_name, chat_file, last_used_at
        FROM ${legacyRecentSessionsTable}
      `).all() as Record<string, unknown>[];

      for (const row of rows) {
        db.prepare(`
          INSERT INTO recent_sessions (account_id, character_avatar, character_name, chat_file, active_model_override, last_used_at)
          VALUES (?, ?, ?, ?, NULL, ?)
          ON CONFLICT(account_id, character_avatar, chat_file) DO UPDATE SET
            character_name = excluded.character_name,
            active_model_override = excluded.active_model_override,
            last_used_at = excluded.last_used_at
        `).run(
          buildTelegramAccountId(String(row.telegram_user_id)),
          String(row.character_avatar),
          String(row.character_name),
          String(row.chat_file),
          String(row.last_used_at),
        );
      }
    }

    if (hasTable(db, "message_links")) {
      const rows = db.prepare(`
        SELECT id, telegram_user_id, chat_id, user_message_id, bot_message_ids, character_avatar, character_name, chat_file, created_at, revoked_at
        FROM message_links
      `).all() as Record<string, unknown>[];

      for (const row of rows) {
        db.prepare(`
          INSERT OR IGNORE INTO turn_records (
            id, account_id, channel, session_key, client_turn_id, request_id, trace_id, operation, status, error_message, external_refs, created_at, updated_at, revoked_at, legacy_message_link_id
          )
          VALUES (?, ?, 'telegram', ?, ?, NULL, NULL, 'telegram_send_stream', ?, NULL, ?, ?, ?, ?, ?)
        `).run(
          Number(row.id),
          buildTelegramAccountId(String(row.telegram_user_id)),
          buildSessionKey(String(row.character_avatar), String(row.chat_file)),
          String(row.user_message_id),
          row.revoked_at ? "completed" : "completed",
          safeJsonStringify({
            chatId: String(row.chat_id),
            userMessageId: Number(row.user_message_id),
            botMessageIds: safeJsonParse<number[]>(String(row.bot_message_ids), []),
            characterAvatar: String(row.character_avatar),
            characterName: String(row.character_name),
            chatFile: String(row.chat_file),
          }),
          String(row.created_at),
          String(row.created_at),
          row.revoked_at ? String(row.revoked_at) : null,
          Number(row.id),
        );
      }
    }

    setMetadataValue(db, "legacy_migration_v1", "done");
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  }
}

export function createSqlitePersistence(databasePath: string): {
  db: DatabaseSync;
  accountRepository: SqliteAccountRepository;
  accountConfigRepository: SqliteAccountConfigRepository;
  bindCodeRepository: SqliteBindCodeRepository;
  sessionRepository: SqliteSessionRepository;
  turnRepository: SqliteTurnRepository;
  historySyncRepository: SqliteHistorySyncRepository;
  close(): void;
} {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  renameLegacyTables(db);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS app_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS accounts (
      account_id TEXT PRIMARY KEY,
      display_name TEXT,
      created_at TEXT NOT NULL,
      st_user_handle TEXT,
      role TEXT NOT NULL DEFAULT 'user'
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_accounts_st_handle ON accounts(st_user_handle) WHERE st_user_handle IS NOT NULL;
    CREATE TABLE IF NOT EXISTS external_identities (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      external_user_id TEXT NOT NULL,
      created_at TEXT NOT NULL,
      UNIQUE(channel, external_user_id)
    );
    CREATE INDEX IF NOT EXISTS idx_external_identities_lookup
    ON external_identities (channel, external_user_id);
    CREATE TABLE IF NOT EXISTS active_sessions (
      account_id TEXT PRIMARY KEY,
      active_character_avatar TEXT,
      active_character_name TEXT,
      active_chat_file TEXT,
      active_model_override TEXT,
      current_model TEXT,
      compression_model_override TEXT,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS recent_sessions (
      account_id TEXT NOT NULL,
      character_avatar TEXT NOT NULL,
      character_name TEXT NOT NULL,
      chat_file TEXT NOT NULL,
      active_model_override TEXT,
      last_used_at TEXT NOT NULL,
      PRIMARY KEY (account_id, character_avatar, chat_file)
    );
    CREATE INDEX IF NOT EXISTS idx_recent_sessions_account_time
    ON recent_sessions (account_id, last_used_at DESC);
    CREATE TABLE IF NOT EXISTS turn_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_id TEXT NOT NULL,
      channel TEXT NOT NULL,
      session_key TEXT NOT NULL,
      client_turn_id TEXT,
      request_id TEXT,
      trace_id TEXT,
      operation TEXT,
      status TEXT NOT NULL DEFAULT 'completed',
      error_message TEXT,
      external_refs TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      revoked_at TEXT,
      legacy_message_link_id INTEGER UNIQUE
    );
    CREATE INDEX IF NOT EXISTS idx_turn_records_lookup
    ON turn_records (account_id, session_key, revoked_at, id DESC);
    CREATE TABLE IF NOT EXISTS history_sync_snapshots (
      session_key TEXT PRIMARY KEY,
      avatar TEXT NOT NULL,
      chat_file TEXT NOT NULL,
      history_revision INTEGER NOT NULL,
      message_count INTEGER NOT NULL,
      last_message_at TEXT,
      preview_message TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS history_sync_messages (
      session_key TEXT NOT NULL,
      sort_index INTEGER NOT NULL,
      message_id TEXT NOT NULL,
      turn_id TEXT,
      speaker TEXT NOT NULL,
      text TEXT NOT NULL,
      send_date TEXT,
      is_user INTEGER NOT NULL,
      PRIMARY KEY (session_key, sort_index)
    );
    CREATE INDEX IF NOT EXISTS idx_history_sync_messages_lookup
    ON history_sync_messages (session_key, sort_index);
  `);

  ensureLegacySchema(db);
  ensureCurrentSchema(db);
  migrateLegacyState(db);

  return {
    db,
    accountRepository: new SqliteAccountRepository(db),
    accountConfigRepository: new SqliteAccountConfigRepository(db),
    bindCodeRepository: new SqliteBindCodeRepository(db),
    sessionRepository: new SqliteSessionRepository(db),
    turnRepository: new SqliteTurnRepository(db),
    historySyncRepository: new SqliteHistorySyncRepository(db),
    close(): void {
      try { db.close(); } catch { /* swallow */ }
    },
  };
}

function parseBotMessageIds(value: unknown): number[] {
  if (typeof value !== "string" || !value.trim()) {
    return [];
  }

  const parsed = safeJsonParse<unknown[]>(value, []);
  return parsed
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item));
}

function parseAllowedUserIdsList(raw: unknown): string[] {
  const list = safeJsonParse<unknown[]>(typeof raw === "string" ? raw : "[]", []);
  return list.map((item) => String(item)).filter((item) => item.length > 0);
}

function parseAccountConfigRow(row: Record<string, unknown>): AccountConfigRecord {
  return {
    accountId: String(row.account_id),
    telegramBotToken: row.telegram_bot_token ? String(row.telegram_bot_token) : null,
    telegramAllowedUserIds: parseAllowedUserIdsList(row.telegram_allowed_user_ids),
    botEnabled: Boolean(Number(row.bot_enabled ?? 0)),
    compress: {
      keepRecent: Number(row.compress_keep_recent ?? 15),
      batchSize: Number(row.compress_batch_size ?? 5),
      timeoutMs: Number(row.compress_timeout_ms ?? 60000),
      retryCount: Number(row.compress_retry_count ?? 3),
      retryDelayMs: Number(row.compress_retry_delay_ms ?? 1500),
    },
    tg: {
      interMessageDelayMs: Number(row.tg_inter_message_delay_ms ?? 1400),
      streamMinIntervalMs: Number(row.tg_stream_min_interval_ms ?? 5000),
      streamMinDeltaChars: Number(row.tg_stream_min_delta_chars ?? 700),
      advanced: safeJsonParse<Record<string, unknown>>(String(row.tg_advanced_json ?? "{}"), {}),
    },
    proxy: {
      enabled: Number(row.proxy_enabled ?? 0) === 1,
      url: row.proxy_url == null ? null : String(row.proxy_url),
    },
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  };
}

export class SqliteAccountConfigRepository implements AccountConfigRepository {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
  }

  public get(accountId: string): AccountConfigRecord | null {
    const row = this.db.prepare(`
      SELECT account_id, telegram_bot_token, telegram_allowed_user_ids, bot_enabled,
             compress_keep_recent, compress_batch_size, compress_timeout_ms, compress_retry_count, compress_retry_delay_ms,
             tg_inter_message_delay_ms, tg_stream_min_interval_ms, tg_stream_min_delta_chars, tg_advanced_json, proxy_enabled, proxy_url,
             created_at, updated_at
      FROM account_configs
      WHERE account_id = ?
    `).get(accountId) as Record<string, unknown> | undefined;
    return row ? parseAccountConfigRow(row) : null;
  }

  public ensure(accountId: string): AccountConfigRecord {
    const existing = this.get(accountId);
    if (existing) return existing;
    const now = nowIso();
    this.db.prepare(`
      INSERT OR IGNORE INTO account_configs (account_id, created_at, updated_at)
      VALUES (?, ?, ?)
    `).run(accountId, now, now);
    return this.get(accountId)!;
  }

  public upsert(accountId: string, patch: AccountConfigPatch): AccountConfigRecord {
    const current = this.ensure(accountId);
    const next: AccountConfigRecord = {
      ...current,
      telegramBotToken: patch.telegramBotToken !== undefined ? patch.telegramBotToken : current.telegramBotToken,
      telegramAllowedUserIds: patch.telegramAllowedUserIds !== undefined ? Array.from(new Set(patch.telegramAllowedUserIds.map(String))) : current.telegramAllowedUserIds,
      botEnabled: patch.botEnabled !== undefined ? Boolean(patch.botEnabled) : current.botEnabled,
      compress: { ...current.compress, ...(patch.compress ?? {}) },
      proxy: {
        ...current.proxy,
        ...(patch.proxy ?? {}),
      },
      tg: {
        ...current.tg,
        ...(patch.tg ?? {}),
        advanced: patch.tg?.advanced !== undefined ? { ...current.tg.advanced, ...patch.tg.advanced } : current.tg.advanced,
      },
      updatedAt: nowIso(),
    };
    this.db.prepare(`
      UPDATE account_configs SET
        telegram_bot_token = ?,
        telegram_allowed_user_ids = ?,
        bot_enabled = ?,
        compress_keep_recent = ?,
        compress_batch_size = ?,
        compress_timeout_ms = ?,
        compress_retry_count = ?,
        compress_retry_delay_ms = ?,
        tg_inter_message_delay_ms = ?,
        tg_stream_min_interval_ms = ?,
        tg_stream_min_delta_chars = ?,
        tg_advanced_json = ?,
        proxy_enabled = ?,
        proxy_url = ?,
        updated_at = ?
      WHERE account_id = ?
    `).run(
      next.telegramBotToken,
      safeJsonStringify(next.telegramAllowedUserIds, "[]"),
      next.botEnabled ? 1 : 0,
      next.compress.keepRecent,
      next.compress.batchSize,
      next.compress.timeoutMs,
      next.compress.retryCount,
      next.compress.retryDelayMs,
      next.tg.interMessageDelayMs,
      next.tg.streamMinIntervalMs,
      next.tg.streamMinDeltaChars,
      safeJsonStringify(next.tg.advanced, "{}"),
      next.proxy.enabled ? 1 : 0,
      next.proxy.url,
      next.updatedAt,
      accountId,
    );
    return this.get(accountId)!;
  }

  public listEnabledWithToken(): AccountConfigRecord[] {
    const rows = this.db.prepare(`
      SELECT account_id, telegram_bot_token, telegram_allowed_user_ids, bot_enabled,
             compress_keep_recent, compress_batch_size, compress_timeout_ms, compress_retry_count, compress_retry_delay_ms,
             tg_inter_message_delay_ms, tg_stream_min_interval_ms, tg_stream_min_delta_chars, tg_advanced_json, proxy_enabled, proxy_url,
             created_at, updated_at
      FROM account_configs
      WHERE bot_enabled = 1 AND telegram_bot_token IS NOT NULL AND length(trim(telegram_bot_token)) > 0
    `).all() as Record<string, unknown>[];
    return rows.map(parseAccountConfigRow);
  }

  public listAll(): AccountConfigRecord[] {
    const rows = this.db.prepare(`
      SELECT account_id, telegram_bot_token, telegram_allowed_user_ids, bot_enabled,
             compress_keep_recent, compress_batch_size, compress_timeout_ms, compress_retry_count, compress_retry_delay_ms,
             tg_inter_message_delay_ms, tg_stream_min_interval_ms, tg_stream_min_delta_chars, tg_advanced_json, proxy_enabled, proxy_url,
             created_at, updated_at
      FROM account_configs
      ORDER BY created_at ASC
    `).all() as Record<string, unknown>[];
    return rows.map(parseAccountConfigRow);
  }

  public remove(accountId: string): void {
    this.db.prepare(`DELETE FROM account_configs WHERE account_id = ?`).run(accountId);
  }
}

function parseBindCodeRow(row: Record<string, unknown>): BindCodeRecord {
  return {
    accountId: String(row.account_id),
    code: String(row.code),
    createdAt: String(row.created_at),
    expiresAt: String(row.expires_at),
  };
}

export class SqliteBindCodeRepository implements BindCodeRepository {
  private readonly db: DatabaseSync;

  public constructor(db: DatabaseSync) {
    this.db = db;
  }

  public upsert(accountId: string, code: string, expiresAt: string): BindCodeRecord {
    const now = nowIso();
    this.db.prepare(`
      INSERT INTO bind_codes (account_id, code, created_at, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(account_id) DO UPDATE SET
        code = excluded.code,
        created_at = excluded.created_at,
        expires_at = excluded.expires_at
    `).run(accountId, code, now, expiresAt);
    return { accountId, code, createdAt: now, expiresAt };
  }

  public getByAccount(accountId: string): BindCodeRecord | null {
    const row = this.db.prepare(`
      SELECT account_id, code, created_at, expires_at
      FROM bind_codes
      WHERE account_id = ?
    `).get(accountId) as Record<string, unknown> | undefined;
    return row ? parseBindCodeRow(row) : null;
  }

  public consume(accountId: string, code: string, nowIsoStr: string): BindCodeRecord | null {
    const row = this.db.prepare(`
      SELECT account_id, code, created_at, expires_at
      FROM bind_codes
      WHERE account_id = ? AND code = ? AND expires_at > ?
    `).get(accountId, code, nowIsoStr) as Record<string, unknown> | undefined;
    if (!row) return null;
    this.db.prepare(`DELETE FROM bind_codes WHERE account_id = ?`).run(accountId);
    return parseBindCodeRow(row);
  }

  public deleteByAccount(accountId: string): void {
    this.db.prepare(`DELETE FROM bind_codes WHERE account_id = ?`).run(accountId);
  }

  public deleteExpired(nowIsoStr: string): void {
    this.db.prepare(`DELETE FROM bind_codes WHERE expires_at <= ?`).run(nowIsoStr);
  }
}

export class LegacyStateStore {
  private readonly accountRepository: SqliteAccountRepository;
  private readonly sessionRepository: SqliteSessionRepository;
  private readonly turnRepository: SqliteTurnRepository;

  public constructor(databasePath: string) {
    const persistence = createSqlitePersistence(databasePath);
    this.accountRepository = persistence.accountRepository;
    this.sessionRepository = persistence.sessionRepository;
    this.turnRepository = persistence.turnRepository;
  }

  private ensureTelegramAccountId(telegramUserId: string): string {
    return this.accountRepository.ensureIdentityAccount({
      channel: "telegram",
      externalUserId: telegramUserId,
      preferredAccountId: buildTelegramAccountId(telegramUserId),
    }).accountId;
  }

  public getUserState(telegramUserId: string): UserState | null {
    const accountId = this.ensureTelegramAccountId(telegramUserId);
    const session = this.sessionRepository.getActiveSession(accountId);
    if (!session) {
      return null;
    }

    return {
      telegramUserId,
      activeCharacterAvatar: session.activeCharacterAvatar,
      activeCharacterName: session.activeCharacterName,
      activeChatFile: session.activeChatFile,
      activeModelOverride: session.activeModelOverride,
      updatedAt: session.updatedAt,
    };
  }

  public setActiveCharacter(telegramUserId: string, avatar: string, name: string): void {
    this.sessionRepository.setActiveCharacter(this.ensureTelegramAccountId(telegramUserId), avatar, name);
  }

  public setActiveSession(telegramUserId: string, avatar: string, characterName: string, chatFile: string): void {
    this.sessionRepository.setActiveSession(this.ensureTelegramAccountId(telegramUserId), avatar, characterName, chatFile);
  }

  public setActiveModelOverride(telegramUserId: string, modelId: string): void {
    this.sessionRepository.setActiveModelOverride(this.ensureTelegramAccountId(telegramUserId), modelId);
  }

  public clearActiveModelOverride(telegramUserId: string): void {
    this.sessionRepository.clearActiveModelOverride(this.ensureTelegramAccountId(telegramUserId));
  }

  public listRecentSessions(telegramUserId: string, limit = 5): RecentSession[] {
    return this.sessionRepository.listRecentSessions(this.ensureTelegramAccountId(telegramUserId), limit);
  }

  public createMessageLink(params: {
    telegramUserId: string;
    chatId: string;
    userMessageId: number;
    botMessageIds: number[];
    characterAvatar: string;
    characterName: string;
    chatFile: string;
  }): number {
    const accountId = this.ensureTelegramAccountId(params.telegramUserId);
    return this.turnRepository.createTurnRecord({
      accountId,
      channel: "telegram",
      sessionKey: buildSessionKey(params.characterAvatar, params.chatFile),
      clientTurnId: String(params.userMessageId),
      operation: "telegram_send_stream",
      status: "completed",
      externalRefs: {
        chatId: params.chatId,
        userMessageId: params.userMessageId,
        botMessageIds: params.botMessageIds,
        characterAvatar: params.characterAvatar,
        characterName: params.characterName,
        chatFile: params.chatFile,
      },
    });
  }

  public getLatestActiveMessageLink(params: {
    telegramUserId: string;
    chatId: string;
    characterAvatar: string;
    chatFile: string;
  }): MessageLink | null {
    const accountId = this.ensureTelegramAccountId(params.telegramUserId);
    const record = this.turnRepository.getLatestActiveTurnRecord({
      accountId,
      channel: "telegram",
      sessionKey: buildSessionKey(params.characterAvatar, params.chatFile),
      externalRefMatches: {
        chatId: params.chatId,
      },
    });

    if (!record) {
      return null;
    }

    return {
      id: record.id,
      telegramUserId: params.telegramUserId,
      chatId: String(record.externalRefs.chatId ?? ""),
      userMessageId: Number(record.externalRefs.userMessageId ?? 0),
      botMessageIds: Array.isArray(record.externalRefs.botMessageIds)
        ? (record.externalRefs.botMessageIds as number[]).map((item) => Number(item)).filter((item) => Number.isInteger(item))
        : parseBotMessageIds(String(record.externalRefs.botMessageIds ?? "")),
      characterAvatar: String(record.externalRefs.characterAvatar ?? params.characterAvatar),
      characterName: String(record.externalRefs.characterName ?? ""),
      chatFile: String(record.externalRefs.chatFile ?? params.chatFile),
      createdAt: record.createdAt,
      revokedAt: record.revokedAt,
    };
  }

  public updateMessageLinkBotMessages(id: number, botMessageIds: number[]): void {
    const existing = this.turnRepository.getTurnRecordById(id);
    if (!existing) {
      return;
    }

    this.turnRepository.updateTurnExternalRefs(id, {
      ...existing.externalRefs,
      botMessageIds,
    });
  }

  public markMessageLinkRevoked(id: number): void {
    this.turnRepository.markTurnRevoked(id);
  }
}
