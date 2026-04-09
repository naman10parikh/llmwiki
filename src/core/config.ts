import { readFileSync, existsSync } from 'node:fs';
import { parse } from 'yaml';

export interface SourceConfig {
  name: string;
  type: 'rss' | 'github' | 'url' | 'x';
  url?: string;
  query?: string;
  schedule?: string;
}

export interface UserConfig {
  provider?: string;
  model?: string;
  api_key?: string;
  vault?: {
    name?: string;
    template?: string;
  };
  sources?: SourceConfig[];
  improve?: {
    enabled?: boolean;
    schedule?: string;
    threshold?: number;
    auto_apply?: boolean;
  };
  search?: {
    engine?: string;
  };
  embeddings?: {
    provider?: string;
    model?: string;
  };
  processing?: {
    audio?: { enabled?: boolean; provider?: string };
    image?: { enabled?: boolean };
    pdf?: { enabled?: boolean };
    video?: { enabled?: boolean };
  };
  pipeline?: {
    custom_steps?: Array<{
      id: string;
      name: string;
      enabled: boolean;
      system_prompt: string;
      model?: string;
      position?: number;
    }>;
    disabled_steps?: string[];
  };
}

export function loadConfig(configPath: string): UserConfig {
  if (!existsSync(configPath)) {
    return {};
  }

  const raw = readFileSync(configPath, 'utf-8');
  const parsed = parse(raw) as UserConfig | null;
  return parsed ?? {};
}
