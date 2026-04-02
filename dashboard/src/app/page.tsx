"use client";

import { useEffect, useState, useCallback } from "react";

interface PeriodStat { incidents: number; downtimeMs: number }
interface SiteStatus {
  name: string;
  url: string;
  currentStatus: "up" | "down" | "unknown";
  lastChecked: string | null;
  lastLatency: number | null;
  checkInterval: number;
  paused: boolean;
  streak: { status: "up" | "down" | "unknown"; durationMs: number };
  uptime: Record<string, number | null>;
  avgLatency: Record<string, number | null>;
  periodStats: Record<string, PeriodStat>;
  totalChecks: number;
  totalIncidents: number;
  currentIncident: Record<string, unknown> | null;
  recentIncidents: Record<string, unknown>[];
  responseHistory: { t: string; l: number }[];
  alert_emails: string[];
}

interface SSLInfo {
  ssl: boolean;
  valid?: boolean;
  issuer?: string;
  validTo?: string;
  daysRemaining?: number;
  error?: string;
}

interface StatusResponse {
  sites: SiteStatus[];
  lastUpdated: string | null;
  totalSites: number;
  sitesUp: number;
  sitesDown: number;
}

function fmtDur(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m`;
  const d = Math.floor(h / 24);
  return `${d}d ${h % 24}h`;
}

function fmtDurLong(ms: number) {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s} seconds`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} h, ${m % 60} m`;
  const d = Math.floor(h / 24);
  return `${d} d, ${h % 24} h, ${m % 60} m`;
}

function timeAgo(iso: string) {
  const s = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (s < 60) return `${s} seconds ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} minute${m > 1 ? "s" : ""} ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hour${h > 1 ? "s" : ""} ago`;
  return `${Math.floor(h / 24)} day${Math.floor(h / 24) > 1 ? "s" : ""} ago`;
}

function uptimeColor(v: number | null) {
  if (v == null) return "text-gray-500";
  if (v >= 99.9) return "text-green-400";
  if (v >= 99) return "text-green-500";
  if (v >= 95) return "text-yellow-400";
  return "text-red-400";
}

// ─── main ───
export default function Dashboard() {
  const [status, setStatus] = useState<StatusResponse | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [editSite, setEditSite] = useState<SiteStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await fetch("/api/status");
      setStatus(await r.json());
    } catch { /* ignore */ } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const i = setInterval(refresh, 30_000);
    return () => clearInterval(i);
  }, [refresh]);

  const remove = async (url: string, name: string) => {
    if (!confirm(`Remove "${name}"?`)) return;
    await fetch("/api/sites", { method: "DELETE", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url }) });
    setSelected(null);
    refresh();
  };

  const togglePause = async (url: string, paused: boolean) => {
    await fetch("/api/sites", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, paused: !paused }) });
    refresh();
  };

  if (loading) return <div className="flex items-center justify-center h-screen bg-gray-950 text-gray-500">Loading...</div>;

  const sites = status?.sites || [];
  const up = status?.sitesUp || 0;
  const down = status?.sitesDown || 0;
  const total = sites.length;

  return (
    <div className="min-h-screen bg-gray-950 text-gray-200">
      {/* top bar */}
      <header className="border-b border-gray-800 sticky top-0 z-30 bg-gray-950">
        <div className="max-w-5xl mx-auto flex items-center justify-between px-4 h-14">
          <div className="flex items-center gap-2">
            <span className="w-3 h-3 rounded-full bg-green-500" />
            <span className="font-semibold text-white text-lg">Site Monitor</span>
          </div>
          <button onClick={() => setShowAdd(true)} className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-4 py-2 rounded-md cursor-pointer">
            + Add Monitor
          </button>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-4 py-6">
        {/* summary */}
        <div className="flex items-center gap-6 mb-6 text-sm">
          <span className="text-gray-400">{total} monitors</span>
          <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-green-500" /><span className="text-green-400 font-medium">{up} up</span></span>
          {down > 0 && <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-red-500" /><span className="text-red-400 font-medium">{down} down</span></span>}
          {status?.lastUpdated && <span className="text-gray-600 text-xs ml-auto">Updated {timeAgo(status.lastUpdated)}</span>}
        </div>

        {total === 0 && (
          <div className="text-center py-20 text-gray-600">
            <p className="mb-4">No monitors yet</p>
            <button onClick={() => setShowAdd(true)} className="text-green-400 hover:underline cursor-pointer">Add your first monitor</button>
          </div>
        )}

        {/* monitor list */}
        <div className="space-y-2">
          {sites.map((site) => (
            <MonitorRow key={site.url} site={site} expanded={selected === site.url}
              onToggle={() => setSelected(selected === site.url ? null : site.url)}
              onRemove={() => remove(site.url, site.name)}
              onEdit={() => setEditSite(site)}
              onPause={() => togglePause(site.url, site.paused)}
              onRefresh={refresh}
            />
          ))}
        </div>
      </div>

      {editSite && <EditMonitor site={editSite} onClose={() => setEditSite(null)} onSaved={() => { setEditSite(null); refresh(); }} />}
      {showAdd && <AddMonitor onClose={() => setShowAdd(false)} onAdded={() => { setShowAdd(false); refresh(); }} />}
    </div>
  );
}

// ─── 24h uptime bar (green/red segments) ───
function UptimeBar24h({ data, uptime }: { data: { t: string; l: number }[]; uptime: number | null }) {
  const segs = 24;
  if (data.length < 2) {
    return <div className="flex gap-[2px] h-6">{Array.from({ length: segs }).map((_, i) => <div key={i} className="flex-1 bg-gray-800 rounded-sm" />)}</div>;
  }
  const cutoff = Date.now() - 24 * 3600000;
  const perSeg = (24 * 3600000) / segs;
  return (
    <div>
      <div className="flex gap-[2px] h-6">
        {Array.from({ length: segs }).map((_, i) => {
          const segStart = cutoff + i * perSeg;
          const segEnd = segStart + perSeg;
          const inSeg = data.filter(d => { const t = new Date(d.t).getTime(); return t >= segStart && t < segEnd; });
          const color = inSeg.length === 0 ? "bg-gray-800" : "bg-green-500";
          return <div key={i} className={`flex-1 ${color} rounded-sm`} />;
        })}
      </div>
      <div className="flex justify-between text-[10px] text-gray-600 mt-1">
        <span>24h ago</span>
        <span>{uptime != null ? `${uptime.toFixed(0)}%` : ""}</span>
        <span>Now</span>
      </div>
    </div>
  );
}

// ─── response time chart ───
function ResponseChart({ data }: { data: { t: string; l: number }[] }) {
  if (data.length < 2) return <div className="text-xs text-gray-600">No data yet</div>;
  const max = Math.max(...data.map(d => d.l), 1);
  return (
    <div className="flex items-end gap-[1px] h-16">
      {data.map((d, i) => {
        const h = Math.max(4, (d.l / max) * 100);
        const c = d.l < 500 ? "bg-green-500" : d.l < 1500 ? "bg-yellow-500" : "bg-red-500";
        return <div key={i} className={`flex-1 ${c} rounded-t-sm`} style={{ height: `${h}%` }} title={`${d.l}ms`} />;
      })}
    </div>
  );
}

// ─── monitor row ───
function MonitorRow({ site, expanded, onToggle, onRemove, onEdit, onPause, onRefresh }: {
  site: SiteStatus; expanded: boolean;
  onToggle: () => void; onRemove: () => void; onEdit: () => void; onPause: () => void; onRefresh: () => void;
}) {
  const [ssl, setSSL] = useState<SSLInfo | null>(null);

  useEffect(() => {
    if (expanded && !ssl) {
      fetch(`/api/ssl?url=${encodeURIComponent(site.url)}`).then(r => r.json()).then(setSSL).catch(() => {});
    }
  }, [expanded, ssl, site.url]);

  const isUp = site.currentStatus === "up";
  const isDown = site.currentStatus === "down";

  const [testing, setTesting] = useState(false);
  const testNotification = async () => {
    setTesting(true);
    try {
      const r = await fetch("/api/test-alert", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: site.name, url: site.url }),
      });
      const d = await r.json();
      alert(d.results?.join("\n") || "Sent!");
    } catch {
      alert("Failed to send test");
    } finally {
      setTesting(false);
    }
  };

  return (
    <div className={`border border-gray-800 rounded-lg overflow-hidden ${site.paused ? "opacity-60" : ""}`}>
      {/* collapsed row */}
      <div onClick={onToggle} className="flex items-center gap-4 px-4 py-3.5 cursor-pointer hover:bg-gray-900 transition-colors">
        <span className={`w-3 h-3 rounded-full flex-shrink-0 ${site.paused ? "bg-gray-600" : isUp ? "bg-green-500" : isDown ? "bg-red-500" : "bg-gray-600"}`} />
        <div className="flex-1 min-w-0">
          <div className="font-medium text-white truncate">{site.name} {site.paused && <span className="text-xs text-gray-500 ml-2">PAUSED</span>}</div>
          <div className="text-xs text-gray-500 truncate">{site.url}</div>
        </div>
        <div className="text-right w-16">
          <div className={`text-sm font-semibold ${uptimeColor(site.uptime["24h"])}`}>{site.uptime["24h"] != null ? `${site.uptime["24h"].toFixed(0)}%` : "—"}</div>
          <div className="text-[10px] text-gray-600">24h</div>
        </div>
        <div className="text-right w-20">
          <div className={`text-sm font-semibold ${site.lastLatency && site.lastLatency < 1000 ? "text-green-400" : site.lastLatency ? "text-yellow-400" : "text-gray-600"}`}>
            {site.lastLatency ? `${site.lastLatency}ms` : "—"}
          </div>
          <div className="text-[10px] text-gray-600">latency</div>
        </div>
        <span className={`text-xs font-semibold px-2.5 py-1 rounded-full ${isUp ? "bg-green-500/10 text-green-400" : isDown ? "bg-red-500/10 text-red-400" : "bg-gray-800 text-gray-500"}`}>
          {site.paused ? "Paused" : isUp ? "Up" : isDown ? "Down" : "?"}
        </span>
      </div>

      {/* expanded detail */}
      {expanded && (
        <div className="border-t border-gray-800 bg-gray-900/50 px-4 py-5">
          {/* action buttons */}
          <div className="flex items-center gap-2 mb-5">
            <button onClick={(e) => { e.stopPropagation(); testNotification(); }} disabled={testing} className="text-xs border border-gray-700 text-gray-400 px-3 py-1.5 rounded hover:bg-gray-800 disabled:opacity-50 cursor-pointer">{testing ? "Sending..." : "Test notification"}</button>
            <button onClick={(e) => { e.stopPropagation(); onPause(); }} className="text-xs border border-gray-700 text-gray-400 px-3 py-1.5 rounded hover:bg-gray-800 cursor-pointer">{site.paused ? "Resume" : "Pause"}</button>
            <button onClick={(e) => { e.stopPropagation(); onEdit(); }} className="text-xs border border-gray-700 text-gray-400 px-3 py-1.5 rounded hover:bg-gray-800 cursor-pointer">Edit</button>
            <div className="flex-1" />
            <button onClick={(e) => { e.stopPropagation(); onRemove(); }} className="text-xs text-red-400/50 hover:text-red-400 cursor-pointer">Remove</button>
          </div>

          {/* status cards row */}
          <div className="grid grid-cols-4 gap-3 mb-5">
            {/* current status */}
            <div className="bg-gray-800/50 rounded-lg p-3">
              <div className="text-[11px] text-gray-500 mb-1">Current status</div>
              <div className={`text-lg font-bold ${isUp ? "text-green-400" : isDown ? "text-red-400" : "text-gray-500"}`}>
                {site.paused ? "Paused" : isUp ? "Up" : isDown ? "Down" : "Unknown"}
              </div>
              <div className="text-[11px] text-gray-600">
                {site.streak.durationMs > 0 ? `Currently ${site.streak.status} for ${fmtDurLong(site.streak.durationMs)}` : ""}
              </div>
            </div>
            {/* last check */}
            <div className="bg-gray-800/50 rounded-lg p-3">
              <div className="text-[11px] text-gray-500 mb-1">Last check</div>
              <div className="text-lg font-bold text-white">{site.lastChecked ? timeAgo(site.lastChecked) : "Never"}</div>
              <div className="text-[11px] text-gray-600">Checked every {site.checkInterval} m</div>
            </div>
            {/* 24h uptime bar */}
            <div className="bg-gray-800/50 rounded-lg p-3">
              <div className="flex items-center justify-between mb-1">
                <span className="text-[11px] text-gray-500">Last 24 hours</span>
                <span className={`text-[11px] font-semibold ${uptimeColor(site.uptime["24h"])}`}>{site.uptime["24h"] != null ? `${site.uptime["24h"].toFixed(0)}%` : "—"}</span>
              </div>
              <UptimeBar24h data={site.responseHistory} uptime={site.uptime["24h"]} />
              <div className="text-[11px] text-gray-600 mt-1">
                {site.periodStats["24h"].incidents} incidents, {site.periodStats["24h"].downtimeMs > 0 ? fmtDur(site.periodStats["24h"].downtimeMs) + " down" : "0 m down"}
              </div>
            </div>
            {/* SSL cert */}
            <div className="bg-gray-800/50 rounded-lg p-3">
              <div className="text-[11px] text-gray-500 mb-1">SSL certificate</div>
              {ssl === null ? (
                <div className="text-sm text-gray-600">Loading...</div>
              ) : ssl.error ? (
                <div className="text-sm text-gray-500">{ssl.error}</div>
              ) : !ssl.ssl ? (
                <div className="text-sm text-yellow-400">No HTTPS</div>
              ) : (
                <>
                  <div className={`text-lg font-bold ${ssl.daysRemaining != null && ssl.daysRemaining > 30 ? "text-green-400" : ssl.daysRemaining != null && ssl.daysRemaining > 7 ? "text-yellow-400" : "text-red-400"}`}>
                    {ssl.validTo ? new Date(ssl.validTo).toLocaleDateString() : "Unknown"}
                  </div>
                  <div className="text-[11px] text-gray-600">
                    {ssl.daysRemaining != null ? `${ssl.daysRemaining} days remaining` : ""}{ssl.issuer ? ` · ${ssl.issuer}` : ""}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* uptime stats */}
          <div className="bg-gray-800/50 rounded-lg p-4 mb-5">
            <div className="text-sm font-semibold text-white mb-3">Uptime stats</div>
            <div className="grid grid-cols-3 gap-4">
              {(["7d", "30d"] as const).map((k) => {
                const label = k === "7d" ? "Last 7 days" : "Last 30 days";
                const ps = site.periodStats[k] || { incidents: 0, downtimeMs: 0 };
                return (
                  <div key={k}>
                    <div className="text-[11px] text-gray-500">{label}</div>
                    <div className={`text-xl font-bold ${uptimeColor(site.uptime[k])}`}>
                      {site.uptime[k] != null ? `${site.uptime[k]!.toFixed(3)}%` : "—"}
                    </div>
                    <div className="text-[11px] text-gray-600">
                      {ps.incidents} incident{ps.incidents !== 1 ? "s" : ""}, {ps.downtimeMs > 0 ? fmtDur(ps.downtimeMs) + " down" : "0 m down"}
                    </div>
                  </div>
                );
              })}
              <div>
                <div className="text-[11px] text-gray-500">Avg latency (24h)</div>
                <div className="text-xl font-bold text-white">{site.avgLatency["24h"] ? `${site.avgLatency["24h"]}ms` : "—"}</div>
                <div className="text-[11px] text-gray-600">{site.totalChecks.toLocaleString()} total checks</div>
              </div>
            </div>
          </div>

          {/* response time chart */}
          <div className="bg-gray-800/50 rounded-lg p-4 mb-5">
            <div className="flex items-center justify-between mb-2">
              <span className="text-sm font-semibold text-white">Response time</span>
              <span className="text-xs text-gray-500">Last {site.responseHistory.length} checks</span>
            </div>
            <ResponseChart data={site.responseHistory} />
          </div>

          {/* alert emails */}
          <AlertEmailEditor url={site.url} emails={site.alert_emails || []} onRefresh={onRefresh} />

          {/* incidents */}
          <div className="mt-4">
            <div className="text-sm font-semibold text-white mb-2">Incidents</div>
            {site.recentIncidents.length === 0 && !site.currentIncident && (
              <div className="text-xs text-gray-600">No downtime recorded</div>
            )}
            {site.currentIncident && (() => {
              const since = new Date(String(site.currentIncident.startedAt));
              const dur = Date.now() - since.getTime();
              return (
                <div className="bg-red-500/10 border border-red-500/20 rounded-lg px-4 py-3 mb-2">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2 text-sm">
                      <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                      <span className="font-semibold text-red-400">Currently Down</span>
                    </div>
                    <span className="text-sm font-semibold text-red-400">{fmtDur(dur)}</span>
                  </div>
                  <div className="text-xs text-red-400/60 mt-1">Since {since.toLocaleString()} &middot; {String(site.currentIncident.error || "")}</div>
                </div>
              );
            })()}
            {site.recentIncidents.slice(0, 10).map((inc, i) => {
              const start = new Date(String(inc.startedAt));
              const end = inc.endedAt ? new Date(String(inc.endedAt)) : null;
              const durMs = (inc.durationMs as number) || (end ? end.getTime() - start.getTime() : 0);
              return (
                <div key={i} className="flex items-center justify-between text-xs border border-gray-800 rounded-lg px-4 py-2.5 mb-1">
                  <div className="flex items-center gap-2">
                    <span className="w-1.5 h-1.5 rounded-full bg-green-500" />
                    <span className="text-gray-400">
                      {start.toLocaleDateString()} {start.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                      {end && <> → {end.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}</>}
                    </span>
                  </div>
                  <span className="text-gray-500 font-medium">{durMs ? fmtDur(durMs) : "—"}</span>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── alert email editor ───
function AlertEmailEditor({ url, emails, onRefresh }: { url: string; emails: string[]; onRefresh: () => void }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(emails.join(", "));
  const [saving, setSaving] = useState(false);

  const save = async () => {
    setSaving(true);
    const list = value.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes("@"));
    await fetch("/api/sites", { method: "PATCH", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ url, alert_emails: list }) });
    setSaving(false); setEditing(false); onRefresh();
  };

  return (
    <div className="bg-gray-800/50 rounded-lg p-4">
      <div className="flex items-center justify-between mb-1">
        <span className="text-sm font-semibold text-white">Alert contacts</span>
        {!editing && <button onClick={(e) => { e.stopPropagation(); setEditing(true); }} className="text-xs text-green-400 hover:underline cursor-pointer">{emails.length > 0 ? "Edit" : "+ Add"}</button>}
      </div>
      {!editing ? (
        emails.length > 0
          ? <div className="flex flex-wrap gap-1">{emails.map((em, i) => <span key={i} className="text-xs bg-gray-800 text-gray-400 px-2 py-0.5 rounded">{em}</span>)}</div>
          : <div className="text-xs text-gray-600">No alert emails — using global default</div>
      ) : (
        <div onClick={(e) => e.stopPropagation()}>
          <textarea value={value} onChange={(e) => setValue(e.target.value)} placeholder="email1@example.com, email2@example.com"
            className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2 text-xs text-gray-300 focus:outline-none focus:ring-1 focus:ring-green-500 resize-none" rows={2} autoFocus />
          <div className="flex justify-end gap-2 mt-1">
            <button onClick={() => setEditing(false)} className="text-xs text-gray-500 cursor-pointer">Cancel</button>
            <button onClick={save} disabled={saving} className="text-xs bg-green-500 text-white px-3 py-1 rounded hover:bg-green-600 disabled:opacity-50 cursor-pointer">{saving ? "..." : "Save"}</button>
          </div>
        </div>
      )}
    </div>
  );
}

// ─── add monitor modal ───
function AddMonitor({ onClose, onAdded }: { onClose: () => void; onAdded: () => void }) {
  const [url, setUrl] = useState("");
  const [name, setName] = useState("");
  const [emails, setEmails] = useState("");
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const autoName = (u: string) => { try { return new URL(u.startsWith("http") ? u : `https://${u}`).hostname.replace("www.", ""); } catch { return ""; } };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setSaving(true);
    const finalUrl = url.startsWith("http") ? url : `https://${url}`;
    const emailList = emails.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes("@"));
    try {
      const r = await fetch("/api/sites", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ name: name || autoName(url), url: finalUrl, alert_emails: emailList }) });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Failed"); return; }
      onAdded();
    } catch { setError("Network error"); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-20 z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6 mx-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-4">New Monitor</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">URL *</label>
            <input type="text" value={url} onChange={(e) => { setUrl(e.target.value); if (!name) setName(""); }} placeholder="example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-green-500" autoFocus required />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Friendly Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)} placeholder={autoName(url) || "My Website"}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-green-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Alert Emails</label>
            <textarea value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="sneha@example.com, dev@example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-green-500 resize-none" rows={2} />
            <div className="text-[10px] text-gray-600 mt-1">Comma-separated. Notified on down/up events.</div>
          </div>
          {error && <div className="text-red-400 text-sm bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 cursor-pointer">Cancel</button>
            <button type="submit" disabled={saving} className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-5 py-2 rounded-lg disabled:opacity-50 cursor-pointer">{saving ? "Adding..." : "Create Monitor"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─── edit monitor modal ───
function EditMonitor({ site, onClose, onSaved }: { site: SiteStatus; onClose: () => void; onSaved: () => void }) {
  const [name, setName] = useState(site.name);
  const [url, setUrl] = useState(site.url);
  const [emails, setEmails] = useState((site.alert_emails || []).join(", "));
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault(); setError(""); setSaving(true);
    let finalUrl = url; if (!finalUrl.startsWith("http")) finalUrl = `https://${finalUrl}`;
    const emailList = emails.split(/[,;\n]/).map(e => e.trim()).filter(e => e.includes("@"));
    try {
      const r = await fetch("/api/sites", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ original_url: site.url, name, url: finalUrl, alert_emails: emailList }) });
      const d = await r.json();
      if (!r.ok) { setError(d.error || "Failed"); return; }
      onSaved();
    } catch { setError("Network error"); } finally { setSaving(false); }
  };

  return (
    <div className="fixed inset-0 bg-black/50 flex items-start justify-center pt-20 z-50" onClick={onClose}>
      <div className="bg-gray-900 border border-gray-800 rounded-xl shadow-2xl w-full max-w-md p-6 mx-4" onClick={(e) => e.stopPropagation()}>
        <h2 className="text-lg font-semibold text-white mb-4">Edit Monitor</h2>
        <form onSubmit={submit} className="space-y-3">
          <div>
            <label className="block text-sm text-gray-400 mb-1">URL</label>
            <input type="text" value={url} onChange={(e) => setUrl(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-green-500" required />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Friendly Name</label>
            <input type="text" value={name} onChange={(e) => setName(e.target.value)}
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-green-500" />
          </div>
          <div>
            <label className="block text-sm text-gray-400 mb-1">Alert Emails</label>
            <textarea value={emails} onChange={(e) => setEmails(e.target.value)} placeholder="sneha@example.com"
              className="w-full bg-gray-800 border border-gray-700 rounded-lg px-3 py-2.5 text-sm text-white focus:outline-none focus:ring-1 focus:ring-green-500 resize-none" rows={2} />
          </div>
          {error && <div className="text-red-400 text-sm bg-red-500/10 rounded-lg px-3 py-2">{error}</div>}
          <div className="flex justify-end gap-2 pt-2">
            <button type="button" onClick={onClose} className="px-4 py-2 text-sm text-gray-500 cursor-pointer">Cancel</button>
            <button type="submit" disabled={saving} className="bg-green-500 hover:bg-green-600 text-white text-sm font-medium px-5 py-2 rounded-lg disabled:opacity-50 cursor-pointer">{saving ? "Saving..." : "Save Changes"}</button>
          </div>
        </form>
      </div>
    </div>
  );
}
