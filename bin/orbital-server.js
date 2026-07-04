#!/usr/bin/env node
// orbital-server [--config <file>] [overrides…]
//
// Configuration lives in a single orbital.config.json at the instance root
// (auto-discovered in the cwd, or pass --config). Flags override the file.
// Relative paths in the config resolve against the CONFIG FILE's directory,
// so state (.filespace/), seeds (public/) and the web dist stay canonical no
// matter where the process is launched from — no more per-cwd databases.
//
//   { "port": 8080, "public": "./public", "web": "./orbital-jam/dist",
//     "store": { "kind": "file", "path": "./.filespace" } }
//   store kinds: "file" (default) | "mongo" ({ url, db }) | "memory"
//
// Flags: --config --port --host --public --web --db --messages --verbose

import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { createServer } from '../src/server.js';

const argv = process.argv.slice(2);
const flags = {};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (!a.startsWith('--')) continue;
  const key = a.slice(2);
  const next = argv[i + 1];
  if (next === undefined || next.startsWith('--')) flags[key] = true;
  else flags[key] = argv[++i];
}

const configPath = flags.config ?? (existsSync('./orbital.config.json') ? './orbital.config.json' : null);
let cfg = {};
let base = process.cwd();
if (configPath) {
  cfg = JSON.parse(readFileSync(configPath, 'utf8'));
  base = dirname(resolve(configPath));
}
const rel = (p) => (p ? resolve(base, p) : null);

const opts = {
  port: Number(flags.port ?? cfg.port ?? 8080),
  host: flags.host ?? cfg.host ?? '0.0.0.0',
  publicDir: rel(flags.public ?? cfg.public ?? './public'),
  webDist: rel(flags.web ?? cfg.web ?? null),
  logger: Boolean(flags.verbose),
};

const store = cfg.store ?? {};
let storeLabel = 'file';
if (flags.db) {
  opts.dbPath = resolve(flags.db);
  opts.messagesPath = flags.messages ? resolve(flags.messages) : join(dirname(resolve(flags.db)), 'messages.jsonl');
} else if (store.kind === 'mongo') {
  const { makeMongoStores } = await import('../src/store/mongo.js');
  const url = store.url ?? process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017';
  const mongo = await makeMongoStores({ url, dbName: store.db ?? 'orbital' });
  opts.store = mongo.nodes;
  opts.messages = mongo.messages;
  storeLabel = `mongo ${store.db ?? 'orbital'}`;
} else if (store.kind === 'memory') {
  const { makeMemoryStore } = await import('@orbitalfoundation/filespace');
  const { makeMemoryMessages } = await import('@orbitalfoundation/streams');
  opts.store = makeMemoryStore();
  opts.messages = makeMemoryMessages();
  storeLabel = 'memory (volatile)';
} else {
  const dir = rel(store.path ?? './.filespace');
  opts.dbPath = join(dir, 'nodes.json');
  opts.messagesPath = join(dir, 'messages.jsonl');
  storeLabel = `file ${dir}`;
}

const server = await createServer(opts);
console.log(`orbital-server listening on ${server.url}  (store: ${storeLabel}${configPath ? `, config: ${resolve(configPath)}` : ''})`);
