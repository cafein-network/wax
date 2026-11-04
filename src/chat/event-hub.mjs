import { randomBytes } from 'node:crypto';

export function createEventHub({ maxClients = 64, replay = 500, backlogBytes = 1024 * 1024 } = {}) {
  const clients = new Set(), recent = [];
  const instance = randomBytes(4).toString('hex');
  let next = 0;
  const send = (res, frame) => {
    if (res.writableLength > backlogBytes) { clients.delete(res); res.destroy(); return; }
    res.write(frame);
  };
  return {
    get size() { return clients.size; },
    broadcast(event, data) {
      const id = `${instance}-${++next}`;
      const frame = `id: ${id}\nevent: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
      recent.push({ seq: next, frame });
      if (recent.length > replay) recent.shift();
      for (const res of clients) send(res, frame);
    },
    connect(res, lastEventId) {
      res.write('retry: 3000\n\n');
      if (clients.size >= maxClients) {
        const oldest = clients.values().next().value; clients.delete(oldest); oldest.end('retry: 30000\n\n');
      }
      clients.add(res);
      if (lastEventId) {
        const match = /^([a-f0-9]{8})-(\d{1,15})$/.exec(String(lastEventId));
        const seq = match && match[1] === instance ? Number(match[2]) : null;
        if (seq !== null && seq <= next && (seq >= next || recent[0]?.seq <= seq + 1)) for (const item of recent) { if (item.seq > seq) send(res, item.frame); }
        else send(res, `event: resync\ndata: {}\n\n`);
      }
      return () => clients.delete(res);
    },
    ping() { for (const res of clients) send(res, ': ping\n\n'); },
    close() { for (const res of clients) res.end(); clients.clear(); },
  };
}
