const sql = require('mssql');

const config = {
  server: process.env.SQL_SERVER,
  port: process.env.SQL_PORT ? Number(process.env.SQL_PORT) : undefined,
  database: process.env.SQL_DATABASE,
  user: process.env.SQL_USER,
  password: process.env.SQL_PASSWORD,
  options: {
    encrypt: process.env.SQL_ENCRYPT === 'true',
    trustServerCertificate: process.env.SQL_TRUST_SERVER_CERTIFICATE === 'true'
  }
};

let poolPromise;

async function getPool() {
  if (!poolPromise) {
    poolPromise = sql.connect(config);
  }
  return poolPromise;
}

async function initSchema() {
  const pool = await getPool();
  await pool
    .request()
    .query(`
      -- If a legacy Tbl_EVPMerchant exists (old columns), rename it out of the way
      IF EXISTS (SELECT * FROM sys.tables WHERE name = 'Tbl_EVPMerchant')
         AND NOT EXISTS (
           SELECT * FROM sys.columns
           WHERE object_id = OBJECT_ID('dbo.Tbl_EVPMerchant') AND name = 'Terminal_ID'
         )
      BEGIN
        EXEC sp_rename 'dbo.Tbl_EVPMerchant', 'Tbl_EVPMerchant_legacy';
      END

      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tbl_EVPMerchant')
      BEGIN
        CREATE TABLE Tbl_EVPMerchant (
          Terminal_ID NVARCHAR(100) NOT NULL,
          Merchant_ID NVARCHAR(100) NOT NULL,
          Branch_ID NVARCHAR(100) NOT NULL,
          Partner_ID NVARCHAR(100) NOT NULL,
          Merchant_Name NVARCHAR(200) NOT NULL,
          ApiKey NVARCHAR(200) NOT NULL,
          BASE_URL NVARCHAR(200) NOT NULL,
          IsActive BIT NOT NULL DEFAULT(1),
          CreatedAtUtc DATETIME2 NOT NULL DEFAULT (SYSUTCDATETIME()),
          UpdatedAtUtc DATETIME2 NULL,
          CONSTRAINT PK_Tbl_EVPMerchant PRIMARY KEY (Terminal_ID, Merchant_ID, Branch_ID)
        );
      END

      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tbl_EVPPayment')
      BEGIN
        CREATE TABLE Tbl_EVPPayment (
          Log_ID INT IDENTITY(1,1) PRIMARY KEY,
          Terminal_ID NVARCHAR(100) NOT NULL,
          Partner_ID NVARCHAR(100) NOT NULL,
          Merchant_ID NVARCHAR(100) NOT NULL,
          Transaction_Type NVARCHAR(20) NOT NULL,
          Amount DECIMAL(18,2) NOT NULL,
          Ref_Order_ID NVARCHAR(100) NOT NULL,
          Ref_Customer_ID NVARCHAR(100) NOT NULL,
          Ref_TRN NVARCHAR(100) NOT NULL,
          CreatedAtUtc DATETIME2 NOT NULL DEFAULT (SYSUTCDATETIME()),
          Res_Payment_ID NVARCHAR(100) NULL,
          Res_Status NVARCHAR(50) NULL,
          Res_Payment_Method NVARCHAR(50) NULL,
          Res_Payment_Network NVARCHAR(50) NULL,
          Res_Masked_Pan NVARCHAR(50) NULL,
          Res_ReferenceData NVARCHAR(MAX) NULL,
          Res_Paid_at DATETIME2 NULL
        );
      END

      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tbl_EVPHookLogs')
      BEGIN
        CREATE TABLE Tbl_EVPHookLogs (
          HookLog_ID INT IDENTITY(1,1) PRIMARY KEY,
          Log_ID INT NULL,
          Res_Payment_ID NVARCHAR(100) NULL,
          Webhook_Url NVARCHAR(500) NULL,
          Payload NVARCHAR(MAX) NOT NULL,
          Forward_StatusCode INT NULL,
          Forward_Response NVARCHAR(MAX) NULL,
          CreatedAtUtc DATETIME2 NOT NULL DEFAULT (SYSUTCDATETIME())
        );
      END

      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tbl_EVPWebhookProcessed')
      BEGIN
        CREATE TABLE Tbl_EVPWebhookProcessed (
          WebhookId NVARCHAR(36) NOT NULL PRIMARY KEY,
          CreatedAtUtc DATETIME2 NOT NULL DEFAULT (SYSUTCDATETIME())
        );
      END

      IF NOT EXISTS (SELECT * FROM sys.tables WHERE name = 'Tbl_EVPMerchant_Deleted')
      BEGIN
        CREATE TABLE Tbl_EVPMerchant_Deleted (
          Deleted_ID   INT IDENTITY(1,1) PRIMARY KEY,
          Terminal_ID  NVARCHAR(100) NOT NULL,
          Merchant_ID  NVARCHAR(100) NOT NULL,
          Branch_ID    NVARCHAR(100) NOT NULL,
          Partner_ID   NVARCHAR(100) NOT NULL,
          Merchant_Name NVARCHAR(200) NOT NULL,
          ApiKey       NVARCHAR(200) NOT NULL,
          BASE_URL     NVARCHAR(200) NOT NULL,
          IsActive     BIT NOT NULL DEFAULT(0),
          CreatedAtUtc  DATETIME2 NOT NULL,
          UpdatedAtUtc  DATETIME2 NULL,
          DeletedAtUtc  DATETIME2 NOT NULL DEFAULT (SYSUTCDATETIME())
        );
      END
    `);
}

