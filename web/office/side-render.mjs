import { CHAIR_STACK, FLOOR, FLOOR_HEIGHT, LIFT_WIDTH, LIFT_X, PROP_BOTTOM, SCALE, WIDTH } from './side-rooms.mjs';
import { NOTE_COLORS, dressed, drawZz } from './paint.mjs';

const flipFor = (info, facingLeft) => facingLeft !== (info?.faces === 'left');

export function sideImageFor(sprite, actor) {
  if (!sprite) return null;
  const { views = {}, poses = {} } = sprite;
  const facingLeft = actor.facing === 'left';
  if (actor.riding) return { info: views.front, flip: false };
  if (actor.walking) {
    const frame = (actor.pose?.leg ?? 0) > 0 ? poses.walk1 : poses.walk2;
    return { info: frame ?? views.side, flip: flipFor(frame ?? views.side, facingLeft), legs: !frame };
  }
  if (actor.sit && actor.seatKind === 'sofa') return { info: views.front, flip: false, sofa: true };
  if (actor.sit) {
    const pose = actor.activity === 'sleep' ? poses.doze : actor.activity === 'coffee' || actor.activity === 'npc' ? poses.coffee : poses.type;
    if (pose) return { info: pose, flip: flipFor(pose, facingLeft) };
    return { info: views.front, flip: false };
  }
  if ((actor.activity === 'coffee' || actor.cup) && poses.sip) return { info: poses.sip, flip: flipFor(poses.sip, facingLeft) };
  if (actor.activity === 'talking' || actor.activity === 'reading' || actor.activity === 'chat' || actor.activity === 'posting') return { info: views.side, flip: flipFor(views.side, facingLeft) };
  return { info: views.front, flip: false };
}

export function actorBox(actor, sprite) {
  const picked = sideImageFor(sprite, actor);
  const k = (actor.scale ?? 1) * (picked?.info?.scale ?? 1);
  const info = picked?.info ?? { width: 60, height: 150, anchor: { x: 30, y: 150 } };
  const drop = picked?.sofa ? sofaLayout(info.height).drop * k : 0;
  return { top: actor.y - info.anchor.y * k + drop, bottom: actor.y + (info.height - info.anchor.y) * k, left: actor.x - (info.width / 2) * k, right: actor.x + (info.width / 2) * k };
}


function shade(hex, amount) {
  const n = parseInt(hex.slice(1), 16);
  const c = [n >> 16, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v + amount))));
  return `rgb(${c.join(',')})`;
}

function drawFloor(ctx, room) {
  ctx.fillStyle = room.wall;
  ctx.fillRect(0, 0, WIDTH, FLOOR);
  ctx.fillStyle = room.accent;
  ctx.fillRect(0, 0, WIDTH, 14);
  ctx.fillStyle = shade(room.wall, -18);
  ctx.fillRect(0, FLOOR - 12, WIDTH, 12);
  ctx.fillStyle = room.dark ? '#1b2232' : '#c69c6d';
  ctx.fillRect(0, FLOOR, WIDTH, FLOOR_HEIGHT - FLOOR);
  ctx.fillStyle = room.dark ? '#222b3d' : '#b98d5f';
  for (let x = 0; x < WIDTH; x += 96) ctx.fillRect(x, FLOOR, 3, 90);
  ctx.fillStyle = '#5b4a3a';
  ctx.fillRect(0, FLOOR_HEIGHT - 16, WIDTH, 16);
}

export const floorName = (building, id) => building.rooms[id]?.floor ?? `${building.floors.indexOf(id) + 1}F`;

