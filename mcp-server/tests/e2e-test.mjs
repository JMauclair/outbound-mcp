// Test de bout en bout : faux client "extension" + vrai client MCP en stdio
import fs from 'node:fs';
import path from 'node:path';
import { WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const DIR = process.argv[2];
const transport = new StdioClientTransport({ command: 'node', args: [new URL('../index.js', import.meta.url).pathname], env: { ...process.env, OUTBOUND_MCP_DIR: DIR }, stderr: 'inherit' });
const client = new Client({ name: 'test', version: '1' });
await client.connect(transport);
const tools = await client.listTools();
console.log('TOOLS', tools.tools.map(t => t.name).join(', '));

const call = async (name, args = {}) => { const r = await client.callTool({ name, arguments: args }); return { err: r.isError, txt: r.content[0].text }; };
console.log('status sans extension ->', (await call('linkedin_status')).txt.replace(/\s+/g,' '));
console.log('profil sans extension ->', (await call('linkedin_get_profile', { profile: 'x' })).txt.slice(0, 60));

const { token, port } = JSON.parse(fs.readFileSync(path.join(DIR, 'config.json'), 'utf8'));

// mauvaise origine
await new Promise(r => { const w = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'https://evil.com' }); w.on('error', () => { console.log('origine web refusée: ok'); r(); }); w.on('open', () => { console.log('ERREUR: origine web acceptée'); r(); }); });
// mauvais jeton
await new Promise(r => { const w = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abc' }); w.on('open', () => w.send(JSON.stringify({ type: 'hello', token: 'x'.repeat(32) }))); w.on('close', (c) => { console.log('mauvais jeton -> close', c); r(); }); });

// bonne extension simulée
const ext = new WebSocket(`ws://127.0.0.1:${port}`, { origin: 'chrome-extension://abc' });
await new Promise(r => ext.on('open', r));
ext.send(JSON.stringify({ type: 'hello', token, version: 'test' }));
ext.on('message', (raw) => {
  const m = JSON.parse(raw);
  if (!m.id) return;
  const res = {
    status: { paused: false, usage: { invite_day: 0 } },
    get_profile: { profileUrn: 'urn:li:fsd_profile:ABC123', firstName: 'Marie', lastName: 'Test' },
    send_invite: { sent: true, waited_seconds: 42 }
  }[m.tool];
  if (m.tool === 'send_message') return ext.send(JSON.stringify({ id: m.id, ok: false, error: 'QUOTA_REACHED: message_day = 30/30' }));
  ext.send(JSON.stringify({ id: m.id, ok: true, result: res ?? { echo: m.args } }));
});
await new Promise(r => setTimeout(r, 300));
console.log('status ->', (await call('linkedin_status')).txt.replace(/\s+/g,' '));
console.log('profil ->', (await call('linkedin_get_profile', { profile: 'https://www.linkedin.com/in/marie-test/' })).txt.replace(/\s+/g,' '));
console.log('invite ->', (await call('linkedin_send_invite', { profile_urn: 'urn:li:fsd_profile:ABC123', note: 'Salut Marie' })).txt.replace(/\s+/g,' '));
console.log('message (quota) ->', JSON.stringify(await call('linkedin_send_message', { profile_urn: 'urn:li:fsd_profile:ABC123', text: 'yo' })));
console.log('note trop longue ->', (await call('linkedin_send_invite', { profile_urn: 'urn:li:fsd_profile:ABC123', note: 'x'.repeat(301) })).txt.slice(0, 80));

// campagne
console.log((await call('campaign_create', { name: 'demo', goal: 'test', steps: [{ type: 'invite', template: 'note' }, { type: 'message', delay_days: 0, template: 'merci' }, { type: 'message', delay_days: 3 }] })).err ? 'create KO' : 'create ok');
console.log('add ->', (await call('campaign_add_leads', { campaign: 'demo', leads: [{ profile: 'https://www.linkedin.com/in/a/' }, { profile: 'https://www.linkedin.com/in/b/' }, { profile: 'https://www.linkedin.com/in/A/' }] })).txt.replace(/\s+/g,' '));
let due = JSON.parse((await call('campaign_due', { campaign: 'demo' })).txt);
console.log('due 1 ->', due.due.map(d => d.type).join(','), 'waiting', due.waiting_count);
const lid = due.due[0].lead_id;
await call('campaign_mark', { campaign: 'demo', lead_id: lid, status: 'done', step_index: 0 });
due = JSON.parse((await call('campaign_due', { campaign: 'demo' })).txt);
console.log('apres invite ->', due.due.length, 'due,', due.waiting_count, 'waiting:', due.waiting[0]?.reason?.slice(0, 30));
await call('campaign_mark', { campaign: 'demo', lead_id: lid, status: 'accepted' });
due = JSON.parse((await call('campaign_due', { campaign: 'demo' })).txt);
console.log('apres acceptation ->', due.due.map(d => `${d.lead_id === lid ? 'A' : 'B'}:${d.type}`).join(','));
await call('campaign_mark', { campaign: 'demo', lead_id: lid, status: 'replied' });
console.log('liste ->', (await call('campaign_list')).txt.replace(/\s+/g,' '));
ext.close(); await client.close(); process.exit(0);
