const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');

const app = express();
const dbPath = process.env.DB_PATH || 'harmonilan.db';
const db = new Database(dbPath);

app.use(cors());
app.use(express.json());
app.use(express.static('public'));

// DB 초기화
db.exec(`
  PRAGMA journal_mode=WAL;
`);

// 기존 테이블에 entered_by 컬럼 추가 (없을 경우에만)
for (const table of ['prescriptions', 'receipts', 'usages']) {
  const cols = db.prepare(`PRAGMA table_info(${table})`).all().map(c => c.name);
  if (!cols.includes('entered_by')) {
    db.prepare(`ALTER TABLE ${table} ADD COLUMN entered_by TEXT NOT NULL DEFAULT ''`).run();
  }
}

db.exec(`
  CREATE TABLE IF NOT EXISTS prescriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size IN (200, 500)),
    pouches INTEGER NOT NULL,
    entered_by TEXT NOT NULL DEFAULT '',
    note TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS receipts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    size INTEGER NOT NULL CHECK(size IN (200, 500)),
    boxes INTEGER NOT NULL,
    pouches INTEGER NOT NULL,
    entered_by TEXT NOT NULL DEFAULT '',
    note TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS usages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    floor INTEGER NOT NULL CHECK(floor BETWEEN 2 AND 7),
    size INTEGER NOT NULL CHECK(size IN (200, 500)),
    pouches INTEGER NOT NULL,
    entered_by TEXT NOT NULL DEFAULT '',
    note TEXT,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// ─── 처방 API ───────────────────────────────────────────────────────────────

app.get('/api/prescriptions', (req, res) => {
  const { year, month, size } = req.query;
  let sql = 'SELECT * FROM prescriptions WHERE 1=1';
  const params = [];
  if (year && month) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    sql += ' AND date LIKE ?';
    params.push(`${ym}%`);
  }
  if (size) { sql += ' AND size = ?'; params.push(Number(size)); }
  sql += ' ORDER BY date DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/prescriptions', (req, res) => {
  const { date, size, pouches, entered_by, note } = req.body;
  if (!date || !size || !pouches || !entered_by) return res.status(400).json({ error: '필수 항목 누락' });
  const r = db.prepare('INSERT INTO prescriptions (date, size, pouches, entered_by, note) VALUES (?,?,?,?,?)').run(date, size, pouches, entered_by, note || '');
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/prescriptions/:id', (req, res) => {
  db.prepare('DELETE FROM prescriptions WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── 입고 API ───────────────────────────────────────────────────────────────

app.get('/api/receipts', (req, res) => {
  const { year, month, size } = req.query;
  let sql = 'SELECT * FROM receipts WHERE 1=1';
  const params = [];
  if (year && month) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    sql += ' AND date LIKE ?';
    params.push(`${ym}%`);
  }
  if (size) { sql += ' AND size = ?'; params.push(Number(size)); }
  sql += ' ORDER BY date DESC';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/receipts', (req, res) => {
  const { date, size, boxes, entered_by, note } = req.body;
  if (!date || !size || !boxes || !entered_by) return res.status(400).json({ error: '필수 항목 누락' });
  const pouchesPerBox = Number(size) === 200 ? 22 : 15;
  const pouches = Number(boxes) * pouchesPerBox;
  const r = db.prepare('INSERT INTO receipts (date, size, boxes, pouches, entered_by, note) VALUES (?,?,?,?,?,?)').run(date, size, boxes, pouches, entered_by, note || '');
  res.json({ id: r.lastInsertRowid, pouches });
});

app.delete('/api/receipts/:id', (req, res) => {
  db.prepare('DELETE FROM receipts WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── 사용 API ───────────────────────────────────────────────────────────────

app.get('/api/usages', (req, res) => {
  const { year, month, size } = req.query;
  let sql = 'SELECT * FROM usages WHERE 1=1';
  const params = [];
  if (year && month) {
    const ym = `${year}-${String(month).padStart(2, '0')}`;
    sql += ' AND date LIKE ?';
    params.push(`${ym}%`);
  }
  if (size) { sql += ' AND size = ?'; params.push(Number(size)); }
  sql += ' ORDER BY date DESC, floor';
  res.json(db.prepare(sql).all(...params));
});

app.post('/api/usages', (req, res) => {
  const { date, floor, size, pouches, entered_by, note } = req.body;
  if (!date || !floor || !size || !pouches || !entered_by) return res.status(400).json({ error: '필수 항목 누락' });
  const r = db.prepare('INSERT INTO usages (date, floor, size, pouches, entered_by, note) VALUES (?,?,?,?,?,?)').run(date, floor, size, pouches, entered_by, note || '');
  res.json({ id: r.lastInsertRowid });
});

app.delete('/api/usages/:id', (req, res) => {
  db.prepare('DELETE FROM usages WHERE id=?').run(req.params.id);
  res.json({ ok: true });
});

// ─── 월간 요약 API ──────────────────────────────────────────────────────────

app.get('/api/summary', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });
  const ym = `${year}-${String(month).padStart(2, '0')}`;

  const sizes = [200, 500];
  const result = {};

  for (const size of sizes) {
    const totalPrescription = db.prepare(
      "SELECT COALESCE(SUM(pouches),0) as total FROM prescriptions WHERE date LIKE ? AND size=?"
    ).get(`${ym}%`, size).total;

    const totalReceipt = db.prepare(
      "SELECT COALESCE(SUM(pouches),0) as total, COALESCE(SUM(boxes),0) as boxes FROM receipts WHERE date LIKE ? AND size=?"
    ).get(`${ym}%`, size);

    const totalUsage = db.prepare(
      "SELECT COALESCE(SUM(pouches),0) as total FROM usages WHERE date LIKE ? AND size=?"
    ).get(`${ym}%`, size).total;

    // 층별 사용량
    const floorUsages = {};
    for (let f = 2; f <= 7; f++) {
      const row = db.prepare(
        "SELECT COALESCE(SUM(pouches),0) as total FROM usages WHERE date LIKE ? AND size=? AND floor=?"
      ).get(`${ym}%`, size, f);
      floorUsages[f] = row.total;
    }

    // 누적 재고 (전체 기간)
    const totalReceiptAll = db.prepare(
      "SELECT COALESCE(SUM(pouches),0) as total FROM receipts WHERE size=?"
    ).get(size).total;
    const totalUsageAll = db.prepare(
      "SELECT COALESCE(SUM(pouches),0) as total FROM usages WHERE size=?"
    ).get(size).total;

    result[size] = {
      prescription: totalPrescription,
      receiptBoxes: totalReceipt.boxes,
      receipt: totalReceipt.total,
      usage: totalUsage,
      floorUsages,
      stock: totalReceiptAll - totalUsageAll,       // 현재 재고
      undelivered: totalPrescription - totalReceipt.total  // 미입고 (이 달)
    };
  }

  res.json(result);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏥 하모닐란 재고 관리 서버 시작`);
  console.log(`   로컬 접속: http://localhost:${PORT}`);
  console.log(`   모바일 접속: http://<이 PC의 IP>:${PORT}\n`);
});
