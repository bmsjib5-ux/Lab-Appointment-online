// ============================================================================
//  BMS Appointment - local server
//  • Serves the static index.html (so cookies + fetch work over http://localhost)
//  • Proxies SQL queries to the central online PostgreSQL DB (lab_app_online)
//    -> a browser cannot speak the Postgres wire protocol, so this backend does it.
//  • Lets the settings page read/update the connection (.env) from localhost only.
//
//  Config comes from .env (NOT committed). See .env.example.
//  Run:  node server.js     (or just double-click start.bat)
// ============================================================================
const http = require('http');
const fs = require('fs');
const path = require('path');

const ENV_PATH = path.join(__dirname, '.env');

// ---- Minimal .env loader (no extra dependency) ----
function loadEnvFile() {
  const out = {};
  try {
    if (!fs.existsSync(ENV_PATH)) return out;
    for (const line of fs.readFileSync(ENV_PATH, 'utf8').split(/\r?\n/)) {
      if (!line.trim() || line.trim().startsWith('#')) continue;
      const m = line.match(/^\s*([\w.]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      out[m[1]] = v;
    }
  } catch (e) { console.error('[env] load error:', e.message); }
  return out;
}

function writeEnvFile(cfg) {
  const content =
`# Central online PostgreSQL (lab_app_online) - DO NOT COMMIT THIS FILE (.gitignore'd)
PORT=${cfg.PORT || 8780}
ONLINE_DB_URL=${cfg.ONLINE_DB_URL || ''}

# Set to true ONLY if you intentionally allow INSERT/UPDATE/DELETE via /api/online/sql.
# Default is read-only (SELECT/WITH only) for safety.
ONLINE_ALLOW_WRITE=${cfg.ONLINE_ALLOW_WRITE || 'false'}
`;
  fs.writeFileSync(ENV_PATH, content, 'utf8');
}

// ---- Connection URL <-> parts ----
function parseDbUrl(url) {
  try {
    if (!url) return { host: '', port: '5432', database: '', username: '', password: '' };
    const u = new URL(url);
    return {
      host: u.hostname || '',
      port: u.port || '5432',
      database: decodeURIComponent((u.pathname || '').replace(/^\//, '')),
      username: decodeURIComponent(u.username || ''),
      password: decodeURIComponent(u.password || ''),
    };
  } catch { return { host: '', port: '5432', database: '', username: '', password: '' }; }
}
function buildDbUrl(p) {
  const enc = encodeURIComponent;
  const auth = `${enc(p.username || '')}:${enc(p.password || '')}`;
  return `postgresql://${auth}@${p.host || ''}:${p.port || '5432'}/${enc(p.database || '')}`;
}

// ---- Runtime state ----
const env = loadEnvFile();
const state = {
  PORT: process.env.PORT || env.PORT || 8780,
  dbUrl: process.env.ONLINE_DB_URL || env.ONLINE_DB_URL || process.env.DATABASE_URL || '',
  allowWrite: String(process.env.ONLINE_ALLOW_WRITE || env.ONLINE_ALLOW_WRITE || '').toLowerCase() === 'true',
  pool: null,
};

let Pool = null;
try { ({ Pool } = require('pg')); }
catch (e) { console.error('[pg] module not installed - run "npm install". Online DB disabled.'); }

function rebuildPool() {
  if (state.pool) { try { state.pool.end(); } catch {} state.pool = null; }
  if (!Pool || !state.dbUrl) return;
  state.pool = new Pool({
    connectionString: state.dbUrl,
    max: 5, idleTimeoutMillis: 30000, connectionTimeoutMillis: 10000,
  });
  state.pool.on('error', (e) => console.error('[pg] idle client error:', e.message));
}
rebuildPool();
if (!state.dbUrl) console.warn('[warn] ONLINE_DB_URL not set - configure it on the settings page.');

const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.png': 'image/png', '.jpg': 'image/jpeg',
};

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function isLocal(req) {
  const a = req.socket.remoteAddress || '';
  return a === '127.0.0.1' || a === '::1' || a === '::ffff:127.0.0.1';
}
function readBody(req) {
  return new Promise((resolve) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 200000) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(b || '{}')); } catch { resolve(null); } });
  });
}

