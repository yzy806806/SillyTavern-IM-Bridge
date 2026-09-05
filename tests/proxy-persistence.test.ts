
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createSqlitePersistence } from "../src/infra/persistence/sqlite-store";

let tmpDir: string;
beforeEach(() => { tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "st-im-bridge-proxy-")); });
afterEach(() => { fs.rmSync(tmpDir, { recursive: true, force: true }); });

describe("AccountConfigRepository proxy persistence", () => {
  it("defaults proxy to disabled/null and persists patches", () => {
    const dbPath = path.join(tmpDir, "app.db");
    const persistence = createSqlitePersistence(dbPath);
    persistence.accountRepository.ensureSTUserAccount({ handle: "px", role: "user" });
    const cfg = persistence.accountConfigRepository.ensure("handle:px");
    expect(cfg.proxy.enabled).toBe(false);
    expect(cfg.proxy.url).toBeNull();

    persistence.accountConfigRepository.upsert("handle:px", { proxy: { enabled: true, url: "socks5://1.2.3.4:1080" } });
    let got = persistence.accountConfigRepository.get("handle:px");
    expect(got?.proxy.enabled).toBe(true);
    expect(got?.proxy.url).toBe("socks5://1.2.3.4:1080");

    // disabling keeps url, per design (so UI can re-enable without retyping)
    persistence.accountConfigRepository.upsert("handle:px", { proxy: { enabled: false } });
    got = persistence.accountConfigRepository.get("handle:px");
    expect(got?.proxy.enabled).toBe(false);
    expect(got?.proxy.url).toBe("socks5://1.2.3.4:1080");
    persistence.close();
  });

  it("migrates a legacy DB without proxy columns", () => {
    // First create a DB, then manually drop the proxy columns by rebuilding a legacy-shaped table.
    const dbPath = path.join(tmpDir, "legacy.db");
    const persistence = createSqlitePersistence(dbPath);
    persistence.accountRepository.ensureSTUserAccount({ handle: "old", role: "user" });
    persistence.accountConfigRepository.upsert("handle:old", { telegramBotToken: "t0k" });
    persistence.close();

    // Simulate legacy schema: recreate table without proxy columns.
    const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: new (p: string) => { exec(sql: string): void; prepare(sql: string): { run(...a: unknown[]): void } } };
    const raw = new DatabaseSync(dbPath);
    raw.exec(`
      BEGIN;
      CREATE TABLE account_configs_new AS SELECT
        account_id, telegram_bot_token, telegram_allowed_user_ids, bot_enabled,
        compress_keep_recent, compress_batch_size, compress_timeout_ms, compress_retry_count, compress_retry_delay_ms,
        tg_inter_message_delay_ms, tg_stream_min_interval_ms, tg_stream_min_delta_chars, tg_advanced_json,
        created_at, updated_at
      FROM account_configs;
      DROP TABLE account_configs;
      CREATE TABLE account_configs (
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
        created_at                TEXT NOT NULL,
        updated_at                TEXT NOT NULL
      );
      INSERT INTO account_configs SELECT * FROM account_configs_new;
      DROP TABLE account_configs_new;
      COMMIT;
    `);
    raw.exec("DELETE FROM accounts WHERE account_id = 'x'"); // no-op check executable
    raw.close?.();

    const reopened = createSqlitePersistence(dbPath);
    const cfg = reopened.accountConfigRepository.get("handle:old");
    expect(cfg?.telegramBotToken).toBe("t0k");
    expect(cfg?.proxy.enabled).toBe(false);
    expect(cfg?.proxy.url).toBeNull();
    reopened.close();
  });
});
