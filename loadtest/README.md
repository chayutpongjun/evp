## Load test (EVP Gateway)

### ทดสอบจากหน้าเว็บ (แนะนำ — ไม่ต้อง Python)

เปิด gateway แล้วไปที่ **`http://localhost:3000/loadtest`** — ตั้งจำนวนคำขอ / ขนาน แล้วกด **เริ่มทดสอบ** (รันในเบราว์เซอร์ ครั้งเดียวจบ)

---

## Locust (ทางเลือก)

### Python version (important on Windows)

Use **Python 3.11 or 3.12** for this venv.

Locust pulls in **gevent**, which on **Python 3.14** often has **no prebuilt wheel** yet; `pip` then tries to compile gevent and the build can fail (e.g. unresolved `PyInt_AsLong` / linker errors). If you see that, delete `.venv` and recreate with 3.12:

```powershell
Set-Location "c:\Users\Chayutpong\Desktop\evp\loadtest"
Remove-Item -Recurse -Force .venv -ErrorAction SilentlyContinue
py -3.12 -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
```

If `py -3.12` is missing, install [Python 3.12](https://www.python.org/downloads/) and retry.

### Install

```powershell
Set-Location "c:\Users\Chayutpong\Desktop\evp\loadtest"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -U pip
pip install -r requirements.txt
```

### Run

Start the Node gateway first, then run Locust (use `python -m locust` so you do not rely on `Scripts` being on `PATH`):

```powershell
Set-Location "c:\Users\Chayutpong\Desktop\evp\loadtest"
.\.venv\Scripts\Activate.ps1
$env:LOCUST_HOST="http://localhost:3000"
python -m locust -f .\locustfile.py
```

Open the Locust UI at `http://localhost:8089`.

### Notes (webhook)

The gateway verifies EVP webhooks (v1a Ed25519) when `EVP_WEBHOOK_PUBLIC_KEY_B64` is set.
Locust does **not** generate real EVP signatures by default, so for webhook load testing:

```powershell
$env:SKIP_WEBHOOK_VERIFY="true"
npm run dev
```

### Tuning

Optional env vars for payload generation:

- `EVP_CURR_CODE` (default `764`)
- `EVP_AMOUNT_MIN` (default `100`)
- `EVP_AMOUNT_MAX` (default `2000`)
