#!/usr/bin/env node
// orbital-server --port 8080 --public ./public --web ../orbital-jam/dist --db ./.filespace/nodes.json
import { createServer } from '../src/server.js';

const opts = {};
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--port') opts.port = Number(argv[++i]);
  else if (a === '--host') opts.host = argv[++i];
  else if (a === '--public') opts.publicDir = argv[++i];
  else if (a === '--web') opts.webDist = argv[++i];
  else if (a === '--db') opts.dbPath = argv[++i];
  else if (a === '--messages') opts.messagesPath = argv[++i];
  else if (a === '--verbose') opts.logger = true;
}

const server = await createServer(opts);
console.log(`orbital-server listening on ${server.url}  (filespace: signed writes, privacy-filtered reads)`);
