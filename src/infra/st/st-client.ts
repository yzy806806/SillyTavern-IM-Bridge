import type {
  CharacterCardDetails,
  CharacterSummary,
  ChatMessage,
  ChatSearchResult,
  LatestDialogueRecord,
  ModelSummary,
  StGenerationSettings,
} from "../../core/models/index";
import { AppError } from "../../shared/errors/app-error";
import {
  decodeCharacterCard,
  decodeCharacterSummaries,
  decodeChatMessages,
  decodeChatSearchResults,
  decodeGenerationSettings,
  decodeModelSummaries,
} from "./st-decoders";
import { createStGenerateError, createStRequestError } from "./st-errors";
import { pickLatestDialogueRecord } from "./st-chat-mapper";

interface StClientOptions {
  baseUrl: string;
  hostHeader: string | null;
  /** 普通 ST API 超时。 */
  timeoutMs: number;
  /** 生成接口硬上限（绝对超时）。 */
  generateTimeoutMs: number;
  /** 流式生成 idle 超时：连续无新 token 超过该值才中断。 */
  generateIdleTimeoutMs: number;
}

interface SessionState {
  csrfToken: string;
  cookieHeader: string;
}

/** 可续命的超时控制器：每次 touch() 重置 idle 计时，同时保留绝对硬上限。 */
class RenewingTimeoutController {
  private readonly controller = new AbortController();
  private readonly hardTimer: ReturnType<typeof setTimeout>;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly idleTimeoutMs: number;
  private reason: "idle" | "hard" | null = null;

  public constructor(hardTimeoutMs: number, idleTimeoutMs: number) {
    this.idleTimeoutMs = Math.max(1_000, idleTimeoutMs);
    this.hardTimer = setTimeout(() => {
      this.reason = "hard";
      this.controller.abort(
        new DOMException(
          `The operation was aborted due to timeout (hard limit ${hardTimeoutMs}ms)`,
          "TimeoutError",
        ),
      );
    }, Math.max(1_000, hardTimeoutMs));
    this.touch();
  }

  public get signal(): AbortSignal {
    return this.controller.signal;
  }

  public get abortReason(): "idle" | "hard" | null {
    return this.reason;
  }

