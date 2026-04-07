import { Command } from 'commander';
import chalk from 'chalk';
import ora from 'ora';
import { existsSync, statSync } from 'node:fs';
import { resolve, basename } from 'node:path';
import { createInterface } from 'node:readline';
import { ingestSource, collectFiles, isAlreadyIngested } from '../../core/ingest.js';
import type { IngestOptions, BatchIngestResult } from '../../core/ingest.js';
import { getVaultConfig } from '../../core/vault.js';
import { createProvider } from '../../providers/index.js';
import { loadConfig } from '../../core/config.js';

interface CliIngestOptions {
  vault?: string;
  provider?: string;
  model?: string;
  verbose?: boolean;
  tags?: string;
  category?: string;
  interactive?: boolean;
  force?: boolean;
  recursive?: boolean;
}

/** Prompt the user for a line of input */
function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

/** Interactive metadata collection */
async function collectInteractiveMetadata(): Promise<{
  tags: string[];
  category: string;
  metadata: Record<string, string>;
}> {
  console.log(chalk.cyan('\n--- Interactive Metadata ---\n'));

  const tagsInput = await prompt(chalk.white('Tags (comma-separated): '));
  const tags = tagsInput ? tagsInput.split(',').map((t) => t.trim()).filter(Boolean) : [];

  const category = await prompt(chalk.white('Category (sources/entities/concepts/syntheses): '));

  const metadata: Record<string, string> = {};
  console.log(chalk.dim('Add custom metadata (empty key to finish):'));
  let addMore = true;
  while (addMore) {
    const key = await prompt(chalk.white('  Key: '));
    if (!key) {
      addMore = false;
    } else {
      const value = await prompt(chalk.white('  Value: '));
      metadata[key] = value;
    }
  }

  console.log('');
  return { tags, category: category || '', metadata };
}

