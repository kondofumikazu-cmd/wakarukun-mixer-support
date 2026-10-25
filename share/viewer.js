import { CaptionCipher } from './crypto.mjs?v=collaboration1';
import { CaptionHistory, captionSnapshot } from './history.mjs?v=chronological1';
const status = document.getElementById('status');
const captions = document.getElementById('captions');
const empty = document.getElementById('empty');
const title = document.getElementById('title');
const follow = document.getElementById('follow');
const furigana = document.getElementById('furigana');
const older = document.getElementById('load-older');
let latest;
let history = new CaptionHistory(), visibleLines = 2000;
let socket, timer, heartbeat, stopped = false, viewing = false, attempts = 0, sessionID;
let connecting = false, connectionID = 0, suspended = false;
const invitation = location.hash.match(/^#room=([a-f0-9]{32})&key=([A-Za-z0-9_-]{43})&v=2&relay=([A-Za-z0-9.-]+)(&reuse=1)?$/);
const room = invitation?.[1], key = invitation?.[2], reusable = Boolean(invitation?.[4]);
const relay = 'wss://fumixer-caption-sharing.kondofumikazu.workers.dev';
const joinApp = document.getElementById('join-app');
if (joinApp && invitation && invitation[3] === 'fumixer-caption-sharing.kondofumikazu.workers.dev') {
  joinApp.href = 'fumixer://join' + location.hash; joinApp.hidden = false;
}
document.getElementById('choose-view').addEventListener('click', () => {
  if (viewing || stopped || !room || invitation?.[3] !== 'fumixer-caption-sharing.kondofumikazu.workers.dev') return;
  viewing = true; document.getElementById('entry').hidden = true;
  document.getElementById('viewer-controls').hidden = false; empty.hidden = false; connect();
});
document.getElementById('size').addEventListener('input', event => {
  document.documentElement.style.setProperty('--caption-size', event.target.value + 'px');
});
document.getElementById('stop').addEventListener('click', () => finish('閲覧を終了しました。'));
furigana.addEventListener('change', () => render());
older.addEventListener('click', () => { visibleLines += 2000; render(false); });
function clear() {
  latest = undefined; history = new CaptionHistory(); sessionID = undefined; visibleLines = 2000;
  captions.replaceChildren(); older.hidden = true; empty.hidden = false; title.textContent = 'リアルタイム字幕';
}
function finish(message) {
  stopped = true; connectionID++; connecting = false;
  clearTimeout(timer); clearInterval(heartbeat); socket?.close(); clear();
  empty.hidden = true; status.textContent = message;
}
function appendText(element, text, readings) {
  if (!furigana.checked || readings == null) { element.textContent = text; return; }
  if (!Array.isArray(readings) || readings.length > 8000) throw Error('Invalid readings');
  let position = 0;
  for (const reading of readings) {
    if (!reading || !Number.isInteger(reading.start) || !Number.isInteger(reading.length) ||
        reading.start < position || reading.length <= 0 || reading.start > text.length || reading.length > text.length - reading.start ||
        typeof reading.text !== 'string' || !reading.text.length || new TextEncoder().encode(reading.text).length > 8192) throw Error('Invalid reading');
    element.append(document.createTextNode(text.slice(position, reading.start)));
    const ruby = document.createElement('ruby'); ruby.append(document.createTextNode(text.slice(reading.start, reading.start + reading.length)));
    const annotation = document.createElement('rt'); annotation.textContent = reading.text; ruby.append(annotation); element.append(ruby);
    position = reading.start + reading.length;
  }
  element.append(document.createTextNode(text.slice(position)));
}
function render(autoFollow = true) {
  const value = history.timeline(latest);
  if (!value) return;
  const fragment = document.createDocumentFragment();
  for (const line of value.lines.slice(-visibleLines)) {
    const section = document.createElement('section'); section.className = 'caption';
    section.dataset.id = line.id;
    section.dataset.color = String(((line.participantID ?? 1) - 1) % 4 + 1);
    const speaker = document.createElement('p'); speaker.className = 'speaker'; speaker.textContent = line.speaker;
    const text = document.createElement('p'); text.className = 'original'; appendText(text, line.text, line.readings);
    section.append(speaker, text);
    if (line.translation) {
      const translation = document.createElement('p'); translation.className = 'translation'; appendText(translation, line.translation, line.translationReadings);
      section.append(translation);
    }
    fragment.append(section);
  }
  const changed = captions.textContent !== fragment.textContent;
  captions.replaceChildren(fragment); empty.hidden = value.lines.length > 0;
  older.hidden = value.lines.length <= visibleLines;
  title.textContent = value.title || 'リアルタイム字幕'; status.textContent = '字幕を受信中'; attempts = 0;
  if (changed && autoFollow && follow.checked) captions.lastElementChild?.scrollIntoView({ block: 'center', behavior: 'auto' });
}
async function connect() {
  if (stopped || suspended || connecting || socket && [WebSocket.OPEN, WebSocket.CONNECTING].includes(socket.readyState)) return;
  clearTimeout(timer); connecting = true; const requestID = ++connectionID;
  let cipher;
  try { cipher = await CaptionCipher.create(key, room); }
  catch {
    if (!stopped && !suspended && requestID === connectionID) finish('このブラウザでは暗号化された字幕を開けません。アプリか、対応するブラウザで開いてください。');
    return;
  }
  if (requestID === connectionID) connecting = false;
  if (stopped || suspended || requestID !== connectionID) return;
  const connection = new WebSocket(`${relay}/api/v2/rooms/${room}/socket`, ['fumixer-e2e-v2', 'r.' + cipher.credential]);
  socket = connection;
  connection.addEventListener('open', () => {
    if (stopped || suspended || socket !== connection) return;
    status.textContent = '相手の字幕を待っています…';
    clearInterval(heartbeat); heartbeat = setInterval(() => { if (connection.readyState === WebSocket.OPEN) connection.send('ping'); }, 20_000);
  });
  let receiveQueue = Promise.resolve();
  connection.addEventListener('message', event => {
    receiveQueue = receiveQueue.then(async () => { try {
      if (stopped || socket !== connection) return;
      if (event.data === 'pong') return;
      if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).length > 72 * 1024) throw Error('Size');
      const value = JSON.parse(event.data);
      if (value.type === 'ready') {
        if (value.version !== 2 || typeof value.sessionID !== 'string' || !/^[a-f0-9-]{36}$/i.test(value.sessionID)) throw Error('Protocol');
        if (sessionID !== value.sessionID) clear();
        sessionID = value.sessionID;
        connection.send('history');
      }
      else if (value.type === 'sealed') {
        if (!sessionID) throw Error('Session');
        const message = JSON.parse(await cipher.open(event.data, sessionID));
        if (stopped || socket !== connection) return;
        if (message.type === 'snapshot') { latest = captionSnapshot(message); render(); }
        else if (message.type === 'history') {
          const update = history.receive(message);
          if (update?.refresh) connection.send('history');
          else if (update) render();
        } else throw Error('Content');
      }
      else if (value.type === 'status' && value.state === 'ended') {
        if (reusable) { clear(); status.textContent = '次の共有を待っています…'; }
        else finish('共有は終了しました。');
      }
      else if (value.type === 'status') { status.textContent = '相手の字幕を待っています…'; }
      else throw Error('Protocol');
    } catch { if (!stopped && socket === connection) finish('字幕の受信データを確認できません。'); }
    });
  });
  connection.addEventListener('close', event => {
    if (socket !== connection) return;
    clearInterval(heartbeat);
    if (stopped || suspended) return;
    history.transfer = null;
    if (!reusable && (event.code === 4000 || attempts >= 5)) { finish('共有は終了したか、サーバーの利用上限に達しています。'); return; }
    status.textContent = reusable ? '共有の開始を待っています…' : '通信が切れました。再接続中…'; attempts += 1;
    timer = setTimeout(connect, reusable ? Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)) : Math.min(attempts, 5) * 1000);
  });
}
if (!room || !key || invitation?.[3] !== 'fumixer-caption-sharing.kondofumikazu.workers.dev') finish('アプリの「共有を開始」で表示したQRコードか、閲覧リンクを開いてください。');
else status.textContent = '閲覧または参加を選んでください。';
document.addEventListener('visibilitychange', () => {
  if (viewing && !document.hidden && !stopped && socket?.readyState === WebSocket.CLOSED) { clearTimeout(timer); connect(); }
});
window.addEventListener('pagehide', () => {
  suspended = true; connectionID++; connecting = false;
  clearInterval(heartbeat); clearTimeout(timer); socket?.close();
});
window.addEventListener('pageshow', () => {
  if (!suspended) return;
  suspended = false; if (viewing && !stopped) connect();
});
window.addEventListener('hashchange', () => { finish('接続を切り替えています…'); location.reload(); });
