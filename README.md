# BMS Appointment — ระบบทะเบียนนัดหมายผู้ป่วย

หน้าจอทะเบียนนัดหมายผู้ป่วย (HOSxP / BMS) เชื่อมต่อข้อมูลผ่าน **BMS-Session-ID** และมีช่องทางเชื่อมต่อ **ฐานกลาง Online (PostgreSQL)** ผ่าน backend proxy

---

## 1. ภาพรวม

| ส่วน | รายละเอียด |
|---|---|
| **หน้าเว็บ** | `index.html` — single-file (HTML/CSS/JS ในไฟล์เดียว) |
| **Backend** | `server.js` — Node.js (เสิร์ฟหน้าเว็บ + proxy ไปฐานกลาง PostgreSQL) |
| **แหล่งข้อมูลหลัก** | HOSxP ผ่าน BMS-Session → tunnel `*.tunnel.hosxp.net/api/sql` |
| **แหล่งข้อมูลรอง** | ฐานกลาง Online `lab_app_online` (PostgreSQL) ผ่าน `server.js` |

---

## 2. โครงสร้างไฟล์

```
BMS-Appointment/
├── login.html                 # หน้า Login (หน้าแรก) — ใส่รหัสสถานพยาบาล → แยกไป index/client
├── index.html                 # หน้าแม่ข่าย (Main) — ดึงจาก HOSxP + ส่งเข้าฐานกลาง
├── client.html                # หน้าลูกข่าย (Sub) — อ่านจากฐานกลางอย่างเดียว (ไม่แตะ HOSxP)
├── server.js                  # backend: static server + proxy ฐานกลาง PostgreSQL
├── package.json               # dependency: pg
├── start.bat                  # ติดตั้ง pg + รัน server.js + เปิดเบราว์เซอร์
├── sync-cli.js                # ยิงข้อมูลเข้าฐานกลางแบบ headless (ไม่ต้องกดปุ่ม)
├── auto-sync.bat              # วนรัน sync-cli.js ทุก N นาที (คุม server.js ให้ด้วย)
├── sync.config.example.json   # ตัวอย่าง config (คัดลอกเป็น sync.config.json)
├── sync.config.json           # config จริง + BMS Session ID (ความลับ — ถูก .gitignore)
├── .env                       # ค่าเชื่อมต่อฐานกลาง (ความลับ — ถูก .gitignore)
├── .env.example               # ตัวอย่าง .env (ไม่มีรหัสจริง)
├── .gitignore                 # กัน .env, sync.config.json, node_modules
└── README.md
```

---

## 3. วิธีใช้งาน

### เปิดใช้งาน
1. ดับเบิลคลิก **`start.bat`**
   - ติดตั้ง `pg` อัตโนมัติครั้งแรก (ต้องมี Node.js ≥ 18 + อินเทอร์เน็ต)
   - รัน server ที่ `http://localhost:8780`
   - เปิดเบราว์เซอร์มาที่ **หน้า Login** (`/login.html`) อัตโนมัติ
2. ใส่ **รหัสสถานพยาบาล** → กด **เข้าสู่ระบบ**
   - รหัส **แม่ข่าย (Main)** → เปิดหน้า `index.html` (ต่อ BMS-Session ดึงจาก HOSxP)
   - รหัส **ลูกข่าย (Sub)** → เปิดหน้า `client.html` (อ่านจากฐานกลาง, ล็อกขอบเขตเฉพาะหน่วยตน)
3. ที่หน้า index ใส่ **BMS Session ID** (หรือเปิดด้วย URL `?bms-session-id=...`) แล้วกด **แสดงข้อมูล**

