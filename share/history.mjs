const encoder = new TextEncoder();
const MAX_FILE = 16 * 1024 * 1024, MAX_TEXT = 4 * 1024 * 1024, CHUNK = 30 * 1024;
const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
const size = value => encoder.encode(value).length;
const identifierOrder = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const order = (a, b) => a.recognizedAt - b.recognizedAt || identifierOrder(a.id, b.id);
function readings(values, text, maximum = 8000, annotationLimit = 8192, utf16Limit = false) {
  if (values == null) return true;
  if (!Array.isArray(values) || values.length > maximum) return false;
  let end = 0;
  for (const value of values) {
    if (!value || !Number.isSafeInteger(value.start) || !Number.isSafeInteger(value.length) || value.start < end || value.length <= 0 ||
        value.start > text.length || value.length > text.length - value.start ||
        typeof value.text !== 'string' || !value.text.length || (utf16Limit ? value.text.length : size(value.text)) > annotationLimit ||
        (value.start < text.length && /[\uDC00-\uDFFF]/.test(text[value.start])) ||
        (value.start + value.length < text.length && /[\uDC00-\uDFFF]/.test(text[value.start + value.length]))) return false;
    end = value.start + value.length;
  }
  return true;
}

export function captionSnapshot(value) {
  if (value?.type !== 'snapshot' || typeof value.title !== 'string' || value.title.length > 256 ||
      !Array.isArray(value.lines) || value.lines.length > 40 || size(JSON.stringify(value)) > 48 * 1024) throw Error('Invalid captions');
  const ids = new Set();
  const lines = value.lines.map(line => {
    if (!line || !uuid(line.id) || ids.has(line.id.toLowerCase()) || typeof line.speaker !== 'string' || line.speaker.length > 80 ||
        (line.participantID != null && (!Number.isInteger(line.participantID) || line.participantID < 1 || line.participantID > 2147483647)) ||
        typeof line.text !== 'string' || !line.text.length || line.text.length > 3000 ||
        (line.translation != null && (typeof line.translation !== 'string' || line.translation.length > 3000)) ||
        typeof line.final !== 'boolean' || !Number.isFinite(line.time) ||
        !readings(line.readings, line.text, 160, 320, true) || !readings(line.translationReadings, line.translation ?? '', 160, 320, true)) throw Error('Invalid captions');
    const id = line.id.toLowerCase(); ids.add(id); return { ...line, id };
  });
  return { ...value, lines: lines.sort((a, b) => a.time - b.time || identifierOrder(a.id, b.id)) };
}

function cleanLine(line) {
  if (!line || !uuid(line.id) || !Number.isInteger(line.participantID) || line.participantID < 1 || line.participantID > 8 ||
      typeof line.speakerName !== 'string' || size(line.speakerName) > 8192 ||
      typeof line.text !== 'string' || !line.text.length || size(line.text) > MAX_TEXT ||
      !Number.isFinite(line.recognizedAt) || typeof line.final !== 'boolean' ||
      (line.sourceLanguageIdentifier != null && (typeof line.sourceLanguageIdentifier !== 'string' || !line.sourceLanguageIdentifier.length || size(line.sourceLanguageIdentifier) > 128))) throw Error('Invalid history line');
  const translation = line.translation;
  if (translation != null && (!translation || typeof translation.text !== 'string' || !translation.text.length || size(translation.text) > MAX_TEXT ||
      !['sourceIdentifier', 'targetIdentifier'].every(key => typeof translation[key] === 'string' && translation[key].length && size(translation[key]) <= 128))) throw Error('Invalid translation');
  if (!readings(line.readings, line.text) || !readings(line.translationReadings, translation?.text ?? '')) throw Error('Invalid readings');
  return { id: line.id.toLowerCase(), participantID: line.participantID, speakerName: line.speakerName, text: line.text,
    recognizedAt: line.recognizedAt, final: line.final,
    ...(translation ? { translation: { sourceIdentifier: translation.sourceIdentifier, targetIdentifier: translation.targetIdentifier, text: translation.text } } : {}),
    ...(line.sourceLanguageIdentifier ? { sourceLanguageIdentifier: line.sourceLanguageIdentifier } : {}),
    ...(line.readings != null ? { readings: line.readings } : {}),
    ...(line.translationReadings != null ? { translationReadings: line.translationReadings } : {}) };
}

