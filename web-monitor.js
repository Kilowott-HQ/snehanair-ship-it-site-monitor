#!/usr/bin/env node

/**
 * Simple monitor (uptime + core web vitals via PageSpeed Insights) + email alert.
 *
 * Usage:
 * 1) npm install
 * 2) create .env (see README)
 * 3) npm run start
 *
 * The job runs every 5 minutes; Core Web Vitals are fetched every 30 minutes.
 */

require('dotenv').config();
const fetch = globalThis.fetch || require('node-fetch');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const LOG_PREFIX = '[site-monitor]';
const WATCH_INTERVAL_MINUTES = Number(process.env.INTERVAL_MINUTES || 5);
const VITALS_INTERVAL_MINUTES = Number(process.env.VITALS_MINUTES || 30);

const sites = (process.env.SITES || "").split(',').map(item => {
  const [name, url, locale] = item.split('|').map(t => t?.trim());
  return url ? { name: name || url, url, locale: locale || 'global' } : null;
}).filter(Boolean);

if (!sites.length) {
  console.error(`${LOG_PREFIX} No sites configured. Set SITES in .env (example in README).`);
  process.exit(1);
}

const emailConfig = {
  host: process.env.SMTP_HOST,
  port: Number(process.env.SMTP_PORT || 587),
  secure: String(process.env.SMTP_SECURE || 'false').toLowerCase() === 'true',
  auth: {
    user: process.env.SMTP_USER,
    pass: process.env.SMTP_PASS,
  },
};

if (!emailConfig.host || !emailConfig.auth.user || !emailConfig.auth.pass || !process.env.ALERT_TO) {
  console.error(`${LOG_PREFIX} Missing email config in .env (SMTP_HOST, SMTP_USER, SMTP_PASS, ALERT_TO).`);
  process.exit(1);
}

const transporter = nodemailer.createTransport(emailConfig);

const state = {};

const thresholds = {
  LCP: Number(process.env.THRESHOLD_LCP || 2500),
  FCP: Number(process.env.THRESHOLD_FCP || 1800),
  CLS: Number(process.env.THRESHOLD_CLS || 0.1),
  TBT: Number(process.env.THRESHOLD_TBT || 300),
};

function now() {
  return new Date().toISOString();
}

async function fetchWithTimeout(url, ms = 10000) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  try {
    const start = Date.now();
    const res = await fetch(url, { signal: controller.signal, redirect: 'follow' });
    const latency = Date.now() - start;
    return { ok: res.ok, status: res.status, statusText: res.statusText, latency, headers: res.headers };
  } finally {
    clearTimeout(timeout);
  }
}

async function checkAvailability(site) {
  try {
    const checked = await fetchWithTimeout(site.url, Number(process.env.TIMEOUT_MS || 20000));
    return { success: checked.ok && checked.status < 500, detail: checked };
  } catch (err) {
    return { success: false, error: err?.message || String(err) };
  }
}

async function fetchCoreWebVitals(site) {
  const apiKey = process.env.PSI_API_KEY || '';
  const params = new URLSearchParams({ url: site.url, strategy: process.env.PSI_STRATEGY || 'mobile' });
  if (apiKey) params.append('key', apiKey);
  const endpoint = `https://www.googleapis.com/pagespeedonline/v5/runPagespeed?${params}`;

  const resp = await fetch(endpoint, { timeout: 25000 });
  if (!resp.ok) {
    throw new Error(`PageSpeed API failed with status ${resp.status}`);
  }
  const payload = await resp.json();
  const audits = payload?.lighthouseResult?.audits;
  if (!audits) {
    throw new Error('PageSpeed API response missing lighthouseResult.audits');
  }

  return {
    LCP: audits['largest-contentful-paint']?.numericValue || null,
    FCP: audits['first-contentful-paint']?.numericValue || null,
    CLS: audits['cumulative-layout-shift']?.numericValue || null,
    TBT: audits['total-blocking-time']?.numericValue || null,
    performanceScore: payload?.lighthouseResult?.categories?.performance?.score || null,
  };
}

