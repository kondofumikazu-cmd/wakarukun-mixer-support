import { CaptionCipher } from './crypto.mjs';
const status = document.getElementById('status');
const captions = document.getElementById('captions');
const empty = document.getElementById('empty');
const title = document.getElementById('title');
const follow = document.getElementById('follow');
const furigana = document.getElementById('furigana');
let latest;
let socket, timer, heartbeat, stopped = false, attempts = 0, sessionID;
const invitation = location.hash.match(/^#room=([a-f0-9]{32})&key=([A-Za-z0-9_-]{43})&v=2&relay=([A-Za-z0-9.-]+)(&reuse=1)?$/);
const room = invitation?.[1], key = invitation?.[2], reusable = Boolean(invitation?.[4]);
const relay = 'wss://fumixer-caption-sharing.kondofumikazu.workers.dev';
document.getElementById('size').addEventListener('input', event => {
  document.documentElement.style.setProperty('--caption-size', event.target.value + 'px');
});
document.getElementById('stop').addEventListener('click', () => finish('閲覧を終了しました。'));
furigana.addEventListener('change', () => { if (latest) render(latest); });
function clear() { latest = undefined; captions.replaceChildren(); empty.hidden = false; title.textContent = 'リアルタイム字幕'; }
function finish(message) {
  stopped = true; clearTimeout(timer); clearInterval(heartbeat); socket?.close(); clear();
  empty.hidden = true; status.textContent = message;
}
function appendText(element, text, readings) {
  if (!furigana.checked || readings == null) { element.textContent = text; return; }
  if (!Array.isArray(readings) || readings.length > 160) throw Error('Invalid readings');
  let position = 0;
  for (const reading of readings) {
    if (!reading || !Number.isInteger(reading.start) || !Number.isInteger(reading.length) ||
        reading.start < position || reading.length <= 0 || reading.start > text.length || reading.length > text.length - reading.start ||
        typeof reading.text !== 'string' || !reading.text.length || reading.text.length > 320) throw Error('Invalid reading');
    element.append(document.createTextNode(text.slice(position, reading.start)));
    const ruby = document.createElement('ruby'); ruby.append(document.createTextNode(text.slice(reading.start, reading.start + reading.length)));
    const annotation = document.createElement('rt'); annotation.textContent = reading.text; ruby.append(annotation); element.append(ruby);
    position = reading.start + reading.length;
  }
  element.append(document.createTextNode(text.slice(position)));
}
function render(value) {
  if (typeof value.title !== 'string' || value.title.length > 256 || !Array.isArray(value.lines) || value.lines.length > 40) throw Error('Invalid captions');
  const fragment = document.createDocumentFragment();
  for (const line of value.lines) {
    if (typeof line.id !== 'string' || typeof line.speaker !== 'string' || line.speaker.length > 80 ||
        (line.participantID != null && (!Number.isInteger(line.participantID) || line.participantID < 1 || line.participantID > 2147483647)) ||
        typeof line.text !== 'string' || line.text.length > 3000 ||
        (line.translation != null && (typeof line.translation !== 'string' || line.translation.length > 3000))) throw Error('Invalid captions');
    const section = document.createElement('section'); section.className = 'caption';
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
  latest = value;
  captions.replaceChildren(fragment); empty.hidden = value.lines.length > 0;
  title.textContent = value.title || 'リアルタイム字幕'; status.textContent = '字幕を受信中'; attempts = 0;
  if (changed && follow.checked) captions.lastElementChild?.scrollIntoView({ block: 'center', behavior: 'auto' });
}
async function connect() {
  if (stopped) return;
  let cipher;
  try { cipher = await CaptionCipher.create(key, room); }
  catch { finish('このブラウザでは暗号化された字幕を開けません。アプリか、対応するブラウザで開いてください。'); return; }
  if (stopped) return;
  const connection = new WebSocket(`${relay}/api/v2/rooms/${room}/socket`, ['fumixer-e2e-v2', 'r.' + cipher.credential]);
  socket = connection; sessionID = undefined;
  connection.addEventListener('open', () => {
    status.textContent = '相手の字幕を待っています…';
    clearInterval(heartbeat); heartbeat = setInterval(() => { if (socket.readyState === WebSocket.OPEN) socket.send('ping'); }, 20_000);
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
      }
      else if (value.type === 'sealed') {
        if (!sessionID) throw Error('Session');
        const message = JSON.parse(await cipher.open(event.data, sessionID));
        if (stopped || socket !== connection) return;
        if (message.type !== 'snapshot') throw Error('Content');
        render(message);
      }
      else if (value.type === 'status' && value.state === 'ended') {
        if (reusable) { clear(); status.textContent = '次の共有を待っています…'; }
        else finish('共有は終了しました。');
      }
      else if (value.type === 'status') { clear(); status.textContent = '相手の字幕を待っています…'; }
      else throw Error('Protocol');
    } catch { finish('字幕の受信データを確認できません。'); }
    });
  });
  connection.addEventListener('close', event => {
    if (socket !== connection) return;
    clearInterval(heartbeat);
    if (stopped) return;
    clear();
    if (!reusable && (event.code === 4000 || attempts >= 5)) { finish('共有は終了したか、サーバーの利用上限に達しています。'); return; }
    status.textContent = reusable ? '共有の開始を待っています…' : '通信が切れました。再接続中…'; attempts += 1;
    timer = setTimeout(connect, reusable ? Math.min(30_000, 1000 * 2 ** Math.min(attempts - 1, 5)) : Math.min(attempts, 5) * 1000);
  });
}
if (!room || !key || invitation?.[3] !== 'fumixer-caption-sharing.kondofumikazu.workers.dev') finish('アプリの「共有を開始」で表示したQRコードか、閲覧リンクを開いてください。');
else connect();
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && !stopped && socket?.readyState === WebSocket.CLOSED) { clearTimeout(timer); connect(); }
});
window.addEventListener('pagehide', () => { clearInterval(heartbeat); clearTimeout(timer); socket?.close(); });
window.addEventListener('hashchange', () => { finish('接続を切り替えています…'); location.reload(); });
