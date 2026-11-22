'use strict';
/**
 * Local usage history (main process).
 * Stores one sample per refresh: { t, f, fr, w, wr }
 *   f / w   = 5-hour / weekly utilization (%)
 *   fr / wr = their resets_at, which identifies the window a sample belongs to
 * Kept for 8 days, saved to <userData>/history.json. Never leaves the computer.
 */
const fs = require('fs');

const KEEP_MS = 8 * 24 * 3600e3;
const MIN_GAP_MS = 50e3;          // ignore samples closer than this
const RATE_LOOKBACK_MS = 60 * 60e3; // use the last hour to estimate the current pace
const RATE_MIN_SPAN_MS = 8 * 60e3;  // need at least this much data to trust it

class History {
  constructor(file) {
    this.file = file;
    this.samples = [];
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data)) this.samples = data.filter(s => s && typeof s.t === 'number');
    } catch { /* first run */ }
    this.prune();
    this.saveTimer = null;
  }

  /** Record a normalized 'ok' state */
  add(state, now = Date.now()) {
    const five = state.windows?.find(w => w.key === 'five_hour');
    const week = state.windows?.find(w => w.key === 'seven_day');
    if (!five && !week) return;
    const s = {
      t: now,
      f: five ? five.pct : null, fr: five?.resetsAt || null,
      w: week ? week.pct : null, wr: week?.resetsAt || null,
    };
    const last = this.samples[this.samples.length - 1];
    if (last && now - last.t < MIN_GAP_MS) this.samples[this.samples.length - 1] = s;
    else this.samples.push(s);
    this.prune(now);
    this.save();
  }

  prune(now = Date.now()) {
    const cut = now - KEEP_MS;
    if (this.samples.length && this.samples[0].t < cut) this.samples = this.samples.filter(s => s.t >= cut);
  }

  save() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      try { fs.writeFileSync(this.file, JSON.stringify(this.samples)); } catch (e) { console.error('[history]', e); }
    }, 1000);
  }

  clear() { this.samples = []; this.save(); }

  /**
   * Recent usage pace in %/ms for a window ('f' or 'w'), using only samples from the
   * same window (same resets_at). Returns null when there isn't enough data.
   */
  recentRate(field, resetsAt, now = Date.now()) {
    const rk = field === 'f' ? 'fr' : 'wr';
    const pts = this.samples.filter(s => s[rk] === resetsAt && s[field] != null && s.t >= now - RATE_LOOKBACK_MS);
    if (pts.length < 2) return null;
    const a = pts[0], b = pts[pts.length - 1];
    const span = b.t - a.t;
    if (span < RATE_MIN_SPAN_MS) return null;
    return Math.max(0, (b[field] - a[field]) / span);
  }

  /** All samples as CSV (local time + ISO UTC), oldest first */
  toCSV() {
    const pad = (n) => String(n).padStart(2, '0');
    const local = (t) => { const d = new Date(t); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
    const cell = (v) => (v == null ? '' : String(v));
    const rows = [['time_local', 'time_utc', 'five_hour_pct', 'five_hour_resets_at', 'weekly_pct', 'weekly_resets_at']];
    for (const s of this.samples) {
      rows.push([local(s.t), new Date(s.t).toISOString(), cell(s.f), cell(s.fr), cell(s.w), cell(s.wr)]);
    }
    return rows.map(r => r.join(',')).join('\r\n') + '\r\n';
  }

  /** Samples since a time, for charts: [{t, v}] */
  series(field, since) {
    const rk = field === 'f' ? 'fr' : 'wr';
    return this.samples.filter(s => s.t >= since && s[field] != null).map(s => ({ t: s.t, v: s[field], r: s[rk] }));
  }
}

module.exports = { History };
