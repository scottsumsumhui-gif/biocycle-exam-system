#!/usr/bin/env node
/**
 * BIOCYCLE exam-system — Redis full backup
 * Dumps EVERY key from Upstash Redis into backups/<timestamp>/
 * so a single _snapshot.json can restore the whole system.
 *
 * Prereqs:
 *   - run from project root (so node_modules/@upstash/redis resolves)
 *   - env vars (DO NOT hardcode tokens in this file):
 *       UPSTASH_REDIS_REST_URL   e.g. https://xxx.upstash.io
 *       UPSTASH_REDIS_REST_TOKEN e.g. Axxx...
 *
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... node scripts/backup-redis.js
 *
 * Ephemeral keys are skipped (sessions.json = login tokens, regenerable).
 */
const { Redis } = require('@upstash/redis');
const fs = require('fs');
const path = require('path');

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!URL || !TOKEN) {
  console.error('ERROR: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first.');
  process.exit(1);
}
const redis = new Redis({ url: URL, token: TOKEN });

// keys that are regenerable / not worth backing up
const EXCLUDE = new Set(['sessions.json']);

(async () => {
  let keys = [];
  try {
    keys = await redis.keys('*');
  } catch (e) {
    console.error('KEYS command failed:', e.message);
    console.error('(Upstash may block KEYS on large keyspaces; this system is small so it should work)');
    process.exit(1);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const outDir = path.join(__dirname, '..', 'backups', ts);
  fs.mkdirSync(outDir, { recursive: true });

  const snapshot = {};
  let count = 0;
  for (const k of keys) {
    if (EXCLUDE.has(k)) continue;
    let v;
    try {
      v = await redis.get(k);
    } catch (e) {
      console.warn('  skip (read error):', k, e.message);
      continue;
    }
    snapshot[k] = v;
    const safe = k.replace(/[:/\\]/g, '_');
    fs.writeFileSync(path.join(outDir, safe + '.json'), JSON.stringify(v, null, 2));
    count++;
  }

  fs.writeFileSync(path.join(outDir, '_snapshot.json'), JSON.stringify(snapshot, null, 2));
  fs.writeFileSync(
    path.join(outDir, '_manifest.txt'),
    `Backup taken: ${ts}\nKeys backed up: ${count}\nExcluded: ${[...EXCLUDE].join(', ')}\n`
  );
  console.log(`OK: backed up ${count} keys -> ${outDir}`);
  console.log(`    restore with: node scripts/restore-redis.js ${path.join(outDir, '_snapshot.json')}`);
})();
