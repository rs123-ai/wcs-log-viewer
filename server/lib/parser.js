/**
 * WCS 日志解析器
 * 格式: [Level]: [Day] [Time].[ms]-[Message]
 * Level: N(正常) / E(错误) / T(人工)
 */

const LEVEL_MAP = { N: 'normal', E: 'error', T: 'manual' };

// 日志行正则
const LINE_RE = /^([NET]):\s+(\d{2})\s+(\d{2}:\d{2}:\d{2})\.(\d+)-(.+)$/;

// 设备提取正则
const DEVICE_RE = /设备[：:](\w+)/;
const DEVICE_TAG_RE = /<设备[：:](\w+)/;

// 错误类型提取 — 优先提取报错后的具体内容
const ERROR_BAOCUO_RE  = /报错[：:]\s*(.+?)(?:$|[,;，；])/;
const ERROR_NOREAD_RE  = /错误条码\s*NOREAD/i;
const ERROR_WMS_WAIT_RE = /等待WMS回复入库货位/;
const ERROR_TASK_FAIL_RE = /任务写入(\d*)次?失败/;
const ERROR_MSG_RE     = /错误[：:]\s*(.+?)(?:$|[,;，；])/;
const ERROR_YICHANG_RE = /异常[：:]\s*(.+?)(?:$|[,;，；])/;

// 条码提取
const BARCODE_RE = /条码[：:]\s*(\w+)/;
const BARCODE_TAG_RE = /\|[^|]*\|(\w+)\|/;

/**
 * 解析单行日志
 */
function parseLine(line, fileDate) {
  const m = line.match(LINE_RE);
  if (!m) return null;

  const [, level, day, timeStr, ms, message] = m;

  // 构造完整时间戳
  const [h, min, s] = timeStr.split(':').map(Number);
  const timestamp = `${fileDate}T${String(h).padStart(2,'0')}:${String(min).padStart(2,'0')}:${String(s).padStart(2,'0')}.${ms}`;

  // 提取设备
  let device = null;
  const dm1 = message.match(DEVICE_RE);
  const dm2 = message.match(DEVICE_TAG_RE);
  if (dm1) device = dm1[1];
  else if (dm2) device = dm2[1];

  // WMS等待入库货位 → 正常业务流程，不算异常
  let actualLevel = level;
  if (level === 'E' && ERROR_WMS_WAIT_RE.test(message)) {
    actualLevel = 'N';
  }

  // 提取错误类型
  let errorType = null;
  if (actualLevel === 'E') {
    const baoCuo = message.match(ERROR_BAOCUO_RE);
    const yiChang = message.match(ERROR_YICHANG_RE);
    const errMsg = message.match(ERROR_MSG_RE);

    if (baoCuo) {
      errorType = baoCuo[1].trim();
    } else if (ERROR_NOREAD_RE.test(message)) {
      errorType = 'NOREAD';
    } else if (ERROR_TASK_FAIL_RE.test(message)) {
      errorType = '任务写入失败';
    } else if (yiChang) {
      const yc = yiChang[1].trim();
      const ora = yc.match(/ORA-\d+/);
      errorType = ora ? ora[0] : yc.substring(0, 40);
    } else if (errMsg) {
      errorType = errMsg[1].trim().substring(0, 40);
    } else if (message.includes('错误') || message.includes('故障')) {
      errorType = '其他错误';
    } else {
      errorType = '未分类';
    }
  }

  // 提取条码
  let barcode = null;
  const bm1 = message.match(BARCODE_RE);
  const bm2 = message.match(BARCODE_TAG_RE);
  if (bm1) barcode = bm1[1];
  else if (bm2) barcode = bm2[1];

  return {
    timestamp,
    time: new Date(timestamp),
    date: fileDate,
    hour: h,
    level: LEVEL_MAP[actualLevel] || 'unknown',
    levelRaw: actualLevel,
    device,
    errorType,
    barcode,
    message: message.substring(0, 300),
  };
}

/**
 * 解析整个日志文件
 */
function parseLog(text, filename) {
  const dateMatch = filename.match(/(\d{4})(\d{2})(\d{2})/);
  let fileDate = 'unknown';
  if (dateMatch) fileDate = `${dateMatch[1]}-${dateMatch[2]}-${dateMatch[3]}`;

  const lines = text.split(/\r?\n/).filter(l => l.trim());
  const entries = lines.map(l => parseLine(l, fileDate)).filter(Boolean);

  const errors = entries.filter(e => e.level === 'error');
  const normals = entries.filter(e => e.level === 'normal');
  const manuals = entries.filter(e => e.level === 'manual');

  return {
    filename,
    date: fileDate,
    totalLines: lines.length,
    parsedEntries: entries.length,
    entries, errors, normals, manuals,
    errorCount: errors.length,
    normalCount: normals.length,
    manualCount: manuals.length,
    errorRate: entries.length > 0 ? (errors.length / entries.length * 100).toFixed(1) : '0',
    timeRange: {
      start: entries[0]?.timestamp || null,
      end: entries[entries.length - 1]?.timestamp || null,
    },
  };
}

module.exports = { parseLine, parseLog, LEVEL_MAP };
