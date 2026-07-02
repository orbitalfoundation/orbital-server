// @orbitalfoundation/server — a transport shim over a filespace, deliberately thin.
//
// The security model lives in the filespace core (enforce + authenticate are ON:
// every mutation needs a signed envelope, every read is privacy-filtered). What
// the server adds is exactly two things:
//
//   1. A socket.io GATEWAY that is an allowlist, not a pipe. A remote client may
//      submit { query } and { command } — nothing else. `seed` and `load` shapes
//      (admin content / code loading) can never cross the wire: the gateway
//      rebuilds the envelope from whitelisted fields rather than forwarding the
//      client's object, so there is no smuggling extra keys onto the bus.
//
//   2. Fan-out. Successful writes announce { filespace: { changed } } on the bus;
//      the server broadcasts those to connected clients — but only events a
//      GUEST could read. Until identities are bound to connections, private-area
//      changes stay off the wire entirely (members poll/refetch; a later
//      per-connection identity binding lifts this).
//
// Plus static serving of the compiled SPA (slash-routed: unknown non-API GETs
// fall back to index.html), so one process serves the whole appliance.

import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import { Server as SocketServer } from 'socket.io';
import { createBus } from '@orbitalfoundation/bus';
import { attach, makeFileStore, makeAuthGuard, policy } from '@orbitalfoundation/filespace';
import { attach as attachStreams, makeFileMessages } from '@orbitalfoundation/streams';
import { existsSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';

const clean = (v) => JSON.parse(JSON.stringify(v ?? null)); // strip prototypes/undefined from wire data

export async function createServer({
  port = 8080,
  host = '0.0.0.0',
  publicDir = './public', // manifest tree (lazy-hydrated); optional
  webDist = null, // compiled SPA to serve; optional
  dbPath = './.filespace/nodes.json',
  messagesPath = null, // defaults to messages.jsonl next to the node store
  store = null,
  messages = null,
  logger = false,
} = {}) {
  const bus = createBus({ description: 'orbital-server' });
  const fsStore = store ?? makeFileStore(dbPath);
  const msgStore = messages ?? makeFileMessages(messagesPath ?? join(dirname(dbPath), 'messages.jsonl'));
  const manifestRoot = publicDir && existsSync(publicDir) ? resolve(publicDir) : null;
  const filespace = attach(bus, {
    store: fsStore,
    enforce: true,
    authenticate: true, // signed envelopes required for every mutation — the core is the bouncer
    manifestRoot,
  });
  const streams = attachStreams(bus, { messages: msgStore, enforce: true, authenticate: true });

  const app = Fastify({ logger });
  app.get('/api/health', async () => ({ ok: true, filespace: true, manifestRoot: Boolean(manifestRoot) }));

  if (webDist && existsSync(webDist)) {
    app.register(fastifyStatic, { root: resolve(webDist) });
    // slash-routed SPA: /anselm/project is a client route, not a file
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api')) return reply.sendFile('index.html');
      return reply.code(404).send({ error: 'not found' });
    });
  }

  await app.listen({ port, host });
  const actualPort = app.server.address().port; // honors port 0 (tests)
  const io = new SocketServer(app.server, { cors: { origin: true } }); // vite dev server runs on another port

  // --- the gateway: an allowlist of shapes, never a pipe ---

  // hello envelopes bind a verified identity to a connection (so room joins can
  // be permission-gated and presence can be attributed). Same signed-envelope
  // format as everything else; its own nonce set.
  const helloGuard = makeAuthGuard({});

  // presence — ephemeral, latest-wins, per-server, deliberately NOT on the bus
  // and NOT in a store. slug -> Map(socket.id -> {principal, label})
  const present = new Map();
  function emitPresence(slug) {
    const room = present.get(slug);
    const people = [];
    const seen = new Set();
    for (const p of room?.values() ?? []) {
      const key = p.principal ?? 'anon';
      if (p.principal && seen.has(key)) continue; // same key in two tabs = one person
      seen.add(key);
      people.push(p);
    }
    io.to(slug).emit('presence', { slug, people });
  }
  function leaveRoom(socket, slug) {
    socket.leave(slug);
    socket.data.rooms?.delete(slug);
    const room = present.get(slug);
    if (room?.delete(socket.id)) {
      if (!room.size) present.delete(slug);
      emitPresence(slug);
    }
  }

  io.on('connection', (socket) => {
    socket.data.rooms = new Set();

    const gateway = (key) => async (msg, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const req = msg && typeof msg === 'object' ? msg : {};
        // rebuild the envelope — only these two shapes exist on the wire.
        // seed/load/changed or any other key a client sends simply does not survive.
        if (req.query && typeof req.query === 'object') {
          return ack(clean(await bus.resolve({ [key]: { query: clean(req.query) } })));
        }
        if (req.command && typeof req.command === 'object') {
          return ack(clean(await bus.resolve({ [key]: { command: clean(req.command) } })));
        }
        return ack({ ok: false, error: 'expected { query } or { command }' });
      } catch (err) {
        return ack({ ok: false, error: err.message });
      }
    };
    socket.on('filespace', gateway('filespace'));
    socket.on('streams', gateway('streams'));

    // hello: prove you hold the key for `principal`; the connection remembers.
    socket.on('hello', (req, ack) => {
      if (typeof ack !== 'function') return;
      const a = helloGuard(req ?? {});
      if (!a.ok || req.op !== 'hello') return ack({ ok: false, error: a.error ?? 'expected op hello' });
      socket.data.principal = req.principal;
      socket.data.label = typeof req.label === 'string' ? req.label.slice(0, 40) : null;
      return ack({ ok: true, principal: req.principal });
    });

    // join: subscribe to a room's live traffic (messages + presence). Gated by
    // filespace visibility — a room you may not read, you may not listen to.
    socket.on('join', async (req, ack) => {
      if (typeof ack !== 'function') return;
      try {
        const slug = String(req?.slug ?? '');
        const node = await filespace.get(slug, socket.data.principal ?? null);
        if (!node) return ack({ ok: false, error: 'no such room (or not visible to you)' });
        socket.join(node.slug);
        socket.data.rooms.add(node.slug);
        const room = present.get(node.slug) ?? new Map();
        room.set(socket.id, { principal: socket.data.principal ?? null, label: socket.data.label ?? null });
        present.set(node.slug, room);
        emitPresence(node.slug);
        return ack({ ok: true, slug: node.slug });
      } catch (err) {
        return ack({ ok: false, error: err.message });
      }
    });

    socket.on('leave', (req) => leaveRoom(socket, String(req?.slug ?? '')));
    socket.on('disconnect', () => {
      for (const slug of [...(socket.data.rooms ?? [])]) leaveRoom(socket, slug);
    });
  });

  // messages fan out room-scoped: only sockets that passed the join gate hear them
  bus.register({
    id: 'server.streams-fanout',
    resolve(event) {
      const c = event?.streams?.changed;
      if (c?.op === 'post') io.to(c.slug).emit('message', clean(c.message));
    },
  });

  // --- fan-out: broadcast guest-readable changes ---

  async function guestVisible(c) {
    if (c.node) return policy.canRead(null, c.node, await filespace.ancestorsOf(c.node.slug));
    // deletes carry no node — judge by what remains of the ancestor chain
    const chain = await filespace.ancestorsOf(c.slug ?? '/');
    return chain.every((n) => (n.policy ?? 'public') !== 'private');
  }

  bus.register({
    id: 'server.fanout',
    resolve(event) {
      const c = event?.filespace?.changed;
      if (!c) return;
      guestVisible(c).then((visible) => {
        if (visible) io.emit('changed', clean(c));
      }).catch(() => {});
    },
  });

  return {
    bus,
    filespace,
    streams,
    store: fsStore,
    messages: msgStore,
    app,
    io,
    port: actualPort,
    url: `http://localhost:${actualPort}`,
    async close() {
      io.close();
      await app.close();
    },
  };
}