export function registerIngestCommand(program: Command): void {
  program
    .command('ingest <source>')
    .description('Ingest a source file, URL, or directory into the wiki')
    .option('-v, --vault <path>', 'Vault root directory', '.')
    .option('-p, --provider <provider>', 'LLM provider (claude, openai, ollama)')
    .option('-m, --model <model>', 'Model to use')
    .option('--verbose', 'Show detailed output')
    .option('-t, --tags <tags>', 'Comma-separated tags (e.g. "research,ai,karpathy")')
    .option('-c, --category <category>', 'Wiki category (sources, entities, concepts, syntheses)')
    .option('-i, --interactive', 'Prompt for tags, category, and metadata before processing')
    .option('-f, --force', 'Force ingest even if duplicate detected')
    .option('-r, --recursive', 'Process subdirectories when ingesting a directory')
    .action(async (source: string, options: CliIngestOptions) => {
      const vaultRoot = resolve(options.vault ?? '.');
      const config = getVaultConfig(vaultRoot);
      const userConfig = loadConfig(config.configPath);

      if (!existsSync(config.schemaPath)) {
        console.error(chalk.red('Not a wikimem vault. Run `wikimem init` first.'));
        process.exit(1);
      }

      const providerName = options.provider ?? userConfig.provider ?? 'claude';
      const model = options.model ?? userConfig.model;
      const provider = createProvider(providerName, { model });

      // Parse tags from CLI flag
      const cliTags = options.tags
        ? options.tags.split(',').map((t) => t.trim()).filter(Boolean)
        : [];

      // Collect interactive metadata if --interactive
      let interactiveTags: string[] = [];
      let interactiveCategory = '';
      let interactiveMetadata: Record<string, string> = {};

      if (options.interactive) {
        const interactive = await collectInteractiveMetadata();
        interactiveTags = interactive.tags;
        interactiveCategory = interactive.category;
        interactiveMetadata = interactive.metadata;
      }

      // Merge all tags and pick category (CLI flag > interactive > auto)
      const allTags = [...new Set([...cliTags, ...interactiveTags])];
      const category = options.category ?? (interactiveCategory || undefined);

      const ingestOpts: IngestOptions = {
        verbose: options.verbose ?? false,
        force: options.force ?? false,
        tags: allTags.length > 0 ? allTags : undefined,
        category,
        metadata: Object.keys(interactiveMetadata).length > 0 ? interactiveMetadata : undefined,
      };

      const resolvedSource = resolve(source);

      // --- Directory batch ingest ---
      if (existsSync(resolvedSource) && statSync(resolvedSource).isDirectory()) {
        const files = collectFiles(resolvedSource, options.recursive ?? false);

        if (files.length === 0) {
          console.log(chalk.yellow('No ingestable files found in directory.'));
          process.exit(0);
        }

        console.log(chalk.cyan(`Found ${files.length} file(s) to process.\n`));

        const batch: BatchIngestResult = {
          ingested: 0,
          skipped: 0,
          duplicates: 0,
          errors: 0,
          results: [],
        };

        for (let i = 0; i < files.length; i++) {
          const file = files[i]!;
          const fileName = basename(file);
          const progress = `[${i + 1}/${files.length}]`;

          // Skip already-ingested files
          if (isAlreadyIngested(config.logPath, file)) {
            console.log(chalk.dim(`${progress} Skipping ${fileName} (already ingested)`));
            batch.skipped++;
            batch.results.push({ file, error: 'already ingested' });
            continue;
          }

          const spinner = ora(`${progress} Ingesting ${fileName}...`).start();

          try {
            const result = await ingestSource(file, config, provider, ingestOpts);

            if (result.rejected) {
              spinner.warn(chalk.yellow(`${progress} Duplicate: ${fileName} — ${result.rejectionReason}`));
              batch.duplicates++;
              batch.results.push({ file, result });
            } else {
              spinner.succeed(chalk.green(`${progress} ${result.title} (${result.pagesUpdated} pages)`));
              batch.ingested++;
              batch.results.push({ file, result });
            }
          } catch (error) {
            const msg = error instanceof Error ? error.message : String(error);
            spinner.fail(chalk.red(`${progress} Error: ${fileName} — ${msg}`));
            batch.errors++;
            batch.results.push({ file, error: msg });
          }
        }

        // Summary
        console.log(chalk.cyan('\n--- Batch Summary ---'));
        console.log(chalk.green(`  Ingested: ${batch.ingested}`));
        if (batch.skipped > 0) console.log(chalk.dim(`  Skipped:  ${batch.skipped} (already ingested)`));
        if (batch.duplicates > 0) console.log(chalk.yellow(`  Duplicates: ${batch.duplicates}`));
        if (batch.errors > 0) console.log(chalk.red(`  Errors:   ${batch.errors}`));
        console.log(chalk.dim(`  Total:    ${files.length} files\n`));

        if (batch.errors > 0) process.exit(1);
        return;
      }

      // --- Single file / URL ingest ---
      const spinner = ora(`Ingesting ${source}...`).start();

      try {
        const result = await ingestSource(source, config, provider, ingestOpts);

        if (result.rejected) {
          spinner.warn(chalk.yellow(`Duplicate detected: ${result.rejectionReason}`));
          console.log(chalk.dim('  Use --force to override.'));
          console.log(chalk.dim(`  Raw file kept at: ${result.rawPath}`));
        } else {
          spinner.succeed(chalk.green(`Ingested: ${result.title}`));
          console.log(chalk.dim(`  Pages created/updated: ${result.pagesUpdated}`));
          console.log(chalk.dim(`  Wiki links added: ${result.linksAdded}`));
          console.log(chalk.dim(`  Source saved to: ${result.rawPath}`));
          if (allTags.length > 0) {
            console.log(chalk.dim(`  Tags: ${allTags.join(', ')}`));
          }
          if (category) {
            console.log(chalk.dim(`  Category: ${category}`));
          }
        }
      } catch (error) {
        spinner.fail(chalk.red('Ingestion failed'));
        console.error(chalk.red(error instanceof Error ? error.message : String(error)));
        process.exit(1);
      }
    });
}
