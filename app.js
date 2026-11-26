/* Turkey Day Best Ball — static, no backend.
   Draft state lives in this browser (localStorage). A share link carries a
   read-only copy of the rosters; every browser pulls live stats from ESPN. */
'use strict';

const LS_KEY = 'tdbb.v1';
const ESPN = 'https://site.api.espn.com/apis/site/v2/sports/football/nfl';
const SLATE_DATE = '20261126';

// Full PPR
const SCORING = {
  passYd: 0.04, passTd: 4, int: -1,
  rushYd: 0.1, rushTd: 6,
  rec: 1, recYd: 0.1, recTd: 6,
  retTd: 6, twoPt: 2, fumLost: -2,
};

// Lineup slots, most restrictive first (the best-ball optimizer relies on this order).
const SLOTS = [
  { key: 'QB', label: 'QB', pos: ['QB'] },
  { key: 'RB', label: 'RB', pos: ['RB'] },
  { key: 'WRTE', label: 'WR/TE', pos: ['WR', 'TE'] },
  { key: 'FLEX', label: 'FLEX', pos: ['RB', 'WR', 'TE'] },
];

let pool = null;            // data/players.json
const byId = new Map();     // player id -> player
const byName = new Map();   // normalized name -> player
let S = null;               // draft state
let viewOnly = false;       // opened from a share link
let tab = 'setup';
const ui = { filter: 'ALL', q: '', hideDrafted: true, pending: null, unlocked: false };
const live = { games: {}, stats: new Map(), twoPt: new Map(), updated: null, error: null, finalLoaded: new Set() };
let pollTimer = null;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(1);

/* ---------- state ---------- */

function blankState() {
  return {
    v: 1, name: 'Turkey Day Best Ball',
    teams: ['', '', '', '', '', ''],
    rounds: 6,
    slots: { QB: 1, RB: 1, WRTE: 2, FLEX: 1 },
    pin: null, picks: [], adj: {}, status: 'setup',
  };
}

function save() {
  if (!viewOnly) localStorage.setItem(LS_KEY, JSON.stringify(S));
}

function loadState() {
  const m = location.hash.match(/[#&]d=([A-Za-z0-9_-]+)/);
  if (m) {
    try {
      const d = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(m[1].replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0))));
      viewOnly = true;
      const total = d.t.length * d.r;
      return { v: 1, name: d.n, teams: d.t, rounds: d.r, slots: d.s, pin: null, picks: d.p || [], adj: d.a || {}, status: (d.p || []).length >= total ? 'done' : 'drafting' };
    } catch (e) { console.warn('bad share link', e); }
  }
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.v === 1) return s;
  } catch (e) { /* fall through */ }
  return blankState();
}

function shareUrl() {
  const d = { n: S.name, t: S.teams, r: S.rounds, s: S.slots, p: S.picks, a: S.adj };
  const bytes = new TextEncoder().encode(JSON.stringify(d));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return location.origin + location.pathname + '#d=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

async function hashPin(pin) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode('tdbb:' + pin));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
const isAdmin = () => !viewOnly && (!S.pin || ui.unlocked);

/* ---------- draft math ---------- */

const nTeams = () => S.teams.length;
const totalPicks = () => nTeams() * S.rounds;
function teamForPick(i) {
  const n = nTeams(), r = Math.floor(i / n), p = i % n;
  return r % 2 === 0 ? p : n - 1 - p;
}
const pickLabel = (i) => `${Math.floor(i / nTeams()) + 1}.${String((i % nTeams()) + 1).padStart(2, '0')}`;
function rosterOf(t) {
  const out = [];
  S.picks.forEach((pid, i) => { if (teamForPick(i) === t) out.push(pid); });
  return out;
}
const teamName = (t) => S.teams[t] || `Team ${t + 1}`;

/* Best-ball lineup: fill slots from most to least restrictive with the top
   remaining scorers. Slot eligibility is nested, so this greedy pass is optimal. */
