/**
 * EVP Standard Webhooks v1a — see https://docs.evp-pay.com/introduction
 * Message: {webhook_id}.{timestamp}.{json_payload}
 * Signature: Ed25519, header webhook-signature format v1a,{base64}
 */
const nacl = require('tweetnacl');

function decodePublicKeyBase64(b64) {
  const buf = Buffer.from(String(b64).trim(), 'base64');
  if (buf.length !== 32) {
    throw new Error('EVP_WEBHOOK_PUBLIC_KEY_B64 must decode to 32 bytes (Ed25519 public key)');
  }
  return new Uint8Array(buf);
}

/**
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

  const webhookId = getWebhookId(req);
  const ts = req.get('webhook-timestamp') || req.headers['webhook-timestamp'];
  const sigHeader = req.get('webhook-signature') || req.headers['webhook-signature'];

  if (!webhookId || !ts || !sigHeader) {
    return {
      ok: false,
      code: 401,
      message: 'Missing Standard Webhooks headers: webhook-id, webhook-timestamp, webhook-signature'
    };
  }

  const toleranceSec = Number(process.env.WEBHOOK_TIMESTAMP_TOLERANCE_SEC || 300);
  const nowSec = Math.floor(Date.now() / 1000);
  const tsNum = parseInt(String(ts), 10);
  if (Number.isNaN(tsNum) || Math.abs(nowSec - tsNum) > toleranceSec) {
    return { ok: false, code: 401, message: 'Invalid or expired webhook-timestamp (replay protection)' };
  }

  if (!req.rawBody || !Buffer.isBuffer(req.rawBody)) {
    return {
      ok: false,
      code: 500,
      message: 'rawBody missing — enable express.json verify to capture raw JSON for signature verification'
    };
  }

  if (!String(sigHeader).startsWith('v1a,')) {
    return { ok: false, code: 401, message: 'webhook-signature must start with v1a,' };
  }

  const sigB64 = String(sigHeader).slice(4);
  const sigBytes = Buffer.from(sigB64, 'base64');
  if (sigBytes.length !== 64) {
    return { ok: false, code: 401, message: 'Invalid Ed25519 signature length' };
  }

  const payloadStr = req.rawBody.toString('utf8');
  const message = `${webhookId}.${ts}.${payloadStr}`;
  const msgBytes = Buffer.from(message, 'utf8');

  let pubKey;
  try {
    pubKey = decodePublicKeyBase64(pubB64);
  } catch (e) {
    return { ok: false, code: 500, message: e.message || 'Invalid public key' };
  }

  const valid = nacl.sign.detached.verify(
    new Uint8Array(msgBytes),
    new Uint8Array(sigBytes),
    pubKey
  );

  if (!valid) {
    return { ok: false, code: 401, message: 'Invalid webhook signature (Ed25519)' };
  }

  return { ok: true, webhookId };
}

function getWebhookId(req) {
  const v = req.get('webhook-id') || req.headers['webhook-id'];
  return v ? String(v) : null;
}

module.exports = {
  verifyEvpWebhookRequest,
  getWebhookId
};
