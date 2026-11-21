// Sokoban solver — original work for make.fun sokoban-solver-01-run-20261121.
// Design (written from scratch, no copied solver):
//  * The generator builds a hallway with 1-4 rooms off it; a box pushed out of
//    a room can never come back, so rooms are independent. The level is split
//    into rooms (connected floor components above / below the hallway row),
//    each room is solved push-optimally on its own, and the walks between
//    rooms are plain BFS walks with every box treated as an obstacle.
//  * Each room is solved with A* over *pushes* (not steps). A state is the
//    sorted box squares plus the player's reachable region, named by its
//    lowest square (any square of one region is equivalent). The heuristic
//    is the cheapest assignment of boxes to goals by grid distance, which is
//    admissible: one push moves exactly one box one square.
//  * Deadlock pruning: "dead squares" (a box that can never be pushed onto
//    any goal, found by pulling boxes back from the goals with the player's
//    standing square required to be open floor) and frozen 2x2 blocks of
//    walls/boxes with a box off its goal. Scoring counts pushes only, and a
//    solution one push over the optimum earns under half, so the search is
//    push-optimal first; a weighted A* is the fallback when the optimal
//    search runs out of its time / expansion budget, so a complete (if
//    longer) solution is still produced instead of nothing.
//  * Deterministic: expansion-count caps decide fallbacks; the wall clock is
//    only a last-resort guard. Two runs on the same input write the same bytes.
import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const I = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const O = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';
const START = Date.now();
// One wall budget of 60 s for the whole set; keep 6 s of margin.
const TOTAL_MS = 54000;
const OPT_EXPANSIONS = 600000;
const WEIGHTED_EXPANSIONS = 600000;

type Dir = { dx: number; dy: number; ch: string };
const DIRS: Dir[] = [
  { dx: 0, dy: -1, ch: 'u' },
  { dx: 0, dy: 1, ch: 'd' },
  { dx: -1, dy: 0, ch: 'l' },
  { dx: 1, dy: 0, ch: 'r' },
];

interface Level {
  w: number;
  h: number;
  size: number;
  floor: Uint8Array; // 1 = open floor (not a wall)
  goals: number[];
  boxes: number[];
  player: number;
}

function parseLevel(text: string): Level {
  const rows = text.split('\n').filter((r) => r.length > 0);
  const h = rows.length;
  const w = Math.max(...rows.map((r) => r.length));
  const size = w * h;
  const floor = new Uint8Array(size);
  const goals: number[] = [];
  const boxes: number[] = [];
  let player = 0;
  rows.forEach((row, y) => {
    for (let x = 0; x < w; x++) {
      const ch = row[x] ?? '#';
      const i = y * w + x;
      if (ch === '#') continue;
      floor[i] = 1;
      if ('.*+'.includes(ch)) goals.push(i);
      if ('$*'.includes(ch)) boxes.push(i);
      if ('@+'.includes(ch)) player = i;
    }
  });
  goals.sort((a, b) => a - b);
  boxes.sort((a, b) => a - b);
  return { w, h, size, floor, goals, boxes, player };
}

/** Grid (BFS) distances from `from` over cells where `open[i]` is 1. */
function bfsDist(from: number, open: Uint8Array, w: number, size: number): Int16Array {
  const d = new Int16Array(size).fill(-1);
  const q = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  d[from] = 0;
  q[qt++] = from;
  while (qh < qt) {
    const u = q[qh++]!;
    const ux = u % w;
    const uy = (u / w) | 0;
    const nd = d[u]! + 1;
    if (ux > 0 && open[u - 1] && d[u - 1]! < 0) { d[u - 1] = nd; q[qt++] = u - 1; }
    if (ux < w - 1 && open[u + 1] && d[u + 1]! < 0) { d[u + 1] = nd; q[qt++] = u + 1; }
    if (uy > 0 && open[u - w] && d[u - w]! < 0) { d[u - w] = nd; q[qt++] = u - w; }
    if (uy < hOf(open, w) - 1 && open[u + w] && d[u + w]! < 0) { d[u + w] = nd; q[qt++] = u + w; }
  }
  return d;
}
function hOf(open: Uint8Array, w: number): number {
  return Math.floor(open.length / w);
}

