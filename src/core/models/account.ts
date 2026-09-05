export interface Account {
  accountId: string;
  displayName: string | null;
  createdAt: string;
}

export type IdentityChannel = "telegram" | "ios";

export interface ExternalIdentity {
  accountId: string;
  channel: IdentityChannel;
  externalUserId: string;
  createdAt: string;
}

export type ProxyScheme = "socks5" | "socks" | "http" | "https";

export interface AccountProxyConfig {
  enabled: boolean;
  /** socks5://[user:pass@]host:port 或 http(s):// 同理；由 proxy-agent 模块校验。 */
  url: string | null;
}
