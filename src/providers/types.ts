export interface LLMMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  tokensUsed: {
    input: number;
    output: number;
  };
}

export interface LLMProvider {
  name: string;
  chat(messages: LLMMessage[], options?: LLMOptions): Promise<LLMResponse>;
  isAvailable(): Promise<boolean>;
}

export interface LLMOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  systemPrompt?: string;
}

export interface VisionProvider extends LLMProvider {
  describeImage(imagePath: string, prompt?: string): Promise<string>;
}

export interface ProviderConfig {
  provider: 'claude' | 'openai' | 'ollama';
  model?: string;
  apiKey?: string;
  baseUrl?: string;
}
