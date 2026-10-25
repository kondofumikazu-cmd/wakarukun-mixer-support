const encoder = new TextEncoder();
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const MAX_PLAIN = 48 * 1024, MAX_WIRE = 72 * 1024;
function base64(bytes) {
  let value = '';
  for (let index = 0; index < bytes.length; index += 4096) value += String.fromCharCode(...bytes.subarray(index, index + 4096));
  return btoa(value);
}
function authenticatedData(room, packet) {
  const fields = ['fumixer-caption-e2e', '2', room, packet.sessionID, packet.streamID, String(packet.sequence), packet.kind,
    packet.transfer ?? '', packet.index == null ? '' : String(packet.index), packet.count == null ? '' : String(packet.count)];
  if (packet.sourceID != null) fields.push(packet.sourceID);
  return encoder.encode(fields.join('\n'));
}
function validate(packet, session) {
  if (!packet || packet.type !== 'sealed' || packet.version !== 2 || packet.sessionID !== session || !uuid(packet.streamID) ||
      !Number.isSafeInteger(packet.sequence) || packet.sequence < 1 || !['snapshot', 'history', 'contribution'].includes(packet.kind)) throw Error('Invalid envelope');
  const allowed = new Set(['type', 'version', 'sessionID', 'streamID', 'sequence', 'kind', 'payload']);
  if (packet.kind === 'contribution') {
    if (!uuid(packet.sourceID)) throw Error('Invalid contributor');
    allowed.add('sourceID');
  }
  if (packet.kind === 'history' || packet.kind === 'contribution') {
    if (!uuid(packet.transfer) || !Number.isInteger(packet.count) || packet.count < 1 || packet.count > 547 ||
        !Number.isInteger(packet.index) || packet.index < 0 || packet.index >= packet.count) throw Error('Invalid transfer');
    for (const key of ['transfer', 'index', 'count']) allowed.add(key);
  }
  if (Object.keys(packet).some(key => !allowed.has(key))) throw Error('Invalid fields');
}

export class CaptionCipher {
  static async create(secret, room, { streamID = crypto.randomUUID() } = {}) {
    if (!/^[A-Za-z0-9_-]{43}$/.test(secret) || !/^[a-f0-9]{32}$/.test(room) || !uuid(streamID)) throw Error('Invalid key');
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('fumixer-caption-view-v2\n' + secret)));
    const credential = base64(digest).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const contributorDigest = new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode('fumixer-caption-contribute-v2\n' + secret)));
    const contributorCredential = base64(contributorDigest).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
    const seed = await crypto.subtle.importKey('raw', encoder.encode(secret), 'HKDF', false, ['deriveKey']);
    const key = await crypto.subtle.deriveKey({ name: 'HKDF', hash: 'SHA-256', salt: encoder.encode(room), info: encoder.encode('fumixer-caption-e2e-v2') },
      seed, { name: 'AES-GCM', length: 256 }, false, ['encrypt', 'decrypt']);
    const cipher = new CaptionCipher(room, key, credential, streamID.toLowerCase());
    cipher.contributorCredential = contributorCredential;
    return cipher;
  }
  constructor(room, key, credential, streamID) {
    this.room = room; this.key = key; this.credential = credential; this.streamID = streamID; this.sequence = 0; this.received = new Map();
  }
  async seal(message, session, { nonce = crypto.getRandomValues(new Uint8Array(12)) } = {}) {
    const data = encoder.encode(message), value = JSON.parse(message);
    if (data.length > MAX_PLAIN || !uuid(session) || nonce.length !== 12 || this.sequence >= Number.MAX_SAFE_INTEGER) throw Error('Invalid content');
    const packet = { type: 'sealed', version: 2, sessionID: session.toLowerCase(), streamID: this.streamID, sequence: ++this.sequence, kind: value.type };
    if (value.type === 'history' || value.type === 'contribution') Object.assign(packet, { transfer: value.transfer, index: value.index, count: value.count });
    if (value.type === 'contribution') packet.sourceID = value.sourceID;
    validate(packet, packet.sessionID);
    const encrypted = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce, additionalData: authenticatedData(this.room, packet), tagLength: 128 }, this.key, data));
    const combined = new Uint8Array(nonce.length + encrypted.length); combined.set(nonce); combined.set(encrypted, nonce.length);
    packet.payload = base64(combined);
    const wire = JSON.stringify(packet);
    if (encoder.encode(wire).length > MAX_WIRE) throw Error('Too large');
    return wire;
  }
  async open(wire, session) {
    if (typeof wire !== 'string' || encoder.encode(wire).length > MAX_WIRE || !uuid(session)) throw Error('Too large');
    const packet = JSON.parse(wire); validate(packet, session.toLowerCase());
    if (packet.sequence <= (this.received.get(packet.streamID) ?? 0) || typeof packet.payload !== 'string' ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(packet.payload) || packet.payload.length % 4) throw Error('Invalid payload');
    const combined = Uint8Array.from(atob(packet.payload), byte => byte.charCodeAt(0));
    if (combined.length < 28 || combined.length > MAX_PLAIN + 28 || base64(combined) !== packet.payload) throw Error('Invalid payload');
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: combined.subarray(0, 12), additionalData: authenticatedData(this.room, packet), tagLength: 128 },
      this.key, combined.subarray(12));
    const message = new TextDecoder('utf-8', { fatal: true }).decode(plain), value = JSON.parse(message);
    if (value.type !== packet.kind || (value.transfer ?? null) !== (packet.transfer ?? null) ||
        (value.index ?? null) !== (packet.index ?? null) || (value.count ?? null) !== (packet.count ?? null) ||
        (value.sourceID ?? null) !== (packet.sourceID ?? null) ||
        (!this.received.has(packet.streamID) && this.received.size >= 256)) throw Error('Invalid contents');
    this.received.set(packet.streamID, packet.sequence);
    return message;
  }
}
