import type {
  LLMProvider,
  LLMOptions,
  LLMMessage,
  LLMResponse,
  ProviderChainConfig,
  ProviderChainId,
} from './types.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';
import type { UserConfig } from '../core/config.js';
import { runClaudeCode, isClaudeCodeAvailable } from '../core/claude-code.js';

/**
 * LLMProvider backed by the Claude Code CLI (`claude -p`).
 * Uses the caller's Claude Code subscription — no API key needed.
 */
export class ClaudeCodeProvider implements LLMProvider {
  readonly name = 'claude-code';

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const systemPrompt =
      options?.systemPrompt ??
      messages.find((m) => m.role === 'system')?.content ??
      '';
    const userContent = messages
      .filter((m) => m.role === 'user')
      .map((m) => m.content)
      .join('\n\n');

    const text = await runClaudeCode(systemPrompt, userContent);

    return {
      content: text,
      model: 'claude-code-cli',
      tokensUsed: { input: 0, output: 0 },
    };
  }

  async isAvailable(): Promise<boolean> {
    return isClaudeCodeAvailable();
  }
}

export function normalizeProviderId(name: string): ProviderChainId | null {
  const n = name.trim().toLowerCase();
  if (n === 'claude' || n === 'anthropic') return 'claude';
  if (n === 'openai' || n === 'gpt') return 'openai';
  if (n === 'ollama' || n === 'local') return 'ollama';
  return null;
}

function dedupeChain(ids: ProviderChainId[]): ProviderChainId[] {
  const seen = new Set<ProviderChainId>();
  const out: ProviderChainId[] = [];
  for (const id of ids) {
    if (!seen.has(id)) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

function resolveAnthropicKey(config: ProviderChainConfig): string | undefined {
  return config.keys?.anthropic ?? process.env['ANTHROPIC_API_KEY'];
}

function resolveOpenaiKey(config: ProviderChainConfig): string | undefined {
  return config.keys?.openai ?? process.env['OPENAI_API_KEY'];
}

function resolveOllamaBaseUrl(config: ProviderChainConfig): string | undefined {
  return config.keys?.ollama_url ?? process.env['OLLAMA_BASE_URL'];
}

function shouldIncludeInChain(id: ProviderChainId, config: ProviderChainConfig): boolean {
  if (id === 'claude') return !!resolveAnthropicKey(config);
  if (id === 'openai') return !!resolveOpenaiKey(config);
  return true;
}

function createConcreteProvider(id: ProviderChainId, config: ProviderChainConfig): LLMProvider {
  const model = config.model;
  if (id === 'claude') return new ClaudeProvider(model, resolveAnthropicKey(config));
  if (id === 'openai') return new OpenAIProvider(model, resolveOpenaiKey(config));
  return new OllamaProvider(model, resolveOllamaBaseUrl(config));
}

/**
 * Ordered LLM provider that tries each backend until one succeeds (Claude → OpenAI → Ollama by default).
 * Providers without credentials are omitted from the chain.
 */
class FallbackLLMProvider implements LLMProvider {
  readonly name: string;

  constructor(private readonly providers: LLMProvider[]) {
    if (providers.length === 0) {
      throw new Error(
        'Provider chain is empty. Set API keys (e.g. ANTHROPIC_API_KEY) or configure providers.keys in config.yaml.',
      );
    }
    this.name = `chain:${this.providers.map((p) => p.name).join('→')}`;
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const errors: string[] = [];
    for (const p of this.providers) {
      try {
        return await p.chat(messages, options);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(`[${p.name}] ${msg}`);
      }
    }
    throw new Error(`All providers in chain failed:\n${errors.join('\n')}`);
  }

  async isAvailable(): Promise<boolean> {
    for (const p of this.providers) {
      if (await p.isAvailable()) return true;
    }
    return false;
  }
}

/**
 * Build a fallback chain: try `primary`, then each entry in `fallback`, skipping providers without keys.
 */
export function createProviderChain(config: ProviderChainConfig): LLMProvider {
  const primary = config.primary;
  const rawOrder = [primary, ...config.fallback];
  const deduped = dedupeChain(rawOrder);

  const instances: LLMProvider[] = [];
  for (const id of deduped) {
    if (!shouldIncludeInChain(id, config)) continue;
    instances.push(createConcreteProvider(id, config));
  }

  return new FallbackLLMProvider(instances);
}

export function createProvider(
  name: string,
  options?: { model?: string; apiKey?: string; baseUrl?: string },
): LLMProvider {
  switch (name.toLowerCase()) {
    case 'claude':
    case 'anthropic':
      return new ClaudeProvider(options?.model, options?.apiKey);
    case 'openai':
    case 'gpt':
      return new OpenAIProvider(options?.model, options?.apiKey);
    case 'ollama':
    case 'local':
      return new OllamaProvider(options?.model, options?.baseUrl);
    case 'claude-code':
    case 'cc':
      return new ClaudeCodeProvider();
    default:
      throw new Error(
        `Unknown provider: "${name}".\n` +
          'Supported providers:\n' +
          '  claude       — Anthropic (requires ANTHROPIC_API_KEY)\n' +
          '  openai       — OpenAI (requires OPENAI_API_KEY)\n' +
          '  ollama       — Local models (requires Ollama running)\n' +
          '  claude-code  — Claude Code CLI (uses your subscription)\n' +
          'Set in config.yaml:  provider: claude',
      );
  }
}

function legacyApiKeyForProvider(
  provider: string | undefined,
  apiKey: string | undefined,
): { anthropic?: string; openai?: string } {
  if (!apiKey) return {};
  const p = (provider ?? 'claude').toLowerCase();
  if (p === 'claude' || p === 'anthropic') return { anthropic: apiKey };
  if (p === 'openai' || p === 'gpt') return { openai: apiKey };
  return {};
}

/**
 * Resolve LLM provider from vault config: uses `providers` fallback chain when `providers.primary` is set,
 * otherwise the legacy single `provider` field.
 *
 * @param opts.providerOverride — e.g. CLI `-p openai` forces a single provider (no chain).
 */
export function createProviderFromUserConfig(
  userConfig: UserConfig,
  opts?: { providerOverride?: string; model?: string },
): LLMProvider {
  if (userConfig.llm_mode === 'claude-code' && !opts?.providerOverride) {
    return new ClaudeCodeProvider();
  }

  const model = opts?.model ?? userConfig.model;

  if (opts?.providerOverride) {
    return createProvider(opts.providerOverride, {
      model,
      apiKey: userConfig.api_key,
      baseUrl: userConfig.providers?.keys?.ollama_url ?? process.env['OLLAMA_BASE_URL'],
    });
  }

  const block = userConfig.providers;
  if (block?.primary) {
    const primary = normalizeProviderId(block.primary) ?? 'claude';
    const fallbackRaw =
      block.fallback === undefined ? (['openai', 'ollama'] as const) : block.fallback;
    const fallbackIds = fallbackRaw
      .map((n) => normalizeProviderId(n))
      .filter((x): x is ProviderChainId => x !== null);

    const legacy = legacyApiKeyForProvider(userConfig.provider, userConfig.api_key);

    return createProviderChain({
      primary,
      fallback: fallbackIds.length > 0 ? fallbackIds : ['openai', 'ollama'],
      keys: {
        anthropic: block.keys?.anthropic ?? legacy.anthropic,
        openai: block.keys?.openai ?? legacy.openai,
        ollama_url: block.keys?.ollama_url,
      },
      model,
    });
  }

  return createProvider(userConfig.provider ?? 'claude', {
    model,
    apiKey: userConfig.api_key,
  });
}
