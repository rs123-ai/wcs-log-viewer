/**
 * WCS 日志分析平台 v3
 */
const express = require('express');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { parseLog } = require('./lib/parser');
const {
  extractIncidents,
  incidentSummary,
  deviceErrorRanking,
  errorTypeDistribution,
  weeklySummary,
} = require('./lib/analyzer');

const app = express();
const PORT = process.env.PORT || 3456;

// CORS — allow any origin to access API
app.use(function(req, res, next) {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET,POST,PUT,DELETE,OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const storage = multer.diskStorage({
  destination: uploadDir,
  filename: (req, file, cb) => cb(null, file.originalname),
});
const upload = multer({
  storage,
  fileFilter: (req, file, cb) => {
    file.originalname.endsWith('.log') || file.originalname.endsWith('.txt')
      ? cb(null, true)
      : cb(new Error('仅支持 .log / .txt'));
  },
});

const logStore = new Map(); // date → { filename, entries }

// ============== API ==============

// 上传
app.post('/api/upload', upload.array('logs', 30), (req, res) => {
  if (!req.files?.length) return res.status(400).json({ error: '请上传文件' });
  const results = [];
  for (const file of req.files) {
    try {
      const text = fs.readFileSync(file.path, 'utf-8');
      const parsed = parseLog(text, file.originalname);
      logStore.set(parsed.date, parsed);
      results.push({ filename: file.originalname, date: parsed.date, entries: parsed.parsedEntries, errors: parsed.errorCount, ok: true });
    } catch (e) {
      results.push({ filename: file.originalname, error: e.message, ok: false });
    }
  }
  res.json({ uploaded: results.length, results });
});

// 获取指定日期范围的条目
function getEntriesInRange(dateFrom, dateTo) {
  const entries = [];
  const dates = Array.from(logStore.keys()).sort();
  for (const d of dates) {
    if ((!dateFrom || d >= dateFrom) && (!dateTo || d <= dateTo)) {
      entries.push(...logStore.get(d).entries);
    }
  }
  entries.sort((a, b) => a.time - b.time);
  return entries;
}

// 仪表盘 — 当日视图
app.get('/api/dashboard', (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const entries = getEntriesInRange(dateFrom, dateTo);
  if (!entries.length) return res.json({ empty: true });

  const incidents = extractIncidents(entries);
  const summary = incidentSummary(incidents);
  const deviceRank = deviceErrorRanking(incidents);
  const errorDist = errorTypeDistribution(incidents);

  // 设备排行附带动错误类型明细
  const deviceRankWithTypes = deviceRank.slice(0, 15).map(d => ({
    ...d,
    topTypes: Object.entries(d.byType).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, c]) => ({ type: t, count: c })),
  }));

  res.json({
    dateCount: logStore.size,
    totalErrors: entries.filter(e => e.level === 'error').length,
    summary,
    deviceRank: deviceRankWithTypes,
    errorDist,
    incidentsTotal: incidents.length,
    dateRange: { from: dateFrom || '', to: dateTo || '' },
  });
});

// 故障事件列表（分页）
app.get('/api/incidents', (req, res) => {
  const { page = 1, pageSize = 15, device, errorType, date, dateFrom, dateTo, resolved: resolvedFilter } = req.query;

  const entries = getEntriesInRange(date || dateFrom, dateTo);
  let incidents = extractIncidents(entries);

  if (device) incidents = incidents.filter(i => i.device === device);
  if (errorType) incidents = incidents.filter(i => i.errorType === errorType);
  if (resolvedFilter === '1') incidents = incidents.filter(i => i.resolved);
  if (resolvedFilter === '0') incidents = incidents.filter(i => !i.resolved);

  const total = incidents.length;
  const p = Number(page);
  const ps = Number(pageSize);
  const start = (p - 1) * ps;
  const items = incidents.slice(start, start + ps).map(i => ({
    ...i,
    durationStr: formatDuration(i.durationSec),
    displayBarcode: i.resolveBarcode || i.barcode || null,
  }));

  res.json({ total, page: p, pageSize: ps, totalPages: Math.ceil(total / ps), incidents: items });
});