async function isWebhookProcessed(webhookId) {
  if (!webhookId) return false;
  const pool = await getPool();
  const r = await pool
    .request()
    .input('WebhookId', webhookId)
    .query('SELECT 1 AS x FROM Tbl_EVPWebhookProcessed WHERE WebhookId = @WebhookId');
  return r.recordset.length > 0;
}

async function markWebhookProcessed(webhookId) {
  if (!webhookId) return;
  const pool = await getPool();
  await pool
    .request()
    .input('WebhookId', webhookId)
    .query(`
      IF NOT EXISTS (SELECT 1 FROM Tbl_EVPWebhookProcessed WHERE WebhookId = @WebhookId)
        INSERT INTO Tbl_EVPWebhookProcessed (WebhookId, CreatedAtUtc) VALUES (@WebhookId, SYSUTCDATETIME());
    `);
}

async function getActiveMerchant() {
  const pool = await getPool();
  const result = await pool
    .request()
    .query(`
      SELECT TOP 1 *
      FROM Tbl_EVPMerchant
      WHERE IsActive = 1
      ORDER BY
        UpdatedAtUtc DESC,
        CreatedAtUtc DESC
    `);

  if (result.recordset.length === 0) {
    throw new Error('No active merchant config found in Tbl_EVPMerchant.');
  }

  return result.recordset[0];
}

async function setActiveMerchant(input) {
  const pool = await getPool();

  const baseUrl = String(input.BASE_URL || '').trim().replace(/\/$/, '');
  const terminalId = String(input.Terminal_ID || '').trim();
  const partnerId = String(input.Partner_ID || '').trim();
  const merchantId = String(input.Merchant_ID || '').trim();
  const branchId = String(input.Branch_ID || '').trim();
  const merchantName = String(input.Merchant_Name || '').trim();
  const apiKey = String(input.ApiKey || '').trim();

  if (
    !baseUrl ||
    !terminalId ||
    !partnerId ||
    !merchantId ||
    !branchId ||
    !merchantName ||
    !apiKey
  ) {
    const err = new Error('Missing required merchant fields.');
    err.statusCode = 400;
    throw err;
  }

  await pool
    .request()
    .query(`
      UPDATE Tbl_EVPMerchant
      SET IsActive = 0,
          UpdatedAtUtc = SYSUTCDATETIME()
    `);

  await pool
    .request()
    .input('Terminal_ID', terminalId)
    .input('Merchant_ID', merchantId)
    .input('Branch_ID', branchId)
    .input('Partner_ID', partnerId)
    .input('Merchant_Name', merchantName)
    .input('ApiKey', apiKey)
    .input('BASE_URL', baseUrl)
    .query(`
      MERGE Tbl_EVPMerchant AS target
      USING (SELECT @Terminal_ID AS Terminal_ID, @Merchant_ID AS Merchant_ID, @Branch_ID AS Branch_ID) AS src
      ON target.Terminal_ID = src.Terminal_ID AND target.Merchant_ID = src.Merchant_ID AND target.Branch_ID = src.Branch_ID
      WHEN MATCHED THEN
        UPDATE SET
          Partner_ID = @Partner_ID,
          Merchant_Name = @Merchant_Name,
          ApiKey = @ApiKey,
          BASE_URL = @BASE_URL,
          IsActive = 1,
          UpdatedAtUtc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (Terminal_ID, Merchant_ID, Branch_ID, Partner_ID, Merchant_Name, ApiKey, BASE_URL, IsActive, CreatedAtUtc)
        VALUES (@Terminal_ID, @Merchant_ID, @Branch_ID, @Partner_ID, @Merchant_Name, @ApiKey, @BASE_URL, 1, SYSUTCDATETIME());
    `);

  return getActiveMerchant();
}

