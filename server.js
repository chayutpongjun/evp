require('dotenv').config();

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const axios = require('axios');
const {
  getPool,
  initSchema,
  getActiveMerchant,
  setActiveMerchant,
  upsertMerchant,
  listMerchants,
  getMerchantByKey,
  archiveMerchant,
  toggleMerchantStatus,
  isWebhookProcessed,
  markWebhookProcessed
} = require('./db');
const { verifyEvpWebhookRequest, getWebhookId } = require('./webhook-verify');

const app = express();

app.set('view engine', 'ejs');
app.set('views', __dirname + '/views');

app.use(cors());
// Capture raw body for EVP Standard Webhooks v1a signature: {webhook_id}.{timestamp}.{json_payload}
app.use(
  express.json({
    limit: '2mb',
    verify: (req, res, buf) => {
      req.rawBody = buf;
    }
  })
);
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/', (req, res) => res.redirect('/payment'));

// Debug helper: list registered routes (dev only)
app.get('/__routes', (req, res) => {
  try {
    const stack = (app.router && app.router.stack) || (app._router && app._router.stack) || [];
    const routes = [];
    for (const layer of stack) {
      if (layer && layer.route && layer.route.path) {
        const methods = layer.route.methods ? Object.keys(layer.route.methods).filter((m) => layer.route.methods[m]) : [];
        routes.push({ path: layer.route.path, methods });
      }
    }
    routes.sort((a, b) => String(a.path).localeCompare(String(b.path)));
    res.json({ count: routes.length, routes });
  } catch (e) {
    res.status(500).json({ message: e.message || String(e) });
  }
});

async function tryGetMerchant() {
  try {
    return await getActiveMerchant();
  } catch {
    return null;
  }
}

function merchantRowKey(m) {
  if (!m) return '';
  return `${m.Terminal_ID}|${m.Merchant_ID}|${m.Branch_ID}`;
}

/** Ensure dropdown always includes the row currently shown in the form (covers empty list query / edge cases). */
function mergeMerchantIntoDropdown(rows, merchant) {
  const list = Array.isArray(rows) ? [...rows] : [];
  if (!merchant) return list;
  const k = merchantRowKey(merchant);
  if (!k || list.some((m) => merchantRowKey(m) === k)) return list;
  return [merchant, ...list];
}

app.get('/payment', async (req, res) => {
  try {
    const merchant = await tryGetMerchant();
    res.render('payment', { merchant });
  } catch (err) {
    console.error(err);
    res.status(500).send('Render error');
  }
});

app.get('/payment-status', async (req, res) => {
  try {
    const pool = await getPool();
    const payments = await pool
      .request()
      .query(
        "SELECT TOP 200 Log_ID, Ref_TRN, Ref_Order_ID, Ref_Customer_ID, Res_Payment_ID, Res_Status, CreatedAtUtc FROM Tbl_EVPPayment ORDER BY Log_ID DESC"
      );
    const merchant = await tryGetMerchant();
    res.render('payment-status', { merchant, payments: payments.recordset });
  } catch (err) {
    console.error(err);
    res.status(500).send('Render error');
  }
});

app.get('/evp-payment-report', async (req, res) => {
  try {
    const pool = await getPool();
    const result = await pool.request().query('SELECT TOP 50 * FROM Tbl_EVPPayment ORDER BY Log_ID DESC');
    const merchant = await tryGetMerchant();
    res.render('evp-payment-report', { logs: result.recordset, merchant });
  } catch (err) {
    console.error(err);
    res.status(500).send('DB error');
  }
});

app.get('/loadtest', async (req, res) => {
  try {
    const merchant = await tryGetMerchant();
    res.render('loadtest', { merchant });
  } catch (err) {
    console.error(err);
    res.status(500).send('Render error');
  }
});

app.get('/webhook', async (req, res) => {
  try {
    const merchant = await tryGetMerchant();
    res.render('webhook', { merchant });
  } catch (err) {
    console.error(err);
    res.status(500).send('Render error');
  }
});

