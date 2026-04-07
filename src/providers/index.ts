import type { LLMProvider, LLMOptions } from './types.js';
import { ClaudeProvider } from './claude.js';
import { OpenAIProvider } from './openai.js';
import { OllamaProvider } from './ollama.js';

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
    default:
      throw new Error(
        `Unknown provider: ${name}. Supported: claude, openai, ollama`,
      );
  }
}
