#!/usr/bin/env node
// Renders self-hosted GitHub stat cards for the profile README:
//   github-overview.svg  – activity numbers + contribution streak
//   github-activity.svg  – weekly contributions for the last 52 weeks
//
// Runs in GitHub Actions with the built-in GITHUB_TOKEN (no third-party services).
// Usage:  GITHUB_TOKEN=... node github-stats.mjs <outDir>
// Local preview: STATS_FIXTURE=data.json node github-stats.mjs <outDir>

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const LOGIN = process.env.GH_USER || process.env.GITHUB_REPOSITORY_OWNER || "ptlshubham";
const OUT = process.argv[2] || "dist";

// ── data ────────────────────────────────────────────────────────────────────

async function gql(query, variables) {
  const res = await fetch("https://api.github.com/graphql", {
    method: "POST",
    headers: {
      Authorization: `bearer ${process.env.GITHUB_TOKEN}`,
      "Content-Type": "application/json",
      "User-Agent": "profile-stats-script",
    },
    body: JSON.stringify({ query, variables }),
  });
  const body = await res.json();
  if (!res.ok || body.errors) throw new Error(`GraphQL ${res.status}: ${JSON.stringify(body.errors || body)}`);
  return body.data;
}

async function fetchData(login) {
  const { user } = await gql(
    `query($login: String!) {
      user(login: $login) {
        login createdAt
        pullRequests(first: 1) { totalCount }
        repositories(first: 1, ownerAffiliations: OWNER, privacy: PUBLIC) { totalCount }
      }
    }`,
    { login },
  );

  // The contribution calendar is limited to one year per query, so walk year by year.
  const created = new Date(user.createdAt);
  const now = new Date();
  const days = new Map();
  for (let y = created.getUTCFullYear(); y <= now.getUTCFullYear(); y++) {
    const from = new Date(Math.max(Date.UTC(y, 0, 1), created.getTime()));
    const to = new Date(Math.min(Date.UTC(y, 11, 31, 23, 59, 59), now.getTime()));
    const data = await gql(
      `query($login: String!, $from: DateTime!, $to: DateTime!) {
        user(login: $login) { contributionsCollection(from: $from, to: $to) {
          contributionCalendar { weeks { contributionDays { date contributionCount } } } } }
      }`,
      { login, from: from.toISOString(), to: to.toISOString() },
    );
    for (const week of data.user.contributionsCollection.contributionCalendar.weeks)
      for (const d of week.contributionDays) days.set(d.date, d.contributionCount);
  }

  return {
    login: user.login,
    createdAt: user.createdAt,
    publicRepos: user.repositories.totalCount,
    pullRequests: user.pullRequests.totalCount,
    days: [...days].sort(([a], [b]) => a.localeCompare(b)).map(([date, count]) => ({ date, count })),
  };
}

// ── metrics ─────────────────────────────────────────────────────────────────

const DAY = 86400000;
const iso = (t) => new Date(t).toISOString().slice(0, 10);

function metrics(data, now = Date.now()) {
  const counts = new Map(data.days.map((d) => [d.date, d.count]));
  const today = iso(now);
  const total = data.days.reduce((s, d) => s + d.count, 0);

  let last12 = 0, activeDays = 0;
  for (let t = now - 364 * DAY; t <= now; t += DAY) { const c = counts.get(iso(t)) || 0; last12 += c; if (c > 0) activeDays++; }
  const bestDay = data.days.reduce((b, d) => (d.count > b.count ? d : b), { count: 0, date: null });
  const years = Math.floor((now - new Date(data.createdAt).getTime()) / (365.25 * DAY));

  // Current streak: today counts only once it has a contribution, so start from yesterday otherwise.
  let cursor = (counts.get(today) || 0) > 0 ? now : now - DAY;
  let current = 0, currentEnd = iso(cursor), currentStart = null;
  while ((counts.get(iso(cursor)) || 0) > 0) { current++; currentStart = iso(cursor); cursor -= DAY; }

  let longest = 0, longestStart = null, longestEnd = null, run = 0, runStart = null;
  for (const d of data.days) {
    if (d.count > 0) {
      if (run === 0) runStart = d.date;
      run++;
      if (run > longest) { longest = run; longestStart = runStart; longestEnd = d.date; }
    } else run = 0;
  }

  // 52 weekly buckets ending today (oldest first).
  const weeks = [];
  for (let w = 51; w >= 0; w--) {
    let sum = 0;
    const end = now - w * 7 * DAY;
    for (let k = 6; k >= 0; k--) sum += counts.get(iso(end - k * DAY)) || 0;
    weeks.push({ start: iso(end - 6 * DAY), count: sum });
  }

  return {
    total, last12, activeDays, bestDay, years, weeks,
    current, currentStart, currentEnd,
    longest, longestStart, longestEnd,
    firstDate: data.days[0]?.date || iso(data.createdAt),
  };
}