// Admin: merchant list (CRU)
app.get('/admin/merchants', async (req, res) => {
  try {
    const merchants = await listMerchants(500);
    const merchant = await tryGetMerchant();
    res.render('merchants', { merchant, merchants });
  } catch (err) {
    console.error(err);
    res.status(500).send('DB error');
  }
});

// Admin: view current merchant config
app.get('/admin/merchant', async (req, res) => {
  try {
    const rawList = await listMerchants(200);
    const picked = await getMerchantByKey({
      Terminal_ID: req.query.terminalId,
      Merchant_ID: req.query.merchantId,
      Branch_ID: req.query.branchId
    });
    const merchant = picked || (await tryGetMerchant());
    const merchantList = mergeMerchantIntoDropdown(rawList, merchant);
    res.render('merchant', { merchant, merchantList });
  } catch (err) {
    console.error(err);
    res.status(500).send('DB error');
  }
});

// UI: simulate webhook payload
app.get('/simulate/webhook', async (req, res) => {
  try {
    res.redirect('/webhook');
  } catch (err) {
    console.error(err);
    res.status(500).send('Render error');
  }
});

// Admin: set active merchant config (store into Tbl_EVPMerchant)
app.post('/admin/merchant', async (req, res) => {
  try {
    await setActiveMerchant({
      BASE_URL: req.body.baseUrl,
      Terminal_ID: req.body.terminalId,
      Partner_ID: req.body.partnerId,
      Merchant_ID: req.body.merchantId,
      Branch_ID: req.body.branchId,
      Merchant_Name: req.body.merchantName,
      ApiKey: req.body.apiKey
    });
    return res.redirect('/admin/merchant');
  } catch (err) {
    console.error(err);
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).send(err.message || 'Error');
  }
});

// Admin: save merchant from list popup (AJAX)
app.post('/admin/merchants/save', async (req, res) => {
  try {
    await upsertMerchant({
      BASE_URL: req.body.baseUrl,
      Terminal_ID: req.body.terminalId,
      Partner_ID: req.body.partnerId,
      Merchant_ID: req.body.merchantId,
      Branch_ID: req.body.branchId,
      Merchant_Name: req.body.merchantName,
      ApiKey: req.body.apiKey,
      Original_Terminal_ID: req.body.originalTerminalId,
      Original_Merchant_ID: req.body.originalMerchantId,
      Original_Branch_ID: req.body.originalBranchId
    });
    return res.json({ ok: true });
  } catch (err) {
    console.error(err);
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({ ok: false, message: err.message || 'Error' });
  }
});

// Admin: make specific merchant row active (CRU list action)
app.post('/admin/merchants/:terminalId/:merchantId/:branchId/activate', async (req, res) => {
  try {
    const row = await getMerchantByKey({
      Terminal_ID: req.params.terminalId,
      Merchant_ID: req.params.merchantId,
      Branch_ID: req.params.branchId
    });
    if (!row) {
      return res.status(404).send('Merchant row not found.');
    }
    await setActiveMerchant(row);
    return res.redirect('/admin/merchants');
  } catch (err) {
    console.error(err);
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).send(err.message || 'Error');
  }
});

// Admin: toggle IsActive for a single merchant row (AJAX)
app.post('/admin/merchants/:terminalId/:merchantId/:branchId/toggle-status', async (req, res) => {
  try {
    const isActive = req.body.isActive === true || req.body.isActive === 1 || req.body.isActive === '1';
    const result = await toggleMerchantStatus(
      req.params.terminalId,
      req.params.merchantId,
      req.params.branchId,
      isActive
    );
    return res.json(result);
  } catch (err) {
    console.error(err);
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).json({ ok: false, message: err.message || 'Error' });
  }
});

// Admin: archive (soft-delete) merchant row → moves to Tbl_EVPMerchant_Deleted
app.post('/admin/merchants/:terminalId/:merchantId/:branchId/delete', async (req, res) => {
  try {
    await archiveMerchant(
      req.params.terminalId,
      req.params.merchantId,
      req.params.branchId
    );
    return res.redirect('/admin/merchants');
  } catch (err) {
    console.error(err);
    const statusCode = err.statusCode || 500;
    return res.status(statusCode).send(err.message || 'Error');
  }
});

