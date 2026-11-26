/* Turkey Day Best Ball — static, no backend.
   Draft state lives in this browser (localStorage). A share link carries a
   read-only copy of the rosters; every browser pulls live stats from ESPN. */
'use strict';

const LS_KEY = 'tdbb.live.v1';
const NTFY = 'https://ntfy.sh';   // free pub/sub relay, no account; the room code is the only key
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
  { key: 'WR', label: 'WR', pos: ['WR'] },
  { key: 'TE', label: 'TE', pos: ['TE'] },
  { key: 'WRTE', label: 'WR/TE', pos: ['WR', 'TE'] },
  { key: 'FLEX', label: 'FLEX', pos: ['RB', 'WR', 'TE'] },
];

let pool = null;            // data/players.json
const byId = new Map();     // player id -> player
const byName = new Map();   // normalized name -> player
let S = null;               // draft state
let viewOnly = false;       // opened from a share link or a locked draft
let locked = false;         // data/draft.json in the repo holds the final draft
let tab = 'setup';
const ui = { filter: 'ALL', q: '', hideDrafted: true, pending: null, unlocked: false, ouDraft: {}, ouAs: 0, ouSent: null, open: new Set() };
const live = { games: {}, stats: new Map(), twoPt: new Map(), updated: null, error: null, finalLoaded: new Set() };
let pollTimer = null;
let guest = false;          // joined from a phone through the join link
let room = null;            // relay topic prefix shared by host and guests
let me = null;              // guest's team index; -1 = just watching; null = not chosen yet
const net = { ok: false, es: null, seq: 0, sending: null, pubTimer: null, opened: 0, seen: new Set() };

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const norm = (s) => String(s).toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, '').replace(/[^a-z]/g, '');
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(1);

/* Headshot in a team-colored circle; falls back to initials if ESPN has no photo. */
function av(p, cls = '', w = 96) {
  const color = pool.teams[p.team]?.color || '333333';
  const initials = p.name.split(' ').map((x) => x[0]).slice(0, 2).join('');
  const img = /^\d+$/.test(p.id)
    ? `<img src="https://a.espncdn.com/combiner/i?img=/i/headshots/nfl/players/full/${p.id}.png&w=${w}&h=${Math.round(w * 0.73)}" alt="" loading="lazy" onerror="this.remove()">` : '';
  return `<span class="av ${cls}" style="--tc:#${color}"><i>${esc(initials)}</i>${img}</span>`;
}

/* How far a pick landed from the player's ADP. */
function valueTag(i, always) {
  const p = byId.get(S.picks[i]);
  if (!p) return '';
  const d = i + 1 - p.adp;
  if (d >= 3) return `<span class="val steal">+${d} steal</span>`;
  if (d <= -3) return `<span class="val reach">−${-d} reach</span>`;
  return always ? '<span class="val even">right at ADP</span>' : '';
}

let actx = null;
function chime() {
  if (ui.sound === false) return;
  try {
    actx = actx || new (window.AudioContext || window.webkitAudioContext)();
    const t = actx.currentTime;
    [[660, 0], [880, 0.12], [1320, 0.24]].forEach(([f, d]) => {
      const o = actx.createOscillator(), g = actx.createGain();
      o.type = 'triangle'; o.frequency.value = f;
      g.gain.setValueAtTime(0.0001, t + d);
      g.gain.exponentialRampToValueAtTime(0.16, t + d + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.4);
      o.connect(g); g.connect(actx.destination);
      o.start(t + d); o.stop(t + d + 0.45);
    });
  } catch (e) { /* sound is optional */ }
}

/* Full-screen flash for each pick. Taps pass through it, so it never blocks the next drafter. */
function announce(i) {
  const p = byId.get(S.picks[i]);
  if (!p) return;
  let el = $('#announce');
  if (!el) { el = document.createElement('div'); el.id = 'announce'; document.body.appendChild(el); }
  el.style.setProperty('--tc', '#' + (pool.teams[p.team]?.color || '333333'));
  el.innerHTML = `<div class="acard"><span class="eyebrow">Round ${Math.floor(i / nTeams()) + 1} · Pick ${(i % nTeams()) + 1}</span>
    ${av(p, 'xl', 264)}
    <p class="ateam">${esc(teamName(teamForPick(i)))} selects</p>
    <h2>${esc(p.name)}</h2>
    <p class="ameta"><span class="chip ${p.pos}">${p.pos}${p.posRank}</span> ${p.team} · ADP ${p.adp} ${valueTag(i, true)}</p></div>`;
  el.classList.remove('show');
  void el.offsetWidth;
  el.classList.add('show');
  clearTimeout(announce.t);
  announce.t = setTimeout(() => el.classList.remove('show'), 2400);
  if (!guest) chime();
}

/* ---------- state ---------- */

function newRoom() {
  const a = crypto.getRandomValues(new Uint8Array(16));
  return 'tdbb' + [...a].map((b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join('');
}

function blankState() {
  return {
    v: 1, name: 'Turkey Day Best Ball',
    teams: ['', '', '', '', '', ''],
    rounds: 7,
    slots: { QB: 1, RB: 1, WR: 2, TE: 1, WRTE: 0, FLEX: 1 },
    pin: null, picks: [], adj: {}, status: 'setup', room: newRoom(),
  };
}

function save() {
  if (viewOnly) return;
  localStorage.setItem(LS_KEY, JSON.stringify(S));
  if (S.status !== 'setup' || S.pub) schedulePublish();
}

/* Compact draft record, used by both the share link and the draft file. */
function packDraft() {
  return { n: S.name, t: S.teams, r: S.rounds, s: S.slots, p: S.picks, a: S.adj, au: S.auto || [], ...(S.ou ? { o: S.ou } : {}) };
}
function unpackDraft(d) {
  if (!d || !Array.isArray(d.t) || !d.t.length || !Number.isInteger(d.r) || !d.s || !Array.isArray(d.p)) throw new Error('not a draft record');
  const total = d.t.length * d.r;
  return {
    v: 1, name: String(d.n || 'Turkey Day Best Ball'), teams: d.t.map(String), rounds: d.r, slots: d.s, pin: null,
    picks: d.p.map(String).slice(0, total), adj: d.a || {}, auto: Array.isArray(d.au) ? d.au : [], ou: d.o && Array.isArray(d.o.l) && Array.isArray(d.o.p) ? d.o : null, status: d.st || (d.p.length >= total ? 'done' : d.p.length || d.started ? 'drafting' : 'setup'),
  };
}

function loadState() {
  try {
    const s = JSON.parse(localStorage.getItem(LS_KEY));
    if (s && s.v === 1) { s.room = s.room || newRoom(); return s; }
  } catch (e) { /* fall through */ }
  return blankState();
}

/* The default lineup changed from QB/RB/2 WR-TE/FLEX to QB/RB/2 WR/TE/FLEX.
   A draft that has not started yet and still holds the old default moves over. */
function migrateSlots(st) {
  const s = st.slots || {};
  if (st.status === 'setup' && s.QB === 1 && s.RB === 1 && s.WRTE === 2 && s.FLEX === 1 && !s.WR && !s.TE) {
    st.slots = { QB: 1, RB: 1, WR: 2, TE: 1, WRTE: 0, FLEX: 1 };
  }
  if (st.status === 'setup' && !st.m7 && st.rounds === 6) st.rounds = 7;
  st.m7 = 1;
  return st;
}

function downloadDraft() {
  const rosters = {};
  S.teams.forEach((_, t) => { rosters[teamName(t)] = rosterOf(t).map((pid) => { const p = byId.get(pid); return p ? `${p.name} (${p.pos}, ${p.team})` : pid; }); });
  const file = { app: 'turkey-day-best-ball', saved: new Date().toISOString(), ...packDraft(), started: S.status !== 'setup', rosters };
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(file, null, 1)], { type: 'application/json' }));
  a.download = 'draft.json';
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  toast('Draft file downloaded');
}

