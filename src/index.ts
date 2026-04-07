#!/usr/bin/env node

import { createProgram } from './cli/index.js';
import { checkForUpdates } from './core/update-checker.js';

const program = createProgram();
program.parse();

// Non-blocking: runs after command completes, never delays CLI
checkForUpdates().catch(() => {});
