/**
 * Barrel exports for the MCP OAuth 2.1 client module.
 *
 * External callers (src/web/server.ts, CLI commands, tests) should import only
 * from `@/core/mcp-client` — never reach into individual files. This keeps the
 * module boundary clean so we can swap internals (e.g. plaintext token store →
 * encrypted) without touching call sites.
 */

export {
  McpClient,
  NotConnectedError,
  RefreshFailedError,
  type McpClientOptions,
  type ConnectInput,
  type ConnectPrepared,
  type ListedTool,
  type ToolCallResult,
  type TokenBundle,
} from './client.js';

export {
  discoverMcpServer,
  probeForResourceMetadata,
  fetchProtectedResourceMetadata,
  fetchAuthorizationServerMetadata,
  parseResourceMetadataFromChallenge,
  type DiscoveryResult,
  type ProtectedResourceMetadata,
  type AuthorizationServerMetadata,
} from './metadata-discovery.js';

export {
  registerDynamicClient,
  useStaticClientId,
  type RegisteredMcpClient,
  type RegistrationInput,
} from './dcr.js';

export {
  generatePkce,
  generateState,
  canonicalizeResource,
  type PkcePair,
} from './oauth-pkce.js';

export {
  getTokenEntry,
  saveTokenEntry,
  deleteTokenEntry,
  listTokenEntries,
  redactEntry,
  isAccessTokenExpired,
  type McpClientTokenEntry,
} from './token-store.js';
