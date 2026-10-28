#!/usr/bin/env node
// Outbound MCP - serveur MCP local
// Claude <-(stdio MCP)-> ce serveur <-(WebSocket 127.0.0.1)-> extension Chrome -> LinkedIn

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { WebSocketServer, WebSocket } from 'ws';
import { z } from 'zod';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { Store } from './store.js';

const VERSION = '0.1.0';
const DIR = process.env.OUTBOUND_MCP_DIR || path.join(os.homedir(), '.outbound-mcp');
const CONFIG_FILE = path.join(DIR, 'config.json');
const log = (...a) => console.error('[outbound-mcp]', ...a); // stdout est réservé au protocole MCP

// ---------------------------------------------------------------- config

fs.mkdirSync(DIR, { recursive: true });
let config = {};
if (fs.existsSync(CONFIG_FILE)) {
  try { config = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8')); } catch (_) { config = {}; }
}
if (!config.token) config.token = crypto.randomBytes(16).toString('hex');
if (!config.port) config.port = 47811;
fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), { mode: 0o600 });

const store = new Store(DIR);

// ---------------------------------------------------------------- websocket bridge
// Claude desktop lance une copie du serveur par conversation. La première copie
// ouvre le port (mode "primaire") et reçoit l'extension. Les suivantes s'y
// connectent en "relais" et lui transmettent leurs appels.


let mode = 'starting';   // primary | relay | starting
let ext = null;          // (primaire) socket de l'extension authentifiée
let extVersion = null;
let relay = null;        // (relais) socket vers le primaire
let relayReady = false;
let bridgeError = null;
const pending = new Map();         // id -> {resolve, reject, timer}
const forwarded = new Map();       // (primaire) id -> socket relais qui attend la réponse

const safeEqual = (a, b) => typeof a === 'string' && a.length === b.length &&
  crypto.timingSafeEqual(Buffer.from(a), Buffer.from(b));

function settle(msg) {
  const p = pending.get(msg.id);
  if (!p) return false;
  pending.delete(msg.id);
  clearTimeout(p.timer);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error || 'erreur extension'));
  return true;
}

function failAllPending(reason) {
  for (const [id, p] of pending) { clearTimeout(p.timer); p.reject(new Error(reason)); pending.delete(id); }
}

function startPrimary() {
  mode = 'starting';
  const wss = new WebSocketServer({
    host: '127.0.0.1',
    port: config.port,
    // Navigateur : seule une extension Chrome est acceptée. Sans en-tête Origin : processus local (relais).
    verifyClient: ({ origin }) => origin === undefined || (typeof origin === 'string' && origin.startsWith('chrome-extension://'))
  });

  wss.on('listening', () => {
    mode = 'primary';
    bridgeError = null;
    log(`primaire : pont WebSocket sur ws://127.0.0.1:${config.port}, jeton dans ${CONFIG_FILE}`);
  });

  wss.on('error', (e) => {
    if (e.code === 'EADDRINUSE') { startRelay(); return; }
    bridgeError = String(e);
    log(bridgeError);
  });

  wss.on('connection', (socket, req) => {
    const isBrowser = req.headers.origin !== undefined;
    let role = null;
    const authTimer = setTimeout(() => { if (!role) socket.close(4401, 'auth timeout'); }, 5000);

    socket.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(String(raw)); } catch (_) { return; }

      if (!role) {
        if (msg.type !== 'hello' || !safeEqual(msg.token, config.token)) { socket.close(4401, 'bad token'); return; }
        clearTimeout(authTimer);
        role = msg.role === 'relay' && !isBrowser ? 'relay' : (isBrowser ? 'extension' : null);
        if (!role) { socket.close(4403, 'role'); return; }
        if (role === 'extension') {
          if (ext && ext !== socket) ext.close(4000, 'remplacé par une nouvelle connexion');
          ext = socket;
          extVersion = msg.version || null;
          log('extension connectée', extVersion || '');
        } else {
          log('relais connecté');
        }
        socket.send(JSON.stringify({ type: 'welcome', version: VERSION }));
        return;
      }

      if (msg.type === 'ping') { socket.send(JSON.stringify({ type: 'pong' })); return; }

      if (role === 'extension') {
        if (settle(msg)) return;
        const target = forwarded.get(msg.id);
        if (target) { forwarded.delete(msg.id); if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify(msg)); }
        return;
      }

      // role === 'relay' : demande d'outil ou d'état à transmettre
      if (msg.type === 'ext_status') {
        socket.send(JSON.stringify({ type: 'ext_status', id: msg.id, connected: Boolean(ext), version: extVersion }));
        return;
      }
      if (!msg.id || !msg.tool) return;
      if (!ext) { socket.send(JSON.stringify({ id: msg.id, ok: false, error: notConnectedError() })); return; }
      forwarded.set(msg.id, socket);
      ext.send(JSON.stringify({ id: msg.id, tool: msg.tool, args: msg.args || {} }));
    });

    socket.on('close', () => {
      clearTimeout(authTimer);
      if (role === 'extension' && ext === socket) {
        ext = null;
        log('extension déconnectée');
        failAllPending('EXTENSION_DISCONNECTED');
        for (const [id, target] of forwarded) {
          if (target.readyState === WebSocket.OPEN) target.send(JSON.stringify({ id, ok: false, error: 'EXTENSION_DISCONNECTED' }));
        }
        forwarded.clear();
      }
      if (role === 'relay') {
        for (const [id, target] of forwarded) if (target === socket) forwarded.delete(id);
      }
    });
  });
}

