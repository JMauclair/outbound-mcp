// Outbound MCP - service worker
// Relie Claude (via le serveur MCP local) à ta session LinkedIn.
// Toutes les actions passent par l'API Voyager depuis un onglet linkedin.com,
// avec tes cookies. Quotas, délais humains et pause d'urgence sont appliqués ici,
// côté extension : Claude ne peut pas les contourner.

import { ENDPOINTS, inviteBody, messageBody } from './voyager-endpoints.js';

const VERSION = '0.1.0';
const WS_URL = 'ws://127.0.0.1:47811';

// Plafonds non modifiables depuis la popup
const HARD_MAX = {
  invite_day: 25,
  invite_week: 100,
  message_day: 50,
  profile_view_day: 150,
  read_day: 600
};

// Réglages par défaut (prudents)
const DEFAULT_LIMITS = {
  invite_day: 15,
  invite_week: 80,
  message_day: 30,
  profile_view_day: 80,
  read_day: 300
};

// Pacing des actions d'écriture (invitation, message)
const MIN_GAP_MS = 60_000;          // écart minimum entre deux écritures
const JITTER_MS = [10_000, 45_000]; // délai aléatoire ajouté avant chaque écriture
const MAX_INLINE_WAIT_MS = 150_000; // au-delà, on demande à Claude de réessayer plus tard
const NOTE_MAX = 300;
const MESSAGE_MAX = 8000;

let ws = null;
let wsState = 'disconnected'; // disconnected | connecting | connected | unauthorized
let lastError = null;
let pingTimer = null;
let meCache = null;
let captureOn = false;

// ---------------------------------------------------------------- storage

async function getState() {
  const s = await chrome.storage.local.get([
    'token', 'paused', 'limits', 'events', 'log', 'lastWriteAt', 'capture', 'captured'
  ]);
  return {
    token: s.token || '',
    paused: Boolean(s.paused),
    limits: clampLimits({ ...DEFAULT_LIMITS, ...(s.limits || {}) }),
    events: s.events || [],
    log: s.log || [],
    lastWriteAt: s.lastWriteAt || 0,
    capture: Boolean(s.capture),
    captured: s.captured || []
  };
}

function clampLimits(limits) {
  const out = {};
  for (const k of Object.keys(DEFAULT_LIMITS)) {
    const v = Number(limits[k]);
    out[k] = Number.isFinite(v) ? Math.max(0, Math.min(HARD_MAX[k], Math.floor(v))) : DEFAULT_LIMITS[k];
  }
  return out;
}

async function addEvent(kind) {
  const { events } = await getState();
  const cutoff = Date.now() - 8 * 24 * 3600_000;
  const next = events.filter((e) => e.ts > cutoff);
  next.push({ kind, ts: Date.now() });
  await chrome.storage.local.set({ events: next });
}

async function addLog(entry) {
  const { log } = await getState();
  log.unshift({ ts: Date.now(), ...entry });
  await chrome.storage.local.set({ log: log.slice(0, 200) });
}

function startOfToday() {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

function usageFrom(events) {
  const today = startOfToday();
  const week = Date.now() - 7 * 24 * 3600_000;
  const count = (kind, since) => events.filter((e) => e.kind === kind && e.ts >= since).length;
  return {
    invite_day: count('invite', today),
    invite_week: count('invite', week),
    message_day: count('message', today),
    profile_view_day: count('profile_view', today),
    read_day: count('read', today)
  };
}

async function checkQuota(kind) {
  const { limits, events } = await getState();
  const usage = usageFrom(events);
  const checks = {
    invite: ['invite_day', 'invite_week'],
    message: ['message_day'],
    profile_view: ['profile_view_day'],
    read: ['read_day']
  }[kind];
  for (const key of checks) {
    if (usage[key] >= limits[key]) {
      throw new Error(`QUOTA_REACHED: ${key} = ${usage[key]}/${limits[key]}. Reprends plus tard.`);
    }
  }
}

// ---------------------------------------------------------------- pacing

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const randInt = (a, b) => a + Math.floor(Math.random() * (b - a + 1));

async function paceWrite() {
  const { paused, lastWriteAt } = await getState();
  if (paused) throw new Error('PAUSED: les actions sont en pause depuis la popup de l\'extension.');
  const wait = Math.max(0, lastWriteAt + MIN_GAP_MS - Date.now()) + randInt(...JITTER_MS);
  if (wait > MAX_INLINE_WAIT_MS) {
    throw new Error(`RETRY_AFTER: ${Math.ceil(wait / 1000)} s avant la prochaine action.`);
  }
  await sleep(wait);
  const again = await getState();
  if (again.paused) throw new Error('PAUSED: mis en pause pendant l\'attente.');
  await chrome.storage.local.set({ lastWriteAt: Date.now() });
  return wait;
}

// ---------------------------------------------------------------- linkedin tab

async function waitComplete(tabId, timeoutMs = 30_000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const tab = await chrome.tabs.get(tabId);
    if (tab.status === 'complete') return;
    await sleep(300);
  }
  throw new Error('TAB_TIMEOUT: l\'onglet LinkedIn ne s\'est pas chargé.');
}

