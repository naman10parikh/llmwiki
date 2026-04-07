import OpenAI from 'openai';
import type { LLMProvider, LLMMessage, LLMResponse, LLMOptions } from './types.js';

export class OpenAIProvider implements LLMProvider {
  name = 'openai';
  private client: OpenAI;
  private defaultModel: string;

  constructor(model?: string, apiKey?: string) {
    this.client = new OpenAI({
      apiKey: apiKey ?? process.env['OPENAI_API_KEY'],
    });
    this.defaultModel = model ?? 'gpt-4o';
  }

  async chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse> {
    const allMessages = options?.systemPrompt
      ? [{ role: 'system' as const, content: options.systemPrompt }, ...messages.filter((m) => m.role !== 'system')]
      : messages;

    const response = await this.client.chat.completions.create({
      model: options?.model ?? this.defaultModel,
      max_tokens: options?.maxTokens ?? 4096,
      messages: allMessages.map((m) => ({
        role: m.role,
        content: m.content,
      })),
    });

    const content = response.choices[0]?.message?.content ?? '';

    return {
      content,
      model: response.model,
      tokensUsed: {
        input: response.usage?.prompt_tokens ?? 0,
        output: response.usage?.completion_tokens ?? 0,
      },
    };
  }

  async isAvailable(): Promise<boolean> {
    return !!process.env['OPENAI_API_KEY'];
  }
}
