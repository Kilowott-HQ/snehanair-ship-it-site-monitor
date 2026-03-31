# Site Monitor

A lightweight Node.js monitor for uptime + Core Web Vitals + email alerts.

## Setup

1. `cd "c:\PM Projects\site-monitor"`
2. `npm install`

3. Create `.env`:

```
SITES="US Site|https://example.com|us,Norway Site|https://example.no|no"

# Optional: Google PageSpeed Insights API key (free quota, recommended)
PSI_API_KEY=
PSI_STRATEGY=mobile

# Email
SMTP_HOST=smtp.example.com
SMTP_PORT=587
SMTP_SECURE=false
SMTP_USER=your-smtp-user
SMTP_PASS=your-smtp-password
SMTP_FROM=monitor@example.com
ALERT_TO=ops@example.com,team@example.com

# Optional thresholds
THRESHOLD_LCP=2500
THRESHOLD_FCP=1800
THRESHOLD_CLS=0.1
THRESHOLD_TBT=300

# Optional timing
INTERVAL_MINUTES=5
VITALS_MINUTES=30
REPEAT_ALERT_EVERY=3

# Timeout for HTTP availability check
TIMEOUT_MS=20000
```

4. Start:

```bash
npm run start
```

## Behavior

- Every `INTERVAL_MINUTES` it checks if each site is reachable.
- It sends a down alert on first failure and repeated every `REPEAT_ALERT_EVERY` failed checks.
- It sends recovery alert when a site comes back up.
- Every `VITALS_MINUTES`, it fetches Core Web Vitals from PageSpeed Insights and alerts if thresholds are exceeded.

## Notes

- Add `PSI_API_KEY` to avoid API limits.
- For production, use a process manager (`pm2`, systemd) or container.
- If you need SMS/Slack, wrap `sendAlert` with extra channels.