async function restoreDraft(file) {
  try {
    const s = unpackDraft(JSON.parse(await file.text()));
    const unknown = s.picks.filter((pid) => !byId.has(pid));
    if (unknown.length) throw new Error('unknown players');
    if (S.picks.length && !window.confirm(`Replace the current draft (${S.picks.length} picks) with the one in this file (${s.picks.length} picks)?`)) return;
    s.pin = S.pin; s.room = S.room; s.pub = true;
    S = s;
    tab = S.status === 'setup' ? 'setup' : S.status === 'done' ? 'scores' : 'draft';
    save(); render(); toast('Draft restored from file');
  } catch (e) {
    console.warn(e);
    toast('That file is not a draft file for this slate');
  }
}

function shareUrl() {
  const bytes = new TextEncoder().encode(JSON.stringify(packDraft()));
  let bin = '';
  bytes.forEach((b) => { bin += String.fromCharCode(b); });
  return new URL('../', location.href).href + '#d=' + btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

const joinUrl = () => location.origin + location.pathname + '#r=' + S.room;

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
      live.games[ev.id] = { state: comp.status.type.state, detail: comp.status.type.shortDetail, home: side.home, away: side.away, ou: comp.odds?.[0]?.overUnder ?? live.games[ev.id]?.ou ?? null };
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
  if (tab === 'scores' || tab === 'ou' || tab === 'me') renderView();
  schedulePoll();
}

function schedulePoll() {
  clearTimeout(pollTimer);
  const states = pool.games.map((g) => live.games[g.id]?.state || 'pre');
  if (states.every((s) => s === 'post') && live.finalLoaded.size === pool.games.length && !live.error) return;
  const wait = live.error ? 20000 : states.includes('in') ? 30000 : 120000;
  pollTimer = setTimeout(() => { if (!document.hidden) refreshLive(); else schedulePoll(); }, wait);
}

/* ---------- live sync: the host is the source of truth ----------
   The host publishes a full snapshot to <room>-s after every change. Guests
   listen to it and send pick requests to <room>-r, which the host validates
   and applies. If the relay is down, the host can still make every pick. */

function setNet(ok) {
  if (net.ok === ok) return;
  net.ok = ok;
  renderGames();
}

function schedulePublish() {
  clearTimeout(net.pubTimer);
  net.pubTimer = setTimeout(publishNow, 120);
}

async function publishNow() {
  if (guest || !S) return;
  try {
    const r = await fetch(`${NTFY}/${S.room}-s`, { method: 'POST', body: JSON.stringify({ q: Date.now(), st: S.status, ...packDraft() }) });
    setNet(r.ok);
    if (r.status === 429) toast('Sync relay is rate-limiting. Picks on this screen still work.');
  } catch (e) { setNet(false); }
}

function listen(topic, onMsg, onOpen) {
  if (net.es) net.es.close();
  const es = new EventSource(`${NTFY}/${topic}/sse`);
  net.es = es;
  es.onopen = (e) => {
    if (e instanceof MessageEvent) return;   // the relay also sends a named "open" event
    setNet(true); net.opened++;
    if (onOpen) onOpen();
  };
  es.onmessage = (e) => { try { onMsg(JSON.parse(JSON.parse(e.data).message)); } catch (err) { console.warn('bad sync message', err); } };
  es.onerror = () => setNet(false);
}

