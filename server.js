const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const path = require('path');
const XLSX = require('xlsx');

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

// ─── 엑셀 다운로드 API ──────────────────────────────────────────────────────

app.get('/api/export', (req, res) => {
  const { year, month } = req.query;
  if (!year || !month) return res.status(400).json({ error: 'year, month 필요' });
  const ym = `${year}-${String(month).padStart(2, '0')}`;

  const wb = XLSX.utils.book_new();

  // 요약 시트
  const summaryRows = [['용량', '처방(포)', '입고(박스)', '입고(포)', '사용(포)', '미입고(포)', '현재재고(포)']];
  for (const size of [200, 500]) {
    const totalPrescription = db.prepare("SELECT COALESCE(SUM(pouches),0) as total FROM prescriptions WHERE date LIKE ? AND size=?").get(`${ym}%`, size).total;
    const totalReceipt = db.prepare("SELECT COALESCE(SUM(pouches),0) as total, COALESCE(SUM(boxes),0) as boxes FROM receipts WHERE date LIKE ? AND size=?").get(`${ym}%`, size);
    const totalUsage = db.prepare("SELECT COALESCE(SUM(pouches),0) as total FROM usages WHERE date LIKE ? AND size=?").get(`${ym}%`, size).total;
    const totalReceiptAll = db.prepare("SELECT COALESCE(SUM(pouches),0) as total FROM receipts WHERE size=?").get(size).total;
    const totalUsageAll = db.prepare("SELECT COALESCE(SUM(pouches),0) as total FROM usages WHERE size=?").get(size).total;
    summaryRows.push([
      `${size}ml`, totalPrescription, totalReceipt.boxes, totalReceipt.total,
      totalUsage, totalPrescription - totalReceipt.total, totalReceiptAll - totalUsageAll
    ]);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(summaryRows), '요약');

  // 층별 사용량 시트
  const floorRows = [['용량', '2층', '3층', '4층', '5층', '6층', '7층', '합계']];
  for (const size of [200, 500]) {
    const row = [`${size}ml`];
    let total = 0;
    for (let f = 2; f <= 7; f++) {
      const v = db.prepare("SELECT COALESCE(SUM(pouches),0) as total FROM usages WHERE date LIKE ? AND size=? AND floor=?").get(`${ym}%`, size, f).total;
      row.push(v);
      total += v;
    }
    row.push(total);
    floorRows.push(row);
  }
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(floorRows), '층별사용량');

  // 처방 상세
  const prescriptions = db.prepare("SELECT date, size, pouches, entered_by, note FROM prescriptions WHERE date LIKE ? ORDER BY date").all(`${ym}%`);
  const prescRows = [['날짜', '용량(ml)', '처방량(포)', '입력자', '비고']];
  prescriptions.forEach(p => prescRows.push([p.date, p.size, p.pouches, p.entered_by, p.note || '']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(prescRows), '처방기록');

  // 입고 상세
  const receipts = db.prepare("SELECT date, size, boxes, pouches, entered_by, note FROM receipts WHERE date LIKE ? ORDER BY date").all(`${ym}%`);
  const recvRows = [['날짜', '용량(ml)', '박스수', '입고량(포)', '입력자', '비고']];
  receipts.forEach(r => recvRows.push([r.date, r.size, r.boxes, r.pouches, r.entered_by, r.note || '']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(recvRows), '입고기록');

  // 사용 상세
  const usages = db.prepare("SELECT date, floor, size, pouches, entered_by, note FROM usages WHERE date LIKE ? ORDER BY date, floor").all(`${ym}%`);
  const useRows = [['날짜', '층', '용량(ml)', '사용량(포)', '입력자', '비고']];
  usages.forEach(u => useRows.push([u.date, `${u.floor}층`, u.size, u.pouches, u.entered_by, u.note || '']));
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(useRows), '사용기록');

  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const filename = encodeURIComponent(`하모닐란_재고현황_${ym}.xlsx`);
  res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
  res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${filename}`);
  res.send(buf);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`\n🏥 하모닐란 재고 관리 서버 시작`);
  console.log(`   로컬 접속: http://localhost:${PORT}`);
  console.log(`   모바일 접속: http://<이 PC의 IP>:${PORT}\n`);
});