// 周汇总
app.get('/api/weekly', (req, res) => {
  const { dateFrom, dateTo } = req.query;

  // 获取可用日期
  let dates = Array.from(logStore.keys()).sort();
  if (dateFrom) dates = dates.filter(d => d >= dateFrom);
  if (dateTo) dates = dates.filter(d => d <= dateTo);

  const dailyData = [];
  for (const date of dates) {
    const entries = logStore.get(date).entries;
    entries.sort((a, b) => a.time - b.time);
    const incidents = extractIncidents(entries);
    const summary = incidentSummary(incidents);
    const deviceRank = deviceErrorRanking(incidents);

    dailyData.push({
      date,
      totalIncidents: incidents.length,
      resolved: summary.resolved,
      unresolved: summary.unresolved,
      repeatTotal: incidents.reduce((s, i) => s + i.repeatCount, 0),
      avgMin: summary.avgMin,
      maxMin: summary.maxMin,
      topDevices: deviceRank.slice(0, 5).map(d => ({ device: d.device, count: d.totalIncidents })),
      errorDist: errorTypeDistribution(incidents).slice(0, 8),
    });
  }

  const allEntries = [];
  for (const date of dates) allEntries.push(...logStore.get(date).entries);
  allEntries.sort((a, b) => a.time - b.time);
  const allIncidents = extractIncidents(allEntries);

  res.json({
    dates, dailyData,
    weekDeviceRank: deviceErrorRanking(allIncidents).slice(0, 15),
    weekErrorDist: errorTypeDistribution(allIncidents),
    weekSummary: { total: allIncidents.length, ...incidentSummary(allIncidents) },
  });
});

// 设备列表
app.get('/api/devices', (req, res) => {
  const entries = getEntriesInRange();
  res.json(deviceErrorRanking(extractIncidents(entries)));
});

// 已加载日期
app.get('/api/dates', (req, res) => {
  const dates = Array.from(logStore.keys()).sort();
  res.json(dates.map(d => ({
    date: d, filename: logStore.get(d).filename, entries: logStore.get(d).parsedEntries, errors: logStore.get(d).errorCount,
  })));
});

// 删除指定日期日志
app.delete('/api/dates/:date', (req, res) => {
  const date = req.params.date;
  if (logStore.has(date)) {
    const data = logStore.get(date);
    const fp = path.join(uploadDir, data.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
    logStore.delete(date);
    res.json({ ok: true, date });
  } else {
    res.status(404).json({ error: '日期不存在' });
  }
});

// 清除全部
app.delete('/api/data', (req, res) => {
  for (const [, data] of logStore) {
    const fp = path.join(uploadDir, data.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  logStore.clear();
  res.json({ ok: true });
});

// 导出
app.get('/api/export', (req, res) => {
  const { dateFrom, dateTo } = req.query;
  const entries = getEntriesInRange(dateFrom, dateTo);
  const incidents = extractIncidents(entries);
  let csv = '设备,错误类型,日期,开始时间,结束时间,持续(秒),重复次数,条码,状态\n';
  for (const i of incidents) {
    csv += `${i.device},${i.errorType},${i.date},${fmtCSV(i.startTimestamp)},${fmtCSV(i.endTimestamp)},${i.durationSec},${i.repeatCount},${i.barcode || ''},${i.resolved ? '已解决' : '未解决'}\n`;
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="wcs-incidents.csv"');
  res.send('﻿' + csv);
});

app.use(express.static(path.join(__dirname, 'public')));

app.listen(PORT, '0.0.0.0', () => console.log(`http://0.0.0.0:${PORT}`));

function formatDuration(sec) {
  if (sec < 60) return `${sec}秒`;
  if (sec < 3600) return `${Math.floor(sec / 60)}分${sec % 60}秒`;
  return `${Math.floor(sec / 3600)}时${Math.floor((sec % 3600) / 60)}分`;
}
function fmtCSV(ts) { return ts ? ts.slice(11, 19) : ''; }