function pick(obj, keys) {
  if (!obj || typeof obj !== 'object') return null;
  for (const k of keys) {
    if (obj[k] !== undefined && obj[k] !== null) return obj[k];
  }
  return null;
}

function parsePaidAt(value) {
  if (!value) return null;
  const d = new Date(value);
  // invalid date
  if (Number.isNaN(d.getTime())) return null;
  return d;
}

function normalizeWebhookEvent(body) {
  // EVP WebhookEvent shape: { type: "payment.completed", data: { payment_id, status, ... } }
  // We keep original body for logging, but use `payload` for extraction.
  if (body && typeof body === 'object' && body.type && body.data && typeof body.data === 'object') {
    return {
      eventType: String(body.type),
      payload: body.data,
      raw: body
    };
  }
  return { eventType: null, payload: body, raw: body };
}

async function handleEvpWebhook(body, res, options = {}) {
  const { webhookId: idempotencyId } = options;
  try {
    const pool = await getPool();
    const normalized = normalizeWebhookEvent(body);
    const payload = normalized.payload || {};

    let evpPaymentId = pick(payload, ['id', 'payment_id', 'paymentId']) || null;
    const refOrderId = pick(payload, ['order_id', 'orderId']) || null;
    const refCustomerId = pick(payload, ['customer_id', 'customerId']) || null;
    const refTrn = pick(payload, ['transaction_ref', 'transactionRef', 'ref_trn', 'refTrn']) || null;

    let selectResult;

    if (evpPaymentId) {
      selectResult = await pool
        .request()
        .input('Res_Payment_ID', evpPaymentId)
        .query(`
          SELECT TOP 1 * FROM Tbl_EVPPayment
          WHERE Res_Payment_ID = @Res_Payment_ID
          ORDER BY Log_ID DESC
        `);
    } else if (refOrderId && refCustomerId && refTrn) {
      // Allow "reference-only webhook": find latest payment by references
      selectResult = await pool
        .request()
        .input('Ref_Order_ID', refOrderId)
        .input('Ref_Customer_ID', refCustomerId)
        .input('Ref_TRN', refTrn)
        .query(`
          SELECT TOP 1 * FROM Tbl_EVPPayment
          WHERE Ref_Order_ID = @Ref_Order_ID
            AND Ref_Customer_ID = @Ref_Customer_ID
            AND Ref_TRN = @Ref_TRN
          ORDER BY Log_ID DESC
        `);
    } else {
      return res.status(400).json({
        message:
          'Webhook payload must include id/payment_id OR (order_id, customer_id, transaction_ref).'
      });
    }

    if (selectResult.recordset.length === 0) {
      return res.status(404).json({ message: 'Payment log not found.' });
    }

    const payment = selectResult.recordset[0];
    if (!evpPaymentId) {
      evpPaymentId = payment.Res_Payment_ID || null;
    }
    if (!evpPaymentId) {
      return res.status(409).json({ message: 'Found payment row but Res_Payment_ID is empty.' });
    }

    // Check status from EVP and return it (like "Get Payment Status")
    let evpStatusHttp = null;
    let evpStatusBody = null;
    try {
      const merchant = await getActiveMerchant();
      const baseUrl = String(merchant.BASE_URL || '').replace(/\/$/, '');
      const terminalId = merchant.Terminal_ID;
      const apiKey = merchant.ApiKey;

      const evpResponse = await axios.get(
        `${baseUrl}/v1/terminals/${terminalId}/payments/${evpPaymentId}`,
        {
          headers: { 'x-api-key': apiKey },
          timeout: 15000
        }
      );

      evpStatusHttp = evpResponse.status;
      evpStatusBody = evpResponse.data;
    } catch (statusErr) {
      evpStatusHttp = statusErr.response?.status || 500;
      evpStatusBody = statusErr.response?.data || { message: statusErr.message };
    }

    // Update payment response fields if provided
    const status = pick(payload, ['status']) || pick(evpStatusBody, ['status']) || null;
    const resMethod =
      pick(payload, ['payment_method', 'method']) || pick(evpStatusBody, ['payment_method', 'method']) || null;
    const resNetwork =
      pick(payload, ['payment_network', 'network']) ||
      pick(evpStatusBody, ['payment_network', 'network']) ||
      null;
    const resMaskedPan =
      pick(payload, ['masked_pan', 'maskedPan', 'masked_card']) ||
      pick(evpStatusBody, ['masked_pan', 'maskedPan', 'masked_card']) ||
      null;
    const resReferenceData =
      payload.reference ||
      payload.reference_data ||
      payload.referenceData ||
      evpStatusBody?.reference ||
      evpStatusBody?.reference_data ||
      evpStatusBody?.referenceData ||
      null;
    const paidAt = parsePaidAt(
      pick(payload, ['paid_at', 'paidAt']) || pick(evpStatusBody, ['paid_at', 'paidAt'])
    );

    await pool
      .request()
      .input('Log_ID', payment.Log_ID)
      .input('Res_Status', status)
      .input('Res_Payment_Method', resMethod)
      .input('Res_Payment_Network', resNetwork)
      .input('Res_Masked_Pan', resMaskedPan)
      .input('Res_ReferenceData', resReferenceData ? JSON.stringify(resReferenceData) : null)
      .input('Res_Paid_at', paidAt)
      .query(`
        UPDATE Tbl_EVPPayment
        SET Res_Status = ISNULL(@Res_Status, Res_Status),
            Res_Payment_Method = ISNULL(@Res_Payment_Method, Res_Payment_Method),
            Res_Payment_Network = ISNULL(@Res_Payment_Network, Res_Payment_Network),
            Res_Masked_Pan = ISNULL(@Res_Masked_Pan, Res_Masked_Pan),
            Res_ReferenceData = ISNULL(@Res_ReferenceData, Res_ReferenceData),
            Res_Paid_at = COALESCE(@Res_Paid_at, Res_Paid_at)
        WHERE Log_ID = @Log_ID
      `);

    await pool
      .request()
      .input('Log_ID', payment.Log_ID)
      .input('Res_Payment_ID', evpPaymentId)
      .input('Webhook_Url', null)
      .input('Payload', JSON.stringify(normalized.raw))
      .input('Forward_StatusCode', evpStatusHttp)
      .input(
        'Forward_Response',
        JSON.stringify({
          event_type: normalized.eventType,
          evp_status_http: evpStatusHttp,
          evp_status: evpStatusBody
        })
      )
      .query(`
        INSERT INTO Tbl_EVPHookLogs
        (Log_ID, Res_Payment_ID, Webhook_Url, Payload, Forward_StatusCode, Forward_Response, CreatedAtUtc)
        VALUES (@Log_ID, @Res_Payment_ID, @Webhook_Url, @Payload, @Forward_StatusCode, @Forward_Response, SYSUTCDATETIME())
      `);

    if (idempotencyId) {
      try {
        await markWebhookProcessed(idempotencyId);
      } catch (e) {
        console.error('markWebhookProcessed:', e.message);
      }
    }

    return res.json({
      ok: true,
      log_id: payment.Log_ID,
      evp_payment_id: evpPaymentId,
      status,
      event_type: normalized.eventType,
      evp_status_http: evpStatusHttp,
      evp_status: evpStatusBody
    });
  } catch (err) {
    console.error('Webhook error:', err.message);
    return res.status(500).json({ message: 'Webhook error', error: err.message });
  }
}

