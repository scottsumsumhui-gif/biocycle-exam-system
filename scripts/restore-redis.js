#!/usr/bin/env node
/**
 * BIOCYCLE exam-system — Redis restore
 * Writes every key from a _snapshot.json back into Upstash Redis.
 *
 * WARNING: this OVERWRITES existing keys with the same name.
 *          Use only to recover from data loss, or onto a fresh DB.
 *
 * Prereqs: same env vars as backup-redis.js
 * Usage:
 *   UPSTASH_REDIS_REST_URL=... UPSTASH_REDIS_REST_TOKEN=... \
 *     node scripts/restore-redis.js backups/<timestamp>/_snapshot.json
 */
const { Redis } = require('@upstash/redis');
const fs = require('fs');

const URL = process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = process.env.UPSTASH_REDIS_REST_TOKEN;
if (!URL || !TOKEN) {
  console.error('ERROR: set UPSTASH_REDIS_REST_URL and UPSTASH_REDIS_REST_TOKEN first.');
  process.exit(1);
}
const redis = new Redis({ url: URL, token: TOKEN });

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/restore-redis.js <path-to/_snapshot.json>');
  process.exit(1);
}
if (!fs.existsSync(file)) {
  console.error('Snapshot not found:', file);
  process.exit(1);
}

const snapshot = JSON.parse(fs.readFileSync(file, 'utf-8'));

// Accept both the wrapped backup format ({ meta, data }) and a flat { key: value } snapshot.
const data = (snapshot && snapshot.data && typeof snapshot.data === 'object') ? snapshot.data : snapshot;

(async () => {
  let n = 0;
  for (const [k, v] of Object.entries(data)) {
    // @upstash/redis serializes objects; pass value as-is (string or object)
    await redis.set(k, v);
    n++;
  }
  console.log(`OK: restored ${n} keys into Redis.`);
})();