function isVitalsBad(vitals) {
  if (!vitals) return false;
  return (
    (typeof vitals.LCP === 'number' && vitals.LCP > thresholds.LCP) ||
    (typeof vitals.FCP === 'number' && vitals.FCP > thresholds.FCP) ||
    (typeof vitals.CLS === 'number' && vitals.CLS > thresholds.CLS) ||
    (typeof vitals.TBT === 'number' && vitals.TBT > thresholds.TBT)
  );
}

function getSeverity(type, detail) {
  if (type === 'down') return { level: 'CRITICAL', color: '#d32f2f', bg: '#fdecea', icon: '🔴' };
  if (type === 'vitals') {
    const scores = [];
    if (detail.LCP > thresholds.LCP * 1.5) scores.push('LCP');
    if (detail.FCP > thresholds.FCP * 1.5) scores.push('FCP');
    if (detail.CLS > thresholds.CLS * 2) scores.push('CLS');
    if (detail.TBT > thresholds.TBT * 1.5) scores.push('TBT');
    if (scores.length >= 2) return { level: 'CRITICAL', color: '#d32f2f', bg: '#fdecea', icon: '🔴' };
    return { level: 'WARNING', color: '#ed6c02', bg: '#fff4e5', icon: '🟡' };
  }
  if (type === 'recovery') return { level: 'RESOLVED', color: '#2e7d32', bg: '#edf7ed', icon: '🟢' };
  return { level: 'INFO', color: '#0288d1', bg: '#e5f6fd', icon: '🔵' };
}

function getRecommendations(type, detail) {
  const recs = [];
  if (type === 'down') {
    recs.push('Verify the server/hosting is running and accessible.');
    recs.push('Check DNS resolution and SSL certificate validity.');
    recs.push('Review recent deployments for breaking changes — consider a rollback if needed.');
    recs.push('Inspect server logs for errors (e.g. 502, 503, connection refused).');
    recs.push('Confirm CDN or reverse proxy (e.g. Cloudflare, Nginx) is routing correctly.');
    recs.push('If the issue persists beyond 10 minutes, escalate to the hosting provider.');
  }
  if (type === 'vitals') {
    if (detail.LCP && detail.LCP > thresholds.LCP) {
      recs.push(`LCP is ${Math.round(detail.LCP)}ms (threshold: ${thresholds.LCP}ms) — optimize largest visible element: compress hero images, use next-gen formats (WebP/AVIF), defer non-critical resources.`);
    }
    if (detail.FCP && detail.FCP > thresholds.FCP) {
      recs.push(`FCP is ${Math.round(detail.FCP)}ms (threshold: ${thresholds.FCP}ms) — reduce render-blocking CSS/JS, inline critical CSS, enable server-side caching.`);
    }
    if (detail.CLS && detail.CLS > thresholds.CLS) {
      recs.push(`CLS is ${detail.CLS.toFixed(3)} (threshold: ${thresholds.CLS}) — set explicit dimensions on images/ads/embeds, avoid injecting content above the fold.`);
    }
    if (detail.TBT && detail.TBT > thresholds.TBT) {
      recs.push(`TBT is ${Math.round(detail.TBT)}ms (threshold: ${thresholds.TBT}ms) — break up long JS tasks, defer/lazy-load heavy scripts, reduce third-party script impact.`);
    }
    if (detail.performanceScore !== null && detail.performanceScore < 0.5) {
      recs.push('Overall performance score is below 50 — a full Lighthouse audit and performance sprint is recommended.');
    }
  }
  return recs;
}