// Reject anything that isn't a single read-only statement (unless write is allowed).
function isReadOnly(sql) {
  let s = sql.replace(/--.*$/gm, ' ').replace(/\/\*[\s\S]*?\*\//g, ' ').trim().replace(/;\s*$/, '');
  if (!s || s.includes(';')) return false;
  const low = s.toLowerCase();
  if (!/^(select|with|explain|show)\b/.test(low)) return false;
  return !/\b(insert|update|delete|drop|truncate|alter|create|grant|revoke|copy|merge)\b/.test(low);
}

async function pingPool(pool, allowWrite) {
  const r = await pool.query('SELECT current_database() AS db, current_user AS usr, version() AS version, now() AS server_time');
  return { MessageCode: 200, Message: 'OK', writable: !!allowWrite, data: r.rows[0] };
}

// ---- Handlers ----
async function handleSql(req, res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const sql = String(body.sql || '').trim();
  if (!sql) return sendJson(res, 400, { MessageCode: 400, Message: 'Empty sql' });
  if (!state.allowWrite && !isReadOnly(sql)) {
    return sendJson(res, 403, { MessageCode: 403, Message: 'Read-only mode: only a single SELECT/WITH is allowed' });
  }
  try {
    const t0 = Date.now();
    const r = await state.pool.query(sql);
    sendJson(res, 200, { MessageCode: 200, Message: 'OK', elapsed: Date.now() - t0, record_count: r.rowCount, data: r.rows });
  } catch (e) {
    sendJson(res, 400, { MessageCode: 400, Message: e.message });
  }
}

async function handlePing(res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  try { sendJson(res, 200, await pingPool(state.pool, state.allowWrite)); }
  catch (e) { sendJson(res, 502, { MessageCode: 502, Message: e.message }); }
}

// GET config - never returns the password (only whether one is set)
function handleGetConfig(res) {
  const p = parseDbUrl(state.dbUrl);
  sendJson(res, 200, {
    MessageCode: 200,
    data: {
      host: p.host, port: p.port, database: p.database, username: p.username,
      hasPassword: !!p.password, allowWrite: state.allowWrite, configured: !!state.dbUrl,
    },
  });
}

// POST config - save to .env, rebuild pool, ping. Password optional (blank = keep current).
async function handleSetConfig(req, res) {
  if (!isLocal(req)) return sendJson(res, 403, { MessageCode: 403, Message: 'แก้ไขค่าได้จากเครื่อง localhost เท่านั้น' });
  if (!Pool) return sendJson(res, 503, { MessageCode: 503, Message: 'pg module not installed - run npm install' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });

  const cur = parseDbUrl(state.dbUrl);
  const parts = {
    host: (body.host ?? cur.host).trim(),
    port: String(body.port ?? cur.port).trim() || '5432',
    database: (body.database ?? cur.database).trim(),
    username: (body.username ?? cur.username).trim(),
    // blank password => keep current
    password: (body.password != null && body.password !== '') ? body.password : cur.password,
  };
  if (!parts.host || !parts.database || !parts.username) {
    return sendJson(res, 400, { MessageCode: 400, Message: 'กรุณากรอก host, database และ username' });
  }
  const allowWrite = body.allowWrite === true || String(body.allowWrite).toLowerCase() === 'true';
  const newUrl = buildDbUrl(parts);

  // Test the new settings on a throwaway pool before committing.
  const test = new Pool({ connectionString: newUrl, max: 1, connectionTimeoutMillis: 10000 });
  try {
    const ping = await pingPool(test, allowWrite);
    try { await test.end(); } catch {}
    // Commit: persist + activate
    state.dbUrl = newUrl; state.allowWrite = allowWrite;
    writeEnvFile({ PORT: state.PORT, ONLINE_DB_URL: newUrl, ONLINE_ALLOW_WRITE: String(allowWrite) });
    rebuildPool();
    sendJson(res, 200, { MessageCode: 200, Message: 'บันทึกและเชื่อมต่อสำเร็จ', ...ping });
  } catch (e) {
    try { await test.end(); } catch {}
    sendJson(res, 502, { MessageCode: 502, Message: 'เชื่อมต่อไม่สำเร็จ: ' + e.message });
  }
}

// POST test - test given settings WITHOUT saving
async function handleTestConfig(req, res) {
  if (!isLocal(req)) return sendJson(res, 403, { MessageCode: 403, Message: 'ทดสอบได้จากเครื่อง localhost เท่านั้น' });
  if (!Pool) return sendJson(res, 503, { MessageCode: 503, Message: 'pg module not installed - run npm install' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const cur = parseDbUrl(state.dbUrl);
  const parts = {
    host: (body.host ?? cur.host).trim(),
    port: String(body.port ?? cur.port).trim() || '5432',
    database: (body.database ?? cur.database).trim(),
    username: (body.username ?? cur.username).trim(),
    password: (body.password != null && body.password !== '') ? body.password : cur.password,
  };
  if (!parts.host || !parts.database || !parts.username) {
    return sendJson(res, 400, { MessageCode: 400, Message: 'กรุณากรอก host, database และ username' });
  }
  const test = new Pool({ connectionString: buildDbUrl(parts), max: 1, connectionTimeoutMillis: 10000 });
  try {
    const ping = await pingPool(test, body.allowWrite === true);
    try { await test.end(); } catch {}
    sendJson(res, 200, { MessageCode: 200, Message: 'เชื่อมต่อสำเร็จ', ...ping });
  } catch (e) {
    try { await test.end(); } catch {}
    sendJson(res, 502, { MessageCode: 502, Message: e.message });
  }
}

// ---- Central appointment table (auto-created on first sync) ----
const APPT_COLS = [
  'source_hcode', 'oapp_id', 'hn', 'cid', 'ptname', 'vstdate', 'nextdate', 'nexttime', 'nexttime_end',
  'doctor', 'clinic', 'clinic_name', 'depcode', 'department', 'app_cause', 'oapp_status_id',
  'oapp_status_name', 'mobile_phone_number', 'queue_slot_number', 'lab_list_text', 'xray_list_text',
  'visit_vn', 'sub_hos_name', 'sub_hos_code', 'main_hos_code',
];
const CREATE_APPT_TABLE = `
CREATE TABLE IF NOT EXISTS appointment_online (
  id                  BIGSERIAL PRIMARY KEY,
  source_hcode        VARCHAR(10)  NOT NULL,
  oapp_id             VARCHAR(40)  NOT NULL,
  hn                  VARCHAR(20),
  cid                 VARCHAR(20),
  ptname              VARCHAR(250),
  vstdate             DATE,
  nextdate            DATE,
  nexttime            VARCHAR(10),
  nexttime_end        VARCHAR(10),
  doctor              VARCHAR(20),
  clinic              VARCHAR(20),
  clinic_name         VARCHAR(200),
  depcode             VARCHAR(20),
  department          VARCHAR(200),
  app_cause           VARCHAR(500),
  oapp_status_id      INTEGER,
  oapp_status_name    VARCHAR(100),
  mobile_phone_number VARCHAR(30),
  queue_slot_number   VARCHAR(30),
  lab_list_text       TEXT,
  xray_list_text      TEXT,
  visit_vn            VARCHAR(20),
  sub_hos_name        VARCHAR(200),
  sub_hos_code        VARCHAR(80),
  main_hos_code       VARCHAR(20),
  synced_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT uq_appointment_online UNIQUE (source_hcode, oapp_id)
);`;

// Migrations for tables created by an earlier version (ADD COLUMN IF NOT EXISTS is idempotent)
const MIGRATE_APPT = [
  'ALTER TABLE appointment_online ADD COLUMN IF NOT EXISTS main_hos_code VARCHAR(20)',
  'ALTER TABLE appointment_online ADD COLUMN IF NOT EXISTS cid VARCHAR(20)',
];
async function ensureApptSchema(db) {
  await db.query(CREATE_APPT_TABLE);
  for (const stmt of MIGRATE_APPT) await db.query(stmt);
}

function normVal(col, v) {
  if (col === 'vstdate' || col === 'nextdate') {
    const s = String(v ?? '').slice(0, 10);
    return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null;
  }
  if (col === 'oapp_status_id') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : null;
  }
  return (v === '' || v == null) ? null : String(v);
}

async function handleInitTable(res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  if (!state.allowWrite) return sendJson(res, 403, { MessageCode: 403, Message: 'ต้องเปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ก่อน' });
  try {
    await ensureApptSchema(state.pool);
    sendJson(res, 200, { MessageCode: 200, Message: 'สร้าง/ตรวจสอบตาราง appointment_online แล้ว', table: 'appointment_online' });
  } catch (e) { sendJson(res, 400, { MessageCode: 400, Message: e.message }); }
}

async function handleSyncAppointments(req, res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  if (!state.allowWrite) return sendJson(res, 403, { MessageCode: 403, Message: 'ต้องเปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ในหน้าตั้งค่าก่อน' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const sourceHcode = String(body.source_hcode || '').trim() || 'UNKNOWN';
  const rows = Array.isArray(body.rows) ? body.rows : [];
  if (!rows.length) return sendJson(res, 400, { MessageCode: 400, Message: 'ไม่มีข้อมูลให้ส่ง' });

  const updateCols = APPT_COLS.filter((c) => c !== 'source_hcode' && c !== 'oapp_id');
  const placeholders = APPT_COLS.map((_, i) => '$' + (i + 1)).join(',');
  const setClause = updateCols.map((c) => `${c}=EXCLUDED.${c}`).join(', ') + ', synced_at=now()';
  const upsertSql =
    `INSERT INTO appointment_online (${APPT_COLS.join(',')}) VALUES (${placeholders})
     ON CONFLICT (source_hcode, oapp_id) DO UPDATE SET ${setClause}`;

  const client = await state.pool.connect();
  let saved = 0, skipped = 0;
  try {
    await client.query('BEGIN');
    await ensureApptSchema(client);
    for (const r of rows) {
      const row = { ...r, source_hcode: sourceHcode };
      if (row.oapp_id == null || String(row.oapp_id).trim() === '') { skipped++; continue; }
      await client.query(upsertSql, APPT_COLS.map((c) => normVal(c, row[c])));
      saved++;
    }
    await client.query('COMMIT');
    sendJson(res, 200, { MessageCode: 200, Message: 'OK', saved, skipped, table: 'appointment_online' });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    sendJson(res, 400, { MessageCode: 400, Message: e.message });
  } finally {
    client.release();
  }
}

// ---- Lab appointment tables (dynamic schema, keyed by oapp_id) ----
// Schema of lab_app_head / lab_app_order / lab_app_order_service is not known ahead
// of time, so target tables are created/extended from the columns actually received.
// Every row carries source_hcode + link_oapp_id so re-sync can replace by oapp scope.
const LAB_TABLES = ['lab_app_head', 'lab_app_order', 'lab_app_order_service'];

function sqlIdent(name) {
  const clean = String(name).replace(/[^a-zA-Z0-9_]/g, '').slice(0, 63);
  if (!clean) throw new Error('invalid identifier: ' + name);
  return '"' + clean + '"';
}

async function syncGenericTable(db, baseName, sourceHcode, rows, scopeOappIds) {
  const target = sqlIdent(baseName + '_online');
  // base table (always has these three)
  await db.query(`CREATE TABLE IF NOT EXISTS ${target} (
    source_hcode TEXT NOT NULL,
    link_oapp_id TEXT,
    synced_at TIMESTAMPTZ NOT NULL DEFAULT now()
  )`);
  // discover data columns from incoming rows and add any that are missing (all TEXT)
  const dataCols = [];
  const seen = new Set(['source_hcode', 'synced_at']);
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (seen.has(k)) continue;
      seen.add(k); dataCols.push(k);
    }
  }
  for (const c of dataCols) {
    if (c === 'link_oapp_id') continue;
    await db.query(`ALTER TABLE ${target} ADD COLUMN IF NOT EXISTS ${sqlIdent(c)} TEXT`);
  }
  // replace existing rows for this hospital + these oapp_ids (idempotent re-sync)
  if (scopeOappIds && scopeOappIds.length) {
    await db.query(`DELETE FROM ${target} WHERE source_hcode = $1 AND link_oapp_id = ANY($2::text[])`,
      [sourceHcode, scopeOappIds.map(String)]);
  }
  // insert
  const insertCols = ['source_hcode', ...dataCols.filter((c) => c !== 'source_hcode')];
  if (!insertCols.includes('link_oapp_id')) insertCols.push('link_oapp_id');
  const colSql = insertCols.map(sqlIdent).join(',');
  const phSql = insertCols.map((_, i) => '$' + (i + 1)).join(',');
  const insertSql = `INSERT INTO ${target} (${colSql}) VALUES (${phSql})`;
  let count = 0;
  for (const r of rows) {
    const vals = insertCols.map((c) => c === 'source_hcode' ? sourceHcode : (r[c] == null || r[c] === '' ? null : String(r[c])));
    await db.query(insertSql, vals);
    count++;
  }
  return count;
}

async function handleSyncLab(req, res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  if (!state.allowWrite) return sendJson(res, 403, { MessageCode: 403, Message: 'ต้องเปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ก่อน' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const sourceHcode = String(body.source_hcode || '').trim() || 'UNKNOWN';
  const scopeOappIds = Array.isArray(body.oapp_ids) ? body.oapp_ids : [];
  const tables = body.tables || {};

  const client = await state.pool.connect();
  const saved = {};
  try {
    await client.query('BEGIN');
    for (const name of LAB_TABLES) {
      const rows = Array.isArray(tables[name]) ? tables[name] : [];
      saved[name] = await syncGenericTable(client, name, sourceHcode, rows, scopeOappIds);
    }
    await client.query('COMMIT');
    sendJson(res, 200, { MessageCode: 200, Message: 'OK', saved });
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    sendJson(res, 400, { MessageCode: 400, Message: e.message });
  } finally {
    client.release();
  }
}

// ---- Hospital registry (login routing: main -> index, sub -> client) ----
// A small lookup table in the central DB. The login page enters a hospital code;
// its hos_type decides which screen to open.
const CREATE_HOSPITAL_TABLE = `
CREATE TABLE IF NOT EXISTS hospital_registry (
  hcode          VARCHAR(15) PRIMARY KEY,
  hname          VARCHAR(250),
  hos_type       VARCHAR(10)  NOT NULL DEFAULT 'sub',   -- 'main' | 'sub'
  main_hos_code  VARCHAR(15),
  note           VARCHAR(300),
  updated_at     TIMESTAMPTZ  NOT NULL DEFAULT now()
);`;
async function ensureHospitalSchema(db) { await db.query(CREATE_HOSPITAL_TABLE); }

function normHcode(v) { return String(v ?? '').trim(); }

// POST /api/online/login  { hcode } -> { found, data:{ hcode, hname, hos_type, main_hos_code } }
// Read-only: works even when write is disabled, so any unit can log in.
async function handleLogin(req, res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const hcode = normHcode(body.hcode);
  if (!hcode) return sendJson(res, 400, { MessageCode: 400, Message: 'กรุณากรอกรหัสสถานพยาบาล' });
  try {
    const r = await state.pool.query(
      'SELECT hcode, hname, hos_type, main_hos_code FROM hospital_registry WHERE hcode = $1', [hcode]);
    if (!r.rows.length) return sendJson(res, 200, { MessageCode: 200, found: false });
    sendJson(res, 200, { MessageCode: 200, found: true, data: r.rows[0] });
  } catch (e) {
    if (/hospital_registry.*(does not exist|relation)/i.test(e.message)) {
      return sendJson(res, 200, { MessageCode: 200, found: false, notInitialized: true, Message: e.message });
    }
    sendJson(res, 400, { MessageCode: 400, Message: e.message });
  }
}

// GET /api/online/hospitals -> list the registry (read-only)
async function handleListHospitals(res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  try {
    const r = await state.pool.query(
      "SELECT hcode, hname, hos_type, main_hos_code, note, to_char(updated_at AT TIME ZONE 'Asia/Bangkok','YYYY-MM-DD HH24:MI:SS') AS updated_at FROM hospital_registry ORDER BY hos_type DESC, hcode");
    sendJson(res, 200, { MessageCode: 200, data: r.rows });
  } catch (e) {
    if (/hospital_registry.*(does not exist|relation)/i.test(e.message)) {
      return sendJson(res, 200, { MessageCode: 200, data: [], notInitialized: true });
    }
    sendJson(res, 400, { MessageCode: 400, Message: e.message });
  }
}

// POST /api/online/hospitals -> upsert one hospital (write required)
async function handleUpsertHospital(req, res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  if (!state.allowWrite) return sendJson(res, 403, { MessageCode: 403, Message: 'ต้องเปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ก่อน' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const hcode = normHcode(body.hcode);
  if (!hcode) return sendJson(res, 400, { MessageCode: 400, Message: 'กรุณากรอกรหัสสถานพยาบาล' });
  const hosType = String(body.hos_type || 'sub').toLowerCase() === 'main' ? 'main' : 'sub';
  const hname = (body.hname == null || body.hname === '') ? null : String(body.hname);
  const mainCode = hosType === 'main' ? hcode : (normHcode(body.main_hos_code) || null);
  const note = (body.note == null || body.note === '') ? null : String(body.note);
  try {
    await ensureHospitalSchema(state.pool);
    await state.pool.query(
      `INSERT INTO hospital_registry (hcode, hname, hos_type, main_hos_code, note, updated_at)
       VALUES ($1,$2,$3,$4,$5, now())
       ON CONFLICT (hcode) DO UPDATE SET
         hname=EXCLUDED.hname, hos_type=EXCLUDED.hos_type,
         main_hos_code=EXCLUDED.main_hos_code, note=EXCLUDED.note, updated_at=now()`,
      [hcode, hname, hosType, mainCode, note]);
    sendJson(res, 200, { MessageCode: 200, Message: 'บันทึกสำเร็จ' });
  } catch (e) { sendJson(res, 400, { MessageCode: 400, Message: e.message }); }
}

// POST /api/online/hospitals/delete  { hcode } (write required)
async function handleDeleteHospital(req, res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  if (!state.allowWrite) return sendJson(res, 403, { MessageCode: 403, Message: 'ต้องเปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ก่อน' });
  const body = await readBody(req);
  if (!body) return sendJson(res, 400, { MessageCode: 400, Message: 'Bad JSON body' });
  const hcode = normHcode(body.hcode);
  if (!hcode) return sendJson(res, 400, { MessageCode: 400, Message: 'ไม่พบรหัสที่จะลบ' });
  try {
    const r = await state.pool.query('DELETE FROM hospital_registry WHERE hcode = $1', [hcode]);
    sendJson(res, 200, { MessageCode: 200, Message: 'ลบแล้ว', deleted: r.rowCount });
  } catch (e) { sendJson(res, 400, { MessageCode: 400, Message: e.message }); }
}

// POST /api/online/hospitals/init -> create the registry table (write required)
async function handleInitHospitals(res) {
  if (!state.pool) return sendJson(res, 503, { MessageCode: 503, Message: 'Online DB not configured/available' });
  if (!state.allowWrite) return sendJson(res, 403, { MessageCode: 403, Message: 'ต้องเปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ก่อน' });
  try {
    await ensureHospitalSchema(state.pool);
    sendJson(res, 200, { MessageCode: 200, Message: 'สร้าง/ตรวจสอบตาราง hospital_registry แล้ว', table: 'hospital_registry' });
  } catch (e) { sendJson(res, 400, { MessageCode: 400, Message: e.message }); }
}

// ---- HOSxP proxy: browser -> server.js -> tunnel (avoids CORS + clearer errors) ----
async function handleHosxpSql(req, res) {
  const body = await readBody(req);
  if (!body) return sendJson(res, 200, { ok: false, status: 400, error: 'Bad JSON body' });
  const apiUrl = String(body.apiUrl || '').replace(/\/$/, '');
  const authKey = String(body.authKey || '');
  const sql = String(body.sql || '').trim();
  if (!apiUrl || !sql) return sendJson(res, 200, { ok: false, status: 400, error: 'missing apiUrl/sql' });
  // SSRF guard: only https hosxp.net hosts
  let host = '';
  try { host = new URL(apiUrl).hostname; } catch { return sendJson(res, 200, { ok: false, status: 400, error: 'invalid apiUrl' }); }
  if (!apiUrl.startsWith('https:') || !/(^|\.)hosxp\.net$/.test(host)) {
    return sendJson(res, 200, { ok: false, status: 400, error: 'apiUrl not allowed' });
  }
  const url = apiUrl + '/api/sql?sql=' + encodeURIComponent(sql.replace(/\s+/g, ' ').trim()) + '&app=BMS.Appointment.Register';
  try {
    const controller = new AbortController();
    const to = setTimeout(() => controller.abort(), 30000);
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + authKey }, signal: controller.signal });
    clearTimeout(to);
    const ct = r.headers.get('content-type') || '';
    if (ct.includes('json')) {
      const j = await r.json();
      if (r.ok && j.MessageCode === 200) return sendJson(res, 200, { ok: true, status: 200, data: j.data || (j.result && j.result.data) || [] });
      return sendJson(res, 200, { ok: false, status: r.status, error: j.Message || `HTTP ${r.status}` });
    }
    return sendJson(res, 200, { ok: false, status: r.status, error: `Tunnel error HTTP ${r.status} — HOSxP/tunnel อาจออฟไลน์ (เปิดโปรแกรม HOSxP ที่ รพ.)` });
  } catch (e) {
    return sendJson(res, 200, { ok: false, status: 0, error: e.name === 'AbortError' ? 'Timeout' : ('เชื่อมต่อ tunnel ไม่ได้: ' + e.message) });
  }
}

function serveStatic(req, res) {
  let rel = decodeURIComponent(req.url.split('?')[0]);
  if (rel === '/') rel = '/login.html';
  if (rel === '/.env' || rel.includes('..')) { res.writeHead(403); return res.end('forbidden'); }
  const file = path.join(__dirname, path.normalize(rel));
  if (!file.startsWith(__dirname)) { res.writeHead(403); return res.end('forbidden'); }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); return res.end('not found'); }
    res.writeHead(200, { 'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

http.createServer((req, res) => {
  const url = req.url.split('?')[0];
  if (url === '/api/online/sql' && req.method === 'POST') return handleSql(req, res);
  if (url === '/api/online/ping') return handlePing(res);
  if (url === '/api/online/config' && req.method === 'GET') return handleGetConfig(res);
  if (url === '/api/online/config' && req.method === 'POST') return handleSetConfig(req, res);
  if (url === '/api/online/test' && req.method === 'POST') return handleTestConfig(req, res);
  if (url === '/api/online/init' && req.method === 'POST') return handleInitTable(res);
  if (url === '/api/online/appointments' && req.method === 'POST') return handleSyncAppointments(req, res);
  if (url === '/api/online/lab' && req.method === 'POST') return handleSyncLab(req, res);
  if (url === '/api/online/login' && req.method === 'POST') return handleLogin(req, res);
  if (url === '/api/online/hospitals' && req.method === 'GET') return handleListHospitals(res);
  if (url === '/api/online/hospitals' && req.method === 'POST') return handleUpsertHospital(req, res);
  if (url === '/api/online/hospitals/delete' && req.method === 'POST') return handleDeleteHospital(req, res);
  if (url === '/api/online/hospitals/init' && req.method === 'POST') return handleInitHospitals(res);
  if (url === '/api/hosxp/sql' && req.method === 'POST') return handleHosxpSql(req, res);
  if (req.method === 'GET') return serveStatic(req, res);
  res.writeHead(405); res.end('method not allowed');
}).listen(state.PORT, () => {
  console.log('============================================');
  console.log('  BMS Appointment  ->  http://localhost:' + state.PORT + '/login.html');
  console.log('  Online DB        :', state.dbUrl ? state.dbUrl.replace(/:[^:@/]+@/, ':****@') : '(not configured)');
  console.log('  Write allowed    :', state.allowWrite);
  console.log('============================================');
});