export class CaptionHistory {
  constructor() { this.lines = new Map(); this.revision = 0; this.transfer = null; this.textBytes = 0; this.translationBytes = 0; this.fileBytes = 0; }
  receive(frame) {
    if (!uuid(frame.transfer) || !Number.isInteger(frame.count) || frame.count < 1 || frame.count > 547 ||
        !Number.isInteger(frame.index) || frame.index < 0 || frame.index >= frame.count ||
        typeof frame.data !== 'string' || frame.data.length > 40960 || !/^[A-Za-z0-9+/]*={0,2}$/.test(frame.data)) throw Error('Invalid history frame');
    const chunk = Uint8Array.from(atob(frame.data), value => value.charCodeAt(0));
    if (chunk.length > CHUNK) throw Error('History chunk too large');
    if (frame.index === 0) this.transfer = { id: frame.transfer, count: frame.count, next: 0, bytes: 0, chunks: [] };
    const transfer = this.transfer;
    if (!transfer || transfer.id !== frame.transfer || transfer.count !== frame.count || transfer.next !== frame.index || transfer.bytes + chunk.length > MAX_FILE) throw Error('Out of order history');
    transfer.chunks.push(chunk); transfer.bytes += chunk.length; transfer.next++;
    if (transfer.next < transfer.count) return null;
    this.transfer = null;
    const bytes = new Uint8Array(transfer.bytes); let offset = 0;
    for (const chunk of transfer.chunks) { bytes.set(chunk, offset); offset += chunk.length; }
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    if (typeof value.reset !== 'boolean' || !Number.isSafeInteger(value.revision) || value.revision < 1 ||
        !Number.isSafeInteger(value.baseRevision) || value.baseRevision < 0 ||
        typeof value.title !== 'string' || size(value.title) > 8192 || !Number.isFinite(value.startedAt) ||
        !Array.isArray(value.lines) || value.lines.length > 50000) throw Error('Invalid history');
    if (!value.reset && (!this.revision || value.baseRevision !== this.revision)) return { refresh: true };
    const lines = value.lines.map(cleanLine);
    if (new Set(lines.map(line => line.id)).size !== lines.length) throw Error('Duplicate history line');
    const removedValue = value.removedIDs ?? [];
    if (!Array.isArray(removedValue) || removedValue.length > 50000 || !removedValue.every(uuid)) throw Error('Invalid removed history');
    const removed = removedValue.map(value => value.toLowerCase());
    const removedSet = new Set(removed);
    if (removedSet.size !== removed.length || lines.some(line => removedSet.has(line.id))) throw Error('Invalid removed history');
    let textBytes = value.reset ? 0 : this.textBytes, translationBytes = value.reset ? 0 : this.translationBytes;
    let fileBytes = value.reset ? 0 : this.fileBytes;
    let count = value.reset ? 0 : this.lines.size;
    for (const id of removed) {
      const old = value.reset ? null : this.lines.get(id);
      if (old) {
        count--; textBytes -= size(old.text); translationBytes -= size(old.translation?.text ?? ''); fileBytes -= size(JSON.stringify(old)) + 1;
      }
    }
    for (const line of lines) {
      const old = value.reset ? null : this.lines.get(line.id);
      if (!old) count++;
      textBytes += size(line.text) - (old ? size(old.text) : 0);
      translationBytes += size(line.translation?.text ?? '') - size(old?.translation?.text ?? '');
      fileBytes += size(JSON.stringify(line)) - (old ? size(JSON.stringify(old)) : 0) + (old ? 0 : 1);
    }
    if (count > 50000 || textBytes > MAX_TEXT || translationBytes > MAX_TEXT || fileBytes + size(value.title) + 1024 > MAX_FILE) throw Error('History limit');
    if (value.reset) this.lines.clear();
    for (const id of removed) this.lines.delete(id);
    for (const line of lines) this.lines.set(line.id, line);
    this.revision = value.revision; this.title = value.title; this.startedAt = value.startedAt;
    this.textBytes = textBytes; this.translationBytes = translationBytes;
    this.fileBytes = fileBytes;
    return { value: { ...value, lines } };
  }
  snapshot() {
    return this.revision ? { reset: true, revision: this.revision, baseRevision: 0, title: this.title, startedAt: this.startedAt, lines: [...this.lines.values()].sort(order) } : null;
  }
  timeline(live) {
    if (!this.revision) return live;
    const updates = new Map((live?.lines ?? []).map(line => [line.id, line]));
    return { title: this.title, lines: [...this.lines.values()].sort(order).map(line => {
      const next = updates.get(line.id), sameText = next?.text === line.text;
      const sameTranslation = sameText && next?.translation === line.translation?.text;
      return { id: line.id, participantID: line.participantID, speaker: line.speakerName, text: line.text,
        final: line.final, time: line.recognizedAt + 978307200, translation: line.translation?.text,
        readings: line.readings ?? (sameText ? next?.readings : undefined),
        translationReadings: line.translationReadings ?? (sameTranslation ? next?.translationReadings : undefined) };
    }) };
  }
}

export function historyFrames(value) {
  const bytes = encoder.encode(JSON.stringify(value));
  if (bytes.length > MAX_FILE) throw Error('History file too large');
  const transfer = crypto.randomUUID(), count = Math.max(1, Math.ceil(bytes.length / CHUNK));
  return Array.from({ length: count }, (_, index) => {
    const chunk = bytes.subarray(index * CHUNK, (index + 1) * CHUNK);
    let binary = ''; for (const byte of chunk) binary += String.fromCharCode(byte);
    return { type: 'history', transfer, index, count, data: btoa(binary) };
  });
}
