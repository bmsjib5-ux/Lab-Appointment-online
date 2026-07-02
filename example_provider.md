# Provider ID Integration Guide

คู่มือสำหรับ dev ที่ต้องการเชื่อม **MOPH Provider ID** (กระทรวงสาธารณสุข) ผ่าน BMS Authen Proxy
เพื่อให้บุคลากรทางการแพทย์ (แพทย์/พยาบาล/เภสัช) login เข้าระบบ

อ้างอิงจาก implementation จริงในโปรเจกต์นี้: [backend/src/routes/authProviderId.ts](backend/src/routes/authProviderId.ts) และ [apps/web/src/app/callback/page.tsx](apps/web/src/app/callback/page.tsx)

---

## 1. ภาพรวม Flow

```
[Browser]                   [MOPH]                  [Your Backend]              [BMS Proxy]
   |                          |                          |                          |
   | 1. คลิกปุ่ม Provider ID  |                          |                          |
   |------------------------->| (redirect MOPH login)    |                          |
   |                          |                          |                          |
   |   2. login เสร็จ → redirect กลับ ?code=xxx          |                          |
   |<-------------------------|                          |                          |
   |                          |                          |                          |
   | 3. POST /auth/provider-id/exchange { code }         |                          |
   |---------------------------------------------------->|                          |
   |                          |                          |                          |
   |                          |     4. encrypt(app_id) + Bearer code                |
   |                          |                          |------------------------->|
   |                          |                          |                          |
   |                          |                          |   5. {moph_account, provider_staff}
   |                          |                          |<-------------------------|
   |                          |                          |                          |
   |   6. {token, user, organizations}                   |                          |
   |<----------------------------------------------------|                          |
   |                          |                          |                          |
   | 7. เลือก hospital (ถ้ามีหลายแห่ง) → เข้าระบบ        |                          |
```

**สรุปขั้นตอนสั้น ๆ**

1. Frontend redirect ไป `https://moph.id.th/oauth/redirect?...`
2. MOPH redirect กลับมาที่ `redirect_uri` ของเรา พร้อม `?code=<jwt-like-string>`
3. Frontend ส่ง `code` ให้ backend
4. Backend encrypt `app_id` ด้วย AES-256-CBC แล้วยิงไปที่ BMS Proxy พร้อม Bearer `code`
5. BMS Proxy ส่งข้อมูลแพทย์ + รายชื่อสถานพยาบาลที่สังกัดกลับมา
6. Backend ออก JWT ของตัวเอง → frontend เก็บ token + ให้แพทย์เลือกโรงพยาบาล

---

## 2. ของที่ต้องขอจาก BMS ก่อน

ติดต่อทีม BMS เพื่อขอ:

| ค่า | ใช้ทำอะไร |
|---|---|
| `client_id` | ส่งใน URL ที่ redirect ไป MOPH |
| `app_id` | plain text — backend จะเอามา encrypt ก่อนส่ง BMS proxy |
| `secret_key` | AES key (32 bytes — ระบบจะ pad ให้ถ้าสั้นกว่า) |
| `redirect_uri` ที่ลงทะเบียนไว้ | **ต้องตรงเป๊ะ** ทั้งฝั่ง MOPH และตอนยิงไป BMS proxy |

> ⚠️ `redirect_uri` ที่ส่งให้ MOPH ตอนเริ่ม flow **ต้องเหมือนกับ** ตอนแลก token กับ BMS เป๊ะ ๆ
> ถ้าไม่ตรง BMS จะ reject ทันที (เคยเจอ bug นี้ — ลบ trailing slash ออกก็ใช้ได้แล้ว)

---

## 3. Environment Variables