/** Squares from which a box can be pushed onto some goal. Reverse play:
 * a square y is live when a box there can be pushed onto a live square z,
 * which needs the player's standing square (y, stepped back from z) to be
 * open floor. Goals start live. */
function liveSquares(goals: number[], open: Uint8Array, w: number, size: number): Uint8Array {
  const live = new Uint8Array(size);
  const q: number[] = [];
  for (const g of goals) {
    live[g] = 1;
    q.push(g);
  }
  while (q.length > 0) {
    const z = q.pop()!;
    const zx = z % w;
    const zy = (z / w) | 0;
    for (const d of DIRS) {
      const y = z - d.dy * w - d.dx;
      const stand = y - d.dy * w - d.dx;
      if (y < 0 || y >= size || stand < 0 || stand >= size) continue;
      if (!open[y] || !open[stand] || live[y]) continue;
      // y must be adjacent to z in the right geometry (no row wrap).
      if (Math.abs((y % w) - zx) + Math.abs(((y / w) | 0) - zy) !== 1) continue;
      if (Math.abs((stand % w) - (y % w)) + Math.abs(((stand / w) | 0) - ((y / w) | 0)) !== 1) continue;
      live[y] = 1;
      q.push(y);
    }
  }
  return live;
}

/** All permutations of 0..n-1. */
function permutations(n: number): number[][] {
  const out: number[][] = [];
  const a: number[] = [];
  for (let i = 0; i < n; i++) a.push(i);
  const gen = (k: number): void => {
    if (k === n) {
      out.push(a.slice());
      return;
    }
    for (let i = k; i < n; i++) {
      const t = a[k]!;
      a[k] = a[i]!;
      a[i] = t;
      gen(k + 1);
      const t2 = a[k]!;
      a[k] = a[i]!;
      a[i] = t2;
    }
  };
  gen(0);
  return out;
}

interface RoomSolution {
  moves: string;
  pushes: number;
  endPlayer: number;
}

/**
 * Push-optimal (weight 1) or weighted (weight > 1) A* over pushes, on the
 * board `open` (1 = a square the player / a box may occupy). Boxes may only
 * be pushed onto squares where `room[i]` is 1 (the room itself, never the
 * hallway entry square). Returns null when the search gives up.
 */