function buildHtmlEmail({ siteName, siteUrl, severity, timestamp, details, recommendations }) {
  const statusBadge = `<span style="display:inline-block;padding:4px 12px;border-radius:4px;background:${severity.bg};color:${severity.color};font-weight:bold;font-size:14px;border:1px solid ${severity.color};">${severity.icon} ${severity.level}</span>`;

  const detailRows = details.map(d =>
    `<tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;width:180px;">${d.label}</td><td style="padding:8px 12px;border-bottom:1px solid #eee;color:${d.highlight ? severity.color : '#333'};">${d.highlight ? '<strong>' + d.value + '</strong>' : d.value}</td></tr>`
  ).join('');

  const recItems = recommendations.map(r =>
    `<li style="margin-bottom:6px;color:#333;">${r}</li>`
  ).join('');

  return `
  <div style="font-family:'Segoe UI',Roboto,Arial,sans-serif;max-width:640px;margin:0 auto;background:#fff;border:1px solid #e0e0e0;border-radius:8px;overflow:hidden;">
    <div style="background:${severity.color};padding:20px 24px;">
      <h1 style="margin:0;color:#fff;font-size:20px;">Site Monitor Alert</h1>
    </div>
    <div style="padding:24px;">
      <div style="margin-bottom:16px;">
        ${statusBadge}
        <span style="margin-left:12px;font-size:16px;color:#333;font-weight:600;">${siteName}</span>
      </div>
      <table style="width:100%;border-collapse:collapse;margin-bottom:20px;background:#fafafa;border-radius:6px;overflow:hidden;">
        <tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;width:180px;">Site</td><td style="padding:8px 12px;border-bottom:1px solid #eee;"><a href="${siteUrl}" style="color:#1976d2;">${siteUrl}</a></td></tr>
        <tr><td style="padding:8px 12px;border-bottom:1px solid #eee;font-weight:600;color:#555;">Timestamp</td><td style="padding:8px 12px;border-bottom:1px solid #eee;">${timestamp}</td></tr>
        ${detailRows}
      </table>
      ${recommendations.length > 0 ? `
      <div style="background:#f5f5f5;border-left:4px solid ${severity.color};padding:16px;border-radius:4px;margin-bottom:16px;">
        <h3 style="margin:0 0 10px;color:${severity.color};font-size:14px;">💡 Tech Lead Recommendations</h3>
        <ol style="margin:0;padding-left:20px;font-size:13px;">${recItems}</ol>
      </div>` : ''}
      <p style="font-size:11px;color:#999;margin:16px 0 0;text-align:center;">Sent by Site Monitor · Kilowott Engineering</p>
    </div>
  </div>`;
}

async function sendAlert(subject, text, { type = 'info', site = {}, vitals = null } = {}) {
  const recipients = process.env.ALERT_TO.split(',').map(v => v.trim()).filter(Boolean);
  const severity = getSeverity(type, vitals || {});
  const timestamp = now();

  const details = [];
  if (type === 'down') {
    details.push({ label: 'Status', value: 'UNREACHABLE / DOWN', highlight: true });
    details.push({ label: 'Error', value: text, highlight: false });
  } else if (type === 'vitals' && vitals) {
    details.push({ label: 'Performance Score', value: vitals.performanceScore !== null ? Math.round(vitals.performanceScore * 100) + '/100' : 'N/A', highlight: vitals.performanceScore !== null && vitals.performanceScore < 0.5 });
    details.push({ label: 'LCP', value: `${Math.round(vitals.LCP)}ms`, highlight: vitals.LCP > thresholds.LCP });
    details.push({ label: 'FCP', value: `${Math.round(vitals.FCP)}ms`, highlight: vitals.FCP > thresholds.FCP });
    details.push({ label: 'CLS', value: vitals.CLS.toFixed(3), highlight: vitals.CLS > thresholds.CLS });
    details.push({ label: 'TBT', value: `${Math.round(vitals.TBT)}ms`, highlight: vitals.TBT > thresholds.TBT });
  } else if (type === 'recovery') {
    details.push({ label: 'Status', value: 'BACK ONLINE', highlight: false });
  }

  const recommendations = getRecommendations(type, vitals || {});

  const html = buildHtmlEmail({
    siteName: site.name || 'Unknown',
    siteUrl: site.url || '',
    type,
    severity,
    timestamp,
    details,
    recommendations,
  });

  const mail = {
    from: process.env.SMTP_FROM || emailConfig.auth.user,
    to: recipients,
    subject: `${severity.icon} [${severity.level}] ${subject}`,
    text,
    html,
  };

  const result = await transporter.sendMail(mail);
  console.log(`${LOG_PREFIX} Alert sent: ${subject} (${result.messageId})`);
}