function startRelay() {
  mode = 'relay';
  relayReady = false;
  const sock = new WebSocket(`ws://127.0.0.1:${config.port}`);
  relay = sock;
  sock.on('open', () => sock.send(JSON.stringify({ type: 'hello', role: 'relay', token: config.token, version: VERSION })));
  sock.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(String(raw)); } catch (_) { return; }
    if (msg.type === 'welcome') { relayReady = true; bridgeError = null; log('relais : connecté au serveur primaire'); return; }
    if (msg.type === 'ext_status') { settle({ id: msg.id, ok: true, result: { connected: msg.connected, version: msg.version } }); return; }
    settle(msg);
  });
  sock.on('close', (code) => {
    relayReady = false;
    relay = null;
    failAllPending('RELAY_DISCONNECTED: le serveur primaire s\'est arrêté, réessaie.');
    if (code === 4401) { bridgeError = 'Jeton refusé par le serveur primaire (config.json modifié ?).'; return; }
    // Le primaire a disparu : on tente de prendre sa place
    setTimeout(startPrimary, 1000 + Math.floor(Math.random() * 1000));
  });
  sock.on('error', () => { /* close suit */ });
}

function notConnectedError() {
  return 'EXTENSION_NOT_CONNECTED: ouvre Chrome avec l\'extension Outbound MCP, colle le jeton de ' +
    CONFIG_FILE + ' dans sa popup, et vérifie que tu es connecté à linkedin.com.';
}

function sendAndWait(socket, payload, timeoutMs) {
  const id = payload.id || crypto.randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('TIMEOUT: l\'extension n\'a pas répondu.')); }, timeoutMs);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ ...payload, id }));
  });
}

async function extensionInfo() {
  if (mode === 'primary') return { connected: Boolean(ext), version: extVersion };
  if (mode === 'relay' && relay && relayReady) {
    try { return await sendAndWait(relay, { type: 'ext_status' }, 5000); } catch (_) { return { connected: false, version: null }; }
  }
  return { connected: false, version: null };
}

function callExtension(tool, args = {}, timeoutMs = 240_000) {
  if (bridgeError) return Promise.reject(new Error(bridgeError));
  if (mode === 'primary') {
    if (!ext) return Promise.reject(new Error(notConnectedError()));
    return sendAndWait(ext, { tool, args }, timeoutMs);
  }
  if (mode === 'relay' && relay && relayReady) return sendAndWait(relay, { tool, args }, timeoutMs);
  return Promise.reject(new Error('BRIDGE_STARTING: le pont démarre, réessaie dans quelques secondes.'));
}

startPrimary();

// ---------------------------------------------------------------- MCP