```bash
# .env
PROVIDER_ID_CLIENT_ID=<จาก BMS>
PROVIDER_ID_APP_ID=<plain text app_id>
PROVIDER_ID_SECRET_KEY=<AES key>
PROVIDER_ID_REDIRECT_URI=http://localhost:3001/callback
PROVIDER_ID_AUTH_URL=https://moph.id.th/oauth/redirect
PROVIDER_ID_TOKEN_URL=https://bms-authen-provider.bmscloud.in.th/api/v1/auth/provider-id
```

---

## 4. Backend Code

### 4.1 AES-256-CBC Encryption Helper

`backend/src/lib/providerIdCrypto.ts`

```ts
import crypto from 'crypto';

/**
 * AES-256-CBC + random IV, return base64(IV ‖ ciphertext)
 * ต้อง match กับฝั่ง BMS proxy ที่ใช้ Dart `encryptAESWithIV`
 */
export function encryptAESWithIV(plaintext: string, key: string): string {
  // pad key เป็น 32 bytes (AES-256)
  const keyBytes = Buffer.from(key.padEnd(32, '0'), 'utf8').slice(0, 32);
  const iv = crypto.randomBytes(16);

  const cipher = crypto.createCipheriv('aes-256-cbc', keyBytes, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);

  return Buffer.concat([iv, encrypted]).toString('base64');
}
```

### 4.2 Redirect Endpoint (เริ่ม flow)

```ts
// GET /api/auth/provider-id  →  redirect ไป MOPH
router.get('/provider-id', (_req, res) => {
  const state = crypto.randomBytes(16).toString('hex');
  const redirectUri = process.env.PROVIDER_ID_REDIRECT_URI!;

  const url = `${process.env.PROVIDER_ID_AUTH_URL}` +
    `?response_type=code` +
    `&client_id=${process.env.PROVIDER_ID_CLIENT_ID}` +
    `&redirect_uri=${encodeURIComponent(redirectUri)}` +
    `&scope=ProviderID` +
    `&state=${state}`;

  res.redirect(url);
});
```

### 4.3 Exchange Endpoint (แลก code → user info)

```ts
import axios from 'axios';
import { encryptAESWithIV } from '../lib/providerIdCrypto';

// กัน double-fire จาก React strict mode / browser refresh
const usedCodes = new Set<string>();

router.post('/provider-id/exchange', async (req, res) => {
  try {
    const { code } = req.body;
    if (!code || code.length < 100) {
      return res.status(400).json({ message: 'Invalid code' });
    }

    const codeKey = code.substring(0, 50);
    if (usedCodes.has(codeKey)) {
      return res.status(409).json({ message: 'Code already used' });
    }
    usedCodes.add(codeKey);
    setTimeout(() => usedCodes.delete(codeKey), 5 * 60 * 1000);

    // 1) encrypt app_id
    const encryptedAppId = encryptAESWithIV(
      process.env.PROVIDER_ID_APP_ID!,
      process.env.PROVIDER_ID_SECRET_KEY!
    );

    // 2) ยิงไป BMS proxy
    //    - app_id + redirect_uri อยู่ใน body
    //    - code ใส่ใน Authorization: Bearer <code>
    //    - redirect_uri ต้องตรงกับที่ส่งให้ MOPH ตอนเริ่ม flow เป๊ะ
    const bmsRes = await axios.post(
      process.env.PROVIDER_ID_TOKEN_URL!,
      {
        app_id: encryptedAppId,
        redirect_uri: process.env.PROVIDER_ID_REDIRECT_URI!,
      },
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${code}`,
        },
        timeout: 15000,
      }
    );

    const data = bmsRes.data;

    // 3) ดึงข้อมูลจาก response
    const account = data.moph_account?.data || {};
    const staff = data.provider_staff?.data || {};
    const organizations = staff.organization || [];

    const providerId = staff.provider_id || '';
    const fullName = `${account.account_title_th || ''} ${
      account.first_name_th || staff.firstname_th || ''
    } ${account.last_name_th || staff.lastname_th || ''}`.trim();

    // 4) ดึง position จาก JWT ที่อยู่ใน org.moph_access_token_idp
    //    เพื่อเช็คว่าเป็นแพทย์จริง (provider_position_std_id === 1)
    let positionStdId: number | null = null;
    for (const org of organizations) {
      if (!org.moph_access_token_idp) continue;
      const parts = org.moph_access_token_idp.split('.');
      if (!parts[1]) continue;
      const decoded = JSON.parse(Buffer.from(parts[1], 'base64').toString('utf8'));
      const client = decoded.client || decoded;
      if (client.provider_position_std_id !== undefined) {
        positionStdId = client.provider_position_std_id;
        break;
      }
    }

    if (positionStdId !== null && positionStdId !== 1) {
      return res.status(403).json({
        message: 'คุณไม่ใช่แพทย์ — ไม่สามารถเข้าใช้ระบบนี้ได้',
      });
    }

    // 5) find or create user ใน DB ของเรา + ออก JWT
    //    (โค้ดส่วนนี้ขึ้นกับ schema ของแต่ละโปรเจกต์)
    //    ...

    return res.json({
      token: '<your JWT here>',
      user: { providerId, name: fullName, /* ... */ },
      organizations: organizations.map((o: any) => ({
        hcode: o.hcode,
        hname: o.hname_th || o.hname_eng,
        position: o.position,
      })),
    });
  } catch (err: any) {
    console.error('Provider ID exchange failed:',
      err.response?.status, err.response?.data || err.message);
    return res.status(500).json({
      message: 'Provider ID login failed',
      reason: err.response?.data?.message || err.message,
    });
  }
});
```

---

## 5. Frontend Code

### 5.1 ปุ่มเริ่ม login

```tsx
<button
  onClick={() => {
    window.location.href = '/api/auth/provider-id';
  }}