// ── rendering ───────────────────────────────────────────────────────────────

const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const num = (n) => n.toLocaleString("en-US");
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const md = (s) => { const d = new Date(s + "T00:00:00Z"); return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}`; };
const mdy = (s) => `${md(s)}, ${s.slice(0, 4)}`;
const my = (s) => `${MONTHS[+s.slice(5, 7) - 1]} ${s.slice(0, 4)}`;
const range = (a, b) => (a === b ? mdy(a) : a.slice(0, 4) === b.slice(0, 4) ? `${md(a)} – ${mdy(b)}` : `${mdy(a)} – ${mdy(b)}`);

const FONT = `'Segoe UI', Ubuntu, 'Helvetica Neue', Helvetica, Arial, sans-serif`;
const C = { surface: "#0f172a", border: "#1e293b", grid: "#1e293b", axis: "#334155", ink: "#f1f5f9", ink2: "#e2e8f0", muted: "#94a3b8", faint: "#64748b", series: "#9085e9" };

const baseStyle = `
    text { font-family: ${FONT}; }
    .kicker { font-size: 14px; font-weight: 700; letter-spacing: 2px; fill: ${C.muted}; }
    .big { font-size: 30px; font-weight: 800; fill: ${C.ink}; }
    .unit { font-size: 16px; font-weight: 600; fill: ${C.muted}; }
    .label { font-size: 15px; font-weight: 600; fill: ${C.ink2}; }
    .sub { font-size: 14px; fill: ${C.muted}; }
    .in { opacity: 0; animation: rise .7s cubic-bezier(.2,.7,.2,1) forwards; }
    @keyframes rise { from { opacity: 0; transform: translateY(10px); } to { opacity: 1; transform: none; } }`;
const reduced = (extra = "") => `
    @media (prefers-reduced-motion: reduce) { .in, .grow, .ring { animation: none; } .in { opacity: 1; } ${extra} }`;

function overviewSvg(data, m) {
  const W = 1200, H = 260;
  const stats = [
    ["Contributions (12 months)", m.last12],
    ["Active days (12 months)", m.activeDays],
    ["Pull requests", data.pullRequests],
    ["Public repositories", data.publicRepos],
    ["Most in a single day", m.bestDay.count],
    ["Years on GitHub", m.years],
  ];
  const cells = stats.map(([label, value], i) => {
    const x = 32 + (i % 2) * 280, y = 100 + Math.floor(i / 2) * 58;
    return `<g class="in" style="animation-delay:${(0.1 + i * 0.08).toFixed(2)}s">
      <text class="big" x="${x}" y="${y}">${num(value)}</text>
      <text class="sub" x="${x}" y="${y + 22}">${esc(label)}</text></g>`;
  }).join("\n    ");

  const R = 46, CIRC = 2 * Math.PI * R;
  const cx = [710, 906, 1102];
  const streakSub = m.current > 0 ? range(m.currentStart, m.currentEnd) : "No active streak";
  const longestSub = m.longest > 0 ? range(m.longestStart, m.longestEnd) : "—";
  const dayUnit = (n) => (n === 1 ? " day" : " days");

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">GitHub overview for @${esc(data.login)}</title>
  <desc id="desc">${stats.map(([l, v]) => `${l}: ${num(v)}`).join(". ")}. Total contributions since ${my(m.firstDate)}: ${num(m.total)}. Current streak: ${m.current}${dayUnit(m.current)}. Longest streak: ${m.longest}${dayUnit(m.longest)}.</desc>
  <style>${baseStyle}
    .ring { stroke-dasharray: ${CIRC.toFixed(1)}; stroke-dashoffset: ${CIRC.toFixed(1)}; animation: draw 1.4s cubic-bezier(.4,0,.2,1) .4s forwards; }
    @keyframes draw { to { stroke-dashoffset: 0; } }${reduced(".ring { stroke-dashoffset: 0; }")}
  </style>

  <rect x="0.5" y="0.5" width="587" height="${H - 1}" rx="18" fill="${C.surface}" stroke="${C.border}"/>
  <text class="kicker" x="32" y="44">GITHUB OVERVIEW · @${esc(data.login.toUpperCase())}</text>
    ${cells}

  <rect x="612.5" y="0.5" width="587" height="${H - 1}" rx="18" fill="${C.surface}" stroke="${C.border}"/>
  <text class="kicker" x="644" y="44">CONTRIBUTION STREAK</text>
  <line x1="808" y1="90" x2="808" y2="222" stroke="${C.border}"/>
  <line x1="1004" y1="90" x2="1004" y2="222" stroke="${C.border}"/>
  <g text-anchor="middle">
    <g class="in" style="animation-delay:.15s">
      <text class="big" x="${cx[0]}" y="140">${num(m.total)}</text>
      <text class="label" x="${cx[0]}" y="172">Total contributions</text>
      <text class="sub" x="${cx[0]}" y="194">Since ${my(m.firstDate)}</text>
    </g>
    <circle cx="${cx[1]}" cy="128" r="${R}" fill="none" stroke="${C.border}" stroke-width="6"/>
    <circle class="ring" cx="${cx[1]}" cy="128" r="${R}" fill="none" stroke="${C.series}" stroke-width="6" stroke-linecap="round" transform="rotate(-90 ${cx[1]} 128)"/>
    <g class="in" style="animation-delay:.3s">
      <text class="big" x="${cx[1]}" y="139">${num(m.current)}</text>
      <text class="label" x="${cx[1]}" y="204">Current streak</text>
      <text class="sub" x="${cx[1]}" y="226">${esc(streakSub)}</text>
    </g>
    <g class="in" style="animation-delay:.45s">
      <text class="big" x="${cx[2]}" y="140">${num(m.longest)}<tspan class="unit">${dayUnit(m.longest)}</tspan></text>
      <text class="label" x="${cx[2]}" y="172">Longest streak</text>
      <text class="sub" x="${cx[2]}" y="194">${esc(longestSub)}</text>
    </g>
  </g>
</svg>
`;
}

