/**
 * Persistent uptime data store.
 * Reads/writes a JSON file that tracks:
 *  - check history (timestamp, status, latency)
 *  - incidents (start, end, duration, error)
 *  - uptime percentages (24h, 7d, 30d, 90d)
 *  - response time stats
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'uptime-data.json');
const MAX_HISTORY_ENTRIES = 26000; // ~90 days at 5-min intervals

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
}

function loadData() {
  ensureDataDir();
  if (fs.existsSync(DATA_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    } catch {
      console.warn('[uptime-store] Corrupt data file, starting fresh.');
    }
  }
  return { sites: {}, lastUpdated: null };
}

function saveData(data) {
  ensureDataDir();
  data.lastUpdated = new Date().toISOString();
  fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
}

function getSiteStore(data, siteUrl, siteName) {
  if (!data.sites[siteUrl]) {
    data.sites[siteUrl] = {
      name: siteName,
      url: siteUrl,
      checks: [],
      incidents: [],
      currentIncident: null,
      stats: {
        totalChecks: 0,
        successfulChecks: 0,
      },
    };
  }
  return data.sites[siteUrl];
}

function recordCheck(data, site, result) {
  const store = getSiteStore(data, site.url, site.name);
  const now = new Date().toISOString();

  const entry = {
    timestamp: now,
    success: result.success,
    status: result.detail?.status || null,
    latency: result.detail?.latency || null,
    error: result.error || null,
  };

  store.checks.push(entry);
  store.stats.totalChecks += 1;
  if (result.success) store.stats.successfulChecks += 1;

  // Trim old entries
  if (store.checks.length > MAX_HISTORY_ENTRIES) {
    store.checks = store.checks.slice(-MAX_HISTORY_ENTRIES);
  }

  // Incident tracking
  if (!result.success) {
    if (!store.currentIncident) {
      store.currentIncident = {
        id: `inc-${Date.now()}`,
        site: site.name,
        url: site.url,
        startedAt: now,
        endedAt: null,
        durationMs: null,
        error: result.error || `HTTP ${result.detail?.status}`,
        checksDown: 1,
      };
    } else {
      store.currentIncident.checksDown += 1;
      store.currentIncident.error = result.error || `HTTP ${result.detail?.status}`;
    }
  } else if (store.currentIncident) {
    // Site recovered — close incident
    store.currentIncident.endedAt = now;
    store.currentIncident.durationMs =
      new Date(now).getTime() - new Date(store.currentIncident.startedAt).getTime();
    store.incidents.push(store.currentIncident);
    store.currentIncident = null;

    // Keep last 200 incidents
    if (store.incidents.length > 200) {
      store.incidents = store.incidents.slice(-200);
    }
  }

  return entry;
}

function recordVitals(data, site, vitals) {
  const store = getSiteStore(data, site.url, site.name);
  const lastCheck = store.checks[store.checks.length - 1];
  if (lastCheck) {
    lastCheck.vitals = vitals;
  }
}

function calculateUptime(store, hoursBack) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = store.checks.filter(c => new Date(c.timestamp).getTime() >= cutoff);
  if (relevant.length === 0) return null;
  const up = relevant.filter(c => c.success).length;
  return (up / relevant.length) * 100;
}

function getAverageLatency(store, hoursBack) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = store.checks
    .filter(c => new Date(c.timestamp).getTime() >= cutoff && c.success && c.latency != null);
  if (relevant.length === 0) return null;
  const sum = relevant.reduce((acc, c) => acc + c.latency, 0);
  return Math.round(sum / relevant.length);
}

function getResponseTimeHistory(store, hoursBack, bucketMinutes = 30) {
  const cutoff = Date.now() - hoursBack * 60 * 60 * 1000;
  const relevant = store.checks
    .filter(c => new Date(c.timestamp).getTime() >= cutoff && c.success && c.latency != null);

  if (relevant.length === 0) return [];

  const buckets = {};
  for (const c of relevant) {
    const t = new Date(c.timestamp).getTime();
    const bucketKey = Math.floor(t / (bucketMinutes * 60 * 1000)) * bucketMinutes * 60 * 1000;
    if (!buckets[bucketKey]) buckets[bucketKey] = { sum: 0, count: 0, timestamp: new Date(bucketKey).toISOString() };
    buckets[bucketKey].sum += c.latency;
    buckets[bucketKey].count += 1;
  }

  return Object.values(buckets)
    .map(b => ({ timestamp: b.timestamp, avgLatency: Math.round(b.sum / b.count) }))
    .sort((a, b) => a.timestamp.localeCompare(b.timestamp));
}

function getSiteReport(data, siteUrl) {
  const store = data.sites[siteUrl];
  if (!store) return null;

  const lastCheck = store.checks[store.checks.length - 1] || null;
  const isUp = lastCheck ? lastCheck.success : null;

  return {
    name: store.name,
    url: store.url,
    currentStatus: isUp === null ? 'unknown' : isUp ? 'up' : 'down',
    currentIncident: store.currentIncident,
    lastChecked: lastCheck?.timestamp || null,
    lastLatency: lastCheck?.latency || null,
    uptime: {
      '24h': calculateUptime(store, 24),
      '7d': calculateUptime(store, 24 * 7),
      '30d': calculateUptime(store, 24 * 30),
      '90d': calculateUptime(store, 24 * 90),
    },
    avgLatency: {
      '24h': getAverageLatency(store, 24),
      '7d': getAverageLatency(store, 24 * 7),
      '30d': getAverageLatency(store, 24 * 30),
    },
    responseTimeHistory: getResponseTimeHistory(store, 24),
    recentIncidents: [...store.incidents].reverse().slice(0, 10),
    totalIncidents: store.incidents.length + (store.currentIncident ? 1 : 0),
    totalChecks: store.stats.totalChecks,
  };
}

function getAllReports(data) {
  return Object.keys(data.sites).map(url => getSiteReport(data, url));
}

module.exports = {
  loadData,
  saveData,
  recordCheck,
  recordVitals,
  calculateUptime,
  getSiteReport,
  getAllReports,
};