>
  เข้าสู่ระบบด้วย Provider ID
</button>
```

### 5.2 Callback page (รับ `?code=...` กลับมา)

`apps/web/src/app/callback/page.tsx` (ตัวอย่างย่อ)

```tsx
'use client';
import { useEffect, useRef } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';

export default function Callback() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const called = useRef(false);

  useEffect(() => {
    if (called.current) return;
    const code = searchParams.get('code');
    if (!code || code.length < 100) return;
    called.current = true; // กัน double-fire จาก strict mode

    (async () => {
      const res = await fetch('/api/auth/provider-id/exchange', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ code }),
      });
      const data = await res.json();
      if (!res.ok) {
        alert(data.message);
        return;
      }

      localStorage.setItem('token', data.token);
      localStorage.setItem('user', JSON.stringify(data.user));

      // ถ้าแพทย์สังกัดหลายโรงพยาบาล → ให้เลือกก่อน
      if (data.organizations.length > 1) {
        sessionStorage.setItem('orgs', JSON.stringify(data.organizations));
        router.push('/select-hospital');
      } else {
        router.push('/doctor');
      }
    })();
  }, [searchParams, router]);

  return <div>กำลังยืนยันตัวตน...</div>;
}
```

---

## 6. รูปร่าง Response จาก BMS Proxy

```jsonc
{
  "moph_account": {
    "data": {
      "first_name_th": "สมชาย",
      "last_name_th": "ใจดี",
      "account_title_th": "นายแพทย์",
      "gender_eng": "MALE",         // upper case — ต้อง toLowerCase ก่อน
      "birth_date": "01/05/1985",   // dd/mm/yyyy
      "mobile_number": "0812345678",
      "email": "doc@example.com",
      "cid": "1234567890123"        // อาจอยู่ใน field ชื่ออื่น เช่น citizen_id, id_card_number
    }
  },
  "provider_staff": {
    "data": {
      "provider_id": "PRV0001",
      "firstname_th": "สมชาย",
      "lastname_th": "ใจดี",
      "organization": [
        {
          "hcode": "10670",
          "hname_th": "โรงพยาบาลตัวอย่าง",
          "position": "แพทย์",
          "moph_access_token_idp": "eyJ...",  // JWT — decode payload แล้วเอา provider_position_std_id
          "address": { "province": "กรุงเทพ" }
        }
      ]
    }
  }
}
```

---

## 7. ข้อควรระวัง (เก็บมาจากของจริง)

1. **`redirect_uri` ต้องตรงเป๊ะ** ทั้งตอน redirect ไป MOPH และตอนแลก code กับ BMS proxy — รวมถึง trailing slash, http vs https, port
2. **Code ใช้ได้ครั้งเดียว** — เก็บ `usedCodes` set ไว้กัน React strict mode / browser refresh ยิงซ้ำ
3. **กัน double-fire ฝั่ง frontend** ด้วย `useRef` เพราะ `useEffect` ใน dev mode รันสองรอบ
4. **CID อาจมาในชื่อ field ต่างกัน** — ลอง `account.cid`, `account.citizen_id`, `account.id_card_number`, `staff.cid` แล้ว validate ให้เป็นตัวเลข 13 หลักก่อนใช้
5. **`gender_eng` เป็นตัวพิมพ์ใหญ่** — `"MALE"` / `"FEMALE"` ต้อง `.toLowerCase()` ก่อน save ถ้า schema enum เป็นตัวเล็ก
6. **ตำแหน่งงานอยู่ใน JWT ที่ฝังใน org** — `org.moph_access_token_idp` เป็น JWT, decode payload (`parts[1]`) แล้วดู `client.provider_position_std_id`:
   - `1` = แพทย์
   - อื่น ๆ = ไม่ใช่แพทย์ (เภสัช/พยาบาล/ทันตแพทย์ ฯลฯ)
7. **แพทย์อาจสังกัดหลายโรงพยาบาล** — ต้องมีหน้าให้เลือกก่อนเข้าระบบ (กรณีมี > 1 org)
8. **อย่า `console.log` code/secret ใน production** — log แค่ length หรือ first 12 chars พอ
9. **Log ทุก failure ลง audit log** เพราะปัญหา Provider ID มักเกิดจากการตั้ง env ผิด — ใส่ envCheck ใน response error เพื่อ debug ง่าย

---

## 8. Debug Checklist

ถ้าแลก code ไม่ผ่าน เช็คตามนี้:

- [ ] `PROVIDER_ID_APP_ID`, `PROVIDER_ID_SECRET_KEY`, `PROVIDER_ID_REDIRECT_URI` มีค่าครบ
- [ ] `redirect_uri` ในตอน redirect ไป MOPH **เหมือนเป๊ะ** กับ body ตอนยิง BMS
- [ ] `redirect_uri` นี้ลงทะเบียนไว้กับ BMS แล้ว
- [ ] `code` จาก URL ยาว > 100 chars (ถ้าสั้นแสดงว่ามาผิดที่)
- [ ] ไม่ได้ใช้ code ซ้ำ (รีเฟรชหน้า callback = code หมดอายุ)
- [ ] เวลาบนเครื่อง backend ถูกต้อง (JWT มี exp)
- [ ] response status จาก BMS — 401/403 มัก = key/uri ผิด, 5xx = ปัญหาฝั่ง BMS

---

## 9. ไฟล์ที่เกี่ยวข้องในโปรเจกต์นี้

- [backend/src/routes/authProviderId.ts](backend/src/routes/authProviderId.ts) — endpoint redirect + exchange
- [backend/src/lib/providerIdCrypto.ts](backend/src/lib/providerIdCrypto.ts) — AES helper
- [apps/web/src/app/callback/page.tsx](apps/web/src/app/callback/page.tsx) — callback handler + hospital picker
- [apps/web/src/app/page.tsx](apps/web/src/app/page.tsx) — login page (ปุ่ม Provider ID)
- [.env.example](.env.example) — รายการ env vars
