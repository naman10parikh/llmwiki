#!/usr/bin/env node

import { createProgram } from './cli/index.js';

const program = createProgram();
program.parse();
