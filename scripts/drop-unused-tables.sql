-- Tables still used by the EVP gateway app — DO NOT DROP:
--   Tbl_EVPMerchant, Tbl_EVPPayment, Tbl_EVPHookLogs, Tbl_EVPWebhookProcessed
--
-- These are unused by the Node app (verify no other service needs them):

IF OBJECT_ID('dbo.PaymentLogs', 'U') IS NOT NULL
  DROP TABLE dbo.PaymentLogs;

IF OBJECT_ID('dbo.Tbl_EVPMerchant_legacy', 'U') IS NOT NULL
  DROP TABLE dbo.Tbl_EVPMerchant_legacy;
