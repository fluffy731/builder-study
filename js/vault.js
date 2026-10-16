// Decryption primitives for the encrypted (published) build. Vault format, version 1:
//   key  = PBKDF2-HMAC-SHA256(NFKC(passphrase), salt, iterations) -> AES-256-GCM
//   blob = IV (12 bytes) || ciphertext || GCM tag (16 bytes), AAD = UTF-8 relative path
//          of the plaintext file under data/ (e.g. "notes/m3v1.html")
// The writer is tools/vault.py. This module has no side effects at load and does no
// fetching, storage or DOM work; it runs in browsers and Node (WebCrypto only).

const IV_BYTES = 12;
const TAG_BYTES = 16;
const CHECK_TEXT = 'builder-study-vault-v1';
const CHECK_AAD = 'vault-check';

// Same normalisation as tools/vault.py (unicodedata NFKC); nothing else is stripped.
export function normalisePassphrase(s) {
  return String(s).normalize('NFKC');
}

function subtle() {
  const c = globalThis.crypto;
  if (!c || !c.subtle) throw new Error('WebCrypto is not available (the page needs HTTPS or localhost).');
  return c.subtle;
}

function b64ToBytes(b64) {
  const bin = atob(String(b64));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i += 1) out[i] = bin.charCodeAt(i);
  return out;
}

function toBytes(data) {
  if (data instanceof ArrayBuffer) return new Uint8Array(data);
  if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
  throw new TypeError('expected an ArrayBuffer or typed array');
}

// Passphrase + base64 salt -> AES-GCM CryptoKey (decrypt only). Pass {extractable: true} only in tests.
export async function deriveKey(passphrase, saltB64, iterations, { extractable = false } = {}) {
  if (!Number.isInteger(iterations) || iterations < 1) throw new RangeError('iterations must be a positive integer');
  const s = subtle();
  const material = await s.importKey('raw', new TextEncoder().encode(normalisePassphrase(passphrase)), 'PBKDF2', false, ['deriveKey']);
  return s.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt: b64ToBytes(saltB64), iterations },
    material,
    { name: 'AES-GCM', length: 256 },
    Boolean(extractable),
    ['decrypt'],
  );
}

// Decrypt one .enc file. Rejects on a wrong key, wrong path (AAD) or any altered byte.
export async function decryptBlob(key, relpath, arrayBuffer) {
  const bytes = toBytes(arrayBuffer);
  if (bytes.length < IV_BYTES + TAG_BYTES) throw new Error('ciphertext is too short');
  return subtle().decrypt(
    { name: 'AES-GCM', iv: bytes.slice(0, IV_BYTES), additionalData: new TextEncoder().encode(String(relpath)), tagLength: TAG_BYTES * 8 },
    key,
    bytes.slice(IV_BYTES),
  );
}

// True only when `checkB64` (vault.json "check") decrypts under `key` to the fixed string. Never throws.
export async function verifyCheck(key, checkB64) {
  try {
    const plain = await decryptBlob(key, CHECK_AAD, b64ToBytes(checkB64));
    return new TextDecoder().decode(plain) === CHECK_TEXT;
  } catch {
    return false;
  }
}