// Upsert merchant row without touching IsActive (for generic CRUD page)
async function upsertMerchant(input) {
  const pool = await getPool();

  const baseUrl = String(input.BASE_URL || '').trim().replace(/\/$/, '');
  const terminalId = String(input.Terminal_ID || '').trim();
  const partnerId = String(input.Partner_ID || '').trim();
  const merchantId = String(input.Merchant_ID || '').trim();
  const branchId = String(input.Branch_ID || '').trim();
  const merchantName = String(input.Merchant_Name || '').trim();
  const apiKey = String(input.ApiKey || '').trim();

  // When editing, we may want to match an existing row by its ORIGINAL composite key
  // (Terminal_ID + Merchant_ID + Branch_ID) even if the user changes the key fields in the UI.
  const origTerminalId = String(input.Original_Terminal_ID || terminalId || '').trim();
  const origMerchantId = String(input.Original_Merchant_ID || merchantId || '').trim();
  const origBranchId = String(input.Original_Branch_ID || branchId || '').trim();

  if (!baseUrl || !terminalId || !partnerId || !merchantId || !branchId || !merchantName || !apiKey) {
    const err = new Error('Missing required merchant fields.');
    err.statusCode = 400;
    throw err;
  }

  await pool
    .request()
    .input('Orig_Terminal_ID', origTerminalId)
    .input('Orig_Merchant_ID', origMerchantId)
    .input('Orig_Branch_ID', origBranchId)
    .input('Terminal_ID', terminalId)
    .input('Merchant_ID', merchantId)
    .input('Branch_ID', branchId)
    .input('Partner_ID', partnerId)
    .input('Merchant_Name', merchantName)
    .input('ApiKey', apiKey)
    .input('BASE_URL', baseUrl)
    .query(`
      MERGE Tbl_EVPMerchant AS target
      USING (SELECT @Orig_Terminal_ID AS Terminal_ID, @Orig_Merchant_ID AS Merchant_ID, @Orig_Branch_ID AS Branch_ID) AS src
      ON target.Terminal_ID = src.Terminal_ID AND target.Merchant_ID = src.Merchant_ID AND target.Branch_ID = src.Branch_ID
      WHEN MATCHED THEN
        UPDATE SET
          Terminal_ID = @Terminal_ID,
          Merchant_ID = @Merchant_ID,
          Branch_ID = @Branch_ID,
          Partner_ID = @Partner_ID,
          Merchant_Name = @Merchant_Name,
          ApiKey = @ApiKey,
          BASE_URL = @BASE_URL,
          UpdatedAtUtc = SYSUTCDATETIME()
      WHEN NOT MATCHED THEN
        INSERT (Terminal_ID, Merchant_ID, Branch_ID, Partner_ID, Merchant_Name, ApiKey, BASE_URL, IsActive, CreatedAtUtc)
        VALUES (@Terminal_ID, @Merchant_ID, @Branch_ID, @Partner_ID, @Merchant_Name, @ApiKey, @BASE_URL, 0, SYSUTCDATETIME());
    `);
}

async function listMerchants(limit = 200) {
  const pool = await getPool();
  const n = Number(limit);
  const safeLimit = Number.isFinite(n) && n > 0 && n <= 1000 ? Math.floor(n) : 200;
  // Use literal TOP — some drivers/servers are flaky with parameterized TOP (@n).
  // Order by CreatedAtUtc only (always present); avoid COALESCE(UpdatedAtUtc,…) if column missing on old DBs.
  const result = await pool.request().query(`
    SELECT TOP (${safeLimit})
      Terminal_ID,
      Merchant_ID,
      Branch_ID,
      Partner_ID,
      Merchant_Name,
      ApiKey,
      BASE_URL,
      IsActive,
      CreatedAtUtc,
      UpdatedAtUtc
    FROM Tbl_EVPMerchant
    ORDER BY
      IsActive DESC,
      CreatedAtUtc DESC
  `);
  return result.recordset;
}

