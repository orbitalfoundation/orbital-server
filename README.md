# @orbitalfoundation/server

A deliberately thin transport shim over an [orbital filespace](../orbital-filespace). The security model lives in the filespace core (authorization + signed-envelope authentication are ON); the server only filters shapes and moves bytes.

What it adds:

- **A socket.io gateway that is an allowlist, not a pipe.** Clients may submit
  `{ query }` and `{ command }` over one `filespace` event — nothing else. The
  envelope is rebuilt from whitelisted fields, so `seed` / `load` (admin
  content, code loading) can never cross the wire.
- **Fan-out.** Successful writes announce `{ filespace: { changed } }` on the
  bus; the server broadcasts them to all clients — **guest-readable events
  only**. Until identities are bound to connections, private-area changes stay
  off the wire (members refetch on navigation).
- **Static SPA serving** with slash-route fallback (`/anselm/project` →
  `index.html`), plus `/api/health`. One process serves the whole appliance.

## Run

The server ships no content and no state — seeds (`public/`), state
(`.filespace/` or a database) and configuration belong to the *instance*. One
`orbital.config.json` at the instance root is the single source of truth; the
server auto-discovers it in the cwd (or `--config <file>`), and relative paths
resolve against the config file's directory, so state stays canonical no
matter where you launch from. Flags override the file.

```json
{
  "port": 8080,
  "public": "./public",
  "web": "./orbital-jam/dist",
  "store": { "kind": "file", "path": "./.filespace" }
}
```

Store kinds: **`file`** (zero-dep JSON/JSONL, the default), **`mongo`**
(`{ "kind": "mongo", "url": "mongodb://…", "db": "orbital" }` — url falls back
to `MONGO_URL`), **`memory`** (volatile). The mongo adapters live here in
[`src/store/mongo.js`](src/store/mongo.js) — one client serving both store
contracts (filespace nodes + streams messages) — because a database is a
deployment detail the composition root recruits, not a dependency of the
cores. Contract-tested against a real mongod (`test/mongo.test.js`, skips
when none is reachable).

From the instance root: `npm start`. Flags: `--config`, `--port`, `--host`,
`--public`, `--web`, `--db`, `--messages`, `--verbose`.

## Test

```sh
npm test   # gateway allowlist, signed writes over the wire, guest-filtered fan-out
```

## Not here yet, on purpose

Blob upload, web3auth token exchange (browser keypairs carry identity for now),
per-connection identity binding (would let private-area changes fan out to
members), rate limiting. Agents belong to a future `@orbitalfoundation/agents`
layer, not to this shim.