function bestLineup(pids, valueOf) {
  const left = pids.map((pid) => ({ pid, v: valueOf(pid), pos: byId.get(pid)?.pos })).sort((a, b) => b.v - a.v);
  const rows = [];
  for (const slot of SLOTS) {
    for (let k = 0; k < (S.slots[slot.key] || 0); k++) {
      const idx = left.findIndex((x) => slot.pos.includes(x.pos));
      rows.push({ slot: slot.label, pid: idx >= 0 ? left.splice(idx, 1)[0].pid : null, starter: true });
    }
  }
  left.forEach((x) => rows.push({ slot: 'BN', pid: x.pid, starter: false }));
  return rows;
}

/* ---------- live scoring ---------- */

function pointsFromStats(st, twoPt) {
  const g = (k) => st[k] || 0;
  return (
    g('passing.passingYards') * SCORING.passYd +
    g('passing.passingTouchdowns') * SCORING.passTd +
    g('passing.interceptions') * SCORING.int +
    g('rushing.rushingYards') * SCORING.rushYd +
    g('rushing.rushingTouchdowns') * SCORING.rushTd +
    g('receiving.receptions') * SCORING.rec +
    g('receiving.receivingYards') * SCORING.recYd +
    g('receiving.receivingTouchdowns') * SCORING.recTd +
    (g('kickReturns.kickReturnTouchdowns') + g('puntReturns.puntReturnTouchdowns')) * SCORING.retTd +
    g('fumbles.fumblesLost') * SCORING.fumLost +
    (twoPt || 0) * SCORING.twoPt
  );
}

function statLine(st, twoPt) {
  const g = (k) => st[k] || 0, parts = [];
  if (g('passing.passingAttempts')) {
    parts.push(`${g('passing.completions')}/${g('passing.passingAttempts')}, ${g('passing.passingYards')} yd` +
      (g('passing.passingTouchdowns') ? `, ${g('passing.passingTouchdowns')} TD` : '') +
      (g('passing.interceptions') ? `, ${g('passing.interceptions')} INT` : ''));
  }
  if (g('rushing.rushingAttempts')) {
    parts.push(`${g('rushing.rushingAttempts')} car, ${g('rushing.rushingYards')} yd` + (g('rushing.rushingTouchdowns') ? `, ${g('rushing.rushingTouchdowns')} TD` : ''));
  }
  if (g('receiving.receptions') || g('receiving.receivingTargets')) {
    parts.push(`${g('receiving.receptions')} rec, ${g('receiving.receivingYards')} yd` + (g('receiving.receivingTouchdowns') ? `, ${g('receiving.receivingTouchdowns')} TD` : ''));
  }
  const ret = g('kickReturns.kickReturnTouchdowns') + g('puntReturns.puntReturnTouchdowns');
  if (ret) parts.push(`${ret} ret TD`);
  if (twoPt) parts.push(`${twoPt} 2-pt`);
  if (g('fumbles.fumblesLost')) parts.push(`${g('fumbles.fumblesLost')} fum lost`);
  return parts.join(' · ');
}

function parseSummary(sum) {
  const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
  for (const t of sum.boxscore?.players ?? []) {
    for (const cat of t.statistics ?? []) {
      for (const a of cat.athletes ?? []) {
        const known = byId.get(a.athlete.id) || byName.get(norm(a.athlete.displayName));
        if (!known) continue;
        const st = live.stats.get(known.id) ?? {};
        cat.keys.forEach((k, i) => {
          const raw = String(a.stats[i] ?? '');
          if (k.includes('/')) {
            const ks = k.split('/'), vs = raw.split('/');
            ks.forEach((kk, j) => { st[`${cat.name}.${kk}`] = num(vs[j]); });
          } else {
            st[`${cat.name}.${k}`] = num(raw);
          }
        });
        live.stats.set(known.id, st);
      }
    }
  }
  // Two-point conversions are not in the box score; read them from scoring-play text.
  const counts = new Map();
  const credit = (name) => {
    const p = byName.get(norm(name));
    if (p) counts.set(p.id, (counts.get(p.id) || 0) + 1);
  };
  for (const play of sum.scoringPlays ?? []) {
    const text = play.text || '';
    let m;
    if ((m = text.match(/\(([^()]+?) Pass to ([^()]+?) for Two-Point Conversion\)/i))) { credit(m[1]); credit(m[2]); }
    else if ((m = text.match(/\(([^()]+?) (?:Run|Rush) for Two-Point Conversion\)/i))) credit(m[1]);
  }
  return counts;
}

