export class OfficeInbox {
  unread = new Map();
  seen = new Set();
  counts = new Map();

  receive(channel, message, self) {
    const key = `${channel}:${message.id}`;
    if (message.author === self || this.seen.has(key)) return false;
    this.seen.add(key);
    this.unread.set(key, { channel, author: message.author });
    this.counts.set(message.author, this.count(message.author) + 1);
    return true;
  }

  read(channel, ids) {
    const keys = ids ? new Set(ids.map((id) => `${channel}:${id}`)) : null;
    if (keys) for (const key of keys) this.seen.add(key);
    for (const [key, item] of this.unread) if (item.channel === channel && (!keys || keys.has(key))) {
      this.unread.delete(key);
      const remaining = this.count(item.author) - 1;
      if (remaining) this.counts.set(item.author, remaining); else this.counts.delete(item.author);
    }
  }

  isUnread(channel, id) { return this.unread.has(`${channel}:${id}`); }

  count(author) {
    return author === undefined ? this.unread.size : this.counts.get(author) ?? 0;
  }

  channelFor(author) {
    let channel;
    for (const item of this.unread.values()) if (author === undefined || item.author === author) channel = item.channel;
    return channel;
  }
}
