// Stockage local des campagnes (fichier JSON dans ~/.outbound-mcp)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export class Store {
  constructor(dir) {
    this.file = path.join(dir, 'campaigns.json');
    this.data = { campaigns: {} };
    if (fs.existsSync(this.file)) {
      try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch (_) { /* fichier corrompu : on repart à vide */ }
    }
    if (!this.data.campaigns) this.data.campaigns = {};
  }

  save() {
    const tmp = this.file + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  get(name) {
    const c = this.data.campaigns[name];
    if (!c) throw new Error(`Campagne inconnue : ${name}. Campagnes : ${Object.keys(this.data.campaigns).join(', ') || 'aucune'}`);
    return c;
  }

  list() {
    return Object.values(this.data.campaigns).map((c) => ({
      name: c.name,
      steps: c.steps.length,
      leads: c.leads.length,
      active: c.leads.filter((l) => l.status === 'active').length,
      replied: c.leads.filter((l) => l.status === 'replied').length,
      finished: c.leads.filter((l) => l.status === 'finished').length,
      created_at: c.created_at
    }));
  }

  create(name, steps, goal) {
    if (this.data.campaigns[name]) throw new Error(`La campagne ${name} existe déjà.`);
    this.data.campaigns[name] = { name, goal: goal || '', steps, leads: [], created_at: new Date().toISOString() };
    this.save();
    return this.data.campaigns[name];
  }

  addLeads(name, leads) {
    const c = this.get(name);
    const known = new Set(c.leads.map((l) => l.profile.toLowerCase()));
    const added = [];
    for (const l of leads) {
      const key = String(l.profile).toLowerCase();
      if (known.has(key)) continue;
      known.add(key);
      const lead = {
        id: crypto.randomBytes(4).toString('hex'),
        profile: l.profile,
        profile_urn: l.profile_urn || null,
        first_name: l.first_name || '',
        company: l.company || '',
        notes: l.notes || '',
        status: 'active', // active | replied | finished | stopped
        connected: false,
        next_step: 0,
        last_done_at: null,
        history: []
      };
      c.leads.push(lead);
      added.push(lead.id);
    }
    this.save();
    return { added: added.length, skipped_duplicates: leads.length - added.length };
  }

  // Étapes à exécuter maintenant
  due(name, now = Date.now()) {
    const c = this.get(name);
    const due = [];
    const waiting = [];
    for (const l of c.leads) {
      if (l.status !== 'active') continue;
      const step = c.steps[l.next_step];
      if (!step) continue;
      const delayMs = (step.delay_days || 0) * 24 * 3600_000;
      const readyAt = l.last_done_at ? new Date(l.last_done_at).getTime() + delayMs : now;
      if (readyAt > now) {
        waiting.push({ lead_id: l.id, step_index: l.next_step, ready_at: new Date(readyAt).toISOString() });
        continue;
      }
      if (step.type === 'message' && !l.connected) {
        waiting.push({ lead_id: l.id, step_index: l.next_step, reason: 'en attente d\'acceptation (vérifie linkedin_list_recent_connections puis campaign_mark accepted)' });
        continue;
      }
      due.push({
        lead_id: l.id,
        step_index: l.next_step,
        type: step.type,
        template: step.template || '',
        lead: { profile: l.profile, profile_urn: l.profile_urn, first_name: l.first_name, company: l.company, notes: l.notes }
      });
    }
    return { campaign: name, goal: c.goal, due, waiting_count: waiting.length, waiting: waiting.slice(0, 30) };
  }

  mark(name, leadId, status, { step_index, note, profile_urn } = {}) {
    const c = this.get(name);
    const l = c.leads.find((x) => x.id === leadId);
    if (!l) throw new Error(`Lead inconnu : ${leadId}`);
    const at = new Date().toISOString();
    if (profile_urn) l.profile_urn = profile_urn;
    if (status === 'done') {
      if (step_index !== undefined && step_index !== l.next_step) {
        throw new Error(`Étape ${step_index} attendue ${l.next_step} pour ce lead.`);
      }
      l.history.push({ at, step: l.next_step, status: 'done', note });
      l.next_step += 1;
      l.last_done_at = at;
      if (l.next_step >= c.steps.length) l.status = 'finished';
    } else if (status === 'accepted') {
      l.connected = true;
      l.history.push({ at, status: 'accepted', note });
    } else if (status === 'replied') {
      l.status = 'replied';
      l.history.push({ at, status: 'replied', note });
    } else if (status === 'failed') {
      l.history.push({ at, step: l.next_step, status: 'failed', note });
    } else if (status === 'skipped') {
      l.history.push({ at, step: l.next_step, status: 'skipped', note });
      l.next_step += 1;
      l.last_done_at = at;
      if (l.next_step >= c.steps.length) l.status = 'finished';
    } else if (status === 'stopped') {
      l.status = 'stopped';
      l.history.push({ at, status: 'stopped', note });
    } else {
      throw new Error('Statut inconnu : ' + status);
    }
    this.save();
    return l;
  }
}
