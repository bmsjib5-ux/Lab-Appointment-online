// ============================================================================
//  BMS Appointment - headless sync (no browser, no button click)
//  Replicates exactly what the "ส่งเข้าฐานกลาง" button does in index.html:
//    1) validate BMS Session ID  -> apiUrl + auth key   (hosxp.net/phapi/PasteJSON)
//    2) resolve hospital code
//    3) run the list SQL over the HOSxP tunnel            (GET {apiUrl}/api/sql)
//    4) POST rows  -> running server.js  /api/online/appointments
//    5) fetch lab for those oapp_ids, POST -> /api/online/lab
//
//  DB writes go through the already-running server.js (which owns .env + the
//  read/write guard + the upsert/schema logic) — this script never touches pg.
//
//  Config: sync.config.json  (git-ignored — holds the BMS Session ID).
//  Run once:  node sync-cli.js       (auto-sync.bat loops this every N minutes)
//  Requires:  Node.js >= 18 (uses global fetch)
// ============================================================================
const fs = require('fs');
const path = require('path');

const APP_NAME = 'BMS.Appointment.Register';
const SQL_TIMEOUT = 30000;
const LAB_BATCH = 50;

// ---- config ----
const CFG_PATH = path.join(__dirname, 'sync.config.json');
function loadConfig() {
  if (!fs.existsSync(CFG_PATH)) {
    fail(`ไม่พบ ${path.basename(CFG_PATH)} — คัดลอกจาก sync.config.example.json แล้วใส่ BMS Session ID`);
  }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(CFG_PATH, 'utf8')); }
  catch (e) { fail(`อ่าน sync.config.json ไม่ได้ (JSON ผิด): ${e.message}`); }
  if (!String(cfg.bmsSessionId || '').trim()) fail('ยังไม่ได้ตั้งค่า bmsSessionId ใน sync.config.json');
  return {
    bmsSessionId: String(cfg.bmsSessionId).trim(),
    serverPort: Number(cfg.serverPort) || 8780,
    dateFromOffset: Number.isFinite(cfg.dateFromOffset) ? cfg.dateFromOffset : 0,
    dateToOffset: Number.isFinite(cfg.dateToOffset) ? cfg.dateToOffset : 7,
    status: ['active', 'closed', 'all'].includes(cfg.status) ? cfg.status : 'active',
    sortLatest: cfg.sortLatest !== false,
    syncLab: cfg.syncLab !== false,
  };
}

// ---- tiny helpers (mirror index.html) ----
function escSql(s) { return String(s ?? '').replace(/'/g, "''"); }
function minifySql(sql) { return String(sql).replace(/\s+/g, ' ').trim(); }
function ptName(r) { return String(r.ptname ?? '').replace(/\s+/g, ' ').trim(); }
function dateOffsetStr(days) {
  const d = new Date(); d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function ts() { return new Date().toISOString().replace('T', ' ').slice(0, 19); }
const LOG_PATH = path.join(__dirname, 'sync.log');
function writeLog(line) { try { fs.appendFileSync(LOG_PATH, line + '\n', 'utf8'); } catch {} }
function log(...a) { const line = `[${ts()}] ${a.join(' ')}`; console.log(line); writeLog(line); }
function fail(msg) { const line = `[${ts()}] ✗ ${msg}`; console.error(line); writeLog(line); process.exit(1); }

async function fetchJson(url, opts, timeoutMs) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...opts, signal: controller.signal });
    let body = null; try { body = await res.json(); } catch {}
    return { res, body };
  } finally { clearTimeout(t); }
}

// ---- 1) validate session ----
async function validateSession(sessionId) {
  const url = `https://hosxp.net/phapi/PasteJSON?Action=GET&code=${encodeURIComponent(sessionId)}`;
  const { res, body } = await fetchJson(url, {
    method: 'GET', headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' }, mode: 'cors',
  }, 10000);
  if (!res.ok || !body || body.MessageCode !== 200) {
    throw new Error(body?.Message || `เชื่อมต่อ Session ไม่สำเร็จ (HTTP ${res.status})`);
  }
  return body;
}
function extractConnectionConfig(data) {
  const result = data.result || {};
  const ui = result.user_info || {};
  let apiUrl, apiAuthKey;
  if (result.key_value && typeof result.key_value === 'object') {
    apiUrl = result.key_value['hosxp.api_url'];
    apiAuthKey = result.key_value['hosxp.api_auth_key'];
  }
  if (!apiUrl) apiUrl = ui['hosxp.api_url'];
  if (!apiAuthKey) apiAuthKey = ui['hosxp.api_auth_key'];
  if (!apiUrl) apiUrl = ui.bms_url;
  if (!apiAuthKey) apiAuthKey = ui.bms_session_code;
  return { apiUrl: (apiUrl || '').replace(/\/$/, ''), apiAuthKey: apiAuthKey || '', userInfo: ui };
}

