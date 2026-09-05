import express, { type Request, type Response, type Router, type NextFunction } from "express";
import type { AppServices } from "./build-services";
import type { Account, ActiveSession, RecentSession, StoredChatSession, StreamEvent } from "../core/models/index";
import type { CompressProgressEvent } from "../core/services/compression-service";
import { SseResponse } from "../delivery/http/sse/sse-response";
import { AppError, toAppError } from "../shared/errors/app-error";
import { maskProxyUrl } from "../infra/proxy/proxy-agent";
import { buildSessionKey, createRequestId } from "../shared/utils/ids";
import {
  requireSTAdmin,
  requireSTLogin,
  requireSelfOrAdmin,
} from "./middleware";
import { createRateLimiter } from "./rate-limit";

interface RequestContext { requestId: string; traceId: string }

function buildRequestContext(req: Request): RequestContext {
  const requestIdHeader = req.headers["x-request-id"];
  const traceIdHeader = req.headers["x-trace-id"];
  const requestId = typeof requestIdHeader === "string" && requestIdHeader.trim()
    ? requestIdHeader.trim()
    : createRequestId();
  const traceId = typeof traceIdHeader === "string" && traceIdHeader.trim()
    ? traceIdHeader.trim()
    : requestId;
  return { requestId, traceId };
}

function maskToken(token: string | null): string | null {
  if (!token) return null;
  if (token.length <= 6) return "***";
  return `***${token.slice(-4)}`;
}

function toSessionPayload(accountId: string, session: ActiveSession | null): Record<string, unknown> {
  const sessionKey = session?.activeCharacterAvatar && session.activeChatFile
    ? buildSessionKey(session.activeCharacterAvatar, session.activeChatFile)
    : null;
  return {
    accountId,
    activeCharacterAvatar: session?.activeCharacterAvatar ?? null,
    activeCharacterName: session?.activeCharacterName ?? null,
    activeChatFile: session?.activeChatFile ?? null,
    activeModelOverride: session?.activeModelOverride ?? null,
    compressionModelOverride: session?.compressionModelOverride ?? null,
    currentModel: session?.currentModel ?? null,
    updatedAt: session?.updatedAt ?? null,
    sessionKey,
    isSelected: Boolean(sessionKey),
  };
}

function toRecentSessionPayload(currentSessionKey: string | null, item: RecentSession): Record<string, unknown> {
  const sessionKey = buildSessionKey(item.characterAvatar, item.chatFile);
  return { ...item, sessionKey, isActive: sessionKey === currentSessionKey };
}

function toStoredSessionPayload(currentSessionKey: string | null, item: StoredChatSession): Record<string, unknown> {
  const sessionKey = buildSessionKey(item.avatar, item.fileId);
  return { ...item, chatFile: item.fileId, sessionKey, isActive: sessionKey === currentSessionKey };
}

function sendStreamEvent(sse: SseResponse, event: StreamEvent, ctx: RequestContext): void {
  switch (event.type) {
    case "started":
      sse.send("started", { sessionKey: event.sessionKey, ...ctx });
      return;
    case "delta":
      sse.send("delta", { text: event.text, fullText: event.fullText, ...ctx });
      return;
    case "done":
      sse.send("done", { replyText: event.replyText, latestRecord: event.latestRecord, finishReason: "stop", ...ctx });
      return;
    case "error":
      sse.send("error", { message: event.message, finishReason: "error", ...ctx });
      return;
  }
}

async function streamConversation(
  services: AppServices,
  res: Response,
  ctx: RequestContext,
  run: (onProgress: (event: StreamEvent) => Promise<void>) => Promise<void>,
): Promise<void> {
  const sse = new SseResponse(res);
  const entry = services.sseRegistry.register(res, sse);
  try {
    await run(async (event) => sendStreamEvent(sse, event, ctx));
  } finally {
    sse.end();
    services.sseRegistry.unregister(entry);
  }
}

function asyncHandler<T extends (req: Request, res: Response, next: NextFunction) => Promise<unknown>>(handler: T) {
  return (req: Request, res: Response, next: NextFunction): void => {
    handler(req, res, next).catch(next);
  };
}