const server = new McpServer(
  { name: 'outbound-mcp', version: VERSION },
  {
    instructions: [
      'Outbound MCP pilote la prospection LinkedIn de l\'utilisateur depuis SA session Chrome, via l\'API interne Voyager.',
      'Règles : 1) Toujours montrer les invitations et messages rédigés à l\'utilisateur et attendre son accord avant linkedin_send_invite ou linkedin_send_message, sauf s\'il a explicitement validé un lot.',
      '2) personnalise chaque note à partir du profil (linkedin_get_profile) : pas de message générique, 200 caractères max pour une note (300 avec Premium).',
      '3) Les quotas, délais et la pause sont gérés par l\'extension : si une erreur QUOTA_REACHED, PAUSED, RATE_LIMITED ou RETRY_AFTER revient, arrête et explique-le, ne contourne jamais.',
      '4) Campagnes : campaign_due donne les actions à faire, campaign_mark enregistre le résultat. Une réponse du prospect stoppe sa séquence (statut replied).'
    ].join('\n')
  }
);

const text = (obj) => ({ content: [{ type: 'text', text: typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2) }] });
const fail = (e) => ({ isError: true, content: [{ type: 'text', text: String(e && e.message ? e.message : e) }] });
const wrap = (fn) => async (args) => { try { return text(await fn(args)); } catch (e) { return fail(e); } };

server.registerTool('linkedin_status', {
  title: 'État de la connexion',
  description: 'Vérifie que l\'extension est connectée, qui est connecté sur LinkedIn, et l\'usage des quotas du jour.',
  inputSchema: {}
}, wrap(async () => {
  const info = await extensionInfo();
  const base = { server: VERSION, bridge_mode: mode, extension_connected: info.connected, extension_version: info.version, bridge_error: bridgeError };
  if (!info.connected) return base;
  return { ...base, ...(await callExtension('status')) };
}));

server.registerTool('linkedin_get_profile', {
  title: 'Lire un profil',
  description: 'Récupère un profil LinkedIn (nom, titre, URN fsd_profile nécessaire pour inviter ou écrire). Compte comme une visite de profil.',
  inputSchema: { profile: z.string().describe('URL linkedin.com/in/... ou identifiant public') }
}, wrap((a) => callExtension('get_profile', a)));

server.registerTool('linkedin_send_invite', {
  title: 'Envoyer une invitation',
  description: 'Envoie une demande de connexion avec une note optionnelle (200 caractères max sans Premium, 300 avec). L\'extension attend un délai humain avant l\'envoi (1 à 3 min) et applique les quotas.',
  inputSchema: {
    profile_urn: z.string().describe('urn:li:fsd_profile:... (via linkedin_get_profile)'),
    note: z.string().max(300).optional().describe('Note personnalisée, 300 caractères max')
  }
}, wrap((a) => callExtension('send_invite', a)));

server.registerTool('linkedin_send_message', {
  title: 'Envoyer un message',
  description: 'Envoie un message LinkedIn à une relation (1er degré). Délai humain et quotas appliqués par l\'extension.',
  inputSchema: {
    profile_urn: z.string().describe('urn:li:fsd_profile:...'),
    text: z.string().min(1).max(8000)
  }
}, wrap((a) => callExtension('send_message', a)));

server.registerTool('linkedin_list_sent_invitations', {
  title: 'Invitations en attente',
  description: 'Liste les invitations envoyées encore en attente.',
  inputSchema: { count: z.number().int().min(1).max(100).optional() }
}, wrap((a) => callExtension('list_sent_invitations', a)));

server.registerTool('linkedin_list_recent_connections', {
  title: 'Dernières relations',
  description: 'Liste les relations les plus récentes : sert à détecter qui a accepté une invitation.',
  inputSchema: { count: z.number().int().min(1).max(100).optional() }
}, wrap((a) => callExtension('list_recent_connections', a)));

server.registerTool('linkedin_list_conversations', {
  title: 'Boîte de réception',
  description: 'Liste les conversations récentes (dernier message, expéditeur, date). Avec keywords, cherche par nom ou entreprise. Sert à détecter les réponses des prospects pour arrêter leur séquence.',
  inputSchema: {
    keywords: z.string().max(100).optional().describe('Nom du prospect ou entreprise'),
    count: z.number().int().min(1).max(40).optional()
  }
}, wrap((a) => callExtension('list_conversations', a)));