async function getLinkedInTab() {
  const tabs = await chrome.tabs.query({ url: 'https://www.linkedin.com/*' });
  const ready = tabs.find((t) => t.status === 'complete') || tabs[0];
  if (ready) return ready.id;
  const tab = await chrome.tabs.create({ url: 'https://www.linkedin.com/feed/', active: false, pinned: true });
  await waitComplete(tab.id);
  return tab.id;
}

// Exécutée DANS la page linkedin.com (monde MAIN) : même origine, tes cookies.
function pageFetch(method, path, body, accept) {
  return (async () => {
    const m = document.cookie.match(/JSESSIONID="?([^";]+)"?/);
    if (!m) return { error: 'NOT_LOGGED_IN: connecte-toi à linkedin.com dans ce Chrome.' };
    const headers = {
      'csrf-token': m[1],
      'x-restli-protocol-version': '2.0.0',
      accept: accept || 'application/vnd.linkedin.normalized+json+2.1'
    };
    if (body !== null) headers['content-type'] = 'application/json; charset=UTF-8';
    try {
      const res = await fetch(path.startsWith('http') ? path : 'https://www.linkedin.com' + path, {
        method,
        headers,
        credentials: 'include',
        body: body !== null ? JSON.stringify(body) : undefined
      });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch (_) { /* HTML ou vide */ }
      return { status: res.status, json, text: json ? '' : text };
    } catch (e) {
      return { error: 'FETCH_FAILED: ' + String(e) };
    }
  })();
}

async function voyager(method, path, body = null, accept = null) {
  const tabId = await getLinkedInTab();
  const [res] = await chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: pageFetch,
    args: [method, path, body, accept]
  });
  const r = res && res.result;
  if (!r) throw new Error('NO_RESULT: l\'exécution dans l\'onglet LinkedIn a échoué.');
  if (r.error) throw new Error(r.error);
  if (r.status === 401 || r.status === 403) {
    throw new Error(`AUTH_${r.status}: session LinkedIn refusée. Recharge linkedin.com et reconnecte-toi.`);
  }
  if (r.status === 429) throw new Error('RATE_LIMITED_429: LinkedIn freine. Arrête pour aujourd\'hui.');
  if (r.status >= 400) {
    const detail = r.json ? JSON.stringify(r.json).slice(0, 500) : String(r.text).slice(0, 300);
    throw new Error(`VOYAGER_${r.status}: ${detail}`);
  }
  return r;
}

// ---------------------------------------------------------------- helpers

// Garde un sous-ensemble lisible des entités d'une réponse "normalized"
const KEEP_KEYS = [
  '$type', 'entityUrn', 'publicIdentifier', 'firstName', 'lastName', 'headline', 'occupation',
  'sentTime', 'createdAt', 'invitationState', 'invitationType', 'customMessage', 'message',
  'toMemberId', '*toMember', '*fromMember', 'connectedMember', '*connectedMemberResolutionResult',
  'distance', 'lastActivityAt', 'unreadCount', 'title', 'text',
  'body', 'deliveredAt', '*sender', 'sender', 'read', 'categories', '*conversationParticipants',
  'conversationParticipants', 'participantType', 'backendUrn', '*messages', 'lastReadAt'
];

// Réponses GraphQL de la messagerie : normalisées (included) ou imbriquées (data)
function summarize(json, limit = 120) {
  if (!json) return null;
  if (Array.isArray(json.included) && json.included.length) return compact(json, limit);
  return { raw: JSON.stringify(json).slice(0, 40_000) };
}

async function voyagerMessaging(path) {
  try {
    return await voyager('GET', path);
  } catch (e) {
    if (!/VOYAGER_4\d\d/.test(e.message)) throw e;
    return voyager('GET', path, null, 'application/graphql');
  }
}