function pts(pid) {
  const st = live.stats.get(pid);
  return (st ? pointsFromStats(st, live.twoPt.get(pid)) : 0) + (Number(S.adj?.[pid]) || 0);
}
const gameState = (pid) => live.games[byId.get(pid)?.gameId]?.state || 'pre';

async function refreshLive() {
  try {
    const board = await (await fetch(`${ESPN}/scoreboard?dates=${SLATE_DATE}`, { cache: 'no-store' })).json();
    const ids = new Set(pool.games.map((g) => g.id));
    for (const ev of board.events ?? []) {
      if (!ids.has(ev.id)) continue;
      const comp = ev.competitions[0], side = {};
      comp.competitors.forEach((c) => { side[c.homeAway] = { abbr: c.team.abbreviation, score: c.score }; });
      live.games[ev.id] = { state: comp.status.type.state, detail: comp.status.type.shortDetail, home: side.home, away: side.away };
    }
    const need = pool.games.filter((g) => {
      const st = live.games[g.id]?.state;
      return st === 'in' || (st === 'post' && !live.finalLoaded.has(g.id));
    });
    const twoPt = new Map(live.twoPt);
    await Promise.all(need.map(async (g) => {
      const sum = await (await fetch(`${ESPN}/summary?event=${g.id}`, { cache: 'no-store' })).json();
      // reset this game's two-point credits before re-reading them
      pool.players.filter((p) => p.gameId === g.id).forEach((p) => twoPt.delete(p.id));
      parseSummary(sum).forEach((v, k) => twoPt.set(k, v));
      if (live.games[g.id].state === 'post') live.finalLoaded.add(g.id);
    }));
    live.twoPt = twoPt;
    live.updated = new Date();
    live.error = null;
  } catch (e) {
    live.error = 'Could not reach ESPN. Retrying…';
    console.warn(e);
  }
  renderGames();
  if (tab === 'scores') renderView();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const states = pool.games.map((g) => live.games[g.id]?.state || 'pre');
  if (states.every((s) => s === 'post') && live.finalLoaded.size === pool.games.length && !live.error) return;
  const wait = live.error ? 20000 : states.includes('in') ? 30000 : 120000;
  pollTimer = setTimeout(() => { if (!document.hidden) refreshLive(); else schedulePoll(); }, wait);
}

/* ---------- rendering ---------- */

function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast.t);
  toast.t = setTimeout(() => t.classList.remove('show'), 2600);
}

function renderChrome() {
  $('#leagueName').textContent = S.name || 'Turkey Day Best Ball';
  const fmtSlots = SLOTS.filter((s) => S.slots[s.key]).map((s) => `${S.slots[s.key] > 1 ? S.slots[s.key] + ' ' : ''}${s.label}`).join(' · ');
  $('#subline').textContent = S.status === 'setup' && !viewOnly
    ? 'Thanksgiving slate · full PPR'
    : `${nTeams()} drafters · ${S.rounds} rounds · ${fmtSlots} · full PPR${viewOnly ? ' · view only' : ''}`;
  const tabs = [];
  if (S.status === 'setup' && !viewOnly) tabs.push(['setup', 'Setup']);
  else {
    if (!viewOnly && S.status === 'drafting') tabs.push(['draft', 'Draft']);
    tabs.push(['board', 'Board'], ['scores', 'Scores']);
    if (!viewOnly) tabs.push(['commish', 'Commish']);
  }
  if (!tabs.some(([k]) => k === tab)) tab = tabs[0][0];
  $('#tabs').innerHTML = tabs.map(([k, label]) => `<button class="tab${k === tab ? ' on' : ''}" data-tab="${k}">${label}</button>`).join('');
}