async function getMerchantByKey(key) {
  const terminalId = String(key?.Terminal_ID || '').trim();
  const merchantId = String(key?.Merchant_ID || '').trim();
  const branchId = String(key?.Branch_ID || '').trim();
  if (!terminalId || !merchantId || !branchId) return null;

  const pool = await getPool();
  const r = await pool
    .request()
    .input('Terminal_ID', terminalId)
    .input('Merchant_ID', merchantId)
    .input('Branch_ID', branchId)
    .query(`
      SELECT TOP 1 *
      FROM Tbl_EVPMerchant
      WHERE Terminal_ID = @Terminal_ID
        AND Merchant_ID = @Merchant_ID
        AND Branch_ID = @Branch_ID
    `);
  return r.recordset[0] || null;
}

// Look up a merchant by Terminal_ID only (used by x-terminal-id header in API calls)
async function getMerchantByTerminalId(terminalId) {
  const tid = String(terminalId || '').trim();
  if (!tid) return null;
  const pool = await getPool();
  const r = await pool
    .request()
    .input('Terminal_ID', tid)
    .query(`
      SELECT TOP 1 *
      FROM Tbl_EVPMerchant
      WHERE Terminal_ID = @Terminal_ID
      ORDER BY IsActive DESC, UpdatedAtUtc DESC, CreatedAtUtc DESC
    `);
  return r.recordset[0] || null;
}

// Move a merchant row to Tbl_EVPMerchant_Deleted instead of hard-deleting
async function archiveMerchant(terminalId, merchantId, branchId) {
  const pool = await getPool();
  const tid  = String(terminalId).trim();
  const mid  = String(merchantId).trim();
  const bid  = String(branchId).trim();

  // Copy row to archive table then delete from main table (single transaction)
  const r = await pool
    .request()
    .input('Terminal_ID', tid)
    .input('Merchant_ID', mid)
    .input('Branch_ID',   bid)
    .query(`
      BEGIN TRANSACTION;

      INSERT INTO Tbl_EVPMerchant_Deleted
        (Terminal_ID, Merchant_ID, Branch_ID, Partner_ID, Merchant_Name,
         ApiKey, BASE_URL, IsActive, CreatedAtUtc, UpdatedAtUtc, DeletedAtUtc)
      SELECT Terminal_ID, Merchant_ID, Branch_ID, Partner_ID, Merchant_Name,
             ApiKey, BASE_URL, IsActive, CreatedAtUtc, UpdatedAtUtc, SYSUTCDATETIME()
      FROM   Tbl_EVPMerchant
      WHERE  Terminal_ID = @Terminal_ID
        AND  Merchant_ID = @Merchant_ID
        AND  Branch_ID   = @Branch_ID;

      DELETE FROM Tbl_EVPMerchant
      WHERE  Terminal_ID = @Terminal_ID
        AND  Merchant_ID = @Merchant_ID
        AND  Branch_ID   = @Branch_ID;

      COMMIT;
      SELECT @@ROWCOUNT AS affected;
    `);

  const affected = r.recordset[0] ? r.recordset[0].affected : 0;
  if (!affected) {
    const err = new Error('Merchant row not found.');
    err.statusCode = 404;
    throw err;
  }
  return { ok: true };
}

// Toggle IsActive for a single row (does NOT touch other rows)
async function toggleMerchantStatus(terminalId, merchantId, branchId, isActive) {
  const pool = await getPool();
  const newVal = isActive ? 1 : 0;
  const r = await pool
    .request()
    .input('Terminal_ID', String(terminalId).trim())
    .input('Merchant_ID', String(merchantId).trim())
    .input('Branch_ID',   String(branchId).trim())
    .input('IsActive',    newVal)
    .query(`
      UPDATE Tbl_EVPMerchant
      SET IsActive = @IsActive,
          UpdatedAtUtc = SYSUTCDATETIME()
      WHERE Terminal_ID = @Terminal_ID
        AND Merchant_ID = @Merchant_ID
        AND Branch_ID   = @Branch_ID;
      SELECT @@ROWCOUNT AS affected;
    `);
  const affected = r.recordset[0] ? r.recordset[0].affected : 0;
  if (!affected) {
    const err = new Error('Merchant row not found.');
    err.statusCode = 404;
    throw err;
  }
  return { ok: true, isActive: newVal };
}

module.exports = {
  sql,
  getPool,
  initSchema,
  getActiveMerchant,
  setActiveMerchant,
  upsertMerchant,
  listMerchants,
  getMerchantByKey,
  getMerchantByTerminalId,
  archiveMerchant,
  toggleMerchantStatus,
  isWebhookProcessed,
  markWebhookProcessed
};