function compact(json, limit = 80) {
  if (!json) return null;
  const included = Array.isArray(json.included) ? json.included : [];
  const items = included.slice(0, limit).map((e) => {
    const o = {};
    for (const k of KEEP_KEYS) {
      if (e[k] === undefined) continue;
      const v = e[k];
      o[k] = typeof v === 'object' && v !== null ? JSON.stringify(v).slice(0, 300) : v;
    }
    return o;
  }).filter((o) => Object.keys(o).length > 1);
  return {
    paging: json.data && json.data.paging ? json.data.paging : undefined,
    count: included.length,
    items
  };
}

function parsePublicId(input) {
  const s = String(input || '').trim();
  const m = s.match(/linkedin\.com\/in\/([^/?#]+)/i);
  const id = m ? m[1] : s.replace(/^\/?in\//, '').replace(/\/$/, '');
  if (!id || /\s/.test(id)) throw new Error('BAD_PROFILE: donne une URL linkedin.com/in/... ou l\'identifiant public.');
  return decodeURIComponent(id);
}

function assertProfileUrn(urn) {
  if (!/^urn:li:fsd_profile:[A-Za-z0-9_-]+$/.test(String(urn || ''))) {
    throw new Error('BAD_URN: attendu urn:li:fsd_profile:XXXX (obtenu via linkedin_get_profile).');
  }
}

// ---------------------------------------------------------------- tools

async function toolWhoami() {
  if (meCache) return meCache;
  await checkQuota('read');
  const r = await voyager('GET', ENDPOINTS.me);
  await addEvent('read');
  const inc = (r.json && r.json.included) || [];
  const mini = inc.find((e) => String(e.entityUrn || '').startsWith('urn:li:fs_miniProfile:')) || {};
  const id = String(mini.entityUrn || '').split(':').pop();
  if (!id) throw new Error('ME_PARSE: impossible de lire ton profil (endpoint /me modifié ?).');
  meCache = {
    profileUrn: `urn:li:fsd_profile:${id}`,
    firstName: mini.firstName,
    lastName: mini.lastName,
    publicIdentifier: mini.publicIdentifier,
    occupation: mini.occupation
  };
  return meCache;
}

async function toolGetProfile({ profile }) {
  const publicId = parsePublicId(profile);
  await checkQuota('profile_view');
  let result = null;

  // 1) GraphQL (ce qu'utilise le site), puis 2) ancien endpoint REST dash
  for (const [source, url] of [
    ['voyager-graphql', ENDPOINTS.profileGraphql(publicId)],
    ['voyager-dash', ENDPOINTS.profileByPublicId(publicId)]
  ]) {
    if (result) break;
    try {
      const r = await voyager('GET', url);
      const inc = (r.json && r.json.included) || [];
      const p = inc.find((e) => String(e.entityUrn || '').startsWith('urn:li:fsd_profile:') &&
        (!e.publicIdentifier || e.publicIdentifier.toLowerCase() === publicId.toLowerCase()) && e.firstName);
      if (p) {
        result = {
          profileUrn: p.entityUrn,
          publicIdentifier: p.publicIdentifier || publicId,
          firstName: p.firstName,
          lastName: p.lastName,
          headline: p.headline,
          source
        };
      }
    } catch (e) {
      if (/AUTH_|NOT_LOGGED_IN|RATE_LIMITED/.test(e.message)) throw e;
    }
  }

  // 2) Secours : page HTML du profil
  if (!result) {
    const r = await voyager('GET', ENDPOINTS.profileHtml(publicId), null, 'text/html');
    const html = r.text || '';
    const urn = (html.match(/urn:li:fsd_profile:([A-Za-z0-9_-]+)/) || [])[0];
    const title = (html.match(/<title>([^<]*)<\/title>/) || [])[1] || '';
    if (!urn) throw new Error('PROFILE_NOT_FOUND: aucun URN trouvé pour ' + publicId);
    result = {
      profileUrn: urn,
      publicIdentifier: publicId,
      displayName: title.replace(/\s*\|\s*LinkedIn.*$/i, '').trim(),
      source: 'html'
    };
  }

  await addEvent('profile_view');
  await addLog({ action: 'profile_view', target: publicId, ok: true });
  return result;
}

async function toolSendInvite({ profile_urn, note }) {
  assertProfileUrn(profile_urn);
  const text = note ? String(note).trim() : '';
  if (text.length > NOTE_MAX) throw new Error(`NOTE_TOO_LONG: ${text.length}/${NOTE_MAX} caractères.`);
  await checkQuota('invite');
  const waited = await paceWrite();
  try {
    const r = await voyager('POST', ENDPOINTS.sendInvite, inviteBody(profile_urn, text || undefined));
    await addEvent('invite');
    await addLog({ action: 'invite', target: profile_urn, ok: true, note: text.slice(0, 80) });
    return { sent: true, waited_seconds: Math.round(waited / 1000), status: r.status };
  } catch (e) {
    await addLog({ action: 'invite', target: profile_urn, ok: false, error: e.message.slice(0, 200) });
    if (/CUSTOM_MESSAGE_TOO_LONG/.test(e.message)) {
      throw new Error(`NOTE_TOO_LONG_FOR_ACCOUNT: LinkedIn refuse ${text.length} caractères sur ce compte (limite 200 sans Premium). Raccourcis la note.`);
    }
    throw e;
  }
}

async function toolSendMessage({ profile_urn, text }) {
  assertProfileUrn(profile_urn);
  const body = String(text || '').trim();
  if (!body) throw new Error('EMPTY_MESSAGE');
  if (body.length > MESSAGE_MAX) throw new Error(`MESSAGE_TOO_LONG: ${body.length}/${MESSAGE_MAX}.`);
  const me = await toolWhoami();
  await checkQuota('message');
  const waited = await paceWrite();
  try {
    const r = await voyager('POST', ENDPOINTS.sendMessage, messageBody(me.profileUrn, profile_urn, body));
    await addEvent('message');
    await addLog({ action: 'message', target: profile_urn, ok: true, note: body.slice(0, 80) });
    return { sent: true, waited_seconds: Math.round(waited / 1000), status: r.status };
  } catch (e) {
    await addLog({ action: 'message', target: profile_urn, ok: false, error: e.message.slice(0, 200) });
    throw e;
  }
}

async function toolSentInvitations({ count }) {
  await checkQuota('read');
  const r = await voyager('GET', ENDPOINTS.sentInvitations(Math.min(Number(count) || 50, 100)));
  await addEvent('read');
  return compact(r.json);
}

async function toolRecentConnections({ count }) {
  await checkQuota('read');
  const r = await voyager('GET', ENDPOINTS.recentConnections(Math.min(Number(count) || 40, 100)));
  await addEvent('read');
  return compact(r.json);
}

async function toolListConversations({ keywords, count }) {
  const me = await toolWhoami();
  await checkQuota('read');
  const n = Math.min(Number(count) || 20, 40);
  const path = keywords
    ? ENDPOINTS.searchConversations(me.profileUrn, String(keywords).slice(0, 100), n)
    : ENDPOINTS.conversations(me.profileUrn, n);
  const r = await voyagerMessaging(path);
  await addEvent('read');
  return summarize(r.json);
}

async function toolGetMessages({ conversation_urn }) {
  if (!/^urn:li:msg_conversation:\(/.test(String(conversation_urn || ''))) {
    throw new Error('BAD_URN: attendu urn:li:msg_conversation:(...) (via linkedin_list_conversations).');
  }
  await checkQuota('read');
  const r = await voyagerMessaging(ENDPOINTS.messages(conversation_urn));
  await addEvent('read');
  return summarize(r.json);
}

async function toolVoyagerGet({ path, raw }) {
  const p = String(path || '');
  if (!p.startsWith('/voyager/api/')) throw new Error('BAD_PATH: lecture seule, chemin /voyager/api/... uniquement.');
  await checkQuota('read');
  const r = await voyager('GET', p);
  await addEvent('read');
  if (raw) return JSON.stringify(r.json || r.text).slice(0, 60_000);
  return compact(r.json, 150);
}

async function toolStatus() {
  const { paused, limits, events } = await getState();
  let me = null;
  try { me = await toolWhoami(); } catch (e) { me = { error: e.message }; }
  return { version: VERSION, paused, limits, usage: usageFrom(events), me };
}

const TOOLS = {
  status: toolStatus,
  whoami: toolWhoami,
  get_profile: toolGetProfile,
  send_invite: toolSendInvite,
  send_message: toolSendMessage,
  list_sent_invitations: toolSentInvitations,
  list_recent_connections: toolRecentConnections,
  list_conversations: toolListConversations,
  get_messages: toolGetMessages,
  voyager_get: toolVoyagerGet
};

// ---------------------------------------------------------------- websocket bridge

function setState(state, err = null) {
  wsState = state;
  lastError = err;
  chrome.action.setBadgeText({ text: state === 'connected' ? 'ON' : '' });
  chrome.action.setBadgeBackgroundColor({ color: '#1a7f37' });
}

async function connect() {
  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) return;
  const { token } = await getState();
  if (!token) { setState('disconnected', 'Colle le jeton du serveur MCP dans la popup.'); return; }
  setState('connecting');
  try {
    ws = new WebSocket(WS_URL);
  } catch (e) {
    setState('disconnected', String(e));
    return;
  }
  ws.onopen = () => {
    ws.send(JSON.stringify({ type: 'hello', token, version: VERSION }));
    clearInterval(pingTimer);
    // Le trafic régulier garde le service worker en vie pendant les attentes
    pingTimer = setInterval(() => {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ type: 'ping' }));
    }, 20_000);
  };
  ws.onmessage = async (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (_) { return; }
    if (msg.type === 'welcome') { setState('connected'); return; }
    if (msg.type === 'pong') return;
    if (!msg.id || !msg.tool) return;
    const fn = TOOLS[msg.tool];
    try {
      if (!fn) throw new Error('UNKNOWN_TOOL: ' + msg.tool);
      const result = await fn(msg.args || {});
      ws.send(JSON.stringify({ id: msg.id, ok: true, result }));
    } catch (e) {
      ws.send(JSON.stringify({ id: msg.id, ok: false, error: String(e && e.message ? e.message : e) }));
    }
  };
  ws.onclose = (ev) => {
    clearInterval(pingTimer);
    ws = null;
    if (ev.code === 4401) setState('unauthorized', 'Jeton refusé par le serveur MCP.');
    else setState('disconnected', 'Serveur MCP injoignable (Claude est-il lancé ?).');
  };
  ws.onerror = () => { /* onclose suit */ };
}

chrome.alarms.create('reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'reconnect') connect(); });
chrome.runtime.onStartup.addListener(connect);
chrome.runtime.onInstalled.addListener(connect);
connect();

// ---------------------------------------------------------------- capture mode

chrome.storage.local.get('capture').then((s) => { captureOn = Boolean(s.capture); });
chrome.storage.onChanged.addListener((changes) => {
  if (changes.capture) captureOn = Boolean(changes.capture.newValue);
  if (changes.token) { if (ws) ws.close(); connect(); }
});

chrome.webRequest.onBeforeRequest.addListener(
  (details) => {
    if (!captureOn) return;
    let body = null;
    const raw = details.requestBody && details.requestBody.raw;
    if (raw && raw.length) {
      try {
        body = raw.map((part) => (part.bytes ? new TextDecoder().decode(part.bytes) : '')).join('').slice(0, 4000);
      } catch (_) { body = '[binaire]'; }
    }
    const url = details.url.replace('https://www.linkedin.com', '');
    chrome.storage.local.get('captured').then((s) => {
      const list = s.captured || [];
      list.unshift({ ts: Date.now(), method: details.method, url, body });
      chrome.storage.local.set({ captured: list.slice(0, 150) });
    });
  },
  { urls: ['https://www.linkedin.com/voyager/api/*'] },
  ['requestBody']
);

// ---------------------------------------------------------------- popup messages

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  (async () => {
    if (msg.type === 'getStatus') {
      const s = await getState();
      sendResponse({
        wsState, lastError, version: VERSION,
        paused: s.paused, limits: s.limits, hardMax: HARD_MAX,
        usage: usageFrom(s.events), log: s.log.slice(0, 30),
        capture: s.capture, capturedCount: s.captured.length, hasToken: Boolean(s.token)
      });
    } else if (msg.type === 'setToken') {
      await chrome.storage.local.set({ token: String(msg.token || '').trim() });
      sendResponse({ ok: true });
    } else if (msg.type === 'setPaused') {
      await chrome.storage.local.set({ paused: Boolean(msg.paused) });
      sendResponse({ ok: true });
    } else if (msg.type === 'setLimits') {
      await chrome.storage.local.set({ limits: clampLimits(msg.limits || {}) });
      sendResponse({ ok: true });
    } else if (msg.type === 'setCapture') {
      await chrome.storage.local.set({ capture: Boolean(msg.capture) });
      sendResponse({ ok: true });
    } else if (msg.type === 'getCaptured') {
      const s = await getState();
      sendResponse({ captured: s.captured });
    } else if (msg.type === 'clearCaptured') {
      await chrome.storage.local.set({ captured: [] });
      sendResponse({ ok: true });
    } else if (msg.type === 'reconnect') {
      await connect();
      sendResponse({ ok: true });
    }
  })();
  return true;
});