function drawRoof(ctx) {
  const sky = ['#9fd3ef', '#b5ddf2', '#c9e6f4', '#dcedf3'];
  const band = Math.ceil(FLOOR / sky.length);
  sky.forEach((color, i) => { ctx.fillStyle = color; ctx.fillRect(0, i * band, WIDTH, band); });
  ctx.fillStyle = '#ffffff';
  for (const [x, y, w] of [[120, 34, 90], [470, 22, 120], [860, 40, 80], [1120, 18, 110]]) {
    ctx.fillRect(x, y + 8, w, 12); ctx.fillRect(x + w * 0.2, y, w * 0.45, 10); ctx.fillRect(x + w * 0.5, y + 3, w * 0.3, 8);
  }
  for (let x = 0, i = 0; x < WIDTH; i++) {
    const w = 40 + ((i * 37) % 50), h = 40 + ((i * 53) % 70);
    ctx.fillStyle = i % 2 ? '#8fb4c9' : '#a3c3d4';
    ctx.fillRect(x, FLOOR - 34 - h, w, h + 34);
    ctx.fillStyle = '#c4dae5';
    for (let wy = FLOOR - 26 - h; wy < FLOOR - 40; wy += 14) for (let wx = x + 6; wx < x + w - 8; wx += 12) ctx.fillRect(wx, wy, 5, 6);
    x += w + 6;
  }
  ctx.fillStyle = '#d7dfd9'; ctx.fillRect(0, FLOOR - 40, WIDTH, 40);
  ctx.fillStyle = '#b9c4bd'; ctx.fillRect(0, FLOOR - 40, WIDTH, 5);
  ctx.fillStyle = 'rgba(200,232,244,0.55)'; ctx.fillRect(0, FLOOR - 78, WIDTH, 38);
  ctx.fillStyle = '#7d8a83'; ctx.fillRect(0, FLOOR - 82, WIDTH, 5);
  for (let x = 40; x < WIDTH; x += 160) ctx.fillRect(x, FLOOR - 82, 4, 42);
  ctx.fillStyle = '#b07a4f'; ctx.fillRect(0, FLOOR, WIDTH, FLOOR_HEIGHT - FLOOR);
  ctx.fillStyle = '#9c6a42';
  for (let y = FLOOR + 10; y < FLOOR_HEIGHT - 16; y += 12) ctx.fillRect(0, y, WIDTH, 2);
  ctx.fillStyle = '#5b4a3a'; ctx.fillRect(0, FLOOR_HEIGHT - 16, WIDTH, 16);
  ctx.strokeStyle = '#4b4f55'; ctx.lineWidth = 2;
  for (const [x0, x1] of [[150, 560], [560, 1010], [1010, 1270]]) {
    ctx.beginPath(); ctx.moveTo(x0, 36);
    ctx.quadraticCurveTo((x0 + x1) / 2, 76, x1, 36); ctx.stroke();
    for (let t = 0.1; t < 1; t += 0.14) {
      const x = (1 - t) * (1 - t) * x0 + 2 * (1 - t) * t * ((x0 + x1) / 2) + t * t * x1;
      const y = (1 - t) * (1 - t) * 36 + 2 * (1 - t) * t * 76 + t * t * 36;
      ctx.fillStyle = '#ffd36b'; ctx.fillRect(Math.round(x) - 3, Math.round(y) + 1, 6, 7);
    }
  }
  ctx.fillStyle = '#5f6b78';
  for (const x of [150, 560, 1010, 1270]) ctx.fillRect(x - 3, 30, 6, FLOOR - 30 - 82);
}

function drawLiftShaft(ctx, building) {
  const x = LIFT_X - LIFT_WIDTH / 2;
  ctx.fillStyle = '#2b2f36';
  ctx.fillRect(x - 10, 0, LIFT_WIDTH + 20, building.SIZE.height);
  building.floors.forEach((id) => {
    const top = building.floorTop[id];
    const S = SCALE, door = 196 * S, sill = 72 * S;
    ctx.fillStyle = '#9aa3ad'; ctx.fillRect(x - 6, top + FLOOR - door, LIFT_WIDTH + 12, door + sill);
    ctx.fillStyle = '#c9ced6'; ctx.fillRect(x, top + FLOOR - door + 8, LIFT_WIDTH / 2 - 1, door + sill - 16);
    ctx.fillRect(x + LIFT_WIDTH / 2 + 1, top + FLOOR - door + 8, LIFT_WIDTH / 2 - 1, door + sill - 16);
    ctx.fillStyle = '#1b2232'; ctx.fillRect(x + LIFT_WIDTH / 2 - 16, top + FLOOR - door - 26, 32, 20);
    ctx.fillStyle = '#f59e3b'; ctx.font = 'bold 14px monospace'; ctx.fillText(floorName(building, id), x + LIFT_WIDTH / 2 - 11, top + FLOOR - door - 11);
  });
}

function drawLiftCar(ctx, y) {
  const x = LIFT_X - LIFT_WIDTH / 2;
  const h = 210 * SCALE;
  ctx.fillStyle = '#e8ebef'; ctx.fillRect(x, y - h + 10, LIFT_WIDTH, h);
  ctx.strokeStyle = '#5f6b78'; ctx.lineWidth = 4; ctx.strokeRect(x, y - h + 10, LIFT_WIDTH, h);
  ctx.fillStyle = '#ffe9a8'; ctx.fillRect(x + 8, y - h + 16, LIFT_WIDTH - 16, 6);
}

const WALL_PROPS = new Set(['window', 'sign', 'door', 'shelf', 'screen']);
const PROP_SPRITE = { table: 'hotdesk', longtable: 'conftable', bench: 'testbench', bossdesk: 'desk' };

