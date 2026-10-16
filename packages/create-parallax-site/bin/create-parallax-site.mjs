#!/usr/bin/env node
import { create } from '../src/create.mjs';

process.exitCode = create(process.argv.slice(2));