function renderGames() {
  if (!pool) return;
  $('#games').innerHTML = pool.games.map((g) => {
    const lg = live.games[g.id];
    const state = lg?.state || 'pre';
    const kick = new Date(g.date).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    const detail = state === 'pre' ? kick : (lg.detail || '');
    const sc = (side, abbr) => `<span class="gteam"><b>${abbr}</b>${state === 'pre' ? '' : `<i>${esc(lg[side]?.score ?? '')}</i>`}</span>`;
    return `<div class="game ${state}">${sc('away', g.away)}<span class="at">@</span>${sc('home', g.home)}<span class="gstat">${state === 'in' ? '<span class="dot"></span>' : ''}${esc(detail)}</span></div>`;
  }).join('') + (live.error ? `<div class="game err">${esc(live.error)}</div>` : '');
}

function render() { renderChrome(); renderGames(); renderView(); }

function renderView() {
  const v = $('#view');
  if (tab === 'setup') v.innerHTML = viewSetup();
  else if (tab === 'draft') { v.innerHTML = viewDraft(); renderPoolRows(); }
  else if (tab === 'board') v.innerHTML = `<div class="panel">${boardHtml()}</div>`;
  else if (tab === 'scores') v.innerHTML = viewScores();
  else if (tab === 'commish') v.innerHTML = viewCommish();
}

/* --- setup --- */

function stepper(label, key, val, min, max, hint) {
  return `<div class="field"><label>${label}</label><div class="stepper"><button data-step="${key}" data-d="-1" ${val <= min ? 'disabled' : ''} aria-label="Fewer">−</button><output>${val}</output><button data-step="${key}" data-d="1" ${val >= max ? 'disabled' : ''} aria-label="More">+</button></div>${hint ? `<small>${hint}</small>` : ''}</div>`;
}