function solveBoard(
  open: Uint8Array,
  room: Uint8Array,
  boxes0: number[],
  goals: number[],
  player0: number,
  w: number,
  size: number,
  deadlineMs: number,
  maxExpansions: number,
  weight: number,
): RoomSolution | null {
  const n = boxes0.length;
  const goalSet = new Uint8Array(size);
  for (const g of goals) goalSet[g] = 1;
  const live = liveSquares(goals, open, w, size);
  for (const b of boxes0) if (!live[b]) return null;

  // Grid distance from every goal, over the board.
  const distGoal: Int16Array[] = goals.map((g) => bfsDist(g, open, w, size));
  const perms = permutations(n);
  const heuristic = (boxes: number[]): number => {
    let best = Infinity;
    for (const p of perms) {
      let s = 0;
      for (let i = 0; i < n; i++) {
        const d = distGoal[p[i]!]![boxes[i]!]!;
        if (d < 0) {
          s = Infinity;
          break;
        }
        s += d;
        if (s >= best) break;
      }
      if (s < best) best = s;
    }
    return best;
  };

  // Reachable region from `from` with `occ` in the way. Returns the lowest
  // square of the region and marks it in `seen` (stamp `mark`).
  const seen = new Uint8Array(size);
  let stamp = 0;
  const reach = (from: number, occ: Uint8Array): { rep: number; mark: number } => {
    stamp++;
    if (stamp > 250) {
      seen.fill(0);
      stamp = 1;
    }
    const mark = stamp;
    const q = new Int32Array(size);
    let qh = 0;
    let qt = 0;
    seen[from] = mark;
    q[qt++] = from;
    let rep = from;
    while (qh < qt) {
      const u = q[qh++]!;
      if (u < rep) rep = u;
      const ux = u % w;
      if (ux > 0 && open[u - 1] && !occ[u - 1] && seen[u - 1] !== mark) { seen[u - 1] = mark; q[qt++] = u - 1; }
      if (ux < w - 1 && open[u + 1] && !occ[u + 1] && seen[u + 1] !== mark) { seen[u + 1] = mark; q[qt++] = u + 1; }
      if (u >= w && open[u - w] && !occ[u - w] && seen[u - w] !== mark) { seen[u - w] = mark; q[qt++] = u - w; }
      if (u + w < size && open[u + w] && !occ[u + w] && seen[u + w] !== mark) { seen[u + w] = mark; q[qt++] = u + w; }
    }
    return { rep, mark };
  };

  const packBoxes = (boxes: number[]): number => {
    let p = 0;
    for (let i = 0; i < 4; i++) {
      const b = i < boxes.length ? boxes[i]! : 255;
      p |= b << (8 * i);
    }
    return p >>> 0;
  };
  const keyOf = (boxes: number[], rep: number): number => packBoxes(boxes) * 256 + rep;

  // Frozen 2x2: every square of a 2x2 block holding `dest` is wall-or-box
  // and some box in it is off its goal.
  const frozenAt = (dest: number, occ: Uint8Array): boolean => {
    const dx0 = dest % w;
    const squares: [number, number, number, number][] = [];
    if (dx0 < w - 1) {
      squares.push([dest, dest + 1, dest + w, dest + w + 1]);
      squares.push([dest, dest + 1, dest - w, dest - w + 1]);
    }
    if (dx0 > 0) {
      squares.push([dest, dest - 1, dest + w, dest + w - 1]);
      squares.push([dest, dest - 1, dest - w, dest - w - 1]);
    }
    for (const sq of squares) {
      let all = true;
      let offGoalBox = false;
      for (const c of sq) {
        if (c < 0 || c >= size || !open[c]) continue; // wall counts as filled
        if (occ[c]) {
          if (!goalSet[c]) offGoalBox = true;
        } else {
          all = false;
          break;
        }
      }
      if (all && offGoalBox) return true;
    }
    return false;
  };

  // State storage.
  const stBoxes: number[][] = [];
  const stPlayer: number[] = [];
  const stG: number[] = [];
  const stParent: number[] = [];
  const stPushFrom: number[] = [];
  const stPushDir: number[] = [];
  // Binary heap of [f, g, id]; smaller f first, larger g first, smaller id first.
  const heap: [number, number, number][] = [];
  const heapLess = (a: [number, number, number], b: [number, number, number]): boolean =>
    a[0] < b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && a[2] < b[2])));
  const heapPush = (e: [number, number, number]): void => {
    let i = heap.length;
    heap.push(e);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!heapLess(heap[i]!, heap[p]!)) break;
      const t = heap[i]!;
      heap[i] = heap[p]!;
      heap[p] = t;
      i = p;
    }
  };
  const heapPop = (): [number, number, number] => {
    const top = heap[0]!;
    const last = heap.pop()!;
    if (heap.length > 0) {
      heap[0] = last;
      for (let i = 0; ; ) {
        let c = 2 * i + 1;
        if (c >= heap.length) break;
        if (c + 1 < heap.length && heapLess(heap[c + 1]!, heap[c]!)) c++;
        if (!heapLess(heap[c]!, heap[i]!)) break;
        const t = heap[i]!;
        heap[i] = heap[c]!;
        heap[c] = t;
        i = c;
      }
    }
    return top;
  };

  const h0 = heuristic(boxes0);
  if (!Number.isFinite(h0)) return null;
  const occ0 = new Uint8Array(size);
  for (const b of boxes0) occ0[b] = 1;
  const r0 = reach(player0, occ0);
  const best = new Map<number, number>();
  best.set(keyOf(boxes0, r0.rep), 0);
  stBoxes.push(boxes0.slice());
  stPlayer.push(player0);
  stG.push(0);
  stParent.push(-1);
  stPushFrom.push(-1);
  stPushDir.push(-1);
  heapPush([weight * h0, 0, 0]);

  let expanded = 0;
  let found = -1;
  while (heap.length > 0) {
    const [, g, s] = heapPop();
    if (g !== stG[s]) continue;
    const boxes = stBoxes[s]!;
    let solved = true;
    for (let i = 0; i < n; i++) if (boxes[i] !== goals[i]) { solved = false; break; }
    if (solved) {
      found = s;
      break;
    }
    if (expanded >= maxExpansions) break;
    if ((expanded & 1023) === 0 && Date.now() > deadlineMs) break;
    expanded++;
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    // Snapshot this state's reachable region: later reach() calls reuse
    // the same stamp array and would overwrite it.
    const { mark } = reach(stPlayer[s]!, occ);
    const reachMask = new Uint8Array(size);
    for (let i = 0; i < size; i++) if (seen[i] === mark) reachMask[i] = 1;
    for (let bi = 0; bi < n; bi++) {
      const b = boxes[bi]!;
      const bx = b % w;
      const by = (b / w) | 0;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        const dest = b + d.dy * w + d.dx;
        const behind = b - d.dy * w - d.dx;
        if (dest < 0 || dest >= size || behind < 0 || behind >= size) continue;
        if (!room[dest]) continue; // a box never leaves its room
        if (occ[dest] || !open[dest]) continue;
        if (!open[behind] || occ[behind] || !reachMask[behind]) continue;
        if ((d.dx === 1 && bx >= w - 1) || (d.dx === -1 && bx <= 0)) continue;
        if ((d.dy === 1 && by >= hOf(open, w) - 1) || (d.dy === -1 && by <= 0)) continue;
        if (!live[dest]) continue;
        const nb = boxes.slice();
        nb[bi] = dest;
        nb.sort((a, b2) => a - b2);
        // Frozen check on the pushed box (other boxes did not move).
        const occ2 = occ;
        occ2[b] = 0;
        occ2[dest] = 1;
        const frozen = frozenAt(dest, occ2);
        if (frozen) {
          occ2[dest] = 0;
          occ2[b] = 1;
          continue;
        }
        const h = heuristic(nb);
        if (!Number.isFinite(h)) {
          occ2[dest] = 0;
          occ2[b] = 1;
          continue;
        }
        // Region after the push, with the box in its new square.
        const { rep } = reach(b, occ2);
        occ2[dest] = 0;
        occ2[b] = 1;
        const k = keyOf(nb, rep);
        const ng = g + 1;
        const prev = best.get(k);
        if (prev !== undefined && prev <= ng) continue;
        best.set(k, ng);
        const id = stBoxes.length;
        stBoxes.push(nb);
        stPlayer.push(b);
        stG.push(ng);
        stParent.push(s);
        stPushFrom.push(b);
        stPushDir.push(di);
        heapPush([ng + weight * h, ng, id]);
      }
    }
  }
  if (found < 0) return null;

  // Reconstruct: walk to each push's standing square, then push.
  const chain: number[] = [];
  for (let s = found; s > 0; s = stParent[s]!) chain.push(s);
  chain.reverse();
  let moves = '';
  let player = player0;
  let boxes = boxes0.slice();
  const walkTo = (from: number, to: number, occ: Uint8Array): string | null => {
    if (from === to) return '';
    const prev = new Int32Array(size).fill(-1);
    const q = new Int32Array(size);
    let qh = 0;
    let qt = 0;
    prev[from] = from;
    q[qt++] = from;
    while (qh < qt) {
      const u = q[qh++]!;
      if (u === to) break;
      const ux = u % w;
      for (let di = 0; di < 4; di++) {
        const d = DIRS[di]!;
        if (d.dx === 1 && ux >= w - 1) continue;
        if (d.dx === -1 && ux <= 0) continue;
        const v = u + d.dy * w + d.dx;
        if (v < 0 || v >= size || prev[v] !== -1 || !open[v] || occ[v]) continue;
        prev[v] = u;
        q[qt++] = v;
      }
    }
    if (prev[to] === -1) return null;
    let s = '';
    for (let v = to; v !== from; v = prev[v]!) {
      const u = prev[v]!;
      const dx = (v % w) - (u % w);
      const dy = ((v / w) | 0) - ((u / w) | 0);
      s = (dx === 1 ? 'r' : dx === -1 ? 'l' : dy === 1 ? 'd' : 'u') + s;
    }
    return s;
  };
  for (const s of chain) {
    const from = stPushFrom[s]!;
    const di = stPushDir[s]!;
    const d = DIRS[di]!;
    const occ = new Uint8Array(size);
    for (const b of boxes) occ[b] = 1;
    const stand = from - d.dy * w - d.dx;
    const walk = walkTo(player, stand, occ);
    if (walk === null) return null;
    moves += walk + d.ch.toUpperCase();
    const bi = boxes.indexOf(from);
    boxes[bi] = from + d.dy * w + d.dx;
    boxes.sort((a, b) => a - b);
    player = from;
  }
  return { moves, pushes: chain.length, endPlayer: player };
}

