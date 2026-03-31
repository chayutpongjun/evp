import os
import random
import time
import uuid

from locust import HttpUser, between, task


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)).strip())
    except Exception:
        return default


TARGET_CURRENCY_CODE = _env_int("EVP_CURR_CODE", 764)  # THB numeric ISO 4217 code
AMOUNT_MIN = _env_int("EVP_AMOUNT_MIN", 100)  # satang
AMOUNT_MAX = _env_int("EVP_AMOUNT_MAX", 2000)  # satang


class EvpGatewayUser(HttpUser):
    """
    Load test the Node gateway (not EVP directly).

    Endpoints hit:
      - POST /api/payments
      - GET  /api/payments/:evpPaymentId
      - POST /api/webhook/evp (dev mode only unless you add real v1a signature)
    """

    wait_time = between(0.2, 1.2)

    def on_start(self):
        self.payment_ids = []

    @task(6)
    def create_payment(self):
        # These values are the gateway's required fields (server.js)
        now_ms = int(time.time() * 1000)
        trn = f"LOCUST-{uuid.uuid4().hex[:10]}-{now_ms}"
        payload = {
            "amount": random.randint(AMOUNT_MIN, AMOUNT_MAX),
            "currCode": TARGET_CURRENCY_CODE,
            "orderId": f"ORD-{now_ms}-{random.randint(100, 999)}",
            "customerId": f"CUST-{random.randint(1000, 9999)}",
            "transactionRef": trn,
        }

        with self.client.post("/api/payments", json=payload, name="POST /api/payments", catch_response=True) as r:
            if r.status_code != 200:
                r.failure(f"create_payment HTTP {r.status_code}: {r.text[:300]}")
                return

            try:
                data = r.json()
                pid = data.get("evp_payment_id")
                if pid:
                    self.payment_ids.append(pid)
                    self.payment_ids = self.payment_ids[-50:]
                else:
                    r.failure("create_payment missing evp_payment_id")
            except Exception as e:
                r.failure(f"create_payment invalid JSON: {e}")

    @task(10)
    def get_status(self):
        if not self.payment_ids:
            return
        pid = random.choice(self.payment_ids)
        with self.client.get(
            f"/api/payments/{pid}",
            name="GET /api/payments/:id",
            catch_response=True,
        ) as r:
            if r.status_code != 200:
                r.failure(f"get_status HTTP {r.status_code}: {r.text[:300]}")

    @task(2)
    def webhook_dev(self):
        """
        This gateway verifies EVP Standard Webhooks v1a when EVP_WEBHOOK_PUBLIC_KEY_B64 is set
        (or when SKIP_WEBHOOK_VERIFY is not true).

        For local load testing webhooks, run the gateway with:
          SKIP_WEBHOOK_VERIFY=true
        or leave EVP_WEBHOOK_PUBLIC_KEY_B64 empty.
        """
        if not self.payment_ids:
            return

        pid = random.choice(self.payment_ids)
        body = {
            "type": "payment.completed",
            "data": {
                "payment_id": pid,
                "status": "completed",
                "amount": random.randint(AMOUNT_MIN, AMOUNT_MAX),
                "currency": str(TARGET_CURRENCY_CODE),
                "reference": {
                    "order_id": "LOCUST",
                    "customer_id": "LOCUST",
                    "transaction_ref": "LOCUST",
                },
                "paid_at": "2025-10-02T10:30:15Z",
            },
        }

        # No signature is generated here (dev mode)
        with self.client.post("/api/webhook/evp", json=body, name="POST /api/webhook/evp", catch_response=True) as r:
            # In strict mode (signature required), this will return 401.
            if r.status_code not in (200, 401):
                r.failure(f"webhook HTTP {r.status_code}: {r.text[:300]}")