function viewSetup() {
  const starters = SLOTS.reduce((n, s) => n + (S.slots[s.key] || 0), 0);
  return `
  <div class="setup">
    <div class="panel">
      <h2>League</h2>
      <div class="field wide"><label for="f-name">League name</label><input id="f-name" data-f="name" value="${esc(S.name)}" maxlength="40"></div>
      <div class="field"><label>Drafters</label>
        <div class="seg">${[4, 5, 6, 7, 8].map((n) => `<button data-count="${n}" class="${n === nTeams() ? 'on' : ''}">${n}</button>`).join('')}</div>
      </div>
      <div class="row">
        ${stepper('Rounds', 'rounds', S.rounds, 3, 10, `${nTeams() * S.rounds} picks from a pool of ${pool.players.length}`)}
      </div>
      <h3>Starting lineup <span class="muted">(${starters} starters, ${Math.max(0, S.rounds - starters)} bench — best ball picks your top scorers automatically)</span></h3>
      <div class="row">
        ${SLOTS.map((s) => stepper(s.label, 'slot:' + s.key, S.slots[s.key] || 0, 0, 4)).join('')}
      </div>
      <h3>Commissioner PIN <span class="muted">(optional)</span></h3>
      <div class="field wide"><input id="f-pin" type="password" inputmode="numeric" autocomplete="off" placeholder="e.g. 4 digits" maxlength="12">
      <small>Locks undo, reset and score adjustments on this device. It is a courtesy lock, not real security.</small></div>
    </div>
    <div class="panel">
      <h2>Draft order <button class="ghost sm" data-act="shuffle">Randomize</button></h2>
      <ol class="order">
        ${S.teams.map((t, i) => `<li><span class="num">${i + 1}</span><input data-team="${i}" value="${esc(t)}" placeholder="Team ${i + 1}" maxlength="24">
          <button class="ghost sm" data-move="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="ghost sm" data-move="${i}" data-d="1" ${i === nTeams() - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></li>`).join('')}
      </ol>
      <p class="muted">Snake draft: the order reverses every round.</p>
      <button class="primary big" data-act="start">Start the draft</button>
    </div>
  </div>`;
}

/* --- draft --- */

function viewDraft() {
  const i = S.picks.length, t = teamForPick(i);
  const next = i + 1 < totalPicks() ? teamName(teamForPick(i + 1)) : null;
  const mine = rosterOf(t).map((pid) => byId.get(pid)).filter(Boolean);
  return `
  <div class="draft">
    <div class="col">
      <div class="clock">
        <div><span class="eyebrow">Round ${Math.floor(i / nTeams()) + 1} · Pick ${(i % nTeams()) + 1} <em>(${i + 1} of ${totalPicks()})</em></span>
          <strong>${esc(teamName(t))}</strong><span class="otc">is on the clock</span></div>
        <div class="mine">${mine.length ? mine.map((p) => `<span class="chip ${p.pos}">${p.pos} ${esc(p.name.split(' ').slice(1).join(' ') || p.name)}</span>`).join('') : '<span class="muted">No picks yet</span>'}
          ${next ? `<span class="deck">On deck: ${esc(next)}</span>` : ''}</div>
      </div>
      <div class="panel pool">
        <div class="tools">
          <div class="seg">${['ALL', 'QB', 'RB', 'WR', 'TE'].map((f) => `<button data-filter="${f}" class="${ui.filter === f ? 'on' : ''}">${f === 'ALL' ? 'All' : f}</button>`).join('')}</div>
          <input id="q" type="search" placeholder="Search players" value="${esc(ui.q)}" autocomplete="off">
          <label class="check"><input type="checkbox" id="hideDrafted" ${ui.hideDrafted ? 'checked' : ''}> Hide drafted</label>
        </div>
        <div class="thead"><span>ADP</span><span>Player</span><span class="r">Proj</span><span></span></div>
        <div id="poolRows"></div>
        <p class="foot">ADP is a rank by projected PPR value at each position (Week ${pool.week} projections via Sleeper), not real draft data.</p>
      </div>
    </div>
    <div class="col side"><div class="panel">${boardHtml()}</div></div>
  </div>`;
}

function renderPoolRows() {
  const el = $('#poolRows');
  if (!el) return;
  const taken = new Set(S.picks), q = norm(ui.q);
  const rows = pool.players.filter((p) =>
    (ui.filter === 'ALL' || p.pos === ui.filter) &&
    (!ui.hideDrafted || !taken.has(p.id)) &&
    (!q || norm(p.name).includes(q) || p.team.toLowerCase().includes(ui.q.toLowerCase())));
  el.innerHTML = rows.map((p) => {
    const gone = taken.has(p.id), st = live.games[p.gameId]?.state || 'pre';
    const action = gone ? '<span class="gone">Drafted</span>'
      : ui.pending === p.id ? `<button class="primary sm" data-confirm="${p.id}">Confirm</button><button class="ghost sm" data-cancel="1" aria-label="Cancel">✕</button>`
      : `<button class="draftbtn sm" data-pick="${p.id}">Draft</button>`;
    return `<div class="prow${gone ? ' taken' : ''}${ui.pending === p.id ? ' pending' : ''}">
      <span class="adp">${p.adp}</span>
      <span class="who"><b>${esc(p.name)}</b>${p.inj ? `<span class="inj" title="${esc(p.inj)}">${esc(p.inj[0])}</span>` : ''}
        <small><span class="chip ${p.pos}">${p.pos}${p.posRank}</span> ${p.team} ${p.home ? 'vs' : '@'} ${p.opp}${st === 'in' ? ' <span class="livetag">LIVE</span>' : st === 'post' ? ' <span class="fintag">FINAL</span>' : ''}</small></span>
      <span class="r proj">${fmt(p.proj)}</span>
      <span class="act">${action}</span>
    </div>`;
  }).join('') || '<p class="muted pad">No players match.</p>';
}

function boardHtml() {
  const n = nTeams(), cur = S.picks.length;
  let h = `<div class="boardwrap"><div class="board" style="--n:${n}">`;
  h += S.teams.map((_, t) => `<div class="bh${S.status === 'drafting' && teamForPick(cur) === t ? ' on' : ''}">${esc(teamName(t))}</div>`).join('');
  for (let r = 0; r < S.rounds; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + (r % 2 === 0 ? c : n - 1 - c);
      const p = byId.get(S.picks[i]);
      const arrow = r % 2 === 0 ? '→' : '←';
      if (p) h += `<div class="cell ${p.pos}"><span class="pn">${pickLabel(i)} ${arrow}</span><b>${esc(p.name)}</b><small>${p.pos} · ${p.team}</small></div>`;
      else h += `<div class="cell empty${i === cur && S.status === 'drafting' ? ' cur' : ''}"><span class="pn">${pickLabel(i)} ${arrow}</span>${i === cur && S.status === 'drafting' ? '<b>On the clock</b>' : ''}</div>`;
    }
  }
  return h + '</div></div>';
}

/* --- scores --- */

function viewScores() {
  const teams = S.teams.map((_, t) => {
    const ids = rosterOf(t);
    const rows = bestLineup(ids, pts);
    const total = rows.filter((r) => r.starter && r.pid).reduce((s, r) => s + pts(r.pid), 0);
    const proj = bestLineup(ids, (pid) => byId.get(pid)?.proj || 0).filter((r) => r.starter && r.pid).reduce((s, r) => s + (byId.get(r.pid)?.proj || 0), 0);
    const liveN = ids.filter((pid) => gameState(pid) === 'in').length;
    const preN = ids.filter((pid) => gameState(pid) === 'pre').length;
    return { t, rows, total, proj, liveN, preN };
  }).sort((a, b) => b.total - a.total || b.proj - a.proj);
  const anyPicks = S.picks.length > 0;
  const upd = live.updated ? `Updated ${live.updated.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' })}` : 'Waiting for ESPN…';
  return `
  <div class="scorebar">
    <span class="muted">${upd} · refreshes automatically during games</span>
    <span class="grow"></span>
    <button class="ghost sm" data-act="refresh">Refresh</button>
    ${anyPicks ? '<button class="primary sm" data-act="share">Copy share link</button>' : ''}
  </div>
  ${anyPicks ? '' : '<p class="muted pad">No picks yet. Scores appear here once the draft starts.</p>'}
  <div class="cards">
    ${teams.map((x, rank) => `
    <article class="card${rank === 0 && x.total > 0 ? ' lead' : ''}">
      <header><span class="rank">${rank + 1}</span><h3>${esc(teamName(x.t))}</h3>
        <div class="tot"><strong>${fmt(x.total)}</strong><small>proj ${fmt(x.proj)}</small></div></header>
      <p class="status">${x.liveN ? `<span class="livetag">${x.liveN} live</span> ` : ''}${x.preN ? `${x.preN} yet to play` : x.liveN ? '' : x.rows.length ? 'All players final' : ''}</p>
      <ul>
        ${x.rows.map((r) => {
          const p = r.pid && byId.get(r.pid);
          if (!p) return `<li class="${r.starter ? '' : 'bn'} hole"><span class="slot">${r.slot}</span><span class="who muted">Empty</span><span class="pp">0.0</span></li>`;
          const st = live.stats.get(p.id), gs = gameState(p.id), adj = Number(S.adj?.[p.id]) || 0;
          const line = st ? statLine(st, live.twoPt.get(p.id)) : '';
          return `<li class="${r.starter ? '' : 'bn'} ${gs}"><span class="slot">${r.slot}</span>
            <span class="who"><span class="l1"><b>${esc(p.name)}</b> <span class="chip ${p.pos}">${p.pos}</span> <small>${p.team}</small></span>
              <small class="line">${gs === 'pre' ? `${p.home ? 'vs' : '@'} ${p.opp} · proj ${fmt(p.proj)}` : esc(line || 'No stats yet')}${adj ? ` · adj ${adj > 0 ? '+' : ''}${adj}` : ''}</small></span>
            <span class="pp">${gs === 'in' ? '<span class="dot"></span>' : ''}${fmt(pts(p.id))}</span></li>`;
        }).join('')}
      </ul>
    </article>`).join('')}
  </div>
  <details class="rules"><summary>Scoring (full PPR)</summary>
    <p>Passing: 1 pt per 25 yards, 4 per TD, −1 per interception. Rushing and receiving: 1 pt per 10 yards, 6 per TD, 1 per reception. Return TD 6, two-point conversion 2, fumble lost −2. Each team's best ${SLOTS.filter((s) => S.slots[s.key]).map((s) => `${S.slots[s.key]} ${s.label}`).join(', ')} count; the rest sit on the bench. Stats come from ESPN's live box score.</p>
  </details>`;
}

/* --- commish --- */

function viewCommish() {
  if (S.pin && !ui.unlocked) {
    return `<div class="panel narrow"><h2>Commissioner</h2><p class="muted">Enter the PIN to unlock undo, reset and score adjustments.</p>
      <form data-form="unlock" class="inline"><input id="pinTry" type="password" inputmode="numeric" autocomplete="off" placeholder="PIN" autofocus><button class="primary">Unlock</button></form></div>`;
  }
  const drafted = S.picks.map((pid) => byId.get(pid)).filter(Boolean).sort((a, b) => a.name.localeCompare(b.name));
  const last = byId.get(S.picks[S.picks.length - 1]);
  const adjRows = Object.entries(S.adj || {}).filter(([, v]) => Number(v));
  return `
  <div class="setup">
    <div class="panel">
      <h2>Draft controls ${S.pin ? '<button class="ghost sm" data-act="lock">Lock</button>' : ''}</h2>
      <p class="muted">${S.picks.length} of ${totalPicks()} picks made${last ? ` · last: ${esc(last.name)}` : ''}</p>
      <div class="btnrow">
        <button class="ghost" data-act="undo" ${S.picks.length ? '' : 'disabled'}>Undo last pick</button>
        <button class="ghost" data-act="share">Copy share link</button>
        <button class="danger" data-act="reset">Reset draft</button>
      </div>
      <p class="muted">The share link is a snapshot of the rosters. Copy it again after any change and re-send it. Everyone's scores update live on their own.</p>
      <h3>Team names</h3>
      <ol class="order">${S.teams.map((t, i) => `<li><span class="num">${i + 1}</span><input data-team="${i}" value="${esc(t)}" placeholder="Team ${i + 1}" maxlength="24"></li>`).join('')}</ol>
    </div>
    <div class="panel">
      <h2>Score adjustments</h2>
      <p class="muted">For anything the box score misses (a stat correction, a fumble-recovery TD). Adds to the player's points.</p>
      <form data-form="adj" class="inline">
        <select id="adjPlayer">${drafted.map((p) => `<option value="${p.id}">${esc(p.name)} (${p.team})</option>`).join('') || '<option value="">No drafted players</option>'}</select>
        <input id="adjPts" type="number" step="0.1" placeholder="+/- pts" required>
        <button class="primary">Apply</button>
      </form>
      <ul class="adjlist">${adjRows.map(([pid, v]) => `<li>${esc(byId.get(pid)?.name || pid)} <b>${v > 0 ? '+' : ''}${v}</b> <button class="ghost sm" data-adjclear="${pid}">Remove</button></li>`).join('') || '<li class="muted">None</li>'}</ul>
    </div>
  </div>`;
}

/* ---------- actions ---------- */

async function copyShare() {
  const url = shareUrl();
  try { await navigator.clipboard.writeText(url); toast('Share link copied'); }
  catch (e) { window.prompt('Copy this link', url); }
}

function makePick(pid) {
  if (viewOnly || S.status !== 'drafting' || S.picks.includes(pid) || !byId.has(pid)) return;
  S.picks.push(pid);
  ui.pending = null;
  if (S.picks.length >= totalPicks()) { S.status = 'done'; tab = 'scores'; toast('Draft complete. Copy the share link for everyone.'); }
  save(); render();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const d = b.dataset;
  if (d.tab) { tab = d.tab; ui.pending = null; render(); return; }
  if (d.filter) { ui.filter = d.filter; renderView(); return; }
  if (d.pick) { ui.pending = d.pick; renderPoolRows(); return; }
  if (d.cancel) { ui.pending = null; renderPoolRows(); return; }
  if (d.confirm) { makePick(d.confirm); return; }
  if (d.count) {
    const n = +d.count;
    while (S.teams.length < n) S.teams.push('');
    S.teams.length = n;
    save(); render(); return;
  }
  if (d.step) {
    const delta = +d.d;
    if (d.step === 'rounds') S.rounds = Math.min(10, Math.max(3, S.rounds + delta));
    else { const k = d.step.split(':')[1]; S.slots[k] = Math.min(4, Math.max(0, (S.slots[k] || 0) + delta)); }
    save(); render(); return;
  }
  if (d.move) {
    const i = +d.move, j = i + +d.d;
    [S.teams[i], S.teams[j]] = [S.teams[j], S.teams[i]];
    save(); renderView(); return;
  }
  if (d.adjclear) { delete S.adj[d.adjclear]; save(); renderView(); return; }
  switch (d.act) {
    case 'shuffle': {
      S.teams = S.teams.map((t, i) => t || `Team ${i + 1}`);
      for (let i = S.teams.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [S.teams[i], S.teams[j]] = [S.teams[j], S.teams[i]];
      }
      save(); renderView(); toast('Draft order randomized'); break;
    }
    case 'start': {
      const pin = $('#f-pin')?.value.trim();
      S.teams = S.teams.map((t, i) => t.trim() || `Team ${i + 1}`);
      S.pin = pin ? await hashPin(pin) : null;
      ui.unlocked = true;
      S.picks = []; S.status = 'drafting'; tab = 'draft';
      save(); render(); break;
    }
    case 'undo':
      if (!isAdmin() || !S.picks.length) break;
      S.picks.pop(); S.status = 'drafting';
      save(); render(); toast('Last pick undone'); break;
    case 'reset':
      if (!isAdmin() || !window.confirm('Reset the draft? All picks are cleared and you go back to setup.')) break;
      S.picks = []; S.adj = {}; S.status = 'setup'; tab = 'setup';
      save(); render(); break;
    case 'lock': ui.unlocked = false; renderView(); break;
    case 'share': copyShare(); break;
    case 'refresh': await refreshLive(); toast('Scores refreshed'); break;
    default:
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'q') { ui.q = el.value; renderPoolRows(); }
  else if (el.id === 'hideDrafted') { ui.hideDrafted = el.checked; renderPoolRows(); }
  else if (el.dataset.f === 'name') { S.name = el.value; save(); $('#leagueName').textContent = S.name || 'Turkey Day Best Ball'; }
  else if (el.dataset.team !== undefined && isAdmin()) { S.teams[+el.dataset.team] = el.value; save(); }
});

