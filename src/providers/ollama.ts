import type { LLMProvider, LLMMessage, LLMResponse, LLMOptions } from './types.js';

export class OllamaProvider implements LLMProvider {
  name = 'ollama';
  private baseUrl: string;
  private defaultModel: string;

  constructor(model?: string, baseUrl?: string) {
    this.baseUrl = baseUrl ?? process.env['OLLAMA_BASE_URL'] ?? 'http://localhost:11434';
    this.defaultModel = model ?? 'llama3.2';
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const allMessages = options?.systemPrompt
      ? [{ role: 'system' as const, content: options.systemPrompt }, ...messages.filter((m) => m.role !== 'system')]
      : messages;

    const response = await fetch(`${this.baseUrl}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        model: options?.model ?? this.defaultModel,
        messages: allMessages.map((m) => ({
          role: m.role,
          content: m.content,
        })),
        stream: false,
      }),
    });

    if (!response.ok) {
      throw new Error(`Ollama API error: ${response.status} ${response.statusText}`);
    }

    const data = (await response.json()) as {
      message: { content: string };
      model: string;
      prompt_eval_count?: number;
      eval_count?: number;
    };

    return {
      content: data.message.content,
      model: data.model,
      tokensUsed: {
        input: data.prompt_eval_count ?? 0,
        output: data.eval_count ?? 0,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`);
      return response.ok;
    } catch {
      return false;
    }
  }
}
