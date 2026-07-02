// The gateway is an allowlist, not a pipe: query and command cross the wire,
// seed/load never do, signed writes work end-to-end over a real socket, and
// changed events fan out — but only guest-readable ones.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { makeMemoryStore, newIdentity, signAction } from '@orbitalfoundation/filespace';

async function setup() {
  const server = await createServer({ port: 0, publicDir: null, store: makeMemoryStore() });
  const socket = connect(server.url, { transports: ['websocket'] });
  await new Promise((r) => socket.on('connect', r));
  const call = (msg) => new Promise((r) => socket.emit('filespace', msg, r));
  return { server, socket, call };
}

test('signed command + anonymous query work over the wire', async () => {
  const { server, socket, call } = await setup();
  try {
    const alice = newIdentity();
    const claimed = await call({ command: signAction(alice, 'claim', { slug: '/alice', policy: 'public' }) });
    assert.equal(claimed.ok, true);
    assert.equal(claimed.node.owner, alice.publicKey);

    const made = await call({ command: signAction(alice, 'create', { slug: '/alice/notes', components: { about: { label: 'Notes' } } }) });
    assert.equal(made.ok, true);

    const kids = await call({ query: { op: 'list', slug: '/alice' } });
    assert.deepEqual(kids.map((n) => n.slug), ['/alice/notes']);
  } finally {
    socket.close();
    await server.close();
  }
});

test('unsigned commands are rejected by the core, not by luck', async () => {
  const { server, socket, call } = await setup();
  try {
    const res = await call({ command: { op: 'claim', slug: '/eve', principal: 'eve' } });
    assert.equal(res.ok, false);
    assert.match(res.error, /signed envelope required/);
  } finally {
    socket.close();
    await server.close();
  }
});

test('seed and load shapes cannot cross the wire', async () => {
  const { server, socket, call } = await setup();
  try {
    // neither top-level smuggling…
    const smuggled = await call({ seed: { slug: '/evil', owner: 'eve' }, load: 'file:///etc/passwd' });
    assert.equal(smuggled.ok, false);
    // …nor as a command op (seed is not a command)
    const alice = newIdentity();
    const asCmd = await call({ command: signAction(alice, 'seed', { dir: '/tmp' }) });
    assert.equal(asCmd.ok, false);
    assert.match(asCmd.error, /unknown command/);
    // and nothing named /evil ever appeared
    assert.equal(await call({ query: { op: 'get', slug: '/evil' } }), null);
  } finally {
    socket.close();
    await server.close();
  }
});

test('changed events fan out to other clients — guest-readable only', async () => {
  const { server, socket, call } = await setup();
  const watcher = connect(server.url, { transports: ['websocket'] });
  await new Promise((r) => watcher.on('connect', r));
  const seen = [];
  watcher.on('changed', (c) => seen.push(`${c.op} ${c.slug}`));
  try {
    const alice = newIdentity();
    await call({ command: signAction(alice, 'claim', { slug: '/alice', policy: 'public' }) });
    await call({ command: signAction(alice, 'create', { slug: '/alice/pub' }) });
    await call({ command: signAction(alice, 'claim', { slug: '/hidden', policy: 'private' }) }); // wait, one key one root…
    const bob = newIdentity();
    await call({ command: signAction(bob, 'claim', { slug: '/bob', policy: 'private' }) });
    await call({ command: signAction(bob, 'create', { slug: '/bob/secret' }) });
    await new Promise((r) => setTimeout(r, 150)); // fan-out is async
    assert.ok(seen.includes('claim /alice'));
    assert.ok(seen.includes('create /alice/pub'));
    assert.ok(!seen.some((s) => s.includes('/bob'))); // private changes stay off the wire
  } finally {
    watcher.close();
    socket.close();
    await server.close();
  }
});
