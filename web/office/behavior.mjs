export const carriesChair = (actor, walking) => Boolean(walking && actor.chair && !actor.stroll);
export function strollNodes(room, used, floor) {
  const reserved = new Set(['door', 'board', 'ne', 'n1', 'b0', 'b1', 'b2']);
  return Object.entries(room.NODES).filter(([name]) => !Object.hasOwn(room.SEATS, name) && !reserved.has(name) && !used.has(`${floor}:${name}`)).map(([name, [x]]) => ({ name, x }));
}
export function resumeBeat(nextBeat, currentTime, beat, index) {
  if (nextBeat >= currentTime) return { nextBeat, index };
  return { nextBeat: currentTime + 0.05, index: index + Math.ceil((currentTime - nextBeat) / beat) };
}

export function restingChairs(actors, extraSeats) {
  const extra = new Set(extraSeats);
  return [...new Set([...actors].filter((actor) => actor.visible && actor.chair && actor.stroll && extra.has(actor.stroll.home)).map((actor) => actor.stroll.home))];
}
export function createSnapshotRetry({ load, onSynced, onError, setTimer = setTimeout, clearTimer = clearTimeout }) {
  let generation = 0, timer, delay = 1000;
  async function run(ticket) {
    try {
      await load();
      if (ticket !== generation) return;
      onSynced();
    } catch (error) {
      if (ticket !== generation) return;
      onError(error);
      timer = setTimer(() => run(ticket), delay);
      delay = Math.min(30_000, delay * 2);
    }
  }
  function stop() { generation++; clearTimer(timer); }
  return { start() { stop(); delay = 1000; run(generation); }, stop };
}
