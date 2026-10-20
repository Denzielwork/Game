'use strict';
const crypto = require('node:crypto');

// No 0/O, 1/I/L, 2/Z, 5/S, 8/B so codes are easy to read out loud.
const CODE_ALPHABET = 'ACDEFGHJKMNPQRTUVWXY34679';
const CODE_LENGTH = 6;

function generateRoomCode(isTaken = () => false) {
  for (let attempt = 0; attempt < 50; attempt++) {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[crypto.randomInt(CODE_ALPHABET.length)];
    if (!isTaken(code)) return code;
  }
  return null;
}

function normalizeCode(input) {
  if (typeof input !== 'string' || input.length > 16) return null;
  const code = input.toUpperCase().replace(/[\s-]/g, '');
  if (code.length !== CODE_LENGTH) return null;
  for (const ch of code) if (!CODE_ALPHABET.includes(ch)) return null;
  return code;
}

function newToken() {
  return crypto.randomBytes(24).toString('base64url');
}

function hashToken(token) {
  return crypto.createHash('sha256').update(String(token)).digest();
}

function tokenMatches(token, storedHash) {
  if (typeof token !== 'string' || token.length < 16 || token.length > 64) return false;
  return crypto.timingSafeEqual(hashToken(token), storedHash);
}

const NAME_MAX = 16;
// Letters, numbers, combining marks, space and a few harmless punctuation marks.
const NAME_DISALLOWED = /[^\p{L}\p{N}\p{M} _.'-]/gu;

function sanitizeName(input) {
  if (typeof input !== 'string') return 'Player';
  let name = input.slice(0, 64).normalize('NFC').replace(NAME_DISALLOWED, '');
  name = name.replace(/\s+/g, ' ').trim();
  name = Array.from(name).slice(0, NAME_MAX).join('').trim();
  return name || 'Player';
}

/** Token bucket: allows bursts, refills steadily. */
class TokenBucket {
  constructor(capacity, refillPerSec) {
    this.capacity = capacity;
    this.refill = refillPerSec;
    this.tokens = capacity;
    this.last = Date.now();
  }
  take(n = 1) {
    const now = Date.now();
    this.tokens = Math.min(this.capacity, this.tokens + ((now - this.last) / 1000) * this.refill);
    this.last = now;
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

/** Sliding-window counter keyed by string (IP). Old keys are swept periodically. */
class WindowCounter {
  constructor(windowMs) {
    this.windowMs = windowMs;
    this.hits = new Map();
  }
  add(key, now = Date.now()) {
    const arr = this._prune(key, now);
    arr.push(now);
    this.hits.set(key, arr);
    return arr.length;
  }
  count(key, now = Date.now()) {
    return this._prune(key, now).length;
  }
  _prune(key, now) {
    const arr = (this.hits.get(key) || []).filter((t) => now - t < this.windowMs);
    if (arr.length) this.hits.set(key, arr);
    else this.hits.delete(key);
    return arr;
  }
  sweep(now = Date.now()) {
    for (const key of this.hits.keys()) this._prune(key, now);
  }
}

module.exports = {
  CODE_ALPHABET, CODE_LENGTH, NAME_MAX,
  generateRoomCode, normalizeCode, newToken, hashToken, tokenMatches,
  sanitizeName, TokenBucket, WindowCounter,
};
