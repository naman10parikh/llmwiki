import { watch } from 'chokidar';
import chalk from 'chalk';
import type { LLMProvider } from '../providers/types.js';
import type { VaultConfig } from './vault.js';
import { ingestSource } from './ingest.js';

export async function watchRawDirectory(
  config: VaultConfig,
  provider: LLMProvider,
): Promise<void> {
  const watcher = watch(config.rawDir, {
    ignored: /(^|[\/\\])\../, // ignore dotfiles
    persistent: true,
    ignoreInitial: true,
    awaitWriteFinish: {
      stabilityThreshold: 2000,
      pollInterval: 100,
    },
  });

  watcher.on('add', async (path: string) => {
    if (path.endsWith('.meta.json')) return; // skip metadata files

    console.log(chalk.blue(`New file detected: ${path}`));

    try {
      const result = await ingestSource(path, config, provider, { verbose: false });
      if (result.rejected) {
        console.log(chalk.yellow(`  Skipped (duplicate): ${result.rejectionReason}`));
      } else {
        console.log(chalk.green(`  Ingested: ${result.title} (${result.pagesUpdated} pages)`));
      }
    } catch (error) {
      console.error(chalk.red(`  Failed to ingest: ${error instanceof Error ? error.message : String(error)}`));
    }
  });

  // Keep process alive
  await new Promise<void>(() => {});
}
