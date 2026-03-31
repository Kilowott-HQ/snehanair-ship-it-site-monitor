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

async function sendAlert(subject, text) {
  const recipients = process.env.ALERT_TO.split(',').map(v => v.trim()).filter(Boolean);
  const mail = {
    from: process.env.SMTP_FROM || emailConfig.auth.user,
    to: recipients,
    subject,
    text,
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
        const signal = `🚨[DOWN] ${site.name} (${site.url})`;
        await sendAlert(signal, `${site.name} is down at ${now()}\nError: ${availability.error || availability.detail?.statusText}`);
      }
      return;
    }

    // site is reachable
    if (currentState.downCount > 0) {
      await sendAlert(`✅[UP] ${site.name} back online`, `${site.name} is back up at ${now()} (status ${availability.detail.status})`);
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
          await sendAlert(`⚠️[CWV Degraded] ${site.name}`,
            `${site.name} core web vitals cross threshold at ${now()}\n` +
            `LCP=${vitals.LCP}ms, FCP=${vitals.FCP}ms, CLS=${vitals.CLS}, TBT=${vitals.TBT}, score=${vitals.performanceScore}`
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

console.log(`${LOG_PREFIX} Monitoring ${sites.length} site(s) every ${WATCH_INTERVAL_MINUTES} minutes.`);

cron.schedule(`*/${WATCH_INTERVAL_MINUTES} * * * *`, () => {
  monitorCycle().catch(err => console.error(`${LOG_PREFIX} Cycle error:`, err));
});

// first immediate run
monitorCycle().catch(err => console.error(`${LOG_PREFIX} Initial run error:`, err));