document.addEventListener('submit', async (e) => {
  e.preventDefault();
  const kind = e.target.dataset.form;
  if (kind === 'unlock') {
    if ((await hashPin($('#pinTry').value.trim())) === S.pin) { ui.unlocked = true; renderView(); }
    else toast('Wrong PIN');
  } else if (kind === 'adj' && isAdmin()) {
    const pid = $('#adjPlayer').value, v = parseFloat($('#adjPts').value);
    if (!pid || !Number.isFinite(v)) return;
    S.adj[pid] = Math.round(((Number(S.adj[pid]) || 0) + v) * 10) / 10;
    save(); renderView(); toast('Adjustment applied');
  }
});

document.addEventListener('visibilitychange', () => { if (!document.hidden && pool) refreshLive(); });

/* ---------- boot ---------- */

(async function boot() {
  try {
    pool = await (await fetch('data/players.json')).json();
  } catch (e) {
    $('#view').innerHTML = '<p class="loading">Could not load the player pool. Reload to try again.</p>';
    return;
  }
  pool.players.forEach((p) => { byId.set(p.id, p); byName.set(norm(p.name), p); });
  S = loadState();
  S.adj = S.adj || {};
  ui.unlocked = !S.pin;
  tab = S.status === 'setup' ? 'setup' : S.status === 'done' || viewOnly ? 'scores' : 'draft';
  render();
  refreshLive();
})();