async function runEvpWebhookHandler(req, res, buildBody) {
  const v = verifyEvpWebhookRequest(req);
  if (v.skip) {
    // dev / no public key configured
  } else if (v.ok) {
    // verified
  } else {
    return res.status(v.code).json({ message: v.message });
  }

  const wid = (v.webhookId || getWebhookId(req)) || null;

  if (wid && (await isWebhookProcessed(wid))) {
    return res.json({ ok: true, duplicate: true, webhook_id: wid });
  }

  const body = buildBody();
  return handleEvpWebhook(body, res, { webhookId: wid || undefined });
}

// Create Payment API
app.post('/api/payments', async (req, res) => {
  const {
    amount,
    currCode,
    orderId,
    customerId,
    transactionRef
  } = req.body;

  if (!amount || !currCode || !orderId || !customerId || !transactionRef) {
    return res.status(400).json({ message: 'Missing required fields.' });
  }

  // EVP sandbox in your examples uses THB = 764
  const curr = Number(currCode);
  if (!Number.isFinite(curr) || curr <= 0) {
    return res.status(400).json({ message: 'Invalid currCode.' });
  }

  try {
    const merchant = await getActiveMerchant();
    const baseUrl = String(merchant.BASE_URL || '').replace(/\/$/, '');
    const terminalId = merchant.Terminal_ID;
    const partnerId = merchant.Partner_ID;
    const apiKey = merchant.ApiKey;
    const merchantId = merchant.Merchant_ID;

    const evpPayload = {
      partner_id: partnerId,
      transaction_type: 'SALE',
      amount: Number(amount),
      curr_code: curr,
      reference: {
        order_id: orderId,
        customer_id: customerId,
        transaction_ref: transactionRef
      }
    };

    const evpResponse = await axios.post(
      `${baseUrl}/v1/terminals/${terminalId}/payments`,
      evpPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey
        },
        timeout: 15000
      }
    );

    const responseBody = evpResponse.data;
    const evpPaymentId = pick(responseBody, ['id', 'payment_id']) || null;
    const resStatus = pick(responseBody, ['status']) || null;
    const resMethod = pick(responseBody, ['payment_method', 'method']) || null;
    const resNetwork = pick(responseBody, ['payment_network', 'network']) || null;
    const resMaskedPan = pick(responseBody, ['masked_pan', 'maskedPan', 'masked_card']) || null;
    const resReferenceData = responseBody.reference || responseBody.reference_data || responseBody.referenceData || null;
    const paidAt = parsePaidAt(pick(responseBody, ['paid_at', 'paidAt']));

    const pool = await getPool();
    const insertResult = await pool
      .request()
      .input('Terminal_ID', terminalId)
      .input('Partner_ID', partnerId)
      .input('Merchant_ID', merchantId)
      .input('Transaction_Type', 'SALE')
      .input('Amount', Number(amount))
      .input('Ref_Order_ID', orderId)
      .input('Ref_Customer_ID', customerId)
      .input('Ref_TRN', transactionRef)
      .input('Res_Payment_ID', evpPaymentId)
      .input('Res_Status', resStatus)
      .input('Res_Payment_Method', resMethod)
      .input('Res_Payment_Network', resNetwork)
      .input('Res_Masked_Pan', resMaskedPan)
      .input('Res_ReferenceData', resReferenceData ? JSON.stringify(resReferenceData) : null)
      .input('Res_Paid_at', paidAt)
      .query(`
        INSERT INTO Tbl_EVPPayment
        (Terminal_ID, Partner_ID, Merchant_ID, Transaction_Type, Amount,
         Ref_Order_ID, Ref_Customer_ID, Ref_TRN, CreatedAtUtc,
         Res_Payment_ID, Res_Status, Res_Payment_Method, Res_Payment_Network, Res_Masked_Pan, Res_ReferenceData, Res_Paid_at)
        OUTPUT INSERTED.Log_ID
        VALUES (@Terminal_ID, @Partner_ID, @Merchant_ID, @Transaction_Type, @Amount,
                @Ref_Order_ID, @Ref_Customer_ID, @Ref_TRN, SYSUTCDATETIME(),
                @Res_Payment_ID, @Res_Status, @Res_Payment_Method, @Res_Payment_Network, @Res_Masked_Pan, @Res_ReferenceData, @Res_Paid_at)
      `);

    const logId = insertResult.recordset[0].Log_ID;

    return res.json({
      ref_trn: transactionRef,
      log_id: logId,
      evp_payment_id: evpPaymentId,
      status: resStatus,
      evp_response: responseBody
    });
  } catch (err) {
    console.error('Create payment error:', err.response?.data || err.message);
    const statusCode = err.response?.status || 500;
    return res
      .status(statusCode)
      .json({
        message: 'Error calling EVP API',
        statusCode,
        evp_error: err.response?.data || err.message,
        evp_request: {
          amount: Number(amount),
          curr_code: curr,
          reference: { order_id: orderId, customer_id: customerId, transaction_ref: transactionRef },
          transaction_type: 'SALE'
        }
      });
  }
});