// ---- 3) HOSxP SQL over the tunnel ----
function makeExecuteSql(conn) {
  return async function executeSql(sql) {
    const fullUrl = `${conn.apiUrl}/api/sql?sql=${encodeURIComponent(minifySql(sql))}&app=${encodeURIComponent(APP_NAME)}`;
    const { res, body } = await fetchJson(fullUrl, {
      method: 'GET', headers: { 'Authorization': `Bearer ${conn.apiAuthKey}`, 'Content-Type': 'application/json' },
    }, SQL_TIMEOUT);
    if (!res.ok) {
      const detail = body?.Message || body?.message || body?.error || '';
      return { ok: false, error: detail ? `HTTP ${res.status}: ${detail}` : `HTTP ${res.status}` };
    }
    if (!body || body.MessageCode !== 200) return { ok: false, error: body?.Message || 'Query failed' };
    return { ok: true, data: body.data || body.result?.data || [] };
  };
}

async function resolveHcode(executeSql, userInfo) {
  let hcode = userInfo?.hcode || userInfo?.hospital_code || userInfo?.hospcode || '';
  if (!hcode) {
    const r = await executeSql('SELECT hospitalcode, hospitalname FROM opdconfig LIMIT 1');
    if (r.ok && r.data && r.data[0]) hcode = r.data[0].hospitalcode || '';
  }
  return String(hcode || '').trim();
}

// ---- list SQL (mirror of buildMainSql in index.html) ----
function buildMainSql(cfg, loginHcode) {
  const dateFrom = dateOffsetStr(cfg.dateFromOffset);
  const dateTo = dateOffsetStr(cfg.dateToOffset);
  let statusClause = '';
  if (cfg.status === 'active') statusClause = ' AND ((o.oapp_status_id < 4) OR o.oapp_status_id IS NULL) ';
  else if (cfg.status === 'closed') statusClause = ' AND o.oapp_status_id >= 4 ';
  const hc = escSql(loginHcode);
  const scopeClause = loginHcode ? ` AND (oc.hos_guid_ext = '${hc}' OR oc.hos_guid = '${hc}') ` : '';
  const orderBy = cfg.sortLatest ? 'o.nextdate DESC, o.nexttime DESC' : 'o.nextdate, o.nexttime';
  return `
    SELECT
      o.oapp_id, o.clinic, o.doctor, o.depcode,
      o.hn, o.vstdate, o.nextdate, o.nexttime, o.nexttime_end,
      o.app_cause, o.oapp_status_id,
      CAST(concat(p.pname, p.fname, ' ', p.lname) AS VARCHAR(200)) AS ptname,
      p.cid, p.mobile_phone_number,
      c.name AS clinic_name, k.department,
      o2.oapp_status_name, qs.queue_slot_number,
      o.lab_list_text::VARCHAR(500) AS lab_list_text,
      o.xray_list_text::VARCHAR(500) AS xray_list_text,
      COALESCE(ov.vn, '') AS visit_vn,
      oc."name" AS sub_hos_name, oc.hos_guid AS sub_hos_code,
      oc.hos_guid_ext AS main_hos_code
    FROM oapp o
      LEFT OUTER JOIN patient p ON p.hn = o.hn
      LEFT OUTER JOIN clinic c ON c.clinic = o.clinic
      LEFT OUTER JOIN kskdepartment k ON k.depcode = o.depcode
      LEFT OUTER JOIN oapp_status o2 ON o2.oapp_status_id = o.oapp_status_id
      LEFT OUTER JOIN opd_qs_slot qs ON qs.opd_qs_slot_id = o.opd_qs_slot_id
      LEFT OUTER JOIN ovst ov ON ov.vn = o.visit_vn
      INNER JOIN oapp_contact oc ON oc."name" = o.contact_point
    WHERE o.nextdate BETWEEN '${escSql(dateFrom)}' AND '${escSql(dateTo)}'
      ${statusClause}${scopeClause}
    ORDER BY ${orderBy}
  `;
}

function toPayloadRow(r) {
  return {
    oapp_id: r.oapp_id, hn: r.hn, cid: r.cid, ptname: ptName(r),
    vstdate: r.vstdate, nextdate: r.nextdate, nexttime: r.nexttime, nexttime_end: r.nexttime_end,
    doctor: r.doctor, clinic: r.clinic, clinic_name: r.clinic_name,
    depcode: r.depcode, department: r.department, app_cause: r.app_cause,
    oapp_status_id: r.oapp_status_id, oapp_status_name: r.oapp_status_name,
    mobile_phone_number: r.mobile_phone_number, queue_slot_number: r.queue_slot_number,
    lab_list_text: r.lab_list_text, xray_list_text: r.xray_list_text,
    visit_vn: r.visit_vn, sub_hos_name: r.sub_hos_name, sub_hos_code: r.sub_hos_code,
    main_hos_code: r.main_hos_code,
  };
}

