// Chat over the wire: hello binds identity, join is permission-gated, posts
// fan out room-scoped (never to eavesdroppers), presence tracks the room.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { createServer } from '../src/server.js';
import { makeMemoryStore, newIdentity, signAction } from '@orbitalfoundation/filespace';
import { makeMemoryMessages } from '@orbitalfoundation/streams';

async function client(url) {
  const socket = connect(url, { transports: ['websocket'] });
  await new Promise((r) => socket.on('connect', r));
  const ask = (ev, msg) => new Promise((r) => socket.emit(ev, msg, r));
  return {
    socket,
    fs: (msg) => ask('filespace', msg),
    st: (msg) => ask('streams', msg),
    hello: (identity, label) => ask('hello', signAction(identity, 'hello', { label })),
    join: (slug) => ask('join', { slug }),
    close: () => socket.close(),
  };
}

async function setup() {
  const server = await createServer({ port: 0, publicDir: null, store: makeMemoryStore(), messages: makeMemoryMessages() });
  return server;
}

test('two people chat in a public room; messages and presence fan out', async () => {
  const server = await setup();
  const alice = newIdentity();
  const bob = newIdentity();
  const a = await client(server.url);
  const b = await client(server.url);
  try {
    await a.fs({ command: signAction(alice, 'claim', { slug: '/lounge', policy: 'public' }) });

    const aMsgs = [];
    const bMsgs = [];
    const bPresence = [];
    a.socket.on('message', (m) => aMsgs.push(m.body));
    b.socket.on('message', (m) => bMsgs.push(m.body));
    b.socket.on('presence', (p) => bPresence.push(p.people.map((x) => x.label ?? 'guest').sort().join(',')));

    await a.hello(alice, 'alice');
    await b.hello(bob, 'bob');
    assert.equal((await a.join('/lounge')).ok, true);
    assert.equal((await b.join('/lounge')).ok, true);

    await a.st({ command: signAction(alice, 'post', { slug: '/lounge', body: 'hi room', label: 'alice' }) });
    await b.st({ command: signAction(bob, 'post', { slug: '/lounge', body: 'hi alice', label: 'bob' }) });
    await new Promise((r) => setTimeout(r, 150));

    assert.deepEqual(aMsgs, ['hi room', 'hi alice']);
    assert.deepEqual(bMsgs, ['hi room', 'hi alice']);
    assert.ok(bPresence.some((p) => p === 'alice,bob')); // both present at some point

    const log = await b.st({ query: { op: 'tail', slug: '/lounge' } });
    assert.deepEqual(log.map((m) => m.body), ['hi room', 'hi alice']);
  } finally {
    a.close();
    b.close();
    await server.close();
  }
});

test('private rooms: eavesdroppers cannot join, invited members can', async () => {
  const server = await setup();
  const alice = newIdentity();
  const bob = newIdentity();
  const eve = newIdentity();
  const a = await client(server.url);
  const b = await client(server.url);
  const e = await client(server.url);
  try {
    await a.fs({ command: signAction(alice, 'claim', { slug: '/alice', policy: 'private' }) });
    await a.fs({ command: signAction(alice, 'create', { slug: '/alice/proj' }) });
    await a.fs({ command: signAction(alice, 'invite', { slug: '/alice/proj', who: bob.publicKey }) });

    // eve: anonymous join denied, and even with a proven identity — denied
    assert.equal((await e.join('/alice/proj')).ok, false);
    await e.hello(eve, 'eve');
    assert.equal((await e.join('/alice/proj')).ok, false);

    // an eavesdropper who never joined hears nothing
    const eMsgs = [];
    e.socket.on('message', (m) => eMsgs.push(m.body));

    await a.hello(alice, 'alice');
    await b.hello(bob, 'bob');
    assert.equal((await a.join('/alice/proj')).ok, true);
    assert.equal((await b.join('/alice/proj')).ok, true); // chain membership via the project invite

    const bMsgs = [];
    b.socket.on('message', (m) => bMsgs.push(m.body));
    await a.st({ command: signAction(alice, 'post', { slug: '/alice/proj', body: 'secret plans' }) });
    await new Promise((r) => setTimeout(r, 150));

    assert.deepEqual(bMsgs, ['secret plans']);
    assert.deepEqual(eMsgs, []);
    // and eve's tail is empty too — hidden rooms have no history
    assert.deepEqual(await e.st({ query: signAction(eve, 'tail', { slug: '/alice/proj' }) }), []);
  } finally {
    a.close();
    b.close();
    e.close();
    await server.close();
  }
});

test('hello with a forged envelope is rejected', async () => {
  const server = await setup();
  const c = await client(server.url);
  try {
    const alice = newIdentity();
    const envelope = signAction(alice, 'hello', { label: 'alice' });
    envelope.principal = newIdentity().publicKey; // claim someone else's key
    const res = await new Promise((r) => c.socket.emit('hello', envelope, r));
    assert.equal(res.ok, false);
  } finally {
    c.close();
    await server.close();
  }
});
