#!/usr/bin/env node
// The tool runs its TypeScript sources with tsx, as the server does (ADR-0001, Server execution).
import { register } from 'tsx/esm/api';

register();
const { main } = await import('../src/main.ts');
process.exitCode = await main(process.argv.slice(2));
