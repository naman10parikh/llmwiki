import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { scanFolder } from '../../core/folder-scanner.js';
import { getVaultConfig } from '../../core/vault.js';
import { loadConfig } from '../../core/config.js';
import { createProviderFromUserConfig } from '../../providers/index.js';
import { ingestSource } from '../../core/ingest.js';
import {
  loadManifest,
  saveManifest,
  diffManifest,
  recordIngest,
  hashFile,
  getFileMtime,
} from '../../core/source-manifest.js';

interface AddSourceOptions {
  vault?: string;
  provider?: string;
  model?: string;
  maxFileSize?: string;
  force?: boolean;
  dryRun?: boolean;
}

const DEFAULT_MAX_SIZE_MB = 50;

function parseMaxFileSize(input: string | undefined): number {
  if (!input) return DEFAULT_MAX_SIZE_MB * 1024 * 1024;
  const n = Number(input);
  if (!Number.isFinite(n) || n <= 0) {
    throw new Error(`Invalid --max-file-size: ${input}`);
  }
  return Math.floor(n * 1024 * 1024);
}

export function registerAddSourceCommand(program: Command): void {
  program
    .command('add-source <path>')
    .description('Incrementally ingest a file or folder, skipping unchanged files (mtime + sha256)')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider (claude, openai, ollama)')
    .option('-m, --model <model>', 'Model to use')
    .option('--max-file-size <mb>', `Skip files larger than this size in MB (default ${DEFAULT_MAX_SIZE_MB})`)
    .option('-f, --force', 'Re-ingest every file, ignoring the manifest')
    .option('--dry-run', 'Show what would be ingested without calling the LLM')
    .action(async (sourcePath: string, options: AddSourceOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const vaultConfig = getVaultConfig(vaultRoot);

      if (!existsSync(vaultConfig.schemaPath)) {
        console.error(chalk.red('Not a wikimem vault. Run `wikimem init` first.'));
        process.exit(1);
      }

      const absSource = resolve(sourcePath);
      if (!existsSync(absSource)) {
        console.error(chalk.red(`Path not found: ${absSource}`));
        process.exit(1);
      }

      let maxFileSize: number;
      try {
        maxFileSize = parseMaxFileSize(options.maxFileSize);
      } catch (err) {
        console.error(chalk.red(err instanceof Error ? err.message : String(err)));
        process.exit(1);
      }

      const stat = statSync(absSource);
      const candidateFiles: string[] = stat.isDirectory()
        ? scanFolder(absSource, 10_000).files
        : [absSource];

      const sizedFiles: string[] = [];
      let oversized = 0;
      for (const f of candidateFiles) {
        try {
          if (statSync(f).size <= maxFileSize) {
            sizedFiles.push(f);
          } else {
            oversized++;
          }
        } catch {
          /* unreadable — skip */
        }
      }

      const manifest = loadManifest(vaultRoot);
      const diff = options.force
        ? { newFiles: sizedFiles, changedFiles: [], unchangedFiles: [] }
        : diffManifest(sizedFiles, manifest);

      const toIngest = [...diff.newFiles, ...diff.changedFiles];

      console.log();
      console.log(
        chalk.bold(`Found ${sizedFiles.length} files. `) +
          chalk.green(`${diff.newFiles.length} new, `) +
          chalk.yellow(`${diff.changedFiles.length} changed, `) +
          chalk.dim(`${diff.unchangedFiles.length} unchanged.`),
      );
      if (oversized > 0) {
        console.log(chalk.dim(`  ${oversized} files exceeded --max-file-size and were skipped.`));
      }

      if (toIngest.length === 0) {
        console.log(chalk.dim('Nothing to ingest.'));
        return;
      }

      console.log(chalk.blue(`Ingesting ${toIngest.length} files...`));
      console.log();

      if (options.dryRun) {
        for (const f of toIngest) {
          console.log(chalk.dim(`  would ingest ${f}`));
        }
        return;
      }

      const userConfig = loadConfig(vaultConfig.configPath);
      const provider = createProviderFromUserConfig(userConfig, {
        providerOverride: options.provider,
        model: options.model,
      });

      let ingested = 0;
      let skipped = 0;
      let errors = 0;

      for (let i = 0; i < toIngest.length; i++) {
        const file = toIngest[i]!;
        const label = basename(file);
        const progress = chalk.dim(`[${i + 1}/${toIngest.length}]`);
        const spinner = ora({ text: `${progress} ${label}`, color: 'cyan' }).start();

        try {
          const result = await ingestSource(file, vaultConfig, provider, {
            verbose: false,
            force: options.force ?? false,
            metadata: { source_type: 'file', original_path: file },
          });

          if (result.rejected) {
            spinner.warn(`${progress} ${label} — ${chalk.yellow('duplicate, skipped')}`);
            skipped++;
            manifest.entries[file] = {
              mtime: getFileMtime(file),
              sha256: hashFile(file),
              ingestedAt: new Date().toISOString(),
            };
          } else {
            spinner.succeed(`${progress} ${label} → ${chalk.green(`${result.pagesUpdated} pages`)}`);
            recordIngest(manifest, file);
            ingested++;
          }
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          spinner.fail(`${progress} ${label} — ${chalk.red(msg.substring(0, 80))}`);
          errors++;
        }
      }

      saveManifest(vaultRoot, manifest);

      console.log();
      console.log(chalk.bold('Results:'));
      console.log(chalk.green(`  ingested: ${ingested}`));
      if (skipped > 0) console.log(chalk.yellow(`  skipped (duplicates): ${skipped}`));
      if (errors > 0) console.log(chalk.red(`  errors: ${errors}`));
      console.log(chalk.dim(`  manifest: ${chalk.underline(vaultRoot + '/.wikimem-manifest.json')}`));

      if (errors > 0) process.exit(1);
    });
}