/** Walk (no pushes) from `from` to `to` on the whole level, boxes as obstacles. */
function walkWhole(level: Level, from: number, to: number, boxes: number[]): string | null {
  if (from === to) return '';
  const { w, size, floor } = level;
  const occ = new Uint8Array(size);
  for (const b of boxes) occ[b] = 1;
  const prev = new Int32Array(size).fill(-1);
  const q = new Int32Array(size);
  let qh = 0;
  let qt = 0;
  prev[from] = from;
  q[qt++] = from;
  while (qh < qt) {
    const u = q[qh++]!;
    if (u === to) break;
    const ux = u % w;
    for (let di = 0; di < 4; di++) {
      const d = DIRS[di]!;
      if (d.dx === 1 && ux >= w - 1) continue;
      if (d.dx === -1 && ux <= 0) continue;
      const v = u + d.dy * w + d.dx;
      if (v < 0 || v >= size || prev[v] !== -1 || !floor[v] || occ[v]) continue;
      prev[v] = u;
      q[qt++] = v;
    }
  }
  if (prev[to] === -1) return null;
  let s = '';
  for (let v = to; v !== from; v = prev[v]!) {
    const u = prev[v]!;
    const dx = (v % w) - (u % w);
    const dy = ((v / w) | 0) - ((u / w) | 0);
    s = (dx === 1 ? 'r' : dx === -1 ? 'l' : dy === 1 ? 'd' : 'u') + s;
  }
  return s;
}

