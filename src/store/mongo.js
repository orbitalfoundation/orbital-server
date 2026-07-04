// mongo adapters — one MongoClient serving BOTH store contracts (filespace
// nodes + streams messages). This lives in the server, not in the core
// packages, on purpose: a database is a secondary citizen — a tool the
// composition root recruits when the config says so — and the cores stay
// zero-dependency. The contracts are the seam; if a second host ever needs
// these adapters, extracting them to a package is a move, not a refactor.
//
// The memory stores' mongo-ish selector dialect ($regex/$exists, dot paths)
// was chosen to make this adapter's query() a pass-through.

import { MongoClient } from 'mongodb';
import { normalizeSlug, parentSlug } from '@orbitalfoundation/filespace/src/paths.js';

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const strip = (d) => {
  if (!d) return undefined;
  const { _id, _parent, ...rest } = d;
  return rest;
};

export async function makeMongoStores({ url = 'mongodb://127.0.0.1:27017', dbName = 'orbital' } = {}) {
  const client = new MongoClient(url, { serverSelectionTimeoutMS: 3000 });
  await client.connect();
  const db = client.db(dbName);
  const nodesCol = db.collection('nodes');
  const msgsCol = db.collection('messages');
  const counters = db.collection('counters');
  await nodesCol.createIndex({ _parent: 1 });
  await nodesCol.createIndex({ owner: 1 });
  await nodesCol.createIndex({ 'members.who': 1 });
  await msgsCol.createIndex({ slug: 1, seq: 1 }, { unique: true });

  // _id IS the slug — uniqueness and claim atomicity come from the primary key
  const toDoc = (node) => ({ ...node, _id: node.slug, _parent: parentSlug(node.slug) });

  const nodes = {
    kind: 'mongo',

    async get(slug) {
      return strip(await nodesCol.findOne({ _id: normalizeSlug(slug) }));
    },

    async put(node) {
      await nodesCol.replaceOne({ _id: node.slug }, toDoc(node), { upsert: true });
      return { ...node };
    },

    async delete(slug) {
      return (await nodesCol.deleteOne({ _id: normalizeSlug(slug) })).deletedCount > 0;
    },

    async children(slug) {
      const p = normalizeSlug(slug);
      return (await nodesCol.find({ _parent: p, _id: { $ne: p } }).sort({ slug: 1 }).toArray()).map(strip);
    },

    async byComponent(name, { prefix = null } = {}) {
      const q = { [`components.${name}`]: { $exists: true } };
      if (prefix) {
        const p = normalizeSlug(prefix);
        q.$or = [{ _id: p }, { slug: { $regex: `^${escapeRe(p)}/` } }];
      }
      return (await nodesCol.find(q).sort({ slug: 1 }).toArray()).map(strip);
    },

    async byMember(principal) {
      return (await nodesCol.find({ $or: [{ owner: principal }, { 'members.who': principal }] }).sort({ slug: 1 }).toArray()).map(strip);
    },

    async query(selector = {}) {
      return (await nodesCol.find(selector).sort({ slug: 1 }).toArray()).map(strip);
    },

    async claimRoot(node) {
      try {
        await nodesCol.insertOne(toDoc(node)); // atomic: _id is the slug
      } catch (err) {
        if (err.code === 11000) throw new Error(`already claimed: ${node.slug}`);
        throw err;
      }
      return { ...node };
    },

    async all() {
      return (await nodesCol.find({}).toArray()).map(strip);
    },
  };

  const messages = {
    kind: 'mongo',

    async append(slug, { author = null, label = null, body = '', at = Date.now() } = {}) {
      const s = normalizeSlug(slug);
      // per-room monotonic seq via an atomic counter — no read-modify-write race
      const counter = await counters.findOneAndUpdate(
        { _id: `msg:${s}` },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' },
      );
      const msg = { seq: counter.seq, slug: s, author, label, body, at };
      await msgsCol.insertOne({ ...msg });
      return msg;
    },

    async tail(slug, { after = 0, limit = 50 } = {}) {
      const rows = await msgsCol
        .find({ slug: normalizeSlug(slug), seq: { $gt: after } })
        .sort({ seq: -1 })
        .limit(limit)
        .toArray();
      return rows.reverse().map(strip);
    },

    async rooms() {
      return msgsCol.distinct('slug');
    },
  };

  const close = () => client.close();
  nodes.close = close;
  messages.close = close;
  return { client, db, nodes, messages, close };
}
