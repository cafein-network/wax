export class ChannelFeed {
  sequence = 0;
  current = null;
  live = new Map();
  pending = false;
  begin(id) { this.current = id; this.live.clear(); this.pending = true; return ++this.sequence; }
  accepts(id, sequence) { return this.current === id && this.sequence === sequence; }
  receive(id, message) { if (id !== this.current) return false; if (this.pending) this.live.set(message.id, message); return true; }
  merge(id, sequence, snapshot) {
    if (!this.accepts(id, sequence)) return null;
    const messages = new Map(snapshot.map((message) => [message.id, message]));
    for (const [key, message] of this.live) messages.set(key, message);
    this.live.clear(); this.pending = false;
    return [...messages.values()].sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0) || String(a.at ?? '').localeCompare(String(b.at ?? '')));
  }
}
export class ChannelDrafts {
  values = new Map();
  read(id) { return this.values.get(id) ?? { body: '', version: 0 }; }
  edit(id, body) { if (this.read(id).body === body) return this.read(id); const entry = { body, version: this.read(id).version + 1 }; this.values.set(id, entry); return entry; }
  sent(id, version) { if (this.read(id).version !== version) return false; this.edit(id, ''); return true; }
}