interface Room {
  cells: number[];
  cellSet: Uint8Array;
  boxes: number[];
  goals: number[];
  door: number;
  entry: number;
}

/** Split a level into rooms: connected floor components off the hallway row.
 * Returns null when the shape is not hallway + rooms (fallback: whole level). */
function extractRooms(level: Level): Room[] | null {
  const { w, size, floor } = level;
  const hallRow = Math.floor(level.player / w);
  const seen = new Uint8Array(size);
  const rooms: Room[] = [];
  const assignedBox = new Uint8Array(size);
  const assignedGoal = new Uint8Array(size);
  for (let i = 0; i < size; i++) {
    if (!floor[i] || ((i / w) | 0) === hallRow || seen[i]) continue;
    const comp: number[] = [];
    const q = [i];
    seen[i] = 1;
    while (q.length > 0) {
      const u = q.pop()!;
      comp.push(u);
      const ux = u % w;
      const uy = (u / w) | 0;
      const nb = [u - 1, u + 1, u - w, u + w];
      const ok = [ux > 0, ux < w - 1, uy > 0, uy < Math.floor(size / w) - 1];
      for (let k = 0; k < 4; k++) {
        if (!ok[k]) continue;
        const v = nb[k]!;
        if (v < 0 || v >= size || !floor[v] || ((v / w) | 0) === hallRow || seen[v]) continue;
        seen[v] = 1;
        q.push(v);
      }
    }
    const boxes = level.boxes.filter((b) => comp.includes(b));
    const goals = level.goals.filter((g) => comp.includes(g));
    if (boxes.length === 0 && goals.length === 0) continue;
    if (boxes.length === 0 || boxes.length !== goals.length) return null;
    // The door: the room cell next to a hallway cell.
    const doors = comp.filter((c) => {
      const below = c + w;
      const above = c - w;
      return (below < size && ((below / w) | 0) === hallRow && floor[below]) ||
        (above >= 0 && ((above / w) | 0) === hallRow && floor[above]);
    });
    if (doors.length !== 1) return null;
    const door = doors[0]!;
    const entry = ((door / w) | 0) < hallRow ? door + w : door - w;
    const cellSet = new Uint8Array(size);
    for (const c of comp) cellSet[c] = 1;
    for (const b of boxes) assignedBox[b] = 1;
    for (const g of goals) assignedGoal[g] = 1;
    rooms.push({ cells: comp, cellSet, boxes, goals, door, entry });
  }
  for (const b of level.boxes) if (!assignedBox[b]) return null;
  for (const g of level.goals) if (!assignedGoal[g]) return null;
  if (rooms.length === 0) return null;
  return rooms;
}

