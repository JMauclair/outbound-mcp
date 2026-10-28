const $ = (id) => document.getElementById(id);
const send = (msg) => chrome.runtime.sendMessage(msg);
const KEYS = ['invite_day', 'invite_week', 'message_day', 'profile_view_day', 'read_day'];
const STATE_LABEL = {
  connected: ['Connecté', 'ok'],
  connecting: ['Connexion...', ''],
  disconnected: ['Déconnecté', 'bad'],
  unauthorized: ['Jeton refusé', 'bad']
};

let paused = false;
let capture = false;
let limitsTouched = false;

function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
}

async function refresh() {
  const s = await send({ type: 'getStatus' });
  const [label, cls] = STATE_LABEL[s.wsState] || ['?', ''];
  $('state').textContent = label;
  $('state').className = 'pill ' + cls;
  $('lastError').textContent = s.wsState === 'connected' ? '' : (s.lastError || '');
  if (s.hasToken && !$('token').value) $('token').placeholder = 'Jeton enregistré (colle-en un autre pour changer)';

  paused = s.paused;
  $('pause').textContent = paused ? 'Reprendre' : 'Pause';
  $('pause').className = paused ? 'primary' : 'danger';
  $('pauseLabel').textContent = paused ? 'Toutes les actions sont bloquées.' : 'Actions autorisées dans les limites.';

  for (const k of KEYS) {
    $('u_' + k).textContent = s.usage[k];
    if (!limitsTouched) $('l_' + k).value = s.limits[k];
    $('l_' + k).max = s.hardMax[k];
  }
  $('hardMax').textContent = 'Plafonds fixes : ' + KEYS.map((k) => `${k} ${s.hardMax[k]}`).join(', ');

  capture = s.capture;
  $('capture').textContent = capture ? 'Arrêter' : 'Démarrer';
  $('capCount').textContent = s.capturedCount;

  $('log').innerHTML = '';
  for (const e of s.log) {
    const li = document.createElement('li');
    const t = document.createElement('span');
    t.className = 't';
    t.textContent = fmtTime(e.ts);
    const body = document.createElement('span');
    if (!e.ok) body.className = 'ko';
    body.textContent = `${e.action} ${e.target || ''} ${e.ok ? '' : '(' + (e.error || 'erreur') + ')'}`;
    li.append(t, body);
    $('log').append(li);
  }
}

$('saveToken').onclick = async () => {
  const token = $('token').value.trim();
  if (!token) return;
  await send({ type: 'setToken', token });
  $('token').value = '';
  setTimeout(refresh, 800);
};

$('pause').onclick = async () => {
  await send({ type: 'setPaused', paused: !paused });
  refresh();
};

for (const k of KEYS) $('l_' + k).addEventListener('input', () => { limitsTouched = true; });

$('saveLimits').onclick = async () => {
  const limits = {};
  for (const k of KEYS) limits[k] = Number($('l_' + k).value);
  await send({ type: 'setLimits', limits });
  limitsTouched = false;
  refresh();
};

$('capture').onclick = async () => {
  await send({ type: 'setCapture', capture: !capture });
  refresh();
};

$('copyCapture').onclick = async () => {
  const { captured } = await send({ type: 'getCaptured' });
  await navigator.clipboard.writeText(JSON.stringify(captured, null, 2));
  $('copyCapture').firstChild.textContent = 'Copié (';
  setTimeout(() => { $('copyCapture').firstChild.textContent = 'Copier ('; }, 1500);
};

$('clearCapture').onclick = async () => {
  await send({ type: 'clearCaptured' });
  refresh();
};

refresh();
setInterval(refresh, 2000);
