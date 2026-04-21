// Minimal connect-and-observe agent.
// Verifies the SDK is wired correctly before you build anything on top.
//
// Run: `node starter-agent.js`

import 'dotenv/config';
import { DjsConnect } from '@unitn-asa/deliveroo-js-sdk';

const socket = DjsConnect(process.env.HOST, process.env.TOKEN);

// Belief snapshots (keep this minimal — real beliefs go in a belief store)
let me = null;
let map = null;
const parcels = new Map();
const agents = new Map();

socket.on('connect', () => {
  console.log('[connect] socket established');
});

socket.on('disconnect', () => {
  console.log('[disconnect] socket dropped — the NPC will be removed in 10s if we don\'t reconnect');
});

socket.on('you', (id, name, x, y, score) => {
  me = { id, name, x, y, score };
  console.log('[you]', me);
});

socket.on('map', (width, height, tiles) => {
  map = { width, height, tiles };
  console.log('[map]', width, 'x', height, 'tiles:', tiles.length);
});

socket.on('parcelsSensing', (sensed) => {
  // Overwrite visible; leave stale ones to belief decay elsewhere
  for (const p of sensed) parcels.set(p.id, p);
  console.log('[parcels]', sensed.length, 'visible');
});

socket.on('agentsSensing', (sensed) => {
  for (const a of sensed) agents.set(a.id, { ...a, lastSeen: Date.now() });
  console.log('[agents]', sensed.length, 'visible');
});
