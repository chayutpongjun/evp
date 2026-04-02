/**
 * EVP Standard Webhooks v1a
 * @see https://docs.evp-pay.com/introduction — Webhook Integration (headers, Ed25519, message format)
 *
 * Signed message: {webhook_id}.{timestamp}.{json_payload}
 * Header webhook-signature: v1a,{base64_signature}
 */

const nacl = require('tweetnacl');

/** @param {string} b64 */
function decodePublicKeyBase64(b64) {
  const buf = Buffer.from(String(b64).trim(), 'base64');
  if (buf.length !== 32) {
    throw new Error('Ed25519 public key must decode to 32 bytes (EVP_WEBHOOK_PUBLIC_KEY_B64)');
  }
  return new Uint8Array(buf);
}

/**
 * Default: single partner key from env. Override for multi-tenant (lookup by webhook-id / partner).
 * @param {string} webhookId
 * @returns {Uint8Array}
 */
function getPublicKeyForWebhook(webhookId) {
  void webhookId;
  const pubB64 = process.env.EVP_WEBHOOK_PUBLIC_KEY_B64 || '';
  if (!String(pubB64).trim()) {
    throw new Error('EVP_WEBHOOK_PUBLIC_KEY_B64 is not configured');
  }
  return decodePublicKeyBase64(pubB64);
}

/** @param {string} b64 */
function base64Decode(b64) {
  return new Uint8Array(Buffer.from(b64, 'base64'));
}

/**
 * @param {Uint8Array} signatureBytes detached Ed25519 signature (64 bytes)
 * @param {string} message UTF-8 string that was signed
 * @param {Uint8Array} publicKey 32-byte Ed25519 public key
 */
function verifyEd25519Signature(signatureBytes, message, publicKey) {
  const msgBytes = Buffer.from(message, 'utf8');
  return nacl.sign.detached.verify(new Uint8Array(msgBytes), signatureBytes, publicKey);
}

/**
 * Partner Integration Guide — verify webhook (throws on failure).
 * Expects Express-style request with `rawBody` Buffer (see express.json verify) and lowercase headers.
 *
 * @param {{ headers: Record<string, unknown>, rawBody?: Buffer }} request
 * @returns {object} parsed JSON payload
 */
function verifyWebhook(request) {
  const h = request.headers || {};
  const webhookId = String(h['webhook-id'] ?? '');
  const timestamp = String(h['webhook-timestamp'] ?? '');
  const signature = h['webhook-signature'];

  if (!webhookId || !timestamp) {
    throw new Error('Missing webhook-id or webhook-timestamp');
  }
  if (signature == null || typeof signature !== 'string') {
    throw new Error('Invalid signature format');
  }

  // Validate signature format
  if (!signature.startsWith('v1a,')) {
    throw new Error('Invalid signature format');
  }

  // Get public key for this webhook
  const publicKey = getPublicKeyForWebhook(webhookId);

  const raw = request.rawBody;
  if (!raw || !Buffer.isBuffer(raw)) {
    throw new Error('rawBody missing — use express.json({ verify: (req, res, buf) => { req.rawBody = buf } })');
  }

  // Construct signed message (raw JSON string, byte-for-byte as received)
  const payload = raw.toString('utf8');
  const message = `${webhookId}.${timestamp}.${payload}`;

  // Decode signature (remove 'v1a,' prefix)
  const signatureBytes = base64Decode(signature.substring(4));
  if (signatureBytes.length !== 64) {
    throw new Error('Invalid signature format');
  }

  // Verify signature
  const isValid = verifyEd25519Signature(signatureBytes, message, publicKey);
  if (!isValid) {
    throw new Error('Invalid signature');
  }

  return JSON.parse(payload);
}

/**
 * Replay protection (docs: reject requests older than tolerance).
 * @param {import('express').Request} req
 * @param {number} toleranceSec default 300 (5 minutes)
 */
function verifyWebhookTimestamp(req, toleranceSec) {
  const tol = Number(toleranceSec ?? process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SEC ?? 300);
  const ts = req.get('webhook-timestamp') || req.headers['webhook-timestamp'];
  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(String(ts), 10);
  if (Number.isNaN(tsNum) || Math.abs(nowSec - tsNum) > tol) {
    throw new Error('Invalid or expired webhook-timestamp');
  }
}

/**
 * Express handler helper: supports SKIP_WEBHOOK_VERIFY and missing public key (dev skip).
 * @param {import('express').Request} req
 * @returns {{ skip: true, webhookId?: string | null } | { ok: true, webhookId: string } | { ok: false, code: number, message: string }}
 */
function verifyEvpWebhookRequest(req) {
  if (process.env.SKIP_WEBHOOK_VERIFY === 'true') {
    return { skip: true, webhookId: getWebhookId(req) };
  }

  const pubB64 = process.env.EVP_WEBHOOK_PUBLIC_KEY_B64 || '';
  if (!String(pubB64).trim()) {
    return { skip: true, webhookId: getWebhookId(req) };
  }

  try {
    verifyWebhookTimestamp(req);
  } catch (e) {
    return { ok: false, code: 401, message: e.message || 'Invalid webhook-timestamp' };
  }

  try {
    verifyWebhook(req);
  } catch (e) {
    const msg = e && e.message ? String(e.message) : 'Verification failed';
    const code = msg.includes('rawBody') ? 500 : 401;
    return { ok: false, code, message: msg };
  }

  const webhookId = getWebhookId(req);
  return { ok: true, webhookId: webhookId || '' };
}

function getWebhookId(req) {
  const v = req.get('webhook-id') || req.headers['webhook-id'];
  return v ? String(v) : null;
}

module.exports = {
  verifyWebhook,
  verifyEvpWebhookRequest,
  verifyWebhookTimestamp,
  getWebhookId,
  getPublicKeyForWebhook,
  base64Decode,
  verifyEd25519Signature
};
