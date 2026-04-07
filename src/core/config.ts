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
  processing?: {
    audio?: { enabled?: boolean; provider?: string };
    image?: { enabled?: boolean };
    pdf?: { enabled?: boolean };
    video?: { enabled?: boolean };
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