// ---- 5) lab (mirror of fetchLabForOapps) ----
async function fetchLabForOapps(executeSql, oappIds) {
  const head = [], order = [], service = [];
  for (let i = 0; i < oappIds.length; i += LAB_BATCH) {
    const inList = oappIds.slice(i, i + LAB_BATCH).map((id) => `'${escSql(id)}'`).join(',');
    const qHead = `SELECT * FROM lab_app_head WHERE oapp_id IN (${inList})`;
    const qOrder = `SELECT lo.*, lh.oapp_id AS link_oapp_id FROM lab_app_order lo JOIN lab_app_head lh ON lh.lab_app_order_number = lo.lab_app_order_number WHERE lh.oapp_id IN (${inList})`;
    const qSvc = `SELECT los.*, lh.oapp_id AS link_oapp_id FROM lab_app_order_service los JOIN lab_app_head lh ON lh.lab_app_order_number = los.lab_app_order_number WHERE lh.oapp_id IN (${inList})`;
    const [rh, ro, rs] = await Promise.all([executeSql(qHead), executeSql(qOrder), executeSql(qSvc)]);
    if (!rh.ok) throw new Error('lab_app_head: ' + rh.error);
    if (!ro.ok) throw new Error('lab_app_order: ' + ro.error);
    if (!rs.ok) throw new Error('lab_app_order_service: ' + rs.error);
    head.push(...rh.data.map((x) => ({ ...x, link_oapp_id: x.oapp_id })));
    order.push(...ro.data);
    service.push(...rs.data);
  }
  return { lab_app_head: head, lab_app_order: order, lab_app_order_service: service };
}

// ---- POST to running server.js ----
function makePostLocal(port) {
  return async function postLocal(pathname, payload) {
    const { res, body } = await fetchJson(`http://127.0.0.1:${port}${pathname}`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
    }, 60000);
    if (!res.ok || !body || body.MessageCode !== 200) {
      const msg = body?.Message || `HTTP ${res.status}`;
      if (res.status === 403) throw new Error(`${msg} — เปิดสิทธิ์เขียน (ONLINE_ALLOW_WRITE=true) ในหน้าตั้งค่าก่อน`);
      if (res.status === 503) throw new Error(`${msg} — ยังไม่ได้ตั้งค่าฐานกลางใน server.js`);
      throw new Error(msg);
    }
    return body;
  };
}

// ---- main ----
async function main() {
  const cfg = loadConfig();

  log('เชื่อมต่อ BMS Session...');
  const sess = await validateSession(cfg.bmsSessionId);
  const conn = extractConnectionConfig(sess);
  if (!conn.apiUrl) fail('ไม่พบ API URL ใน Session (Session ID อาจหมดอายุ — ขอใหม่จาก HOSxP)');
  const executeSql = makeExecuteSql(conn);

  const loginHcode = await resolveHcode(executeSql, conn.userInfo);
  log(`เชื่อมต่อสำเร็จ · hcode=${loginHcode || '(ไม่ทราบ)'} · api=${conn.apiUrl}`);

  log('ดึงรายการนัดจากฐานหลัก...');
  const listRes = await executeSql(buildMainSql(cfg, loginHcode));
  if (!listRes.ok) fail(`ดึงรายการนัดไม่สำเร็จ: ${listRes.error}`);
  const rows = listRes.data || [];
  log(`ช่วง ${dateOffsetStr(cfg.dateFromOffset)}..${dateOffsetStr(cfg.dateToOffset)} · สถานะ=${cfg.status} · พบ ${rows.length} รายการ`);
  if (!rows.length) { log('ไม่มีรายการให้ส่ง — จบ'); return; }

  const sourceHcode = loginHcode || 'UNKNOWN';
  const postLocal = makePostLocal(cfg.serverPort);

  log('ส่งนัดเข้าฐานกลาง...');
  const apptRes = await postLocal('/api/online/appointments', {
    source_hcode: sourceHcode, rows: rows.map(toPayloadRow),
  });
  log(`✓ ส่งนัดสำเร็จ ${apptRes.saved} รายการ${apptRes.skipped ? ` (ข้าม ${apptRes.skipped})` : ''} → ${apptRes.table}`);

  if (cfg.syncLab) {
    const oappIds = rows.map((r) => String(r.oapp_id ?? '').trim()).filter(Boolean);
    if (oappIds.length) {
      log('ดึง/ส่ง Lab...');
      const labTables = await fetchLabForOapps(executeSql, oappIds);
      const labRes = await postLocal('/api/online/lab', {
        source_hcode: sourceHcode, oapp_ids: oappIds, tables: labTables,
      });
      const s = labRes.saved || {};
      log(`✓ ส่ง Lab สำเร็จ: head ${s.lab_app_head || 0} · order ${s.lab_app_order || 0} · service ${s.lab_app_order_service || 0}`);
    }
  }
  log('เสร็จสมบูรณ์');
}

main().catch((e) => fail(e.message));