const PROP_DRAW = {
  door(ctx, p) { ctx.fillStyle = '#7a5a3a'; ctx.fillRect(p.x, FLOOR - 230, p.w, 230); ctx.fillStyle = '#5e4429'; ctx.fillRect(p.x + 8, FLOOR - 220, p.w - 16, 220); ctx.fillStyle = '#e6c27a'; ctx.fillRect(p.x + p.w - 24, FLOOR - 120, 8, 16); },
  window(ctx, p) { ctx.fillStyle = '#8fb8d6'; ctx.fillRect(p.x, 40, p.w, 180); ctx.fillStyle = '#b9d6ea'; ctx.fillRect(p.x + 8, 48, p.w - 16, 80); ctx.fillStyle = '#6d8fa8'; for (let i = 0; i < 5; i++) ctx.fillRect(p.x + 16 + i * (p.w - 32) / 4, 130 - (i % 3) * 22, 24, 90 + (i % 3) * 22); ctx.strokeStyle = '#e9e4da'; ctx.lineWidth = 7; ctx.strokeRect(p.x, 40, p.w, 180); },
  sign(ctx, p) { ctx.fillStyle = '#27342b'; ctx.fillRect(p.x, 70, p.w, 60); ctx.fillStyle = '#f59e3b'; ctx.font = 'bold 36px monospace'; ctx.fillText('wax', p.x + 40, 113); },
  desk(ctx, p) { ctx.fillStyle = '#f4f1ea'; ctx.fillRect(p.x, FLOOR + 22, p.w, 12); ctx.fillStyle = '#c9c3b6'; ctx.fillRect(p.x + 8, FLOOR + 34, 7, 46); ctx.fillRect(p.x + p.w - 15, FLOOR + 34, 7, 46); ctx.fillStyle = '#9aa3ad'; ctx.fillRect(p.x + 28, FLOOR + 15, 42, 7); ctx.fillStyle = '#5f6b78'; ctx.fillRect(p.x + 66, FLOOR - 12, 5, 34); },
  table(ctx, p) { ctx.fillStyle = '#d9b38c'; ctx.fillRect(p.x, FLOOR + 8, p.w, 14); ctx.fillStyle = '#a77f58'; ctx.fillRect(p.x + p.w / 2 - 5, FLOOR + 22, 10, 56); },
  longtable(ctx, p) { ctx.fillStyle = '#c99a6b'; ctx.fillRect(p.x, FLOOR + 26, p.w, 16); ctx.fillStyle = '#8a6440'; ctx.fillRect(p.x + 20, FLOOR + 42, 10, 46); ctx.fillRect(p.x + p.w - 30, FLOOR + 42, 10, 46); },
  whiteboard(ctx, p) { ctx.fillStyle = '#7d858e'; ctx.fillRect(p.x + 10, 110, 6, FLOOR - 100); ctx.fillRect(p.x + p.w - 16, 110, 6, FLOOR - 100); ctx.fillStyle = '#fbfbf7'; ctx.fillRect(p.x, 100, p.w, 110); ctx.strokeStyle = '#7d858e'; ctx.lineWidth = 5; ctx.strokeRect(p.x, 100, p.w, 110); },
  sofa(ctx, p) { ctx.fillStyle = '#3f7f86'; ctx.fillRect(p.x, FLOOR + 8, p.w, 50); ctx.fillStyle = '#336a70'; ctx.fillRect(p.x, FLOOR - 26, 20, 84); ctx.fillRect(p.x + p.w - 20, FLOOR - 26, 20, 84); ctx.fillStyle = '#4c929a'; ctx.fillRect(p.x + 20, FLOOR - 8, p.w - 40, 26); },
  coffee(ctx, p) { ctx.fillStyle = '#8a6440'; ctx.fillRect(p.x - 8, FLOOR - 16, p.w + 16, 96); ctx.fillStyle = '#2b2f36'; ctx.fillRect(p.x, FLOOR - 76, p.w, 60); ctx.fillStyle = '#f4f1ea'; ctx.fillRect(p.x + 12, FLOOR - 30, 12, 12); },
  plant(ctx, p) { ctx.fillStyle = '#f4f1ea'; ctx.fillRect(p.x, FLOOR + 16, p.w, 34); ctx.fillStyle = '#3f8f4f'; for (let i = 0; i < 5; i++) ctx.fillRect(p.x - 10 + i * 12, FLOOR - 50 + (i % 2) * 18, 12, 68); },
  monitorwall(ctx, p) { for (let i = 0; i < 3; i++) { const x = p.x + i * (p.w / 3); ctx.fillStyle = '#0d1320'; ctx.fillRect(x, 70, p.w / 3 - 8, 96); ctx.fillStyle = i % 2 ? '#38d39f' : '#4fa3ff'; for (let k = 0; k < 6; k++) { const h = ((k * 37 + i * 11) % 50) + 8; ctx.fillRect(x + 10 + k * 10, 150 - h, 6, h); } } },
  server(ctx, p) { ctx.fillStyle = '#10151f'; ctx.fillRect(p.x, FLOOR - 220, p.w, 300); for (let r = 0; r < 10; r++) { ctx.fillStyle = r % 3 ? '#38d39f' : '#4fa3ff'; ctx.fillRect(p.x + 10, FLOOR - 205 + r * 28, 6, 6); ctx.fillStyle = '#2a3346'; ctx.fillRect(p.x + 24, FLOOR - 206 + r * 28, p.w - 34, 8); } },
  bench(ctx, p) { ctx.fillStyle = '#c3ccd8'; ctx.fillRect(p.x, FLOOR + 20, p.w, 12); ctx.fillStyle = '#8692a3'; ctx.fillRect(p.x + 8, FLOOR + 32, 7, 48); ctx.fillRect(p.x + p.w - 15, FLOOR + 32, 7, 48); ctx.fillStyle = '#1b2232'; ctx.fillRect(p.x + 40, FLOOR - 26, 56, 46); ctx.fillStyle = '#38d39f'; ctx.fillRect(p.x + 45, FLOOR - 21, 46, 34); },
  screen(ctx, p) { ctx.fillStyle = '#1b2232'; ctx.fillRect(p.x, 60, p.w, 120); ctx.fillStyle = '#4fa3ff'; ctx.fillRect(p.x + 10, 70, p.w - 20, 100); },
  shelf(ctx, p) { ctx.fillStyle = '#7a5a3a'; ctx.fillRect(p.x, 50, p.w, FLOOR - 50); const colors = ['#d9774b', '#3b82c4', '#7fd17a', '#f7d154', '#8c96a3']; for (let r = 0; r < 4; r++) for (let i = 0; i < 8; i++) { ctx.fillStyle = colors[(r * 3 + i) % colors.length]; ctx.fillRect(p.x + 12 + i * 28, 64 + r * 58, 18, 44); } },
  tree(ctx, p) {
    const b = PROP_BOTTOM, c = p.x + p.w / 2;
    ctx.fillStyle = '#8a5a36'; ctx.fillRect(p.x, b - 34, p.w, 34); ctx.fillStyle = '#6f4528'; ctx.fillRect(p.x, b - 34, p.w, 5);
    ctx.fillStyle = '#4c9a58'; ctx.fillRect(p.x + 4, b - 40, p.w - 8, 6);
    ctx.fillStyle = '#6b4a2e'; ctx.fillRect(c - 6, b - 120, 12, 82); ctx.fillRect(c - 22, b - 112, 16, 6);
    const rows = [[0.3, '#2f7a40'], [0.55, '#3f8f4f'], [0.75, '#3f8f4f'], [0.9, '#3f8f4f'], [1, '#3f8f4f'], [0.95, '#2f7a40'], [0.8, '#2f7a40'], [0.55, '#2a6b38']];
    rows.forEach(([k, color], r) => { const w = Math.round(p.w * 0.9 * k); ctx.fillStyle = color; ctx.fillRect(Math.round(c - w / 2), b - 212 + r * 12, w, 12); });
    ctx.fillStyle = '#58a862';
    for (const [dx, dy, w] of [[-34, -196, 22], [6, -186, 26], [-48, -164, 18], [22, -160, 20], [-14, -150, 16]]) ctx.fillRect(c + dx, b + dy, w, 10);
    ctx.fillStyle = '#f29bb6'; for (const [dx, dy] of [[-40, -176], [30, -190], [10, -146], [-24, -132]]) ctx.fillRect(c + dx, b + dy, 5, 5);
  },
  lawn(ctx, p) { const b = PROP_BOTTOM; ctx.fillStyle = '#5aa865'; ctx.fillRect(p.x, b - 10, p.w, 12); ctx.fillStyle = '#4c9a58'; for (let x = p.x; x < p.x + p.w; x += 8) ctx.fillRect(x, b - 14 + (x % 3), 3, 6); },
  planter(ctx, p) { const b = PROP_BOTTOM; ctx.fillStyle = '#8a5a36'; ctx.fillRect(p.x, b - 30, p.w, 30); ctx.fillStyle = '#6f4528'; ctx.fillRect(p.x, b - 30, p.w, 5); ctx.fillStyle = '#4c9a58'; ctx.fillRect(p.x + 4, b - 46, p.w - 8, 16); const flowers = ['#f29bb6', '#ffd36b', '#ffffff', '#e5735f']; for (let i = 0; i < p.w / 16; i++) { ctx.fillStyle = '#3f8f4f'; ctx.fillRect(p.x + 8 + i * 16, b - 58 + (i % 3) * 4, 3, 14); ctx.fillStyle = flowers[i % flowers.length]; ctx.fillRect(p.x + 5 + i * 16, b - 64 + (i % 3) * 4, 9, 8); } },
  gardenbench(ctx, p) { const b = PROP_BOTTOM; ctx.fillStyle = '#4b4f55'; ctx.fillRect(p.x + 8, b - 18, 6, 18); ctx.fillRect(p.x + p.w - 14, b - 18, 6, 18); ctx.fillStyle = '#c08a58'; ctx.fillRect(p.x, b - 24, p.w, 8); ctx.fillStyle = '#a8744a'; ctx.fillRect(p.x + 4, b - 58, p.w - 8, 8); ctx.fillRect(p.x + 4, b - 44, p.w - 8, 8); ctx.fillStyle = '#4b4f55'; ctx.fillRect(p.x + 8, b - 60, 5, 40); ctx.fillRect(p.x + p.w - 13, b - 60, 5, 40); },
  bartable(ctx, p) { const b = PROP_BOTTOM; ctx.fillStyle = '#4b4f55'; ctx.fillRect(p.x + p.w / 2 - 3, b - 66, 6, 66); ctx.fillRect(p.x + p.w / 2 - 16, b - 4, 32, 4); ctx.fillStyle = '#e8e2d6'; ctx.fillRect(p.x, b - 72, p.w, 7); ctx.fillStyle = '#f4f1ea'; ctx.fillRect(p.x + 10, b - 82, 8, 10); ctx.fillRect(p.x + p.w - 18, b - 82, 8, 10); },
  parasol(ctx, p) { const b = PROP_BOTTOM, c = p.x + p.w / 2; ctx.fillStyle = '#5f6b78'; ctx.fillRect(c - 2, b - 150, 4, 150); ctx.fillStyle = '#e5735f'; ctx.fillRect(p.x, b - 158, p.w, 10); ctx.fillRect(p.x + 14, b - 168, p.w - 28, 10); ctx.fillRect(p.x + 40, b - 176, p.w - 80, 8); ctx.fillStyle = '#fbe9d0'; for (let x = p.x + 20; x < p.x + p.w - 10; x += 40) ctx.fillRect(x, b - 158, 16, 10); ctx.fillStyle = '#e8e2d6'; ctx.fillRect(c - 34, b - 42, 68, 6); ctx.fillStyle = '#4b4f55'; ctx.fillRect(c - 3, b - 36, 6, 36); ctx.fillStyle = '#f4f1ea'; ctx.fillRect(c - 20, b - 51, 8, 9); ctx.fillRect(c + 12, b - 51, 8, 9); },
  cabinet(ctx, p) { const b = PROP_BOTTOM, h = p.h ?? 34; ctx.fillStyle = '#8a5a36'; ctx.fillRect(p.x, b - h, p.w, h); ctx.fillStyle = '#a8744a'; ctx.fillRect(p.x - 3, b - h - 4, p.w + 6, 5); ctx.fillStyle = '#6f4528'; ctx.fillRect(p.x + p.w / 2 - 1, b - h + 4, 2, h - 6); ctx.fillStyle = '#e6c27a'; ctx.fillRect(p.x + p.w / 2 - 6, b - h / 2, 3, 6); ctx.fillRect(p.x + p.w / 2 + 3, b - h / 2, 3, 6); ctx.fillStyle = '#f4f1ea'; for (let i = 0; i < 3; i++) ctx.fillRect(p.x + p.w - 30 + i * 9, b - h - 13, 6, 9); ctx.fillStyle = '#dcd5c8'; ctx.fillRect(p.x + p.w - 32, b - h - 5, 30, 2); },
  coffeecart(ctx, p) { const b = PROP_BOTTOM; ctx.fillStyle = '#b47f4d'; ctx.fillRect(p.x, b - 54, p.w, 50); ctx.fillStyle = '#dbab76'; ctx.fillRect(p.x - 2, b - 58, p.w + 4, 5); ctx.fillStyle = '#c9ced6'; ctx.fillRect(p.x + 12, b - 86, 30, 28); ctx.fillStyle = '#2f3338'; ctx.fillRect(p.x + 8, b - 4, 6, 4); ctx.fillRect(p.x + p.w - 14, b - 4, 6, 4); },
  lantern(ctx, p) { const b = PROP_BOTTOM, c = p.x + p.w / 2; ctx.fillStyle = '#2f3338'; ctx.fillRect(c - 2, b - 96, 4, 92); ctx.fillRect(c - 6, b - 6, 12, 6); ctx.fillRect(c - 8, b - 120, 16, 6); ctx.fillStyle = '#ffd36b'; ctx.fillRect(c - 6, b - 114, 12, 16); },
  chair(ctx, p) { const b = PROP_BOTTOM; ctx.fillStyle = '#23262b'; ctx.fillRect(p.x + p.w * 0.2, b - 100, p.w * 0.3, 70); ctx.fillRect(p.x + p.w * 0.2, b - 40, p.w * 0.6, 12); ctx.fillStyle = '#5f6b78'; ctx.fillRect(p.x + p.w * 0.45, b - 28, 5, 22); ctx.fillRect(p.x + p.w * 0.25, b - 6, p.w * 0.5, 4); },
  speaker(ctx, p) {
    const b = p.bottom ?? PROP_BOTTOM, h = 20, y = b - h;
    ctx.fillStyle = '#1f2328'; ctx.fillRect(p.x + 2, y, p.w - 4, h); ctx.fillRect(p.x, y + 2, p.w, h - 4);
    ctx.fillStyle = '#3a4048'; for (const cx of [p.x + 9, p.x + p.w - 9]) { ctx.beginPath(); ctx.arc(cx, y + 10, 6, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#596270'; for (const cx of [p.x + 9, p.x + p.w - 9]) { ctx.beginPath(); ctx.arc(cx, y + 10, 2.5, 0, Math.PI * 2); ctx.fill(); }
    ctx.fillStyle = '#4fa3ff'; ctx.fillRect(p.x + p.w / 2 - 1, y + 3, 2, 2);
  },
  bossdesk(ctx, p) { ctx.fillStyle = '#5e4429'; ctx.fillRect(p.x, FLOOR + 16, p.w, 64); ctx.fillStyle = '#7a5a3a'; ctx.fillRect(p.x - 8, FLOOR + 6, p.w + 16, 12); ctx.fillStyle = '#9aa3ad'; ctx.fillRect(p.x + 50, FLOOR - 1, 48, 7); },
};

function drawLabel(ctx, building, id) {
  ctx.fillStyle = 'rgba(39,52,43,0.82)';
  ctx.fillRect(1090, 20, 170, 34);
  ctx.fillStyle = '#fdfcf6';
  ctx.font = 'bold 18px sans-serif';
  ctx.fillText(`${floorName(building, id)} ${building.rooms[id].label}`, 1104, 44);
}

function foldedChair(ctx, x, bottom, h = 62) {
  ctx.fillStyle = '#8d96a1'; ctx.fillRect(x + 1, bottom - h, 3, h); ctx.fillRect(x + 10, bottom - h + 4, 3, h - 4);
  ctx.fillStyle = '#c4cbd3'; ctx.fillRect(x + 1, bottom - Math.round(h * 0.45), 12, 2);
  ctx.fillStyle = '#16233a'; ctx.fillRect(x - 1, bottom - h - 3, 16, Math.round(h * 0.34) + 2);
  ctx.fillStyle = '#2f4b73'; ctx.fillRect(x, bottom - h - 2, 14, Math.round(h * 0.34));
  ctx.fillStyle = '#16233a'; ctx.fillRect(x - 1, bottom - Math.round(h * 0.62) - 1, 16, 8);
  ctx.fillStyle = '#3d5f8f'; ctx.fillRect(x, bottom - Math.round(h * 0.62), 14, 6);
  ctx.fillStyle = 'rgba(255,255,255,0.22)'; ctx.fillRect(x + 1, bottom - h - 1, 2, Math.round(h * 0.32));
  ctx.fillStyle = 'rgba(40,24,10,0.22)'; ctx.fillRect(x - 1, bottom - 1, 16, 2);
}

function drawChairStack(ctx, building, assets) {
  if (!building.floorTop?.meeting) return;
  const bottom = building.floorTop.meeting + PROP_BOTTOM;
  const stack = assets?.props?.chairstack;
  if (stack) { drawPropImage(ctx, { x: CHAIR_STACK.x, w: stack.width, bottom }, stack); return; }
  const one = assets?.props?.foldchair;
  if (one) { for (let i = CHAIR_STACK.count - 1; i >= 0; i--) drawPropImage(ctx, { x: CHAIR_STACK.x + i * CHAIR_STACK.gap, w: one.width, bottom: bottom - i }, one); return; }
  for (let i = CHAIR_STACK.count - 1; i >= 0; i--) foldedChair(ctx, CHAIR_STACK.x + i * CHAIR_STACK.gap, bottom - i, 62);
}

function drawMusic(ctx, building, music) {
  const hit = building.SPEAKER_HIT;
  if (!hit || !music) return;
  const cx = hit.x + hit.width / 2, base = hit.y + 6;
  ctx.save();
  ctx.font = 'bold 22px sans-serif'; ctx.textAlign = 'center'; ctx.lineWidth = 3; ctx.strokeStyle = '#fffaf0';
  for (let i = 0; i < 3; i++) {
    const phase = ((music.t / 2400) + i / 3) % 1;
    const x = cx + Math.sin((phase + i) * Math.PI * 2) * 10 + (i - 1) * 10, y = base - phase * 52, note = i % 2 ? '♫' : '♪';
    ctx.globalAlpha = Math.min(1, Math.sin(phase * Math.PI) * 1.6);
    ctx.strokeText(note, x, y);
    ctx.fillStyle = ['#2f7fe0', '#d24a86', '#1f9e66'][i];
    ctx.fillText(note, x, y);
  }
  ctx.restore();
}

function drawBoard(ctx, building, board) {
  const hit = building.WHITEBOARD_HIT;
  if (!hit || !board) return;
  board.notes.slice(-12).forEach((note, i) => {
    ctx.fillStyle = NOTE_COLORS[note.type] ?? '#ddd';
    ctx.fillRect(hit.x + 10 + (i % 4) * 28, hit.y + 10 + Math.floor(i / 4) * 30, 22, 22);
  });
}

const LEG_RATIO = 0.26, STRIDE_PX = 9, LIFT_PX = 4;
export function strideOffsets(stride) {
  const front = stride * STRIDE_PX, back = -stride * STRIDE_PX;
  const lift = (v) => Math.round(Math.max(0, v) * LIFT_PX);
  const round = (v) => Math.round(v) || 0;
  return { front: round(front), back: round(back), frontLift: lift(stride) || 0, backLift: lift(-stride) || 0 };
}
function drawStride(ctx, image, info, stride) {
  const { width, height, anchor } = info;
  const split = Math.round(height * (1 - LEG_RATIO)), half = Math.round(width / 2);
  const x0 = -anchor.x, y0 = -anchor.y, o = strideOffsets(stride);
  ctx.drawImage(image, 0, split, half, height - split, x0 + o.back, y0 + split - o.backLift, half, height - split);
  ctx.drawImage(image, 0, 0, width, split, x0, y0, width, split);
  ctx.drawImage(image, half, split, width - half, height - split, x0 + half + o.front, y0 + split - o.frontLift, width - half, height - split);
}

const SOFA_LEGS = 0.3, SOFA_FOLD = 0.4;
export function sofaLayout(height) {
  const legs = Math.round(height * SOFA_LEGS), folded = Math.max(1, Math.round(legs * SOFA_FOLD));
  return { split: height - legs, legs, folded, drop: legs - folded };
}
function drawOnSofa(ctx, image, info) {
  const { width, height, anchor } = info;
  const { split, legs, folded, drop } = sofaLayout(height);
  const x0 = -anchor.x, y0 = -anchor.y;
  ctx.drawImage(image, 0, 0, width, split, x0, y0 + drop, width, split);
  ctx.drawImage(image, 0, split, width, legs, x0, y0 + drop + split, width, folded);
}

function drawPropImage(ctx, prop, sprite) {
  const w = sprite.native ? sprite.width : prop.w * SCALE, x = prop.x + (prop.w - w) / 2;
  const k = w / sprite.width, h = Math.round(sprite.height * k);
  const bottom = prop.bottom ?? PROP_BOTTOM;
  if (!prop.flip) { ctx.drawImage(sprite.image, Math.round(x), Math.round(bottom - h), Math.round(w), h); return; }
  ctx.save(); ctx.translate(Math.round(x + w), 0); ctx.scale(-1, 1);
  ctx.drawImage(sprite.image, 0, Math.round(bottom - h), Math.round(w), h);
  ctx.restore();
}

export function occupiedSeats(building, actors) {
  const at = new Map(Object.entries(building.SEATS ?? {}).map(([key, seat]) => [`${Math.round(seat.x)},${Math.round(seat.y)}`, key]));
  return new Set(actors.filter((actor) => actor.sit).map((actor) => at.get(`${Math.round(actor.x)},${Math.round(actor.y)}`)).filter(Boolean));
}

function deskSprite(assets, prop) {
  return prop.seat ? assets?.props?.['desk-bare'] : null;
}

function drawOccupiedDesk(ctx, assets, prop) {
  const desk = deskSprite(assets, prop);
  if (!desk) { PROP_DRAW[prop.type]?.(ctx, prop); return; }
  drawPropImage(ctx, prop, desk);
  const w = prop.w * SCALE, x0 = prop.x + (prop.w - w) / 2, top = PROP_BOTTOM - Math.round((desk.height * w) / desk.width) + 5;
  const laptop = assets?.props?.desklaptop, lamp = assets?.props?.desklamp;
  if (laptop) drawPropImage(ctx, { x: x0 + 10, w: laptop.width, bottom: top }, laptop);
  if (lamp) drawPropImage(ctx, { x: x0 + w - lamp.width - 6, w: lamp.width, bottom: top }, lamp);
}

export function render(ctx, { assets, actors, board, room: building, music = null, chairs = [] }) {
  ctx.imageSmoothingEnabled = false;
  const occupied = occupiedSeats(building, actors);
  const seatTaken = (id, prop) => (prop.seat && occupied.has(`${id}:${prop.seat}`)) || (prop.seatOf && occupied.has(`${id}:${prop.seatOf}`));
  const frontDesks = new Map();
  building.floors.forEach((id) => {
    const room = building.rooms[id];
    ctx.save();
    ctx.translate(0, building.floorTop[id]);
    const background = assets?.backgrounds?.[room.background];
    if (background) {
      const bw = Math.round(WIDTH * SCALE);
      ctx.drawImage(background, 0, 0, bw, FLOOR_HEIGHT);
      ctx.save(); ctx.translate(bw * 2, 0); ctx.scale(-1, 1);
      ctx.drawImage(background, 0, 0, bw, FLOOR_HEIGHT);
      ctx.restore();
      ctx.fillStyle = '#3c3229'; ctx.fillRect(0, FLOOR_HEIGHT - 16, WIDTH, 16);
      for (const prop of room.props ?? []) {
        if (WALL_PROPS.has(prop.type) || prop.codeOnly) continue;
        if (seatTaken(id, prop)) {
          if (prop.seat) frontDesks.set(`${id}:${prop.seat}`, { prop, top: building.floorTop[id] });
          continue;
        }
        const sprite = deskSprite(assets, prop) || assets?.props?.[PROP_SPRITE[prop.type] ?? prop.type];
        if (sprite) drawPropImage(ctx, prop, sprite); else PROP_DRAW[prop.type]?.(ctx, prop);
      }
    } else if (room.outdoor) {
      drawRoof(ctx);
      for (const prop of room.props ?? []) {
        if (seatTaken(id, prop)) continue;
        const sprite = assets?.props?.[PROP_SPRITE[prop.type] ?? prop.type];
        if (sprite) drawPropImage(ctx, prop, sprite); else PROP_DRAW[prop.type]?.(ctx, prop);
      }
    } else {
      drawFloor(ctx, room);
      for (const prop of room.props ?? []) if (!(prop.seatOf && seatTaken(id, prop))) PROP_DRAW[prop.type]?.(ctx, prop);
    }
    for (const key of chairs) {
      const [floor, seat] = key.split(':');
      if (floor !== id || occupied.has(key)) continue;
      const place = room.SEATS[seat];
      if (!place) continue;
      const prop = { type: 'chair', x: Math.round(place.x + (place.facing === 'left' ? 8 : -8) - 26), w: 52, bottom: PROP_BOTTOM + place.y - room.SEATS.s.y, flip: place.facing === 'left' };
      const sprite = assets?.props?.foldchair;
      if (sprite) drawPropImage(ctx, prop, sprite); else PROP_DRAW.chair(ctx, prop);
    }
    drawLabel(ctx, building, id);
    ctx.restore();
  });
  drawLiftShaft(ctx, building);
  for (const actor of actors) if (actor.riding) drawLiftCar(ctx, actor.y);
  drawBoard(ctx, building, board);
  drawMusic(ctx, building, music);
  drawChairStack(ctx, building, assets);
  const seatKeyOf = (actor) => (actor.sit ? [...occupied].find((key) => { const seat = building.SEATS[key]; return Math.round(seat.x) === Math.round(actor.x) && Math.round(seat.y) === Math.round(actor.y); }) : null);
  for (const actor of [...actors].sort((a, b) => a.y - b.y || Number(Boolean(b.sit)) - Number(Boolean(a.sit)))) {
    const sprite = assets?.characters?.[actor.persona] ?? null;
    const picked = sideImageFor(sprite, actor);
    if (!picked?.info) continue;
    const { info, flip } = picked;
    const k = (actor.scale ?? 1) * (info.scale ?? 1);
    ctx.save();
    ctx.translate(Math.round(actor.x), Math.round(actor.y + (actor.pose?.dy ?? 0)));
    ctx.scale(flip ? -k : k, k);
    ctx.fillStyle = 'rgba(40,24,10,0.22)';
    ctx.beginPath(); ctx.ellipse(0, 0, info.width * 0.32, 6, 0, 0, Math.PI * 2); ctx.fill();
    const image = dressed(info, actor.look);
    ctx.imageSmoothingEnabled = k < 1; ctx.imageSmoothingQuality = 'high';
    if (picked.sofa) drawOnSofa(ctx, image, info);
    else if (picked.legs && actor.pose?.stride !== undefined) drawStride(ctx, image, info, actor.pose.stride);
    else ctx.drawImage(image, -info.anchor.x, -info.anchor.y);
    ctx.restore();
    if (actor.carry && !actor.sit) {
      const one = assets?.props?.foldchair, x = Math.round(actor.x + (actor.facing === 'left' ? -24 : 10));
      if (one) drawPropImage(ctx, { x, w: one.width, bottom: Math.round(actor.y - 14), flip: actor.facing === 'left' }, one);
      else foldedChair(ctx, x, Math.round(actor.y - 22), 48);
    }
    const desk = frontDesks.get(seatKeyOf(actor));
    if (desk) {
      ctx.save(); ctx.translate(0, desk.top);
      drawOccupiedDesk(ctx, assets, desk.prop);
      ctx.restore();
    }
    if (actor.sit && actor.activity === 'sleep') {
      drawZz(ctx, Math.round(actor.x + (picked.flip ? -1 : 1) * info.width * 0.1 * k), Math.round(actor.y - info.anchor.y * k + 10), actor.pose?.zz);
    }
  }
}
