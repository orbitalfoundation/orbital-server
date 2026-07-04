// The mongo adapters against a REAL mongod, exercising the same contracts the
// memory/file stores satisfy — plus a full filespace service running on top.
// Skips cleanly when no mongod is reachable (set MONGO_URL or start one).

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { makeService, makeNode } from '@orbitalfoundation/filespace';

let stores = null;
try {
  const { makeMongoStores } = await import('../src/store/mongo.js');
  stores = await makeMongoStores({
    url: process.env.MONGO_URL ?? 'mongodb://127.0.0.1:27017',
    dbName: `orbital_test_${process.pid}_${Math.floor(Math.random() * 1e6)}`,
  });
} catch { /* mongod not running */ }
const skip = stores ? false : 'mongod not reachable — set MONGO_URL or start mongod';

after(async () => {
  if (stores) {
    await stores.db.dropDatabase();
    await stores.close();
  }
});

test('mongo nodes: put/get/children/byComponent/byMember/query', { skip }, async () => {
  const s = stores.nodes;
  await s.put(makeNode({ slug: '/drwobbles', owner: 'drwobbles' }));
  await s.put(makeNode({ slug: '/drwobbles/a', components: { geo: { ll: [0, 0, 0] } } }));
  await s.put(makeNode({ slug: '/drwobbles/b', components: { about: { label: 'B' } }, members: [{ who: 'bob', role: 'member' }] }));
  await s.put(makeNode({ slug: '/drwobbles/a/deep' }));

  assert.equal((await s.get('/drwobbles')).owner, 'drwobbles');
  assert.equal(await s.get('/nope'), undefined);
  assert.deepEqual((await s.children('/drwobbles')).map((n) => n.slug), ['/drwobbles/a', '/drwobbles/b']);
  assert.deepEqual((await s.byComponent('geo')).map((n) => n.slug), ['/drwobbles/a']);
  assert.equal((await s.byComponent('geo', { prefix: '/other' })).length, 0);
  assert.deepEqual((await s.byMember('bob')).map((n) => n.slug), ['/drwobbles/b']);
  assert.deepEqual(
    (await s.query({ slug: { $regex: '^/drwobbles/a' } })).map((n) => n.slug),
    ['/drwobbles/a', '/drwobbles/a/deep'],
  );
  // internal fields never leak
  const node = await s.get('/drwobbles/a');
  assert.ok(!('_id' in node) && !('_parent' in node));
});

test('mongo nodes: claimRoot is first-come; delete deletes', { skip }, async () => {
  const s = stores.nodes;
  await s.claimRoot(makeNode({ slug: '/macy', owner: 'macy' }));
  await assert.rejects(() => s.claimRoot(makeNode({ slug: '/macy', owner: 'bob' })), /already claimed/);
  assert.equal(await s.delete('/macy'), true);
  assert.equal(await s.delete('/macy'), false);
});

test('mongo messages: per-room seq, tail slicing, rooms', { skip }, async () => {
  const m = stores.messages;
  await m.append('/room', { author: 'x', body: 'one' });
  await m.append('/other', { author: 'y', body: 'elsewhere' });
  const two = await m.append('/room', { author: 'x', body: 'two' });
  assert.equal(two.seq, 2); // per-room, not global

  assert.deepEqual((await m.tail('/room')).map((x) => x.body), ['one', 'two']);
  assert.deepEqual((await m.tail('/room', { after: 1 })).map((x) => x.seq), [2]);
  assert.deepEqual((await m.tail('/room', { limit: 1 })).map((x) => x.body), ['two']);
  assert.deepEqual((await m.rooms()).sort(), ['/other', '/room']);
});

test('mongo: the full filespace service runs on it unchanged', { skip }, async () => {
  const fs = makeService(stores.nodes, { enforce: true });
  assert.equal((await fs.claim({ slug: '/alice', principal: 'alice', policy: 'private' })).ok, true);
  assert.equal((await fs.create({ slug: '/alice/proj', principal: 'alice' })).ok, true);
  assert.equal((await fs.invite({ slug: '/alice/proj', principal: 'alice', who: 'bob' })).ok, true);
  assert.equal((await fs.create({ slug: '/alice/proj/photo', principal: 'bob' })).ok, true); // chain membership
  assert.equal(await fs.get('/alice/proj', null), null); // privacy holds
  assert.deepEqual((await fs.list('/alice/proj', 'bob')).map((n) => n.slug), ['/alice/proj/photo']);
  assert.equal((await fs.move({ slug: '/alice/proj', to: '/alice/project', principal: 'alice' })).ok, true);
  assert.equal((await fs.get('/alice/project/photo', 'bob'))?.slug, '/alice/project/photo');
});