async function pollTopic(topic, since) {
  const r = await fetch(`${NTFY}/${topic}/json?poll=1&since=${since}`, { cache: 'no-store' });
  if (!r.ok) throw new Error('relay ' + r.status);
  return (await r.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((m) => m.event === 'message')
    .map((m) => { try { return JSON.parse(m.message); } catch (e) { return null; } }).filter(Boolean);
}

/* host side */
function connectHost() {
  listen(`${S.room}-r`, onRequest, async () => {
    // after a reconnect, pick up any requests sent while this tab was away
    if (net.opened > 1) { try { (await pollTopic(`${S.room}-r`, '2m')).forEach(onRequest); } catch (e) { /* the guest will retry */ } }
  });
}

function onRequest(m) {
  if (m && m.k === 'ou') {
    if (net.seen.has(m.n)) return;
    net.seen.add(m.n);
    applyOu(m.t, m.v);
    save();   // always republish, so the phone gets its confirmation
    if (tab === 'ou') renderView();
    return;
  }
  if (!m || net.seen.has(m.n) || S.status !== 'drafting') return;
  net.seen.add(m.n);
  const i = S.picks.length;
  if (m.i === i && m.t === teamForPick(i) && byId.has(m.pid) && !S.picks.includes(m.pid)) makePick(m.pid);
  else if (m.i >= i) publishNow();   // invalid request: resend the truth so that phone resyncs
}

/* guest side */
const myTurn = () => guest && !!S && S.status === 'drafting' && me !== null && me >= 0 && teamForPick(S.picks.length) === me;

function connectGuest() { listen(`${room}-s`, applySnapshot, fetchLatest); }

async function fetchLatest() {
  try {
    const all = await pollTopic(`${room}-s`, 'all');
    if (all.length) applySnapshot(all[all.length - 1]);
  } catch (e) { setNet(false); }
}

function applySnapshot(d) {
  if (!d || !(d.q > net.seq)) return;
  let s;
  try { s = unpackDraft(d); } catch (e) { return; }
  net.seq = d.q;
  const first = !S, wasMine = myTurn(), prevStatus = S?.status, prevTeams = S?.teams, prevLen = S ? S.picks.length : null, hadOu = !!(S && S.ou);
  S = s;
  localStorage.setItem(`tdbb.live.guest.${room}`, JSON.stringify(d));
  if (me !== null && me >= 0 && (me >= S.teams.length || (prevTeams && prevTeams[me] !== S.teams[me]))) me = null;
  if (net.sending && S.picks.length > net.sending.i) {
    const ok = S.picks[net.sending.i] === net.sending.pid;
    clearTimeout(net.sending.timer); net.sending = null; ui.pending = null;
    toast(ok ? 'Pick is in' : 'That pick did not go through');
  }
  if (first || prevStatus !== S.status) tab = S.status === 'drafting' ? 'draft' : 'scores';
  if (S.ou && !hadOu && !first) { tab = 'ou'; toast('The over/under game is open'); }
  if (ui.ouSent && S.ou && me !== null && me >= 0) {
    const mine = S.ou.p[me] || '';
    if (Object.entries(ui.ouDraft).every(([i, v]) => mine[i] === v || ouState(S.ou.l[i]).locked)) {
      clearTimeout(ui.ouSent); ui.ouSent = null; ui.ouDraft = {};
      toast('Picks saved');
    }
  }
  if (!wasMine && myTurn()) { tab = 'draft'; toast("You're on the clock"); if (navigator.vibrate) navigator.vibrate(250); }
  rerenderKeepingPlace();
  if (prevLen !== null && S.picks.length > prevLen) announce(S.picks.length - 1);
}

async function sendPick(pid) {
  if (!myTurn() || net.sending || S.picks.includes(pid)) return;
  const req = { n: Math.random().toString(36).slice(2), t: me, i: S.picks.length, pid };
  net.sending = { ...req, timer: setTimeout(() => {
    net.sending = null; ui.pending = null; renderPoolRows();
    toast('Pick did not reach the host. Try again, or call it out.');
    fetchLatest();
  }, 9000) };
  renderPoolRows();
  try {
    const r = await fetch(`${NTFY}/${room}-r`, { method: 'POST', body: JSON.stringify(req) });
    if (!r.ok) throw new Error('relay ' + r.status);
  } catch (e) {
    if (net.sending) clearTimeout(net.sending.timer);
    net.sending = null; renderPoolRows();
    toast('Could not send the pick. Check your connection and try again.');
  }
}

function rerenderKeepingPlace() {
  const focused = document.activeElement && document.activeElement.id === 'q';
  const rows = $('#poolRows'), scroll = rows ? rows.scrollTop : 0;
  render();
  const q = $('#q');
  if (focused && q) { q.focus(); q.setSelectionRange(q.value.length, q.value.length); }
  if (scroll && $('#poolRows')) $('#poolRows').scrollTop = scroll;
}

async function copyJoin() {
  const url = joinUrl();
  try { await navigator.clipboard.writeText(url); toast('Join link copied. Text it to everyone.'); }
  catch (e) { window.prompt('Copy this join link', url); }
}

function netPill() {
  if (!guest && (!S || S.status === 'setup')) return '';
  return `<div class="game net ${net.ok ? 'ok' : 'bad'}"><span class="sdot"></span>${net.ok ? 'Live sync on' : 'Reconnecting…'}</div>`;
}

function inviteBar() {
  return `<div class="invite"><div><b>Phone drafting is on.</b> <span class="muted">Send the join link. Each person picks on their own turn, and you can still pick for anyone from this screen.</span></div><button class="primary sm" data-act="join">Copy join link</button></div>`;
}

function viewWho() {
  return `<div class="panel narrow"><h2>Who are you?</h2><p class="muted">Tap your name. You can draft from this phone when it is your turn.</p>
    <div class="who-list">${S.teams.map((_, t) => `<button class="ghost" data-iam="${t}">${esc(teamName(t))}</button>`).join('')}
    <button class="link" data-iam="-1">Just watching</button></div></div>`;
}

/* ---------- over/under game ----------
   S.ou = { l: [[kind, ref, line], ...], lock: ms, p: ['ou-…' one string per team] }
   kind g = a game's total points, p = a player's fantasy points, t = a drafter's team total.
   Each pick string is index-aligned with the lines: o, u or - (no pick). */

const gameOf = (ln) => (ln[0] === 'g' ? ln[1] : ln[0] === 'p' ? byId.get(ln[1])?.gameId : null);
const kickoff = (gid) => +new Date(pool.games.find((g) => g.id === gid)?.date || 0);
const lockTime = (ln) => (gameOf(ln) ? kickoff(gameOf(ln)) : S.ou.lock);
const ouWho = () => (guest ? me : Math.min(ui.ouAs, nTeams() - 1));

function ouState(ln) {
  const gid = gameOf(ln);
  if (gid) {
    const st = live.games[gid]?.state || 'pre';
    return { locked: st !== 'pre' || Date.now() >= kickoff(gid), final: st === 'post', started: st !== 'pre' };
  }
  return { locked: Date.now() >= S.ou.lock, final: pool.games.every((g) => live.games[g.id]?.state === 'post'), started: true };
}

function teamTotal(t, valueOf = pts) {
  return bestLineup(rosterOf(t), valueOf).filter((r) => r.starter && r.pid).reduce((sum, r) => sum + valueOf(r.pid), 0);
}

function ouActual(ln) {
  if (ln[0] === 'g') { const g = live.games[ln[1]]; return g ? (+g.home.score || 0) + (+g.away.score || 0) : 0; }
  return Math.round((ln[0] === 'p' ? pts(ln[1]) : teamTotal(ln[1])) * 100) / 100;
}

/* 'o' or 'u' once decided (or as soon as the over is passed), 'x' for a push, null while open */
function ouOutcome(ln) {
  const st = ouState(ln), a = ouActual(ln);
  if (st.final) return a > ln[2] ? 'o' : a < ln[2] ? 'u' : 'x';
  return st.started && a > ln[2] ? 'o' : null;
}

function ouLabel(ln) {
  if (ln[0] === 'g') {
    const g = pool.games.find((x) => x.id === ln[1]);
    return { title: `${g.away} @ ${g.home} total points`, sub: 'Both teams combined · sportsbook line', icon: '<span class="ico">🏈</span>' };
  }
  if (ln[0] === 'p') {
    const p = byId.get(ln[1]);
    return { title: esc(p.name), sub: `Fantasy points · ${p.pos} ${p.team}`, icon: av(p, 'sm') };
  }
  return { title: `${esc(teamName(ln[1]))}'s team`, sub: 'Final best-ball score', icon: `<span class="ico">${esc(teamName(ln[1])[0] || '?')}</span>` };
}

/* Lines only for games that have not kicked off: the real game total from the
   sportsbook line in ESPN's feed, the two QBs and top two other players per
   game from projections, and every drafter's expected final team total. */
function buildOu() {
  const now = Date.now();
  const open = pool.games.filter((g) => (live.games[g.id]?.state || 'pre') === 'pre' && +new Date(g.date) > now);
  if (!open.length) return false;
  const half = (x) => Math.floor(x) + 0.5;
  const lines = [];
  for (const g of open) {
    const total = live.games[g.id]?.ou;
    if (total) lines.push(['g', g.id, total]);
    const ps = pool.players.filter((p) => p.gameId === g.id).sort((a, b) => b.proj - a.proj);
    [...ps.filter((p) => p.pos === 'QB').slice(0, 2), ...ps.filter((p) => p.pos !== 'QB').slice(0, 2)]
      .forEach((p) => lines.push(['p', p.id, half(p.proj)]));
  }
  const expected = (pid) => {
    const st = gameState(pid), proj = byId.get(pid)?.proj || 0;
    return st === 'post' ? pts(pid) : st === 'in' ? Math.max(pts(pid), proj) : proj;
  };
  S.teams.forEach((_, t) => lines.push(['t', t, half(teamTotal(t, expected))]));
  S.ou = { l: lines, lock: Math.min(...open.map((g) => +new Date(g.date))), p: S.teams.map(() => '-'.repeat(lines.length)) };
  ui.ouDraft = {};
  return true;
}

function applyOu(t, str) {
  if (!S.ou || !Number.isInteger(t) || t < 0 || t >= nTeams() || typeof str !== 'string') return;
  const cur = (S.ou.p[t] || '').padEnd(S.ou.l.length, '-').split('');
  S.ou.l.forEach((ln, i) => {
    if ((str[i] === 'o' || str[i] === 'u') && !ouState(ln).locked) cur[i] = str[i];
  });
  S.ou.p[t] = cur.join('');
}

function ouTap(i, v) {
  const t = ouWho();
  if (!S.ou || t === null || t < 0 || !S.ou.l[i] || ouState(S.ou.l[i]).locked || ui.ouSent) return;
  if (v === S.ou.p[t]?.[i]) delete ui.ouDraft[i]; else ui.ouDraft[i] = v;
  renderView();
}

async function ouSubmit() {
  const t = ouWho();
  if (!S.ou || t === null || t < 0 || !Object.keys(ui.ouDraft).length || ui.ouSent) return;
  const str = S.ou.l.map((_, i) => ui.ouDraft[i] || '-').join('');
  if (!guest) {
    applyOu(t, str); ui.ouDraft = {};
    save(); renderView(); toast('Picks saved');
    return;
  }
  ui.ouSent = setTimeout(() => { ui.ouSent = null; renderView(); toast('Picks did not reach the host. Tap Save again.'); fetchLatest(); }, 9000);
  renderView();
  try {
    const r = await fetch(`${NTFY}/${room}-r`, { method: 'POST', body: JSON.stringify({ n: Math.random().toString(36).slice(2), k: 'ou', t, v: str }) });
    if (!r.ok) throw new Error('relay ' + r.status);
  } catch (e) {
    clearTimeout(ui.ouSent); ui.ouSent = null; renderView();
    toast('Could not send your picks. Check your connection and try again.');
  }
}

function viewOu() {
  if (!S.ou) return '<p class="muted pad">The over/under game has not been started.</p>';
  const t = ouWho(), can = t !== null && t >= 0, total = S.ou.l.length;
  const board = S.teams.map((_, k) => {
    let right = 0, wrong = 0, made = 0;
    S.ou.l.forEach((ln, i) => {
      const v = S.ou.p[k]?.[i];
      if (v !== 'o' && v !== 'u') return;
      made++;
      const out = ouOutcome(ln);
      if (out === v) right++; else if (out && out !== 'x' && ouState(ln).final) wrong++;
    });
    return { k, right, wrong, made };
  }).sort((a, b) => b.right - a.right || a.wrong - b.wrong || b.made - a.made);
  const openN = S.ou.l.filter((ln) => !ouState(ln).locked).length;
  const dirty = Object.keys(ui.ouDraft).length;
  const clock = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

  const row = (ln, i) => {
    const st = ouState(ln), out = ouOutcome(ln), a = ouActual(ln), L = ouLabel(ln);
    const saved = can ? S.ou.p[t]?.[i] : null;
    const mine = can ? (ui.ouDraft[i] || (saved === 'o' || saved === 'u' ? saved : null)) : null;
    const shown = ln[0] === 'g' ? a : fmt(a);
    const status = !st.locked ? `Locks ${clock(lockTime(ln))}` : st.final ? `Final ${shown}` : st.started ? `Now ${shown}` : 'Locked';
    const btn = (v, text) => `<button data-ou="${i}:${v}" class="oub${mine === v ? ' on' : ''}${ui.ouDraft[i] === v ? ' unsaved' : ''}${st.locked && out === v ? ' hit' : ''}" ${st.locked || !can ? 'disabled' : ''}>${text}</button>`;
    const names = (v) => S.teams.map((_, k) => k).filter((k) => S.ou.p[k]?.[i] === v).map((k) => esc(teamName(k))).join(', ') || 'nobody';
    const result = mine && out && out !== 'x' ? (out === mine ? ' won' : st.final ? ' lost' : '') : '';
    return `<div class="ourow${st.locked ? ' locked' : ''}${result}">
      <div class="oul">${L.icon}<div class="wt"><b>${L.title}</b><small>${L.sub}</small></div></div>
      <div class="ouline"><strong>${ln[2]}</strong><small>${status}</small></div>
      <div class="oubtns">${btn('o', 'Over')}${btn('u', 'Under')}</div>
      ${st.locked ? `<div class="ouwho"><span><b>Over:</b> ${names('o')}</span><span><b>Under:</b> ${names('u')}</span></div>` : ''}
    </div>`;
  };
  const section = (title, idxs) => (idxs.length ? `<section class="ousec"><h3>${title}</h3><div class="ourows">${idxs.map((i) => row(S.ou.l[i], i)).join('')}</div></section>` : '');
  const all = S.ou.l.map((_, i) => i);

  return `
  <div class="scorebar">
    <span class="muted">${openN ? `${openN} of ${total} lines still open. Other people's picks stay hidden until a line locks.` : 'Every line is locked.'}</span>
    <span class="grow"></span>
    ${guest ? '' : `<label class="check">Picking as <select id="ouAs">${S.teams.map((_, k) => `<option value="${k}" ${k === ui.ouAs ? 'selected' : ''}>${esc(teamName(k))}</option>`).join('')}</select></label>`}
  </div>
  <div class="oulb">${board.map((b, r) => `<div class="oulbc${r === 0 && b.right ? ' lead' : ''}"><span class="rank">${r + 1}</span><b>${esc(teamName(b.k))}</b><strong>${b.right}</strong><small>${b.made}/${total} picked${b.wrong ? ` · ${b.wrong} missed` : ''}</small></div>`).join('')}</div>
  ${pool.games.map((g) => section(`${g.away} @ ${g.home}`, all.filter((i) => gameOf(S.ou.l[i]) === g.id))).join('')}
  ${section('Team totals', all.filter((i) => S.ou.l[i][0] === 't'))}
  ${can ? '' : '<p class="muted pad">You are watching. Tap Me to pick a name and play.</p>'}
  ${dirty && can ? `<div class="ousubmit"><button class="primary big" data-act="ousubmit" ${ui.ouSent ? 'disabled' : ''}>${ui.ouSent ? 'Sending…' : `Save ${dirty} pick${dirty > 1 ? 's' : ''}`}</button></div>` : ''}`;
}

/* ---------- autodraft (runs on the host only) ---------- */

const isAuto = (t) => !!(S.auto && S.auto[t]);
let autoTimer = null;

/* Best available by ADP at a position the team still needs to start; once the
   starting lineup is full, the best remaining RB, WR or TE. */
function autoChoice(t) {
  const taken = new Set(S.picks), open = new Set();
  bestLineup(rosterOf(t), (pid) => byId.get(pid)?.proj || 0).forEach((r) => {
    if (r.starter && !r.pid) SLOTS.find((x) => x.label === r.slot).pos.forEach((pos) => open.add(pos));
  });
  const avail = pool.players.filter((p) => !taken.has(p.id) && !/^(out|ir|doubtful)/i.test(p.inj || ''));   // ADP order
  const pick = avail.find((p) => open.has(p.pos)) || avail.find((p) => p.pos !== 'QB') || avail[0]
    || pool.players.find((p) => !taken.has(p.id));
  return pick ? pick.id : null;
}

function scheduleAuto() {
  clearTimeout(autoTimer);
  if (viewOnly || !S || S.status !== 'drafting' || ui.autoHold) return;
  const i = S.picks.length, t = teamForPick(i);
  if (!isAuto(t)) return;
  autoTimer = setTimeout(() => {
    if (S.status !== 'drafting' || S.picks.length !== i || !isAuto(teamForPick(i)) || ui.autoHold) return;
    const pid = autoChoice(t);
    if (pid) makePick(pid);
  }, 3500);
}

function autoBar(t) {
  if (viewOnly) return isAuto(t) ? '<div class="autobar"><span class="autotag">AUTO</span> Autodraft is picking for this team.</div>' : '';
  if (isAuto(t)) {
    return ui.autoHold
      ? '<div class="autobar"><span class="autotag">AUTO</span> Autodraft is paused after the undo. <button class="ghost sm" data-act="autoresume">Resume</button></div>'
      : '<div class="autobar"><span class="autotag">AUTO</span> Autodraft picks for this team in a few seconds…</div>';
  }
  return `<div class="autobar"><button class="ghost sm" data-act="autopick">Auto-pick for ${esc(teamName(t))}</button><span>takes the best available player by ADP that fits their lineup</span></div>`;
}

/* ---------- my team + scoring breakdown ---------- */

/* Each stat with the points it earned, as [label, points] rows. */
function breakdown(pid) {
  const st = live.stats.get(pid) || {}, g = (k) => st[k] || 0, rows = [];
  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const count = (n, label, each) => { if (n) rows.push([label, n * each]); };
  if (g('passing.passingAttempts')) rows.push([`${g('passing.completions')}/${g('passing.passingAttempts')} passing, ${g('passing.passingYards')} yd`, g('passing.passingYards') * SCORING.passYd]);
  count(g('passing.passingTouchdowns'), plural(g('passing.passingTouchdowns'), 'passing TD', 'passing TDs'), SCORING.passTd);
  count(g('passing.interceptions'), plural(g('passing.interceptions'), 'interception', 'interceptions'), SCORING.int);
  if (g('rushing.rushingAttempts')) rows.push([`${plural(g('rushing.rushingAttempts'), 'carry', 'carries')}, ${g('rushing.rushingYards')} rushing yd`, g('rushing.rushingYards') * SCORING.rushYd]);
  count(g('rushing.rushingTouchdowns'), plural(g('rushing.rushingTouchdowns'), 'rushing TD', 'rushing TDs'), SCORING.rushTd);
  count(g('receiving.receptions'), plural(g('receiving.receptions'), 'reception', 'receptions'), SCORING.rec);
  if (g('receiving.receptions') || g('receiving.receivingYards')) rows.push([`${g('receiving.receivingYards')} receiving yd`, g('receiving.receivingYards') * SCORING.recYd]);
  count(g('receiving.receivingTouchdowns'), plural(g('receiving.receivingTouchdowns'), 'receiving TD', 'receiving TDs'), SCORING.recTd);
  const ret = g('kickReturns.kickReturnTouchdowns') + g('puntReturns.puntReturnTouchdowns');
  count(ret, plural(ret, 'return TD', 'return TDs'), SCORING.retTd);
  const two = live.twoPt.get(pid) || 0;
  count(two, plural(two, 'two-point conversion', 'two-point conversions'), SCORING.twoPt);
  count(g('fumbles.fumblesLost'), plural(g('fumbles.fumblesLost'), 'fumble lost', 'fumbles lost'), SCORING.fumLost);
  const adj = Number(S.adj?.[pid]) || 0;
  if (adj) rows.push(['Commissioner adjustment', adj]);
  return rows;
}

function breakdownHtml(pid) {
  const p = byId.get(pid), gs = gameState(pid), rows = breakdown(pid);
  const num = (v) => fmt(v).replace('-', '−');
  const kick = new Date(kickoff(p.gameId)).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const head = gs === 'pre' ? `Kicks off ${kick} · projected ${fmt(p.proj)}` : `${gs === 'post' ? 'Final' : 'Live now'} · projected ${fmt(p.proj)}`;
  const body = rows.length
    ? rows.map(([label, v]) => `<div><span>${esc(label)}</span><span>${num(v)}</span></div>`).join('')
    : `<div><span>${gs === 'pre' ? 'No stats until kickoff' : 'No stats yet'}</span><span>0.0</span></div>`;
  return `<div class="bd"><p class="bdh">${head}</p>${body}<div class="tt"><span>Total</span><span>${num(pts(pid))}</span></div></div>`;
}

function viewMe() {
  const t = ouWho();
  if (t === null || t < 0) {
    return '<div class="panel narrow"><h2>My team</h2><p class="muted">You are watching. Pick your name to see your team here.</p><div class="btnrow"><button class="primary" data-act="whoami">Pick my name</button></div></div>';
  }
  const totals = S.teams.map((_, k) => ({ k, total: teamTotal(k) })).sort((a, b) => b.total - a.total);
  const rank = totals.findIndex((x) => x.k === t), mine = totals[rank].total, other = totals[rank === 0 ? 1 : 0];
  const gap = !other ? '' : rank === 0 ? `${fmt(mine - other.total)} ahead of ${esc(teamName(other.k))}` : `${fmt(other.total - mine)} behind ${esc(teamName(other.k))}`;
  const ids = rosterOf(t);
  const liveN = ids.filter((pid) => gameState(pid) === 'in').length, preN = ids.filter((pid) => gameState(pid) === 'pre').length;
  const proj = teamTotal(t, (pid) => byId.get(pid)?.proj || 0);
  const n = rank + 1, ord = n + (n % 100 > 10 && n % 100 < 14 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const rows = bestLineup(ids, pts).map((r) => {
    const p = r.pid && byId.get(r.pid);
    if (!p) return `<li class="${r.starter ? '' : 'bn'} hole"><span class="slot">${r.slot}</span><span class="who muted">Empty</span><span class="pp">0.0</span></li>`;
    const st = live.stats.get(p.id), gs = gameState(p.id), open = ui.open.has(p.id);
    const line = gs === 'pre' ? `${p.home ? 'vs' : '@'} ${p.opp} · proj ${fmt(p.proj)}` : esc((st && statLine(st, live.twoPt.get(p.id))) || 'No stats yet');
    return `<li class="${r.starter ? '' : 'bn'} ${gs} tap" data-open="${p.id}" role="button" tabindex="0" aria-expanded="${open}"><span class="slot">${r.slot}</span>
      <span class="who avrow">${av(p, 'sm')}<span class="wt"><span class="l1"><b>${esc(p.name)}</b> <span class="chip ${p.pos}">${p.pos}</span> <small>${p.team}</small></span><small class="line">${line}</small></span></span>
      <span class="pp">${gs === 'in' ? '<span class="dot"></span>' : ''}${fmt(pts(p.id))}<span class="chev">${open ? '▴' : '▾'}</span></span></li>${open ? `<li class="bdli">${breakdownHtml(p.id)}</li>` : ''}`;
  }).join('');
  return `<div class="mewrap">
    ${guest ? '' : `<label class="check">Viewing <select id="meAs">${S.teams.map((_, k) => `<option value="${k}" ${k === t ? 'selected' : ''}>${esc(teamName(k))}</option>`).join('')}</select></label>`}
    <div class="mehero"><div><span class="eyebrow">${ord} of ${nTeams()}</span><h2>${esc(teamName(t))}</h2>
      <p class="muted">${[gap, liveN ? `<span class="livetag">${liveN} live</span>` : '', preN ? `${preN} yet to play` : ''].filter(Boolean).join(' · ')}</p></div>
      <div class="tot"><strong>${fmt(mine)}</strong><small>proj ${fmt(proj)}</small></div></div>
    <article class="card">${rows ? `<ul>${rows}</ul>` : '<p class="muted pad">No players drafted yet.</p>'}</article>
    <p class="muted center">Tap a player to see how their points add up.${guest ? ' <button class="link" data-act="whoami">Not you? Change name</button>' : ''}</p>
  </div>`;
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
  document.title = myTurn() ? 'Your pick! · Turkey Day Best Ball' : 'Turkey Day Best Ball · Live Draft';
  if (guest && (!S || S.status === 'setup' || me === null)) {
    if (S) $('#leagueName').textContent = S.name || 'Turkey Day Best Ball';
    $('#subline').textContent = 'Live draft';
    $('#tabs').innerHTML = '';
    return;
  }
  $('#leagueName').textContent = S.name || 'Turkey Day Best Ball';
  const fmtSlots = SLOTS.filter((s) => S.slots[s.key]).map((s) => `${S.slots[s.key] > 1 ? S.slots[s.key] + ' ' : ''}${s.label}`).join(' · ');
  $('#subline').textContent = S.status === 'setup' && !viewOnly
    ? 'Thanksgiving slate · full PPR'
    : `${nTeams()} drafters · ${S.rounds} rounds · ${fmtSlots} · full PPR${guest ? ` · you: ${me >= 0 ? teamName(me) : 'watching'}` : ''}`;
  const tabs = [];
  if (S.status === 'setup' && !viewOnly) tabs.push(['setup', 'Setup']);
  else {
    if ((!viewOnly || guest) && S.status === 'drafting') tabs.push(['draft', 'Draft']);
    tabs.push(['me', 'My team'], ['board', 'Board'], ['scores', 'Scores']);
    if (S.ou) tabs.push(['ou', 'O/U']);
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
  }).join('') + (live.error ? `<div class="game err">${esc(live.error)}</div>` : '') + netPill();
}

function render() { renderChrome(); renderGames(); renderView(); scheduleAuto(); }

function renderView() {
  const v = $('#view');
  if (guest && (!S || S.status === 'setup')) {
    v.innerHTML = '<div class="panel narrow"><h2>Waiting for the host</h2><p class="muted">The draft has not started yet. This page updates on its own the moment it does.</p></div>';
    return;
  }
  if (guest && me === null) { v.innerHTML = viewWho(); return; }
  if (tab === 'setup') v.innerHTML = viewSetup();
  else if (tab === 'draft') { v.innerHTML = viewDraft(); renderPoolRows(); }
  else if (tab === 'board') v.innerHTML = `<div class="panel">${boardHtml()}</div>`;
  else if (tab === 'scores') v.innerHTML = viewScores();
  else if (tab === 'commish') v.innerHTML = viewCommish();
  else if (tab === 'ou') v.innerHTML = viewOu();
  else if (tab === 'me') v.innerHTML = viewMe();
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
          <label class="check auto" title="Autodraft picks for this team"><input type="checkbox" data-auto="${i}" ${isAuto(i) ? 'checked' : ''}> Auto</label>
          <button class="ghost sm" data-move="${i}" data-d="-1" ${i === 0 ? 'disabled' : ''} aria-label="Move up">↑</button>
          <button class="ghost sm" data-move="${i}" data-d="1" ${i === nTeams() - 1 ? 'disabled' : ''} aria-label="Move down">↓</button></li>`).join('')}
      </ol>
      <p class="muted">Snake draft: the order reverses every round.</p>
      <button class="primary big" data-act="start">Start the draft</button>
      <p class="muted center">Starting the draft creates a join link so everyone can pick from their own phone.</p>
      <p class="muted center"><button class="link" data-act="restore">Restore a draft from a saved file</button></p>
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
      ${guest ? '' : inviteBar()}
      <div class="clock${myTurn() ? ' you' : ''}">
        <div><span class="eyebrow">Round ${Math.floor(i / nTeams()) + 1} · Pick ${(i % nTeams()) + 1} <em>(${i + 1} of ${totalPicks()})</em></span>
          <strong>${myTurn() ? 'You' : esc(teamName(t))}</strong><span class="otc">${myTurn() ? 'are on the clock. Make your pick.' : 'is on the clock'}</span></div>
        ${autoBar(t)}
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
      : guest && net.sending ? (net.sending.pid === p.id ? '<span class="gone">Sending…</span>' : '')
      : guest && !myTurn() ? ''
      : ui.pending === p.id ? `<button class="primary sm" data-confirm="${p.id}">Confirm</button><button class="ghost sm" data-cancel="1" aria-label="Cancel">✕</button>`
      : `<button class="draftbtn sm" data-pick="${p.id}">Draft</button>`;
    return `<div class="prow${gone ? ' taken' : ''}${ui.pending === p.id ? ' pending' : ''}">
      <span class="adp">${p.adp}</span>
      <span class="who avrow">${av(p)}<span class="wt"><b>${esc(p.name)}</b>${p.inj ? `<span class="inj" title="${esc(p.inj)}">${esc(p.inj[0])}</span>` : ''}
        <small><span class="chip ${p.pos}">${p.pos}${p.posRank}</span> ${p.team} ${p.home ? 'vs' : '@'} ${p.opp}${st === 'in' ? ' <span class="livetag">LIVE</span>' : st === 'post' ? ' <span class="fintag">FINAL</span>' : ''}</small></span></span>
      <span class="r proj">${fmt(p.proj)}</span>
      <span class="act">${action}</span>
    </div>`;
  }).join('') || '<p class="muted pad">No players match.</p>';
}

