import { Command } from 'commander';
import { startMcpServer } from '../../mcp-server.js';

interface McpOptions {
  vault: string;
}

export function registerMcpCommand(program: Command): void {
  program
    .command('mcp')
    .description('Start WikiMem as an MCP server for Claude Code (JSON-RPC 2.0 over stdio)')
    .option('--vault <path>', 'Vault directory', process.cwd())
    .action(async (options: McpOptions) => {
      await startMcpServer(options.vault);
    });
}
