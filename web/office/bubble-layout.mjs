import { bubbleMs } from './chatter.mjs';
import { stackDown } from './model.mjs';

export const BUBBLE_MS = 6000;

export function bubbleText(text, kind, ms = BUBBLE_MS, translate = (value) => value) {
  const flat = String(kind === 'message' || kind === 'note' ? text : translate(text)).replace(/\s+/g, ' ').trim();
  const max = kind === 'npc' ? 120 : 60;
  const shown = flat.length > max ? `${flat.slice(0, max)}…` : flat;
  return { text: shown, ms: kind === 'emote' ? ms : bubbleMs(shown, ms) };
}

export function stackBubbles(items, stageWidth, gap = 4) {
  const boxes = [];
  for (const item of items.sort((a, b) => b.y - a.y)) {
    const { width, height } = item;
    const headX = item.x;
    item.x = Math.max(width / 2 + gap, Math.min(stageWidth - width / 2 - gap, headX));
    item.tail = `${Math.max(8, Math.min(width - 8, headX - item.x + width / 2))}px`;
    let bottom = item.y;
    for (let moved = true; moved;) {
      moved = false;
      for (const box of boxes) {
        const overlapX = Math.abs(item.x - box.x) < (width + box.width) / 2 + gap;
        const overlapY = bottom > box.bottom - box.height - gap && bottom - height < box.bottom + gap;
        if (overlapX && overlapY) { bottom = box.bottom - box.height - gap; moved = true; }
      }
    }
    item.bottom = bottom;
    boxes.push({ x: item.x, bottom, width, height });
  }
  return items;
}

export function stackTags(tags, gap = 2) {
  const tops = new Array(tags.length);
  for (const limit of new Set(tags.map((t) => t.limit))) {
    const floor = tags.map((t, i) => [t, i]).filter(([t]) => t.limit === limit);
    const placed = stackDown(floor.map(([t]) => ({ x: t.x, top: t.top, width: t.width, height: t.height })), gap, limit);
    floor.forEach(([, i], n) => { tops[i] = placed[n]; });
  }
  return tops;
}