function boardHtml() {
  const n = nTeams(), cur = S.picks.length;
  let h = `<div class="boardwrap"><div class="board" style="--n:${n}">`;
  h += S.teams.map((_, t) => `<div class="bh${S.status === 'drafting' && teamForPick(cur) === t ? ' on' : ''}">${esc(teamName(t))}${isAuto(t) ? ' <span class="autotag">AUTO</span>' : ''}</div>`).join('');
  for (let r = 0; r < S.rounds; r++) {
    for (let c = 0; c < n; c++) {
      const i = r * n + (r % 2 === 0 ? c : n - 1 - c);
      const p = byId.get(S.picks[i]);
      const arrow = r % 2 === 0 ? '→' : '←';
      if (p) h += `<div class="cell ${p.pos}"><span class="pn">${pickLabel(i)} ${arrow}</span>${av(p, 'xs')}<b>${esc(p.name)}</b><small>${p.pos} · ${p.team}</small>${valueTag(i)}</div>`;
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
          return `<li class="${r.starter ? '' : 'bn'} ${gs} tap" data-open="${p.id}" role="button" tabindex="0"><span class="slot">${r.slot}</span>
            <span class="who avrow">${av(p, 'sm')}<span class="wt"><span class="l1"><b>${esc(p.name)}</b> <span class="chip ${p.pos}">${p.pos}</span> <small>${p.team}</small></span>
              <small class="line">${gs === 'pre' ? `${p.home ? 'vs' : '@'} ${p.opp} · proj ${fmt(p.proj)}` : esc(line || 'No stats yet')}${adj ? ` · adj ${adj > 0 ? '+' : ''}${adj}` : ''}</small></span></span>
            <span class="pp">${gs === 'in' ? '<span class="dot"></span>' : ''}${fmt(pts(p.id))}</span></li>${ui.open.has(p.id) ? `<li class="bdli">${breakdownHtml(p.id)}</li>` : ''}`;
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
      <h3>Over/under game</h3>
      <div class="btnrow">${S.ou
        ? '<button class="ghost" data-act="ouopen">Open the O/U tab</button><button class="danger" data-act="ouclear">Remove the game</button>'
        : `<button class="primary" data-act="oustart" ${S.status === 'done' ? '' : 'disabled'}>Start the over/under game</button>`}</div>
      <p class="muted">After the draft, everyone calls over or under on game totals, player fantasy points and each team's final score, for the games that have not kicked off yet. One point per correct call. Each line locks at kickoff.</p>
      <h3>Phone drafting</h3>
      <div class="btnrow"><button class="primary" data-act="join">Copy join link</button>
        <label class="check"><input type="checkbox" id="soundOn" ${ui.sound === false ? '' : 'checked'}> Play a sound on this screen for each pick</label></div>
      <p class="muted">Everyone who opens the join link sees the draft live and picks on their own turn. Keep this tab open on this device: it is the hub, and every pick passes through it. Team names and picks travel through ntfy.sh, a public relay, and the link is the only key.</p>
      <h3>Save to a file</h3>
      <div class="btnrow">
        <button class="primary" data-act="download">Download draft file</button>
        <button class="ghost" data-act="restore">Restore from file</button>
      </div>
      <p class="muted">The draft is saved in this browser after every pick, so a refresh keeps it. The file is a backup that survives a cleared browser or a different device. To lock the final rosters for everyone, put the file in the repo as <code>data/draft.json</code>: the main site link then shows them, view only.</p>
      <h3>Starting lineup</h3>
      <div class="row">${SLOTS.map((s) => stepper(s.label, 'slot:' + s.key, S.slots[s.key] || 0, 0, 4)).join('')}</div>
      <p class="muted">Changing the lineup re-scores every team right away.</p>
      <h3>Team names and autodraft</h3>
      <ol class="order">${S.teams.map((t, i) => `<li><span class="num">${i + 1}</span><input data-team="${i}" value="${esc(t)}" placeholder="Team ${i + 1}" maxlength="24"><label class="check auto" title="Autodraft picks for this team"><input type="checkbox" data-auto="${i}" ${isAuto(i) ? 'checked' : ''}> Auto</label></li>`).join('')}</ol>
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
  if (guest) { sendPick(pid); return; }
  if (viewOnly || S.status !== 'drafting' || S.picks.includes(pid) || !byId.has(pid)) return;
  S.picks.push(pid);
  ui.pending = null;
  ui.autoHold = false;
  announce(S.picks.length - 1);
  if (S.picks.length >= totalPicks()) { S.status = 'done'; tab = 'scores'; toast('Draft complete. Copy the share link for everyone.'); }
  save(); render();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('button, [data-open]');
  if (!b) return;
  const d = b.dataset;
  if (d.tab) { tab = d.tab; ui.pending = null; render(); return; }
  if (d.open) { if (ui.open.has(d.open)) ui.open.delete(d.open); else ui.open.add(d.open); renderView(); return; }
  if (d.filter) { ui.filter = d.filter; renderView(); return; }
  if (d.pick) { ui.pending = d.pick; renderPoolRows(); return; }
  if (d.cancel) { ui.pending = null; renderPoolRows(); return; }
  if (d.confirm) { makePick(d.confirm); return; }
  if (d.count) {
    const n = +d.count;
    while (S.teams.length < n) S.teams.push('');
    S.teams.length = n;
    S.auto = S.teams.map((_, k) => isAuto(k));
    save(); render(); return;
  }
  if (d.step) {
    const delta = +d.d;
    if (d.step === 'rounds') S.rounds = Math.min(10, Math.max(3, S.rounds + delta));
    else { const k = d.step.split(':')[1]; S.slots[k] = Math.min(4, Math.max(0, (S.slots[k] || 0) + delta)); }
    save(); render(); return;
  }
  if (d.move) {
    const i = +d.move, j = i + +d.d, au = S.teams.map((_, k) => isAuto(k));
    [S.teams[i], S.teams[j]] = [S.teams[j], S.teams[i]];
    [au[i], au[j]] = [au[j], au[i]];
    S.auto = au;
    save(); renderView(); return;
  }
  if (d.ou) { const [i, v] = d.ou.split(':'); ouTap(+i, v); return; }
  if (d.adjclear) { delete S.adj[d.adjclear]; save(); renderView(); return; }
  if (d.iam !== undefined) {
    me = +d.iam;
    localStorage.setItem(`tdbb.live.me.${room}`, String(me));
    tab = S.status === 'drafting' ? 'draft' : me >= 0 ? 'me' : 'scores';
    render(); return;
  }
  switch (d.act) {
    case 'shuffle': {
      S.teams = S.teams.map((t, i) => t || `Team ${i + 1}`);
      const au = S.teams.map((_, k) => isAuto(k));
      for (let i = S.teams.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [S.teams[i], S.teams[j]] = [S.teams[j], S.teams[i]];
        [au[i], au[j]] = [au[j], au[i]];
      }
      S.auto = au;
      save(); renderView(); toast('Draft order randomized'); break;
    }
    case 'start': {
      const pin = $('#f-pin')?.value.trim();
      S.teams = S.teams.map((t, i) => t.trim() || `Team ${i + 1}`);
      S.pin = pin ? await hashPin(pin) : null;
      ui.unlocked = true;
      S.picks = []; S.status = 'drafting'; S.pub = true; tab = 'draft';
      if (room !== S.room) { room = S.room; connectHost(); }
      save(); render(); break;
    }
    case 'undo':
      if (!isAdmin() || !S.picks.length) break;
      S.picks.pop(); S.status = 'drafting'; ui.autoHold = true;
      save(); render(); toast('Last pick undone'); break;
    case 'reset':
      if (!isAdmin() || !window.confirm('Reset the draft? All picks are cleared and you go back to setup.')) break;
      S.picks = []; S.adj = {}; S.ou = null; S.status = 'setup'; tab = 'setup';
      save(); render(); break;
    case 'lock': ui.unlocked = false; renderView(); break;
    case 'share': copyShare(); break;
    case 'autopick': {
      if (viewOnly || S.status !== 'drafting') break;
      const pid = autoChoice(teamForPick(S.picks.length));
      if (pid) makePick(pid);
      break;
    }
    case 'autoresume': ui.autoHold = false; render(); break;
    case 'join': copyJoin(); break;
    case 'oustart':
      if (!isAdmin()) break;
      if (!buildOu()) { toast('Every game has already kicked off'); break; }
      tab = 'ou'; save(); render(); toast('Over/under game is open on every phone'); break;
    case 'ouclear':
      if (!isAdmin() || !window.confirm('Remove the over/under game and everyone\'s picks?')) break;
      S.ou = null; ui.ouDraft = {}; save(); render(); break;
    case 'ouopen': tab = 'ou'; render(); break;
    case 'ousubmit': ouSubmit(); break;
    case 'whoami': me = null; render(); break;
    case 'download': downloadDraft(); break;
    case 'restore': if (isAdmin()) $('#restoreFile').click(); break;
    case 'refresh': if (guest) fetchLatest(); await refreshLive(); toast('Scores refreshed'); break;
    default:
  }
});

document.addEventListener('input', (e) => {
  const el = e.target;
  if (el.id === 'q') { ui.q = el.value; renderPoolRows(); }
  else if (el.id === 'soundOn') { ui.sound = el.checked; }
  else if (el.id === 'hideDrafted') { ui.hideDrafted = el.checked; renderPoolRows(); }
  else if (el.dataset.f === 'name') { S.name = el.value; save(); $('#leagueName').textContent = S.name || 'Turkey Day Best Ball'; }
  else if (el.dataset.auto !== undefined && isAdmin()) {
    const au = S.teams.map((_, k) => isAuto(k));
    au[+el.dataset.auto] = el.checked;
    S.auto = au; save(); render();
  }
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

document.addEventListener('change', (e) => {
  if (e.target.id === 'ouAs' || e.target.id === 'meAs') { ui.ouAs = +e.target.value; localStorage.setItem('tdbb.live.hostAs', String(ui.ouAs)); ui.ouDraft = {}; renderView(); return; }
  if (e.target.id !== 'restoreFile' || !e.target.files[0]) return;
  restoreDraft(e.target.files[0]);
  e.target.value = '';
});

document.addEventListener('keydown', (e) => {
  if ((e.key === 'Enter' || e.key === ' ') && e.target.matches && e.target.matches('[data-open]')) { e.preventDefault(); e.target.click(); }
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden || !pool) return;
  refreshLive();
  if (guest) connectGuest(); else if (S) connectHost();   // phones drop the stream while asleep
});

/* ---------- boot ---------- */

(async function boot() {
  try {
    pool = await (await fetch('../data/players.json')).json();
  } catch (e) {
    $('#view').innerHTML = '<p class="loading">Could not load the player pool. Reload to try again.</p>';
    return;
  }
  pool.players.forEach((p) => { byId.set(p.id, p); byName.set(norm(p.name), p); });
  const m = location.hash.match(/[#&]r=([a-z0-9]{8,40})/);
  if (m) {
    guest = true; viewOnly = true; room = m[1];
    const who = localStorage.getItem(`tdbb.live.me.${room}`);
    me = who === null ? null : +who;
    try {
      const d = JSON.parse(localStorage.getItem(`tdbb.live.guest.${room}`));
      if (d) { S = unpackDraft(d); net.seq = d.q || 0; }
    } catch (e) { /* wait for the host */ }
    if (S) tab = S.status === 'drafting' ? 'draft' : 'scores';
    render();
    connectGuest();
  } else {
    S = loadState();
    migrateSlots(S);
    S.adj = S.adj || {};
    room = S.room;
    ui.unlocked = !S.pin;
    ui.ouAs = +(localStorage.getItem('tdbb.live.hostAs') || 0) || 0;
    tab = S.status === 'setup' ? 'setup' : S.status === 'done' ? 'scores' : 'draft';
    render();
    connectHost();
    if (S.status !== 'setup') publishNow();
  }
  refreshLive();
})();