async function monitorCycle() {
  console.log(`${LOG_PREFIX} Starting check cycle at ${now()}`);

  await Promise.all(sites.map(async site => {
    const currentState = state[site.url] = state[site.url] || { downCount: 0, lastVitals: null };
    const availability = await checkAvailability(site);

    if (!availability.success) {
      currentState.downCount += 1;
      console.warn(`${LOG_PREFIX} ${site.name} DOWN (#${currentState.downCount}):`, availability.error || availability.detail?.status);

      if (currentState.downCount === 1 || currentState.downCount % Number(process.env.REPEAT_ALERT_EVERY || 3) === 0) {
        await sendAlert(
          `${site.name} (${site.url}) is DOWN`,
          `${site.name} is down at ${now()}\nError: ${availability.error || availability.detail?.statusText}`,
          { type: 'down', site }
        );
      }
      return;
    }

    // site is reachable
    if (currentState.downCount > 0) {
      await sendAlert(
        `${site.name} back online`,
        `${site.name} is back up at ${now()} (status ${availability.detail.status})`,
        { type: 'recovery', site }
      );
    }
    currentState.downCount = 0;
    console.info(`${LOG_PREFIX} ${site.name} UP (${availability.detail.status}) latency=${availability.detail.latency}ms`);

    // core web vitals check every VITALS_INTERVAL_MINUTES
    const lastVitals = currentState.lastVitals || { when: 0 };
    const ageMin = (Date.now() - lastVitals.when) / 60000;

    if (ageMin >= VITALS_INTERVAL_MINUTES) {
      try {
        const vitals = await fetchCoreWebVitals(site);
        currentState.lastVitals = { when: Date.now(), vitals };

        if (isVitalsBad(vitals)) {
          console.warn(`${LOG_PREFIX} ${site.name} bad CWV`, vitals);
          await sendAlert(
            `${site.name} Core Web Vitals degraded`,
            `${site.name} core web vitals cross threshold at ${now()}\nLCP=${vitals.LCP}ms, FCP=${vitals.FCP}ms, CLS=${vitals.CLS}, TBT=${vitals.TBT}, score=${vitals.performanceScore}`,
            { type: 'vitals', site, vitals }
          );
        } else {
          console.log(`${LOG_PREFIX} ${site.name} CWV nominal`, vitals);
        }
      } catch (err) {
        console.error(`${LOG_PREFIX} ${site.name} CWV check failed:`, err.message || err);
      }
    }
  }));

  console.log(`${LOG_PREFIX} Check cycle completed at ${now()}`);
}

const runOnce = process.argv.includes('--once');

if (runOnce) {
  console.log(`${LOG_PREFIX} Running single check for ${sites.length} site(s)...`);
  monitorCycle()
    .then(() => { console.log(`${LOG_PREFIX} Done.`); process.exit(0); })
    .catch(err => { console.error(`${LOG_PREFIX} Error:`, err); process.exit(1); });
} else {
  console.log(`${LOG_PREFIX} Monitoring ${sites.length} site(s) every ${WATCH_INTERVAL_MINUTES} minutes.`);
  cron.schedule(`*/${WATCH_INTERVAL_MINUTES} * * * *`, () => {
    monitorCycle().catch(err => console.error(`${LOG_PREFIX} Cycle error:`, err));
  });
  // first immediate run
  monitorCycle().catch(err => console.error(`${LOG_PREFIX} Initial run error:`, err));
}
