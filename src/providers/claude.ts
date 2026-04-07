import Anthropic from '@anthropic-ai/sdk';
import type { LLMProvider, LLMMessage, LLMResponse, LLMOptions } from './types.js';

export class ClaudeProvider implements LLMProvider {
  name = 'claude';
  private client: Anthropic;
  private defaultModel: string;

  constructor(model?: string, apiKey?: string) {
    this.client = new Anthropic({
      apiKey: apiKey ?? process.env['ANTHROPIC_API_KEY'],
    });
    this.defaultModel = model ?? 'claude-sonnet-4-20250514';
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const systemMessages = messages.filter((m) => m.role === 'system');
    const nonSystemMessages = messages.filter((m) => m.role !== 'system');

    const systemPrompt = options?.systemPrompt
      ?? systemMessages.map((m) => m.content).join('\n\n')
      ?? undefined;

    const response = await this.client.messages.create({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      ...(systemPrompt ? { system: systemPrompt } : {}),
      messages: nonSystemMessages.map((m) => ({
        role: m.role as 'user' | 'assistant',
        content: m.content,
      })),
    });

    const content = response.content
      .filter((block): block is Anthropic.TextBlock => block.type === 'text')
      .map((block) => block.text)
      .join('');

    return {
      content,
      model: response.model,
      tokensUsed: {
        input: response.usage.input_tokens,
        output: response.usage.output_tokens,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env['ANTHROPIC_API_KEY'];
  }
}
