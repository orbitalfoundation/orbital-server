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

The server ships no content — a `public/` seed tree belongs to the *instance*
(deployment), not to this package. For the orbital instance that's
[`orbital/public/`](../public), booted via `../run-jam.sh`; or point the flags
anywhere:

```sh
npm install
npm start -- --port 8080 --public ../public --web ../orbital-jam/dist
```

Flags: `--port`, `--host`, `--public <manifest tree>` (lazy-hydrated),
`--web <dist>` (compiled SPA), `--db <nodes.json>`, `--verbose`.

## Test

```sh
npm test   # gateway allowlist, signed writes over the wire, guest-filtered fan-out
```

## Not here yet, on purpose

Blob upload, web3auth token exchange (browser keypairs carry identity for now),
per-connection identity binding (would let private-area changes fan out to
members), rate limiting. Agents belong to a future `@orbitalfoundation/agents`
layer, not to this shim.