server.registerTool('linkedin_get_messages', {
  title: 'Messages d\'une conversation',
  description: 'Lit les messages d\'une conversation (URN obtenu via linkedin_list_conversations).',
  inputSchema: { conversation_urn: z.string().startsWith('urn:li:msg_conversation:') }
}, wrap((a) => callExtension('get_messages', a)));

server.registerTool('linkedin_voyager_get', {
  title: 'Lecture Voyager brute',
  description: 'Lecture seule (GET) d\'un chemin /voyager/api/... Utile pour un endpoint relevé avec le mode capture (ex. messagerie).',
  inputSchema: {
    path: z.string().startsWith('/voyager/api/'),
    raw: z.boolean().optional().describe('true = JSON brut tronqué, sinon résumé lisible')
  }
}, wrap((a) => callExtension('voyager_get', a)));

// --- campagnes (séquences façon lemlist, stockées en local)

const stepSchema = z.object({
  type: z.enum(['invite', 'message']),
  delay_days: z.number().min(0).max(60).default(0).describe('Jours après l\'étape précédente'),
  template: z.string().optional().describe('Trame de la note ou du message, à personnaliser par Claude')
});

server.registerTool('campaign_create', {
  title: 'Créer une campagne',
  description: 'Crée une séquence. Exemple : invite (jour 0) puis message (2 jours après acceptation) puis relance (4 jours).',
  inputSchema: {
    name: z.string().min(1),
    goal: z.string().optional().describe('Objectif et offre, pour guider la personnalisation'),
    steps: z.array(stepSchema).min(1).max(10)
  }
}, wrap(({ name, goal, steps }) => store.create(name, steps, goal)));

server.registerTool('campaign_add_leads', {
  title: 'Ajouter des prospects',
  description: 'Ajoute des prospects (URL de profil) à une campagne. Les doublons sont ignorés.',
  inputSchema: {
    campaign: z.string(),
    leads: z.array(z.object({
      profile: z.string().describe('URL linkedin.com/in/...'),
      profile_urn: z.string().optional(),
      first_name: z.string().optional(),
      company: z.string().optional(),
      notes: z.string().optional()
    })).min(1).max(500)
  }
}, wrap(({ campaign, leads }) => store.addLeads(campaign, leads)));

server.registerTool('campaign_list', {
  title: 'Lister les campagnes',
  description: 'Liste les campagnes et leurs compteurs.',
  inputSchema: {}
}, wrap(() => store.list()));

server.registerTool('campaign_get', {
  title: 'Détail d\'une campagne',
  description: 'Étapes, prospects et historique d\'une campagne.',
  inputSchema: { campaign: z.string() }
}, wrap(({ campaign }) => store.get(campaign)));

server.registerTool('campaign_due', {
  title: 'Actions à faire',
  description: 'Renvoie les étapes à exécuter maintenant pour chaque prospect, et ceux en attente (délai ou acceptation).',
  inputSchema: { campaign: z.string() }
}, wrap(({ campaign }) => store.due(campaign)));

server.registerTool('campaign_mark', {
  title: 'Enregistrer un résultat',
  description: 'done = étape faite ; accepted = invitation acceptée ; replied = le prospect a répondu (stoppe la séquence) ; failed ; skipped ; stopped.',
  inputSchema: {
    campaign: z.string(),
    lead_id: z.string(),
    status: z.enum(['done', 'accepted', 'replied', 'failed', 'skipped', 'stopped']),
    step_index: z.number().int().min(0).optional(),
    profile_urn: z.string().optional(),
    note: z.string().optional()
  }
}, wrap(({ campaign, lead_id, status, ...rest }) => store.mark(campaign, lead_id, status, rest)));

const transport = new StdioServerTransport();
await server.connect(transport);
log(`serveur MCP prêt (v${VERSION})`);

const shutdown = () => process.exit(0);
process.stdin.on('close', shutdown);
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
