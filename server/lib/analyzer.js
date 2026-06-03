/**
 * 日志分析引擎 v2
 * - 故障事件合并：同设备+同错误类型 → 持续合并到恢复或日志结束
 * - 解决判定：设备出现正常(N)日志 = 已解决
 * - 周趋势汇总
 */

/**
 * 从日志条目中提取故障事件
 *
 * 合并规则：
 *  同设备 + 同错误类型 → 合并为一条事件
 *  持续合并直到：
 *    a) 该设备出现正常(N)日志 → 事件结束，标记已解决
 *    b) 日志结束 → 事件结束，标记未解决
 *
 * @param {Array} entries - 所有日志条目（时间已排序）
 * @returns {Array} 故障事件列表
 */
function extractIncidents(entries) {
  // 先按设备+错误类型追踪当前打开的事件
  const openIncidents = {}; // key: "device|errorType" → incident
  const closedIncidents = [];

  for (const entry of entries) {
    // 正常日志 或 人工补码 → 关闭该设备所有打开的事件
    if ((entry.level === 'normal' || entry.level === 'manual') && entry.device) {
      for (const key of Object.keys(openIncidents)) {
        const [dev] = key.split('|');
        if (dev === entry.device) {
          const inc = openIncidents[key];
          inc.resolveTime = entry.time;
          inc.resolveTimestamp = entry.timestamp;
          inc.resolved = true;
          inc.durationSec = Math.round((entry.time - inc.startTime) / 1000);
          // 从正常/人工日志中捕获条码（NOREAD 的 barcode 为空，补码时才拿到）
          if (!inc.barcode && entry.barcode) inc.barcode = entry.barcode;
          if (entry.barcode) inc.resolveBarcode = entry.barcode;
          closedIncidents.push(inc);
          delete openIncidents[key];
        }
      }
      continue;
    }

    if (entry.level !== 'error' || !entry.device) continue;

    const key = `${entry.device}|${entry.errorType || '未分类'}`;

    if (openIncidents[key]) {
      const inc = openIncidents[key];
      inc.endTime = entry.time;
      inc.endTimestamp = entry.timestamp;
      inc.repeatCount++;
      inc.errors.push(entry);
      if (entry.barcode) inc.barcode = entry.barcode;
    } else {
      openIncidents[key] = {
        device: entry.device,
        errorType: entry.errorType || '未分类',
        startTime: entry.time,
        startTimestamp: entry.timestamp,
        endTime: entry.time,
        endTimestamp: entry.timestamp,
        date: entry.date,
        barcode: entry.barcode,
        resolveBarcode: null,
        repeatCount: 1,
        resolved: false,
        resolveTime: null,
        resolveTimestamp: null,
        durationSec: 0,
        errors: [entry],
      };
    }
  }

  // 日志结束 → 关闭所有未解决事件
  for (const inc of Object.values(openIncidents)) {
    inc.durationSec = Math.round((inc.endTime - inc.startTime) / 1000);
    closedIncidents.push(inc);
  }

  // 按开始时间排序
  closedIncidents.sort((a, b) => a.startTime - b.startTime);

  // 移除内部存储的错误数组（减少数据传输）
  return closedIncidents.map(inc => {
    const { errors, ...rest } = inc;
    return rest;
  });
}

/**
 * 汇总统计
 */
function incidentSummary(incidents) {
  const resolved = incidents.filter(i => i.resolved);
  const unresolved = incidents.filter(i => !i.resolved);

  const durations = resolved.map(i => i.durationSec);

  const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const median = arr => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  };
  const max = arr => arr.length ? Math.max(...arr) : 0;

  return {
    total: incidents.length,
    resolved: resolved.length,
    unresolved: unresolved.length,
    avgSec: avg(durations),
    medianSec: median(durations),
    maxSec: max(durations),
    avgMin: (avg(durations) / 60).toFixed(1),
    medianMin: (median(durations) / 60).toFixed(1),
    maxMin: (max(durations) / 60).toFixed(1),
  };
}

/**
 * 设备故障排行
 */
function deviceErrorRanking(incidents) {
  const map = new Map();
  for (const inc of incidents) {
    const d = map.get(inc.device) || { device: inc.device, totalIncidents: 0, totalRepeats: 0, byType: {}, unresolved: 0 };
    d.totalIncidents++;
    d.totalRepeats += inc.repeatCount;
    d.byType[inc.errorType] = (d.byType[inc.errorType] || 0) + 1;
    if (!inc.resolved) d.unresolved++;
    map.set(inc.device, d);
  }
  return Array.from(map.values()).sort((a, b) => b.totalIncidents - a.totalIncidents);
}

/**
 * 错误类型分布
 */
function errorTypeDistribution(incidents) {
  const map = new Map();
  for (const inc of incidents) {
    map.set(inc.errorType, (map.get(inc.errorType) || 0) + 1);
  }
  return Array.from(map.entries())
    .map(([type, count]) => ({ type, count, pct: (count / incidents.length * 100).toFixed(1) }))
    .sort((a, b) => b.count - a.count);
}

/**
 * 周汇总 — 按日期分组统计
 */
function weeklySummary(incidents) {
  const byDate = {};
  for (const inc of incidents) {
    if (!byDate[inc.date]) {
      byDate[inc.date] = { date: inc.date, total: 0, resolved: 0, unresolved: 0, durations: [] };
    }
    const d = byDate[inc.date];
    d.total++;
    if (inc.resolved) {
      d.resolved++;
      d.durations.push(inc.durationSec);
    } else {
      d.unresolved++;
    }
  }

  const dates = Object.keys(byDate).sort();

  return dates.map(date => {
    const d = byDate[date];
    const avg = arr => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
    return {
      date,
      total: d.total,
      resolved: d.resolved,
      unresolved: d.unresolved,
      avgSec: avg(d.durations),
      avgMin: (avg(d.durations) / 60).toFixed(1),
      maxSec: d.durations.length ? Math.max(...d.durations) : 0,
    };
  });
}

module.exports = {
  extractIncidents,
  incidentSummary,
  deviceErrorRanking,
  errorTypeDistribution,
  weeklySummary,
};