/** Replay moves on the level; returns pushes when every box ends on a goal. */
function replay(level: Level, moves: string): number | null {
  const { w, size, floor } = level;
  const box = new Uint8Array(size);
  for (const b of level.boxes) box[b] = 1;
  const goal = new Uint8Array(size);
  for (const g of level.goals) goal[g] = 1;
  let player = level.player;
  let pushes = 0;
  for (const ch of moves) {
    const lower = ch.toLowerCase();
    const d = DIRS.find((x) => x.ch === lower);
    if (!d) return null;
    const next = player + d.dy * w + d.dx;
    if (next < 0 || next >= size || !floor[next]) return null;
    if (box[next]) {
      const beyond = next + d.dy * w + d.dx;
      if (beyond < 0 || beyond >= size || !floor[beyond] || box[beyond]) return null;
      box[next] = 0;
      box[beyond] = 1;
      pushes++;
    }
    player = next;
  }
  for (let i = 0; i < size; i++) if (box[i] && !goal[i]) return null;
  return pushes;
}

function solveLevel(text: string, deadlineMs: number): string {
  const level = parseLevel(text);
  const rooms = extractRooms(level);
  let moves = '';
  if (rooms === null) {
    // Fallback: one push search over the whole level.
    const open = level.floor;
    const solved = solveBoard(open, open, level.boxes, level.goals, level.player, level.w, level.size, deadlineMs, OPT_EXPANSIONS, 1)
      ?? solveBoard(open, open, level.boxes, level.goals, level.player, level.w, level.size, deadlineMs, WEIGHTED_EXPANSIONS, 4);
    if (solved) moves = solved.moves;
  } else {
    // Room order: nearest door first from where the player stands.
    const todo = rooms.slice();
    let player = level.player;
    let boxes = level.boxes.slice();
    let ok = true;
    while (todo.length > 0 && ok) {
      // Nearest room by walk distance to its entry (boxes as obstacles).
      let bestRoom = -1;
      let bestWalk = '';
      for (let i = 0; i < todo.length; i++) {
        const walk = walkWhole(level, player, todo[i]!.entry, boxes);
        if (walk !== null && (bestRoom < 0 || walk.length < bestWalk.length)) {
          bestRoom = i;
          bestWalk = walk;
        }
      }
      if (bestRoom < 0) {
        ok = false;
        break;
      }
      const room = todo[bestRoom]!;
      todo.splice(bestRoom, 1);
      moves += bestWalk;
      player = room.entry;
      // Board for this room: its cells plus the hallway entry square.
      const open = room.cellSet.slice();
      open[room.entry] = 1;
      const share = Math.max(500, (deadlineMs - Date.now()) / (todo.length + 1));
      const roomDeadline = Math.min(deadlineMs, Date.now() + share);
      const solved = solveBoard(open, room.cellSet, room.boxes, room.goals, player, level.w, level.size, roomDeadline, OPT_EXPANSIONS, 1)
        ?? solveBoard(open, room.cellSet, room.boxes, room.goals, player, level.w, level.size, Math.min(deadlineMs, Date.now() + share), WEIGHTED_EXPANSIONS, 4);
      if (!solved) {
        ok = false;
        break;
      }
      moves += solved.moves;
      player = solved.endPlayer;
      boxes = boxes.filter((b) => !room.boxes.includes(b)).concat(room.goals);
      boxes.sort((a, b) => a - b);
    }
    if (!ok) return '';
  }
  // Never emit a move string that does not solve the level.
  return replay(level, moves) === null ? '' : moves;
}

const ids = readdirSync(I).sort();
for (let k = 0; k < ids.length; k++) {
  const id = ids[k]!;
  const deadline = Math.min(START + TOTAL_MS, START + (TOTAL_MS * (k + 1)) / ids.length);
  let moves = '';
  try {
    if (Date.now() < START + TOTAL_MS) moves = solveLevel(readFileSync(join(I, id, 'level.txt'), 'utf8'), deadline);
  } catch {
    moves = '';
  }
  mkdirSync(join(O, id), { recursive: true });
  writeFileSync(join(O, id, 'solution.txt'), `${moves}\n`);
}