// Get Payment Status API
app.get('/api/payments/:evpPaymentId', async (req, res) => {
  const { evpPaymentId } = req.params;

  try {
    const merchant = await getActiveMerchant();
    const baseUrl = String(merchant.BASE_URL || '').replace(/\/$/, '');
    const terminalId = merchant.Terminal_ID;
    const apiKey = merchant.ApiKey;

    const evpResponse = await axios.get(
      `${baseUrl}/v1/terminals/${terminalId}/payments/${evpPaymentId}`,
      {
        headers: {
          'x-api-key': apiKey
        },
        timeout: 15000
      }
    );

    const responseBody = evpResponse.data;
    const status = pick(responseBody, ['status']) || null;
    const resMethod = pick(responseBody, ['payment_method', 'method']) || null;
    const resNetwork = pick(responseBody, ['payment_network', 'network']) || null;
    const resMaskedPan = pick(responseBody, ['masked_pan', 'maskedPan', 'masked_card']) || null;
    const resReferenceData = responseBody.reference || responseBody.reference_data || responseBody.referenceData || null;
    const paidAt = parsePaidAt(pick(responseBody, ['paid_at', 'paidAt']));

    const pool = await getPool();
    await pool
      .request()
      .input('Res_Payment_ID', evpPaymentId)
      .input('Res_Status', status)
      .input('Res_Payment_Method', resMethod)
      .input('Res_Payment_Network', resNetwork)
      .input('Res_Masked_Pan', resMaskedPan)
      .input('Res_ReferenceData', resReferenceData ? JSON.stringify(resReferenceData) : null)
      .input('Res_Paid_at', paidAt)
      .query(`
        UPDATE Tbl_EVPPayment
        SET Res_Status = ISNULL(@Res_Status, Res_Status),
            Res_Payment_Method = ISNULL(@Res_Payment_Method, Res_Payment_Method),
            Res_Payment_Network = ISNULL(@Res_Payment_Network, Res_Payment_Network),
            Res_Masked_Pan = ISNULL(@Res_Masked_Pan, Res_Masked_Pan),
            Res_ReferenceData = ISNULL(@Res_ReferenceData, Res_ReferenceData),
            Res_Paid_at = COALESCE(@Res_Paid_at, Res_Paid_at)
        WHERE Res_Payment_ID = @Res_Payment_ID
      `);

    return res.json({
      evp_payment_id: evpPaymentId,
      status,
      evp_response: responseBody
    });
  } catch (err) {
    console.error('Get status error:', err.response?.data || err.message);
    const statusCode = err.response?.status || 500;
    return res
      .status(statusCode)
      .json({ message: 'Error getting EVP status', error: err.response?.data || err.message });
  }
});

// Webhook from EVP (Standard Webhooks v1a — https://docs.evp-pay.com/introduction)
// Option: per-payment webhook URL pattern
app.post('/webhook/:paymentId', async (req, res) => {
  const { paymentId } = req.params;
  return runEvpWebhookHandler(req, res, () => ({ ...(req.body || {}), id: paymentId }));
});

app.post('/api/webhook/evp', async (req, res) => {
  return runEvpWebhookHandler(req, res, () => req.body);
});

// Start server (after DB schema ready)
const port = process.env.PORT || 3000;

initSchema()
  .then(() => {
    app.listen(port, () => {
      console.log(`Server listening on http://localhost:${port}`);
      console.log(`  Load test (browser): http://localhost:${port}/loadtest`);
    });
  })
  .catch((err) => {
    console.error('Failed to init DB schema:', err);
    process.exit(1);
  });

