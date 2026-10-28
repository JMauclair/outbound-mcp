# Outbound MCP

Pilote ta prospection LinkedIn depuis Claude, avec ta propre session Chrome.
Une extension Chrome + un petit serveur MCP local. Pas de cloud, pas d'abonnement, pas de proxy.

```
Claude (desktop / Code)
   │  MCP (stdio)
   ▼
mcp-server/  ── WebSocket 127.0.0.1:47811 (jeton) ──►  extension/ (Chrome)
                                                          │  fetch depuis un onglet linkedin.com,
                                                          ▼  avec tes cookies
                                                   API Voyager de LinkedIn
```

Claude rédige et décide. L'extension exécute, et c'est elle qui applique les garde-fous :
quotas journaliers et hebdomadaires, plafonds fixes, délai humain avant chaque action,
écart minimum entre deux envois, bouton pause. Claude ne peut pas les contourner.

## Ce que ça fait

| Outil MCP | Rôle |
| --- | --- |
| `linkedin_status` | Connexion, compte LinkedIn, quotas du jour |
| `linkedin_get_profile` | Lit un profil et récupère son URN (compte comme une visite) |
| `linkedin_send_invite` | Invitation avec note personnalisée (300 caractères max) |
| `linkedin_send_message` | Message à une relation |
| `linkedin_list_sent_invitations` | Invitations en attente |
| `linkedin_list_recent_connections` | Dernières acceptations |
| `linkedin_voyager_get` | Lecture brute d'un endpoint Voyager (GET uniquement) |
| `campaign_create` / `campaign_add_leads` / `campaign_due` / `campaign_mark` / `campaign_list` / `campaign_get` | Séquences façon lemlist, stockées en local dans `~/.outbound-mcp/campaigns.json` |

## Installation

### 1. Le serveur MCP

```bash
cd mcp-server
npm install
node index.js   # premier lancement : crée ~/.outbound-mcp/config.json avec ton jeton, puis Ctrl+C
cat ~/.outbound-mcp/config.json
```

Ajoute-le à Claude desktop (`~/Library/Application Support/Claude/claude_desktop_config.json` sur Mac) :

```json
{
  "mcpServers": {
    "outbound": {
      "command": "node",
      "args": ["/CHEMIN/ABSOLU/outbound-mcp/mcp-server/index.js"]
    }
  }
}
```

Ou à Claude Code :

```bash
claude mcp add outbound -- node /CHEMIN/ABSOLU/outbound-mcp/mcp-server/index.js
```

Plusieurs conversations peuvent tourner en même temps : la première copie du serveur ouvre le port 47811, les suivantes passent par elle en relais, et reprennent la main si elle s'arrête.

### 2. L'extension

1. Chrome → `chrome://extensions` → active le **Mode développeur**.
2. **Charger l'extension non empaquetée** → choisis le dossier `extension/`.
3. Ouvre la popup de l'extension, colle le `token` de `~/.outbound-mcp/config.json`, clique OK.
4. Connecte-toi à linkedin.com dans ce Chrome. La pastille passe à **Connecté** quand Claude tourne.

## Utilisation

Dans Claude :

> Vérifie la connexion LinkedIn.

> Crée une campagne « dirmark-ecom » : objectif, proposer un audit tracking gratuit aux directeurs marketing e-commerce.
> Étape 1 invitation avec note, étape 2 message 1 jour après acceptation, étape 3 relance 4 jours après.
> Ajoute ces 5 profils : …

> Fais le point sur la campagne : récupère chaque profil, propose-moi une note personnalisée par prospect, et attends mon accord avant d'envoyer.

> Qui a accepté depuis hier ? Marque-les et prépare les messages de l'étape 2.

## Garde-fous

Réglages par défaut, modifiables dans la popup sans dépasser les plafonds fixes :

| | Défaut | Plafond fixe |
| --- | --- | --- |
| Invitations / jour | 15 | 25 |
| Invitations / 7 jours | 80 | 100 |
| Messages / jour | 30 | 50 |
| Profils consultés / jour | 80 | 150 |
| Lectures API / jour | 300 | 600 |

Avant chaque invitation ou message : au moins 60 s depuis l'action précédente, plus 10 à 45 s aléatoires.
Sur 429 ou erreur d'authentification, l'extension renvoie l'erreur et Claude doit s'arrêter.

## Mode capture

Voyager est une API interne, non documentée. Les `decorationId` et `queryId` changent régulièrement.

1. Popup → **Mode capture → Démarrer**.
2. Fais l'action à la main sur linkedin.com (envoyer une invitation, ouvrir la messagerie…).
3. **Copier** : tu obtiens les requêtes Voyager exactes (méthode, URL, corps).
4. Mets à jour `extension/voyager-endpoints.js`, puis recharge l'extension dans `chrome://extensions`.

C'est aussi le moyen de brancher de nouvelles lectures via `linkedin_voyager_get` sans toucher au code.

## Tests

```bash
cd mcp-server && node tests/e2e-test.mjs /tmp/outbound-test
```

Simule l'extension et vérifie l'authentification, la remontée des erreurs et le cycle d'une campagne.

## Avertissement

L'automatisation est interdite par les conditions d'utilisation de LinkedIn, que ce soit avec cet outil
ou avec un SaaS. Le risque (restriction, déconnexion, bannissement) porte sur **ton** compte.
Reste sur de petits volumes, personnalise chaque message, et n'utilise pas cet outil pour du spam.
Tu es responsable du respect du RGPD pour les données de prospects que tu traites.

## Licence

MIT
