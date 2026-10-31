const OPEN = 1;

function hub() {
  try { if (window.parent && window.parent !== window && window.parent.__waxEvents) return window.parent.__waxEvents; } catch {}
  return (window.__waxEvents ??= { source: null, users: 0 });
}

export function openEvents() {
  const shared = hub();
  shared.source ??= new EventSource('/api/events');
  shared.users++;
  const source = shared.source, added = [];
  let closed = false;
  const slots = {};
  const handle = {
    get readyState() { return source.readyState; },
    addEventListener(type, listener) {
      if (closed) return;
      source.addEventListener(type, listener); added.push([type, listener]);
      if (type === 'open' && source.readyState === OPEN) queueMicrotask(() => { if (!closed) listener(new Event('open')); });
    },
    set onopen(listener) { handle.setSlot('open', listener); },
    set onerror(listener) { handle.setSlot('error', listener); },
    setSlot(type, listener) {
      if (slots[type]) {
        source.removeEventListener(type, slots[type]);
        const at = added.findIndex(([t, l]) => t === type && l === slots[type]);
        if (at >= 0) added.splice(at, 1);
      }
      slots[type] = typeof listener === 'function' ? listener : null;
      if (slots[type]) handle.addEventListener(type, slots[type]);
    },
    close() {
      if (closed) return;
      closed = true;
      for (const [type, listener] of added) source.removeEventListener(type, listener);
      if (--shared.users === 0 && shared.source === source) { source.close(); shared.source = null; }
    },
  };
  return handle;
}