function niceMax(v) {
  if (v <= 4) return 4;
  const p = 10 ** Math.floor(Math.log10(v));
  for (const k of [1, 2, 4, 6, 8, 10]) if (k * p >= v) return k * p; // halves stay whole numbers
  return 10 * p;
}

function activitySvg(data, m) {
  const W = 1200, H = 320, X0 = 72, X1 = 1168, TOP = 84, BASE = 262;
  const max = Math.max(...m.weeks.map((w) => w.count));
  const top = niceMax(max);
  const slot = (X1 - X0) / m.weeks.length, bw = Math.max(4, slot - 6);
  const y = (v) => BASE - (v / top) * (BASE - TOP);

  const grid = [0, top / 2, top].map((v) => `
  <line x1="${X0}" y1="${y(v).toFixed(1)}" x2="${X1}" y2="${y(v).toFixed(1)}" stroke="${v === 0 ? C.axis : C.grid}"/>
  <text class="tick" x="${X0 - 12}" y="${(y(v) + 4).toFixed(1)}" text-anchor="end">${num(v)}</text>`).join("");

  const peak = m.weeks.findIndex((w) => w.count === max && max > 0);
  const bars = m.weeks.map((w, i) => {
    const x = X0 + i * slot + (slot - bw) / 2;
    if (w.count === 0) return `<rect x="${x.toFixed(1)}" y="${BASE - 2}" width="${bw.toFixed(1)}" height="2" rx="1" fill="${C.axis}"><title>Week of ${mdy(w.start)}: 0</title></rect>`;
    const h = Math.max(3, BASE - y(w.count)), r = Math.min(4, h / 2, bw / 2);
    const d = `M${x.toFixed(1)} ${BASE}V${(BASE - h + r).toFixed(1)}a${r} ${r} 0 0 1 ${r} -${r}h${(bw - 2 * r).toFixed(1)}a${r} ${r} 0 0 1 ${r} ${r}V${BASE}z`;
    const label = i === peak ? `\n    <text class="peak in" style="animation-delay:1.2s" x="${(x + bw / 2).toFixed(1)}" y="${(BASE - h - 8).toFixed(1)}" text-anchor="middle">${num(w.count)}</text>` : "";
    return `<path class="grow" style="animation-delay:${(0.2 + i * 0.018).toFixed(3)}s" d="${d}" fill="${C.series}"><title>Week of ${mdy(w.start)}: ${num(w.count)}</title></path>${label}`;
  }).join("\n    ");

  // Month labels where a new month starts, skipping ones that would collide.
  let lastX = -Infinity;
  const months = m.weeks.map((w, i) => {
    const prev = m.weeks[i - 1];
    if (i > 0 && prev.start.slice(5, 7) === w.start.slice(5, 7)) return "";
    const x = X0 + i * slot;
    if (x - lastX < 56) return "";
    lastX = x;
    const mon = MONTHS[+w.start.slice(5, 7) - 1];
    return `<text class="tick" x="${x.toFixed(1)}" y="${BASE + 24}">${mon === "Jan" || i === 0 ? `${mon} ’${w.start.slice(2, 4)}` : mon}</text>`;
  }).join("");

  const empty = max === 0 ? `<text class="sub" x="${(X0 + X1) / 2}" y="${(TOP + BASE) / 2}" text-anchor="middle">No public contributions in the last 52 weeks</text>` : "";

  return `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" role="img" aria-labelledby="title desc">
  <title id="title">Weekly GitHub contributions, last 52 weeks</title>
  <desc id="desc">${num(m.last12)} contributions in the last 52 weeks. Busiest week: ${max > 0 ? `${num(max)} contributions, week of ${mdy(m.weeks[peak].start)}` : "none"}.</desc>
  <style>${baseStyle}
    .tick { font-size: 13px; fill: ${C.faint}; }
    .peak { font-size: 14px; font-weight: 700; fill: ${C.ink2}; }
    .grow { transform-box: fill-box; transform-origin: bottom; transform: scaleY(0); animation: grow .6s cubic-bezier(.2,.7,.2,1) forwards; }
    @keyframes grow { to { transform: scaleY(1); } }${reduced(".grow { transform: none; }")}
  </style>
  <rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" rx="18" fill="${C.surface}" stroke="${C.border}"/>
  <text class="kicker" x="32" y="44">CONTRIBUTIONS · LAST 52 WEEKS</text>
  <text class="sub" x="${W - 32}" y="44" text-anchor="end"><tspan class="label">${num(m.last12)}</tspan> contributions</text>
  ${grid}
    ${bars}
  ${months}
  ${empty}
</svg>
`;
}

// ── main ────────────────────────────────────────────────────────────────────

const data = process.env.STATS_FIXTURE
  ? JSON.parse(readFileSync(process.env.STATS_FIXTURE, "utf8"))
  : await fetchData(LOGIN);
const m = metrics(data);
mkdirSync(OUT, { recursive: true });
writeFileSync(join(OUT, "github-overview.svg"), overviewSvg(data, m));
writeFileSync(join(OUT, "github-activity.svg"), activitySvg(data, m));
console.log(`@${data.login}: ${num(m.total)} total, ${num(m.last12)} in 12 months, streak ${m.current} (longest ${m.longest}) → ${OUT}`);