> ⚠️ ต้องเปิดผ่าน `start.bat` (http://localhost) ไม่ใช่ดับเบิลคลิกไฟล์ `.html` ตรงๆ
> มิฉะนั้น cookie/ฐานกลางจะไม่ทำงาน และอาจเจอ cache เก่า

### หยุด server
กด **Ctrl+C** ในหน้าต่าง cmd

---

## 3.5 หน้า Login (แยกแม่ข่าย / ลูกข่าย)

หน้าแรกคือ **`login.html`** — ผู้ใช้กรอก **รหัสสถานพยาบาล** ระบบจะค้นจากตาราง `hospital_registry` ในฐานกลาง แล้วพาไปหน้าจอที่เหมาะสม:

```
กรอกรหัส → POST /api/online/login → hospital_registry
   • hos_type = 'main' → index.html?hcode=รหัส   (แม่ข่าย: ต่อ HOSxP, เห็นทุกลูกข่าย)
   • hos_type = 'sub'  → client.html?hcode=รหัส  (ลูกข่าย: อ่านฐานกลาง, ล็อกเฉพาะหน่วยตน)
   • ไม่พบรหัส → แจ้งเตือน ไม่พาไปไหน
```

- รหัสที่ล็อกอินถูกส่งต่อผ่าน `?hcode=` + `sessionStorage` → `index.html` ใช้เป็นขอบเขต (scope) แทนรหัสจาก session, `client.html` เติมช่อง "รหัสหน่วย" ให้อัตโนมัติ
- ทั้งสองหน้ามีปุ่ม **↻ เปลี่ยน รพ.** กลับมาหน้า Login

### จัดการทะเบียน รพ. (ตั้งค่าครั้งแรก)
ที่หน้า Login กด **"จัดการทะเบียน รพ."** → เพิ่มรหัส/ชื่อ/ประเภท (main/sub)/รหัสแม่ข่าย
- ครั้งแรกตารางยังไม่มี — กด **บันทึก** จะสร้าง `hospital_registry` ให้อัตโนมัติ
- การเพิ่ม/แก้/ลบ ต้องเปิดสิทธิ์เขียน (`ONLINE_ALLOW_WRITE=true` — ตั้งที่ปุ่ม ⚙ ในหน้า index)
- การ **login เป็นแบบอ่านอย่างเดียว** ทำได้แม้ไม่เปิด write

ตาราง `hospital_registry`: `hcode` (PK) · `hname` · `hos_type` ('main'/'sub') · `main_hos_code` · `note` · `updated_at`

---

## 3.6 Login ด้วย MOPH Provider ID (ทางเลือก)

ปุ่ม **"เข้าสู่ระบบด้วย Provider ID (MOPH)"** ในหน้า Login ให้บุคลากรล็อกอินด้วยบัญชี MOPH แล้ว route ตาม **ทะเบียน รพ. เดิม** (hcode จากสิทธิ์ที่สังกัด → `hospital_registry` → main/sub)

```
ปุ่ม → GET /api/auth/provider-id → redirect ไป moph.id.th
     → กลับมาที่ /login.html?code=... 
     → POST /api/auth/provider-id/exchange {code}
        (server encrypt app_id ด้วย AES-256-CBC + Bearer code → BMS proxy)
     → ได้ provider + organizations[].hcode
     → 1 แห่ง = เข้าเลย / หลายแห่ง = เลือกก่อน → resolve ผ่านทะเบียน รพ.
```

### ตั้งค่า (`.env` หรือ Environment บน Render)
| คีย์ | หมายเหตุ |
|---|---|
| `PROVIDER_ID_CLIENT_ID` | จาก BMS (มีค่าปริยายจาก collection) |
| `PROVIDER_ID_APP_ID` | **ความลับ — ขอจาก BMS** (plain text, server จะ encrypt ให้) |
| `PROVIDER_ID_SECRET_KEY` | **ความลับ — ขอจาก BMS** (AES key) |
| `PROVIDER_ID_REDIRECT_URI` | ต้อง **ตรงเป๊ะ** กับที่ลงทะเบียนกับ BMS และชี้มาที่ `/login.html` |
| `PROVIDER_ID_AUTH_URL` / `PROVIDER_ID_TOKEN_URL` | ค่าปริยายมักไม่ต้องแก้ |

> ⚠️ ต้องขอ `app_id` + `secret_key` จาก BMS และ **ลงทะเบียน `redirect_uri`** (เช่น `https://<app>.onrender.com/login.html`) ก่อน ถึงจะใช้งานได้ — ถ้ายังไม่ตั้ง ปุ่มจะขึ้น error บอกให้ตั้งค่า
> รายละเอียด flow/ข้อควรระวังดูใน `example_provider.md`

---

## 4. การเชื่อมต่อ BMS-Session (แหล่งข้อมูลหลัก)

ลำดับการเชื่อมต่อ: **URL param → cookie (7 วัน) → กรอกเอง**

```
URL ?bms-session-id=XXXX
   → hosxp.net/phapi/PasteJSON (validate)
   → ได้ apiUrl + auth key
   → GET {apiUrl}/api/sql?sql=...  (Bearer token)
```

### ตัวกรอง / คอลัมน์ในตาราง
- **ตัวกรอง:** ช่วงวันที่นัด, หน่วยบริการ (sub_hos_name), เรียงล่าสุดก่อน, ค้นหา (HN/ชื่อ/เบอร์/คลินิก)
- **คอลัมน์:** ลำดับ, เลือก, วันที่รับบริการ, วันนัดถัดไป, เวลาเริ่ม-ถึง, HN, ชื่อ, โทรศัพท์, QS Slot, ผู้นัดหมาย (รหัสแพทย์), คลินิก, ห้องตรวจ, หน่วยบริการ, Lab/X-ray, เหตุที่นัด, สถานะ
- **อื่นๆ:** เลือกทั้งหมด/ไม่เลือก, พิมพ์, Auto-refresh, การ์ดสรุป, modal รายละเอียด (โหลดที่อยู่/note/spclty/referin เพิ่มตอนกด)

### คิวรี่ (แบ่ง 2 ชั้น)
เนื่องจาก tunnel จำกัด URL ~2048 ตัวอักษร จึงแยกเป็น:
- **List query (ตาราง):** คอลัมน์เท่าที่ตารางใช้ — สั้น ~1.3K ตัวอักษร
- **Detail query (รายละเอียด):** โหลดที่อยู่ (`thaiaddress` concat), note, spclty, referin, สถานะส่งข้อความ ตอนกดปุ่ม "รายละเอียด"

ขอบเขตข้อมูล: `INNER JOIN oapp_contact oc ON oc.name = o.contact_point` (ดึง `sub_hos_name`, `sub_hos_code`)

---

## 5. ฐานกลาง Online (PostgreSQL) — แหล่งข้อมูลรอง

เบราว์เซอร์**พูด protocol ของ PostgreSQL ตรงๆ ไม่ได้** → `server.js` เป็นตัวกลาง (proxy)

### หน้าตั้งค่า
กดไอคอน **⚙** บนหัวเว็บ → กรอก Host / Port / Database / Username / Password / อนุญาตเขียน → **ทดสอบ** → **บันทึกและเชื่อมต่อ**
- รหัสผ่านเก็บใน `.env` ฝั่ง server (ไม่แสดงกลับมาบนหน้าเว็บ)
- เว้น Password ว่าง = ใช้รหัสเดิม
- บันทึกจะ**ทดสอบก่อน commit** — ถ้าต่อไม่ได้ `.env` จะไม่ถูกแก้

### API endpoints (server.js)
| Method | Path | หน้าที่ |
|---|---|---|
| GET | `/api/online/ping` | ทดสอบการเชื่อมต่อ |
| POST | `/api/online/sql` | รันคิวรี่ (อ่านอย่างเดียว เว้นแต่เปิด write) — body `{sql}` |
| GET | `/api/online/config` | อ่านค่าปัจจุบัน (ไม่ส่ง password) |
| POST | `/api/online/config` | บันทึก + เชื่อมต่อใหม่ (localhost เท่านั้น) |
| POST | `/api/online/test` | ทดสอบค่าที่กรอกโดยไม่บันทึก (localhost เท่านั้น) |
| POST | `/api/online/init` | สร้างตาราง `appointment_online` (ต้องเปิด write) |
| POST | `/api/online/appointments` | ส่ง/อัปเดตรายการนัดเข้าฐานกลาง (upsert) |
| POST | `/api/online/lab` | ส่งข้อมูล Lab (`lab_app_head/order/order_service`) เข้าฐานกลาง |
| POST | `/api/online/login` | ตรวจรหัสสถานพยาบาลจากตาราง `hospital_registry` (อ่านอย่างเดียว) — body `{hcode}` |
| GET | `/api/online/hospitals` | อ่านทะเบียน รพ. ทั้งหมด |
| POST | `/api/online/hospitals` | เพิ่ม/แก้ทะเบียน รพ. (upsert, ต้องเปิด write) |
| POST | `/api/online/hospitals/delete` | ลบทะเบียน รพ. (ต้องเปิด write) — body `{hcode}` |
| POST | `/api/online/hospitals/init` | สร้างตาราง `hospital_registry` (ต้องเปิด write) |

### ส่งข้อมูล Lab เข้าฐานกลาง (อัตโนมัติพร้อมปุ่ม ⬆ ส่งเข้าฐานกลาง)
เมื่อกดส่งนัด ระบบจะดึง `lab_app_head`, `lab_app_order`, `lab_app_order_service` จากฐานหลัก (HOSxP) ตาม `oapp_id` ที่ส่ง แล้วเก็บลงตารางปลายทาง `*_online`
- **Dynamic schema** — ไม่ทราบ schema ล่วงหน้า จึงสร้าง/เพิ่มคอลัมน์ (TEXT) ตามข้อมูลที่ได้จริง + `source_hcode` + `link_oapp_id`
- ลูก (order/service) join กับ head ผ่าน `lab_app_order_number` → ทุกแถวมี `link_oapp_id`
- ส่งซ้ำ = **ลบตาม (source_hcode, oapp_id) แล้วเขียนใหม่** (idempotent)
- `oapp_id` ถูก chunk ทีละ 50 เพื่อไม่ให้ URL เกิน 2048

### ส่งข้อมูลเข้าฐานกลาง
กดปุ่ม **⬆ ส่งเข้าฐานกลาง** บนแถบเครื่องมือ → ส่งรายการ**ที่เลือก** (หรือ**ทั้งหมด**หากไม่เลือก) เข้าตาราง `appointment_online`
- ตารางถูก**สร้างอัตโนมัติ**ครั้งแรก (`CREATE TABLE IF NOT EXISTS`)
- Insert แบบ **parameterized** (กัน SQL injection) ใน transaction เดียว
- กันข้อมูลซ้ำด้วย unique key **`(source_hcode, oapp_id)`** → ส่งซ้ำ = อัปเดตทับ (`ON CONFLICT DO UPDATE`, อัปเดต `synced_at`)
- `source_hcode` = รหัส รพ. ต้นทาง (จาก session)
- ต้องเปิด **`ONLINE_ALLOW_WRITE=true`** (ในหน้าตั้งค่า หรือ `.env`)

### ตั้งค่าผ่านไฟล์ `.env` (ทางเลือก)
```
PORT=8780
ONLINE_DB_URL=postgresql://USER:PASSWORD@HOST:5432/DATABASE
ONLINE_ALLOW_WRITE=false      # true = เปิด INSERT/UPDATE/DELETE
```

---

## 5.1 ยิงข้อมูลเข้าฐานกลางอัตโนมัติ (auto-sync — ไม่ต้องกดปุ่ม)

`sync-cli.js` + `auto-sync.bat` ทำสิ่งเดียวกับปุ่ม **"ส่งเข้าฐานกลาง"** แต่รันเองแบบ headless (ไม่เปิดเบราว์เซอร์) โดยยิงผ่าน `server.js` ตัวเดิม (ใช้ `.env` + สิทธิ์เขียน + logic upsert ชุดเดียวกัน)

### ตั้งค่าครั้งแรก
1. คัดลอก `sync.config.example.json` → **`sync.config.json`**
2. ใส่ **BMS Session ID** ลงในช่อง `bmsSessionId`
3. ต้องเปิดสิทธิ์เขียนฐานกลางไว้ก่อน (หน้า ⚙ → อนุญาตเขียน หรือ `ONLINE_ALLOW_WRITE=true`)

### รัน
- **ดับเบิลคลิก `auto-sync.bat`** → ตรวจ/สตาร์ท `server.js` ให้อัตโนมัติ แล้ววนยิงข้อมูลทุก `INTERVAL_MIN` นาที (ค่าเริ่มต้น 15) — กด **Ctrl+C** เพื่อหยุด
- รันครั้งเดียว: `node sync-cli.js`
- log บันทึกไว้ที่ `sync.log`

### ตั้งเวลาแบบไม่ต้องเปิดหน้าต่างค้าง (ทางเลือก)
ใช้ **Windows Task Scheduler** เรียก `node sync-cli.js` (working dir = โฟลเดอร์นี้) ตามรอบที่ต้องการ — แต่ต้องมั่นใจว่า `server.js` รันอยู่ (เช่นเปิดผ่าน `start.bat` ทิ้งไว้)

### ค่าใน `sync.config.json`
| คีย์ | ความหมาย | ค่าเริ่มต้น |
|---|---|---|
| `bmsSessionId` | BMS Session ID (จำเป็น) | — |
| `serverPort` | พอร์ต server.js | `8780` |
| `dateFromOffset` / `dateToOffset` | ช่วงวันนัด = วันนี้ +offset (วัน) | `0` / `7` |
| `status` | `active` (นัดที่ยังเปิด) / `closed` / `all` | `active` |
| `sortLatest` | เรียงล่าสุดก่อน | `true` |
| `syncLab` | ยิง lab_app_* ด้วยหรือไม่ | `true` |

> ⚠️ **Session ID มีอายุ** — ถ้ายิงไม่ผ่าน (`ไม่พบ API URL ใน Session`) แปลว่า Session หมดอายุ ต้องขอใหม่จาก HOSxP แล้วอัปเดต `sync.config.json`
> 🔒 `sync.config.json` ถูก `.gitignore` เพราะมี Session ID — อย่า push ขึ้น git

---

## 5.2 หน้า Client — อ่านจากฐานกลางอย่างเดียว (`client.html`)

หน้าสำหรับผู้ดู (เช่นหน่วยลูก/หน่วยแม่) ที่ **ไม่ต้องเชื่อม HOSxP / ไม่ต้องมี BMS Session** — ดึงข้อมูลจากฐานกลางล้วนๆ ผ่าน `POST /api/online/sql` (read-only)

เปิดที่: **`http://localhost:8780/client.html`** (เสิร์ฟผ่าน server.js เดิม)

- อ่านตาราง `appointment_online` (+ `lab_app_*_online` ในหน้ารายละเอียด)
- **ตัวกรอง:** ช่วงวันที่นัด, **รหัสหน่วย 5 หลัก** (แม่=เห็นทุกลูก / ลูก=เฉพาะตน — `main_hos_code OR sub_hos_code`), หน่วยบริการ (sub_hos), รพ.ต้นทาง (source_hcode), ค้นหา (HN/CID/ชื่อ/เบอร์/คลินิก)
- แสดง CID, หน่วยบริการ, รพ.ต้นทาง, เวลาซิงค์ (แปลงเป็นเวลาไทย) และ modal รายละเอียด + รายการ Lab จากฐานกลาง
- DATE cast เป็น text ใน SQL เพื่อกันวันเพี้ยนจาก timezone

---

## 6. ข้อจำกัด/ข้อควรรู้ (พบจากการทดสอบจริง)

1. **URL ≤ 2048 ตัวอักษร** — tunnel nginx ตอบ 404 ถ้า URL ยาวเกิน (ตัวอักษรไทยใน SQL กิน ~9 ตัว/ตัวอักษร) → จึงแยกคิวรี่ list/detail
2. **ตาราง `opduser` ถูกบล็อก** — API ตอบ `SQL Validation Failed` (เก็บ login/รหัสผ่าน) → คอลัมน์ "ผู้ออกใบนัด" ใช้ไม่ได้, "ผู้นัดหมาย" แสดงรหัสแพทย์แทนชื่อ
3. **ชื่อผู้ป่วย/แพทย์ภาษาไทยเพี้ยน** — ฟิลด์ชื่อจาก API ออกมาสลับอักขระ (ตารางอ้างอิงคลินิก/ห้อง/หน่วยบริการปกติดี) — ข้อสังเกตที่ต้องยืนยันกับฐานข้อมูลจริง
4. **ฐานกลาง host `*.svc.cluster.local`** — เป็นชื่อภายใน Kubernetes:
   - รันในคลัสเตอร์ → ใช้ host เดิมได้
   - รันบน PC → ทำ port-forward ก่อน:
     ```
     kubectl -n shared-databases port-forward service/postgres 5432:5432
     ```
     แล้วตั้ง Host = `127.0.0.1` ในหน้าตั้งค่า

---

## 7. ความปลอดภัย

- รหัสผ่านฐานกลางอยู่ใน `.env` เท่านั้น (ถูก `.gitignore` — ไม่ push ขึ้น git, ไม่อยู่ใน HTML)
- `GET /.env` ถูกบล็อก (403)
- แก้ไข config (`/config`, `/test`) ได้จาก **localhost เท่านั้น**
- ฐานกลางเป็น **read-only** โดยปริยาย (เฉพาะ SELECT/WITH) จนกว่าจะเปิด `ONLINE_ALLOW_WRITE=true`
- ⚠️ หากรหัสผ่านเคยถูกพิมพ์/แชร์ ควรพิจารณาเปลี่ยนรหัส

---

## 8. แก้ปัญหาเบื้องต้น (Troubleshooting)

| อาการ | สาเหตุ / วิธีแก้ |
|---|---|
| `api/online/config` → **404**, `test` → **405** | server.js เวอร์ชันเก่ายังรันอยู่ → **Ctrl+C แล้วรัน start.bat ใหม่** + Ctrl+F5 |
| `api/online/ping` → **502** | ต่อ DB ไม่ได้ (host cluster เข้าไม่ถึง) → ทำ port-forward, ตั้ง Host `127.0.0.1` |
| `เรียก backend ไม่ได้` | เปิดหน้าเว็บผ่าน `start.bat` ไม่ใช่ไฟล์ตรงๆ |
| query ตาราง 404 | SQL ยาวเกิน 2048 — แยกคอลัมน์ไป detail |
| `SQL Validation Failed` | แตะตารางต้องห้าม (เช่น opduser) |
| หน้าเว็บไม่อัปเดต | กด **Ctrl+F5** ล้าง cache |

---

## 9. ความต้องการระบบ

- **Node.js ≥ 18** (สำหรับ server.js + ฐานกลาง)
- เบราว์เซอร์สมัยใหม่ (Chrome/Edge)
- เข้าถึง `hosxp.net` (BMS-Session) และฐานกลาง PostgreSQL (ตามที่ deploy)
