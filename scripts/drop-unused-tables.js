/**
 * Drops DB tables that this EVP gateway app never references.
 * Safe to run if you do not need data in these tables for other systems.
 *
 * Removes:
 *   - dbo.PaymentLogs — not used by this Node app (no code references)
 *   - dbo.Tbl_EVPMerchant_legacy — backup after schema migration (app reads Tbl_EVPMerchant only)
 *
 * Usage: node scripts/drop-unused-tables.js
 */
require('dotenv').config();
const path = require('path');
const { getPool } = require(path.join(__dirname, '..', 'db'));

const sql = `
IF OBJECT_ID('dbo.PaymentLogs', 'U') IS NOT NULL
  DROP TABLE dbo.PaymentLogs;

IF OBJECT_ID('dbo.Tbl_EVPMerchant_legacy', 'U') IS NOT NULL
  DROP TABLE dbo.Tbl_EVPMerchant_legacy;
`;

async function main() {
  const pool = await getPool();
  await pool.request().query(sql);
  console.log('Dropped unused tables (if they existed): PaymentLogs, Tbl_EVPMerchant_legacy');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
