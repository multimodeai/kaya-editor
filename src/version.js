// Leaf module: node builtins only. The entrypoint reads this before loading the
// command graph, so `kaya --version` never pays for importing the server.
import { readFileSync } from 'node:fs';

export const VERSION = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