  public touch(): void {
    if (this.controller.signal.aborted) {
      return;
    }
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
    }
    this.idleTimer = setTimeout(() => {
      this.reason = "idle";
      this.controller.abort(
        new DOMException(
          `The operation was aborted due to timeout (idle ${this.idleTimeoutMs}ms without new tokens)`,
          "TimeoutError",
        ),
      );
    }, this.idleTimeoutMs);
  }

  public dispose(): void {
    clearTimeout(this.hardTimer);
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

export class StClient {
  private readonly options: StClientOptions;
  private sessionState: SessionState | null = null;

  public constructor(options: StClientOptions) {
    this.options = {
      ...options,
      generateTimeoutMs: options.generateTimeoutMs > 0 ? options.generateTimeoutMs : 900_000,
      generateIdleTimeoutMs: options.generateIdleTimeoutMs > 0 ? options.generateIdleTimeoutMs : 90_000,
    };
  }

  public async listCharacters(): Promise<CharacterSummary[]> {
    const payload = await this.postJson("/api/characters/all", {});
    return decodeCharacterSummaries(payload);
  }

  public async listCharacterChats(avatar: string): Promise<ChatSearchResult[]> {
    const payload = await this.postJson("/api/chats/search", { avatar_url: avatar, query: "" });
    return decodeChatSearchResults(payload);
  }

  public async getChatMessages(avatar: string, fileId: string): Promise<ChatMessage[]> {
    const payload = await this.postJson("/api/chats/get", {
      avatar_url: avatar,
      file_name: fileId,
    });

    return decodeChatMessages(payload);
  }

  public async getLatestDialogueRecord(avatar: string, fileId: string): Promise<LatestDialogueRecord | null> {
    const messages = await this.getChatMessages(avatar, fileId);
    return pickLatestDialogueRecord(avatar, fileId, messages);
  }

  public async getCharacterCard(avatar: string): Promise<CharacterCardDetails> {
    const payload = await this.postJson("/api/characters/all", {});
    return decodeCharacterCard(payload, avatar);
  }

  public async getGenerationSettings(): Promise<StGenerationSettings> {
    const payload = await this.postJson("/api/settings/get", {});
    return decodeGenerationSettings(payload);
  }

  public async generateChatReply(params: {
    settings: StGenerationSettings;
    messages: Array<{ role: string; content: string; name?: string }>;
  }): Promise<any> {
    const payload = this.buildGeneratePayload(params.settings, params.messages, false);
    return this.postJson(
      "/api/backends/chat-completions/generate",
      payload,
      true,
      this.options.generateTimeoutMs,
    );
  }

  public async generateChatReplyStream(params: {
    settings: StGenerationSettings;
    messages: Array<{ role: string; content: string; name?: string }>;
    onProgress?: (content: string) => Promise<void> | void;
  }): Promise<any> {
    const payload = this.buildGeneratePayload(params.settings, params.messages, true);
    const session = await this.ensureSession();
    const timeout = new RenewingTimeoutController(
      this.options.generateTimeoutMs,
      this.options.generateIdleTimeoutMs,
    );

    try {
      const response = await fetch(new URL("/api/backends/chat-completions/generate", this.options.baseUrl), {
        method: "POST",
        headers: {
          ...this.buildCommonHeaders(),
          "content-type": "application/json",
          "x-csrf-token": session.csrfToken,
          Cookie: session.cookieHeader,
        },
        body: JSON.stringify(payload),
        signal: timeout.signal,
      });

      // 首包到达，续命 idle 计时。
      timeout.touch();

      if (!response.ok) {
        throw createStRequestError("/api/backends/chat-completions/generate", response.status);
      }

      if (!response.body) {
        throw new AppError("ST_STREAM_MISSING", "ST stream response body missing", 502);
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      let content = "";
      let errorMessage = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          break;
        }

        // 任意 chunk 到达都续命，避免长文被绝对 120s 误杀。
        timeout.touch();

        buffer += decoder.decode(value, { stream: true });
        const events = buffer.split("\n\n");
        buffer = events.pop() ?? "";

        for (const event of events) {
          const lines = event
            .split("\n")
            .map((line) => line.trim())
            .filter((line) => line.startsWith("data:"));

          for (const line of lines) {
            const jsonText = line.slice(5).trim();
            if (!jsonText || jsonText === "[DONE]") {
              continue;
            }

            const parsed = JSON.parse(jsonText);
            if (typeof parsed?.error?.message === "string" && parsed.error.message.trim()) {
              errorMessage = parsed.error.message.trim();
            }

            const delta = parsed?.choices?.[0]?.delta ?? {};
            if (typeof delta.content === "string" && delta.content) {
              content += delta.content;
              // 真正吐出 token 时再续一次，覆盖 onProgress 慢（TG edit）场景。
              timeout.touch();
              await params.onProgress?.(content);
            }
          }
        }
      }

      if (errorMessage) {
        throw createStGenerateError(errorMessage);
      }

      if (!content.trim()) {
        return this.generateChatReply({
          settings: params.settings,
          messages: params.messages,
        });
      }

      return {
        choices: [
          {
            message: {
              content,
            },
          },
        ],
      };
    } catch (error) {
      if (timeout.abortReason === "idle" || timeout.abortReason === "hard") {
        const kind = timeout.abortReason === "idle" ? "idle" : "hard";
        const limitMs = kind === "idle"
          ? this.options.generateIdleTimeoutMs
          : this.options.generateTimeoutMs;
        throw createStGenerateError(
          `生成超时（${kind} ${Math.round(limitMs / 1000)}s）。可调 ST_GENERATE_IDLE_TIMEOUT_MS / ST_GENERATE_TIMEOUT_MS`,
        );
      }
      throw error;
    } finally {
      timeout.dispose();
    }
  }

  public async listAvailableModels(settings?: StGenerationSettings): Promise<ModelSummary[]> {
    const effectiveSettings = settings ?? await this.getGenerationSettings();
    const payload: Record<string, unknown> = {
      chat_completion_source: effectiveSettings.chatCompletionSource,
    };

    if (effectiveSettings.chatCompletionSource === "custom") {
      payload.custom_url = effectiveSettings.customUrl;
      payload.custom_include_headers = "";
      payload.reverse_proxy = "";
      payload.proxy_password = "";
    }

    const response = await this.postJson("/api/backends/chat-completions/status", payload);
    return decodeModelSummaries(response);
  }

  public async saveChat(params: {
    avatar: string;
    characterName: string;
    chatFile: string;
    chat: ChatMessage[];
  }): Promise<void> {
    await this.postJson("/api/chats/save", {
      avatar_url: params.avatar,
      ch_name: params.characterName,
      file_name: params.chatFile,
      chat: params.chat,
      force: false,
    });
  }

  public async deleteChat(params: { avatar: string; chatFile: string }): Promise<void> {
    await this.postJson("/api/chats/delete", {
      avatar_url: params.avatar,
      chatfile: params.chatFile,
    });
  }

  private buildGeneratePayload(
    settings: StGenerationSettings,
    messages: Array<{ role: string; content: string; name?: string }>,
    stream: boolean,
  ): Record<string, unknown> {
    const payload: Record<string, unknown> = {
      chat_completion_source: settings.chatCompletionSource,
      model: settings.model,
      messages,
      temperature: settings.temperature,
      top_p: settings.topP,
      max_tokens: settings.maxTokens,
      stream,
    };

    if (settings.chatCompletionSource === "custom") {
      payload.custom_url = settings.customUrl;
      payload.custom_prompt_post_processing = settings.customPromptPostProcessing;
      payload.custom_include_body = "";
      payload.custom_include_headers = "";
      payload.custom_exclude_body = "";
    }

    return payload;
  }

  private async postJson(pathname: string, body: Record<string, unknown>, retry = true, timeoutMs?: number): Promise<any> {
    const session = await this.ensureSession();
    const response = await fetch(new URL(pathname, this.options.baseUrl), {
      method: "POST",
      headers: {
        ...this.buildCommonHeaders(),
        "content-type": "application/json",
        "x-csrf-token": session.csrfToken,
        Cookie: session.cookieHeader,
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs ?? this.options.timeoutMs),
    });

    if (response.status === 403 && retry) {
      this.sessionState = null;
      return this.postJson(pathname, body, false, timeoutMs);
    }

    if (!response.ok) {
      let bodyPreview = "";
      try {
        bodyPreview = (await response.text()).slice(0, 300);
      } catch {
        bodyPreview = "<unreadable>";
      }
      console.error(JSON.stringify({
        scope: "st_client",
        event: "request_failed",
        pathname,
        status: response.status,
        bodyPreview,
      }));
      throw createStRequestError(pathname, response.status);
    }

    const parsed = await response.json();
    if (pathname === "/api/chats/get" && !Array.isArray(parsed)) {
      console.error(JSON.stringify({
        scope: "st_client",
        event: "chat_payload_non_array",
        pathname,
        status: response.status,
        payloadType: parsed === null ? "null" : Array.isArray(parsed) ? "array" : typeof parsed,
        payloadPreview: JSON.stringify(parsed).slice(0, 300),
        requestBody: { avatar_url: body.avatar_url, file_name: body.file_name },
      }));
    }
    return parsed;
  }

  private async ensureSession(): Promise<SessionState> {
    if (this.sessionState) {
      return this.sessionState;
    }

    const response = await fetch(new URL("/csrf-token", this.options.baseUrl), {
      headers: this.buildCommonHeaders(),
      signal: AbortSignal.timeout(this.options.timeoutMs),
    });

    if (!response.ok) {
      throw new AppError("ST_CSRF_FAILED", `Failed to get ST CSRF token: ${response.status}`, 502);
    }

    const body = await response.json() as { token?: string };
    if (!body.token) {
      throw new AppError("ST_CSRF_MISSING", "ST CSRF token missing", 502);
    }

    const cookies = response.headers.getSetCookie?.() ?? [];
    const cookieHeader = cookies.map((entry) => entry.split(";", 1)[0]).join("; ");
    if (!cookieHeader) {
      throw new AppError("ST_COOKIE_MISSING", "ST session cookie missing", 502);
    }

    this.sessionState = {
      csrfToken: body.token,
      cookieHeader,
    };
    return this.sessionState;
  }

  private buildCommonHeaders(): Record<string, string> {
    if (!this.options.hostHeader) {
      return {};
    }

    return {
      Host: this.options.hostHeader,
    };
  }
}