function accountIdFromCtx(req: Request): string {
  if (!req.stCtx) {
    throw new AppError("ST_LOGIN_REQUIRED", "需要 SillyTavern 登录", 403);
  }
  return req.stCtx.accountId;
}

function targetAccountId(req: Request): string {
  return `handle:${req.params.handle}`;
}

export function registerRoutes(router: Router, services: AppServices): void {
  router.use(express.json({ limit: "1mb" }));

  router.get("/probe", (_req, res) => { res.status(204).end(); });

  router.use(requireSTLogin(services.repositories.accountRepository));

  const limiter = createRateLimiter({
    windowMs: services.runtime.rateLimitWindowMs,
    max: services.runtime.rateLimitMaxRequests,
  });

  router.get("/me", asyncHandler(async (req, res) => {
    const ctx = req.stCtx!;
    const cfg = services.repositories.accountConfigRepository.get(ctx.accountId);
    const bot = services.botManager.get(ctx.accountId);
    res.json({
      handle: ctx.handle,
      admin: ctx.admin,
      accountId: ctx.accountId,
      displayName: ctx.displayName,
      hasBotToken: !!cfg?.telegramBotToken,
      botEnabled: cfg?.botEnabled ?? false,
      botStatus: bot?.status ?? "stopped",
      botUsername: bot?.username ?? null,
      lastError: bot?.lastError ?? null,
    });
  }));

  router.get("/characters", asyncHandler(async (_req, res) => {
    const items = await services.characterService.listCharacters();
    res.json({ items });
  }));

  router.get("/characters/:avatar", asyncHandler(async (req, res) => {
    const card = await services.characterService.getCharacterCard(req.params.avatar);
    res.json(card);
  }));

  router.get("/characters/:avatar/chats", asyncHandler(async (req, res) => {
    const items = await services.characterService.listCharacterChats(req.params.avatar);
    res.json({ items });
  }));

  router.get("/session/all", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const currentSession = services.sessionService.getActiveSession(accountId);
    const currentSessionKey = currentSession?.activeCharacterAvatar && currentSession.activeChatFile
      ? buildSessionKey(currentSession.activeCharacterAvatar, currentSession.activeChatFile)
      : null;
    const items = await services.characterService.listAllChats();
    res.json({ items: items.map((item) => toStoredSessionPayload(currentSessionKey, item)) });
  }));

  router.get("/session/current", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    res.json(toSessionPayload(accountId, services.sessionService.getActiveSession(accountId)));
  }));

  router.post("/session/select-character", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const avatar = typeof req.body?.avatar === "string" ? req.body.avatar : "";
    const characterName = typeof req.body?.characterName === "string" && req.body.characterName.trim()
      ? req.body.characterName.trim()
      : (await services.characterService.getCharacterCard(avatar)).name;
    services.sessionService.setActiveCharacter(accountId, avatar, characterName);
    res.json({ ok: true, session: toSessionPayload(accountId, services.sessionService.getActiveSession(accountId)) });
  }));

  router.post("/session/select-chat", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const avatar = typeof req.body?.avatar === "string" ? req.body.avatar : "";
    const chatFile = typeof req.body?.chatFile === "string" ? req.body.chatFile : "";
    const characterName = typeof req.body?.characterName === "string" && req.body.characterName.trim()
      ? req.body.characterName.trim()
      : (await services.characterService.getCharacterCard(avatar)).name;
    services.sessionService.setActiveSession(accountId, avatar, characterName, chatFile);
    res.json({ ok: true, session: toSessionPayload(accountId, services.sessionService.getActiveSession(accountId)) });
  }));

  router.post("/session/start-chat", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const avatar = typeof req.body?.avatar === "string" ? req.body.avatar : "";
    const created = await services.characterService.createChatFromCharacter(avatar);
    services.sessionService.setActiveSession(accountId, created.avatar, created.characterName, created.fileId);
    res.json({
      ...toSessionPayload(accountId, services.sessionService.getActiveSession(accountId)),
      createdChat: toStoredSessionPayload(buildSessionKey(created.avatar, created.fileId), created),
    });
  }));

  router.get("/session/recent", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const currentSession = services.sessionService.getActiveSession(accountId);
    const currentSessionKey = currentSession?.activeCharacterAvatar && currentSession.activeChatFile
      ? buildSessionKey(currentSession.activeCharacterAvatar, currentSession.activeChatFile)
      : null;
    const items = services.sessionService.listRecentSessions(accountId, services.runtime.pageSize);
    res.json({ items: items.map((item) => toRecentSessionPayload(currentSessionKey, item)) });
  }));

  router.get("/messages/last", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const session = services.sessionService.requireActiveSession(accountId);
    const details = await services.chatEditService.getLastTurn({
      avatar: session.activeCharacterAvatar!,
      chatFile: session.activeChatFile!,
    });
    res.json(details);
  }));

  router.get("/messages/history", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const session = services.sessionService.requireActiveSession(accountId);
    const items = await services.chatEditService.getChatHistory({
      avatar: session.activeCharacterAvatar!,
      chatFile: session.activeChatFile!,
    });
    res.json({ items });
  }));

  router.get("/messages/history-sync", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const session = services.sessionService.requireActiveSession(accountId);
    const sessionKey = buildSessionKey(session.activeCharacterAvatar!, session.activeChatFile!);
    const requestedSessionKey = typeof req.query.sessionKey === "string" ? req.query.sessionKey : null;
    if (requestedSessionKey && requestedSessionKey !== sessionKey) {
      throw new AppError("SESSION_MISMATCH", "当前激活会话与请求目标不一致", 409);
    }
    const knownRevisionRaw = typeof req.query.knownRevision === "string" ? req.query.knownRevision : null;
    const afterSortIndexRaw = typeof req.query.afterSortIndex === "string" ? req.query.afterSortIndex : null;
    const knownRevision = knownRevisionRaw !== null ? Number(knownRevisionRaw) : null;
    const afterSortIndex = afterSortIndexRaw !== null ? Number(afterSortIndexRaw) : null;
    const result = await services.chatEditService.getChatHistorySync({
      accountId,
      avatar: session.activeCharacterAvatar!,
      chatFile: session.activeChatFile!,
      knownRevision: Number.isFinite(knownRevision) ? knownRevision : null,
      afterSortIndex: Number.isFinite(afterSortIndex) ? afterSortIndex : null,
    });
    res.json(result);
  }));

  router.post("/messages/send", limiter, asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const ctx = buildRequestContext(req);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const clientTurnId = typeof req.body?.clientTurnId === "string" ? req.body.clientTurnId : null;
    const session = services.sessionService.requireActiveSession(accountId);
    const sessionKey = buildSessionKey(session.activeCharacterAvatar!, session.activeChatFile!);
    const turnRecordId = services.repositories.turnRepository.createTurnRecord({
      accountId, channel: "ios", sessionKey, clientTurnId,
      requestId: ctx.requestId, traceId: ctx.traceId,
      operation: "http_send", status: "started",
      externalRefs: clientTurnId ? { clientTurnId } : {},
    });
    try {
      const result = await services.conversationService.sendMessage({
        accountId,
        avatar: session.activeCharacterAvatar!,
        characterName: session.activeCharacterName!,
        chatFile: session.activeChatFile!,
        text,
        modelOverride: session.activeModelOverride,
      });
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed", errorMessage: null,
        externalRefs: {
          ...(clientTurnId ? { clientTurnId } : {}),
          latestMessageId: result.latestRecord?.messageId ?? null,
          latestTurnId: result.latestRecord?.turnId ?? null,
        },
      });
      res.json({ ...result, ...ctx, turnRecordId });
    } catch (error) {
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed", errorMessage: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
  }));

  router.post("/messages/send-stream", limiter, asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const ctx = buildRequestContext(req);
    const text = typeof req.body?.text === "string" ? req.body.text : "";
    const clientTurnId = typeof req.body?.clientTurnId === "string" ? req.body.clientTurnId : null;
    const session = services.sessionService.requireActiveSession(accountId);
    const sessionKey = buildSessionKey(session.activeCharacterAvatar!, session.activeChatFile!);
    const turnRecordId = services.repositories.turnRepository.createTurnRecord({
      accountId, channel: "ios", sessionKey, clientTurnId,
      requestId: ctx.requestId, traceId: ctx.traceId,
      operation: "http_send_stream", status: "started",
      externalRefs: clientTurnId ? { clientTurnId } : {},
    });
    let doneLatestRecord: Record<string, unknown> | null = null;
    try {
      await streamConversation(services, res, ctx, async (onProgress) => {
        await services.conversationService.sendMessageStream({
          accountId,
          avatar: session.activeCharacterAvatar!,
          characterName: session.activeCharacterName!,
          chatFile: session.activeChatFile!,
          text,
          modelOverride: session.activeModelOverride,
          onProgress: async (event) => {
            if (event.type === "done") {
              doneLatestRecord = event.latestRecord as Record<string, unknown> | null;
            }
            await onProgress(event);
          },
        });
      });
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed", errorMessage: null,
        externalRefs: {
          ...(clientTurnId ? { clientTurnId } : {}),
          latestMessageId: doneLatestRecord?.["messageId"] ?? null,
          latestTurnId: doneLatestRecord?.["turnId"] ?? null,
        },
      });
    } catch (error) {
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed", errorMessage: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
  }));

  router.post("/messages/undo", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const ctx = buildRequestContext(req);
    const session = services.sessionService.requireActiveSession(accountId);
    const turnRecordId = services.repositories.turnRepository.createTurnRecord({
      accountId, channel: "ios",
      sessionKey: buildSessionKey(session.activeCharacterAvatar!, session.activeChatFile!),
      requestId: ctx.requestId, traceId: ctx.traceId, operation: "http_undo", status: "started",
    });
    try {
      const result = await services.chatEditService.deleteLastTurn({
        accountId,
        avatar: session.activeCharacterAvatar!,
        characterName: session.activeCharacterName!,
        chatFile: session.activeChatFile!,
      });
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed", errorMessage: null,
        externalRefs: {
          removedUserMessageId: result.removed.userMessage?.messageId ?? null,
          removedAssistantMessageId: result.removed.assistantMessage?.messageId ?? null,
          latestMessageId: result.latestRecord?.messageId ?? null,
          latestTurnId: result.latestRecord?.turnId ?? null,
        },
      });
      res.json({ ...result, ...ctx, turnRecordId });
    } catch (error) {
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed", errorMessage: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
  }));

  router.post("/messages/redo-stream", limiter, asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const ctx = buildRequestContext(req);
    const session = services.sessionService.requireActiveSession(accountId);
    const turnRecordId = services.repositories.turnRepository.createTurnRecord({
      accountId, channel: "ios",
      sessionKey: buildSessionKey(session.activeCharacterAvatar!, session.activeChatFile!),
      requestId: ctx.requestId, traceId: ctx.traceId, operation: "http_redo_stream", status: "started",
    });
    let doneLatestRecord: Record<string, unknown> | null = null;
    try {
      await streamConversation(services, res, ctx, async (onProgress) => {
        await services.chatEditService.regenerateLastReply({
          accountId,
          avatar: session.activeCharacterAvatar!,
          characterName: session.activeCharacterName!,
          chatFile: session.activeChatFile!,
          modelOverride: session.activeModelOverride,
          onProgress: async (event) => {
            if (event.type === "done") {
              doneLatestRecord = event.latestRecord as Record<string, unknown> | null;
            }
            await onProgress(event);
          },
        });
      });
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed", errorMessage: null,
        externalRefs: {
          latestMessageId: doneLatestRecord?.["messageId"] ?? null,
          latestTurnId: doneLatestRecord?.["turnId"] ?? null,
        },
      });
    } catch (error) {
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed", errorMessage: error instanceof Error ? error.message : "未知错误",
      });
      throw error;
    }
  }));

  router.get("/models", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const result = await services.modelService.listAvailableModels(accountId);
    res.json(result);
  }));
  router.post("/models/select", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : "";
    services.modelService.selectModel(accountId, modelId);
    res.json({ ok: true });
  }));
  router.delete("/models/select", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    services.modelService.clearModelSelection(accountId);
    res.json({ ok: true });
  }));

  router.get("/compress/model", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const result = await services.modelService.listCompressionModels(accountId);
    res.json(result);
  }));
  router.post("/compress/model", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const modelId = typeof req.body?.modelId === "string" ? req.body.modelId : "";
    if (!modelId.trim()) throw new AppError("INVALID_MODEL_ID", "modelId 不能为空", 400);
    services.modelService.selectCompressionModel(accountId, modelId.trim());
    res.json({ ok: true });
  }));
  router.delete("/compress/model", asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    services.modelService.clearCompressionModelSelection(accountId);
    res.json({ ok: true });
  }));

  router.post("/compress/run", limiter, asyncHandler(async (req, res) => {
    const accountId = accountIdFromCtx(req);
    const ctx = buildRequestContext(req);
    const session = services.sessionService.requireActiveSession(accountId);
    const sessionKey = buildSessionKey(session.activeCharacterAvatar!, session.activeChatFile!);
    const turnRecordId = services.repositories.turnRepository.createTurnRecord({
      accountId, channel: "ios", sessionKey,
      requestId: ctx.requestId, traceId: ctx.traceId,
      operation: "http_compress", status: "started",
    });
    const sse = new SseResponse(res);
    const entry = services.sseRegistry.register(res, sse);
    const modelOverride = session.compressionModelOverride ?? session.activeModelOverride ?? null;
    try {
      const result = await services.compressionService.compressChat({
        accountId,
        avatar: session.activeCharacterAvatar!,
        characterName: session.activeCharacterName!,
        chatFile: session.activeChatFile!,
        modelOverride,
        onProgress: async (event: CompressProgressEvent) => {
          switch (event.type) {
            case "started":
              sse.send("started", { sessionKey: event.sessionKey, totalMessages: event.totalMessages, ...ctx });
              return;
            case "batch_done":
              sse.send("progress", { completedMessages: event.completedMessages, totalMessages: event.totalMessages, ...ctx });
              return;
            case "done":
              sse.send("done", {
                compressedCount: event.compressedCount,
                skippedCount: event.skippedCount,
                originalBytes: event.originalBytes,
                compressedBytes: event.compressedBytes,
                backupFile: event.backupFile,
                ...ctx,
              });
              return;
            case "error":
              sse.send("error", { message: event.message, ...ctx });
              return;
          }
        },
      });
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "completed", errorMessage: null,
        externalRefs: {
          compressedCount: result.compressedCount,
          skippedCount: result.skippedCount,
          backupFile: result.backupFile,
          originalBytes: result.originalBytes,
          compressedBytes: result.compressedBytes,
        },
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      services.repositories.turnRepository.updateTurnRecord(turnRecordId, {
        status: "failed", errorMessage: message,
      });
      sse.send("error", { message, ...ctx });
    } finally {
      sse.end();
      services.sseRegistry.unregister(entry);
    }
  }));

  function serializeAccount(accountId: string): Record<string, unknown> {
    const acc = services.repositories.accountRepository.getSTUserAccount(accountId);
    const cfg = services.repositories.accountConfigRepository.get(accountId);
    const bot = services.botManager.get(accountId);
    return {
      accountId,
      handle: acc?.stUserHandle ?? null,
      role: acc?.role ?? "user",
      displayName: acc?.displayName ?? null,
      botEnabled: cfg?.botEnabled ?? false,
      tokenPreview: maskToken(cfg?.telegramBotToken ?? null),
      hasBotToken: !!cfg?.telegramBotToken,
      allowedUserIds: cfg?.telegramAllowedUserIds ?? [],
      proxy: cfg?.proxy
        ? { enabled: cfg.proxy.enabled, urlMasked: maskProxyUrl(cfg.proxy.url), hasUrl: !!cfg.proxy.url }
        : { enabled: false, urlMasked: null, hasUrl: false },
      compress: cfg?.compress ?? null,
      tg: cfg?.tg ?? null,
      botStatus: bot?.status ?? "stopped",
      botUsername: bot?.username ?? null,
      lastError: bot?.lastError ?? null,
      startedAt: bot?.startedAt ?? null,
    };
  }

  router.get("/admin/accounts", requireSTAdmin(), asyncHandler(async (_req, res) => {
    const accounts = services.repositories.accountRepository.listSTUserAccounts();
    res.json({ items: accounts.map((a) => serializeAccount(a.accountId)) });
  }));

  router.get("/admin/accounts/:handle", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const acc = services.repositories.accountRepository.getSTUserAccount(targetAccountId(req));
    if (!acc) throw new AppError("ACCOUNT_NOT_FOUND", "账号不存在", 404);
    res.json(serializeAccount(acc.accountId));
  }));

  router.put("/admin/accounts/:handle/bot-token", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const token = typeof req.body?.token === "string" ? req.body.token : "";
    services.accountConfigService.setBotToken(accountId, token);
    if (services.botManager.get(accountId)) {
      await services.botManager.restartBot(accountId);
    }
    res.json(serializeAccount(accountId));
  }));

  router.delete("/admin/accounts/:handle/bot-token", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    if (services.botManager.get(accountId)) {
      await services.botManager.stopBot(accountId);
    }
    services.accountConfigService.clearBotToken(accountId);
    res.json(serializeAccount(accountId));
  }));

  router.post("/admin/accounts/:handle/bot/start", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    await services.botManager.startBot(accountId);
    res.json(serializeAccount(accountId));
  }));

  router.post("/admin/accounts/:handle/bot/stop", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    await services.botManager.stopBot(accountId);
    res.json(serializeAccount(accountId));
  }));

  router.put("/admin/accounts/:handle/allowed-users", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const userIds = Array.isArray(req.body?.userIds) ? req.body.userIds : [];
    services.accountConfigService.setAllowedUsers(accountId, userIds.map(String));
    res.json(serializeAccount(accountId));
  }));

  router.delete("/admin/accounts/:handle/allowed-users/:tgId", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    services.accountConfigService.removeAllowedUser(accountId, req.params.tgId);
    res.json(serializeAccount(accountId));
  }));

  router.post("/admin/accounts/:handle/bind-code", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const result = services.bindCodeService.generate(accountId);
    res.json(result);
  }));

  router.get("/admin/accounts/:handle/bind-code", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const active = services.bindCodeService.getActive(accountId);
    if (!active) {
      throw new AppError("NO_ACTIVE_BIND_CODE", "无活跃绑定码", 404);
    }
    res.json(active);
  }));

  router.delete("/admin/accounts/:handle/bind-code", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    services.bindCodeService.revoke(accountId);
    res.status(204).end();
  }));

  router.get("/admin/accounts/:handle/proxy", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const cfg = services.accountConfigService.get(accountId);
    if (!cfg) throw new AppError("ACCOUNT_NOT_FOUND", "账号不存在", 404);
    res.json({
      enabled: cfg.proxy.enabled,
      urlMasked: maskProxyUrl(cfg.proxy.url),
      hasUrl: !!cfg.proxy.url,
    });
  }));

  router.put("/admin/accounts/:handle/proxy", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const enabled = Boolean(req.body?.enabled);
    // url 未随请求提供（undefined）→ 服务层保留已存 URL；显式 null → 清空
    const rawUrl = req.body?.url;
    const url = rawUrl === undefined ? undefined : typeof rawUrl === "string" ? rawUrl : null;
    services.accountConfigService.setProxy(accountId, { enabled, url });
    if (services.botManager.get(accountId)) {
      await services.botManager.restartBot(accountId);
    }
    res.json(serializeAccount(accountId));
  }));

  router.delete("/admin/accounts/:handle/proxy", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    services.accountConfigService.clearProxy(accountId);
    if (services.botManager.get(accountId)) {
      await services.botManager.restartBot(accountId);
    }
    res.json(serializeAccount(accountId));
  }));

  router.put("/admin/accounts/:handle/compress-config", requireSelfOrAdmin(), asyncHandler(async (req, res) => {
    const accountId = targetAccountId(req);
    const compress = typeof req.body?.compress === "object" && req.body.compress ? req.body.compress as Record<string, number> : {};
    services.accountConfigService.update(accountId, { compress });
    res.json(serializeAccount(accountId));
  }));

  router.get("/admin/bots", requireSTAdmin(), asyncHandler(async (_req, res) => {
    const items = services.botManager.list().map((entry) => ({
      accountId: entry.accountId,
      handle: entry.handle,
      status: entry.status,
      username: entry.username,
      lastError: entry.lastError,
      startedAt: entry.startedAt,
    }));
    res.json({ items });
  }));

  router.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const ae = toAppError(err);
    if (res.headersSent) {
      res.end();
      return;
    }
    res.status(ae.statusCode).json({ error: { code: ae.code, message: ae.message } });
  });
}
