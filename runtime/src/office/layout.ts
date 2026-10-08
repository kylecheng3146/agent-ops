import {roomSprites} from "./art.js";

/**
 * The single geometry source of one office room, in art pixels (576x320 at
 * scale 1). Six walled rooms follow the phases in an S: planning,
 * implementing, verifying left to right on top; reviewing, integrating,
 * lobby right to left below. Each pair of consecutive phases shares a door.
 */
export type RoomId = "planning" | "implementing" | "verifying" | "reviewing" | "integrating" | "lobby";
export const ROOM_ORDER: readonly RoomId[] = ["planning", "implementing", "verifying", "reviewing", "integrating", "lobby"];

export interface Rect { readonly x: number; readonly y: number; readonly w: number; readonly h: number }
export interface Point { readonly x: number; readonly y: number }

export interface LayoutRoom extends Rect {
  readonly id: RoomId;
  readonly floor: string;
  /** Where people of this phase sit or stand: sprite top-left, pose, draw depth and the floor point they walk to. */
  readonly slots: readonly LayoutSlot[];
}
export interface LayoutSlot { readonly x: number; readonly y: number; readonly pose: string; readonly z: number; readonly feet: Point }
export interface LayoutItem {
  readonly sprite: string;
  readonly x: number;
  readonly y: number;
  /** Draw depth; larger draws later. Defaults to the sprite's bottom edge. */
  readonly z: number;
  readonly room: RoomId;
  /** "verify" swaps the Pass sprite for its Fail twin while the room's verification fails. */
  readonly variant?: "verify";
  /** Solid floor area in absolute pixels. */
  readonly footprint: readonly Rect[];
}
export interface LayoutDecor { readonly sprite: string; readonly x: number; readonly y: number; readonly wall: "back" | "middle"; readonly variant?: "verify" }
export interface LayoutDoor { readonly id: string; readonly kind: "side" | "front"; readonly x: number; readonly y: number; readonly between: readonly [RoomId, RoomId]; readonly gap: Rect }
export interface LayoutRug extends Rect { readonly fill: string; readonly border: string }

export interface OfficeLayout {
  readonly width: number;
  readonly height: number;
  /** Wall faces where decor may hang: back wall and middle wall. */
  readonly faces: {readonly back: Rect; readonly middle: Rect};
  readonly walls: {readonly back: Rect; readonly middle: Rect; readonly vertical: readonly Rect[]; readonly sides: readonly Rect[]; readonly bottom: Rect};
  readonly rooms: readonly LayoutRoom[];
  readonly doors: readonly LayoutDoor[];
  readonly entrance: Rect;
  /** Where the viewer appears in a room: on the doormat inside the entrance. */
  readonly spawn: Point;
  readonly items: readonly LayoutItem[];
  readonly decor: readonly LayoutDecor[];
  readonly rugs: readonly LayoutRug[];
  /** The planning whiteboard; criteria notes are laid on it. */
  readonly board: Point;
  /** Floor areas people may stand on: room floors, door gaps and the entrance. */
  readonly open: readonly Rect[];
  /** Furniture footprints, absolute. */
  readonly blocked: readonly Rect[];
}

const W = 576, H = 320;
const WALL = 40, ROW1 = {top: 40, bottom: 152}, MIDDLE = {top: 152, bottom: 192}, ROW2 = {top: 192, bottom: 312};
const VERTICAL = [188, 380], THICK = 8, COLUMN = [4, 196, 388], ROOM_W = 184;

/** Bounding box of the opaque pixels in the bottom `rows` rows of a sprite. */
function baseOf(rows: readonly string[], depth = 10): Rect {
  let left = Infinity, right = -1, top = Infinity;
  for (let y = Math.max(0, rows.length - depth); y < rows.length; y++) for (let x = 0; x < rows[y]!.length; x++) {
    if (rows[y]![x] === ".") continue;
    left = Math.min(left, x); right = Math.max(right, x); top = Math.min(top, y);
  }
  return right < 0 ? {x: 0, y: rows.length, w: 0, h: 0} : {x: left, y: top, w: right - left + 1, h: rows.length - top};
}

export function officeLayout(): OfficeLayout {
  const sprites = roomSprites();
  const room = (id: RoomId, row: 1 | 2, column: number, floor: string, slots: LayoutSlot[]): LayoutRoom => {
    const band = row === 1 ? ROW1 : ROW2;
    return {id, x: COLUMN[column]!, y: band.top, w: ROOM_W, h: band.bottom - band.top, floor, slots};
  };
  // Feet sit on the path-finding grid so a walk ends exactly on them.
  const onGrid = (p: Point): Point => ({x: Math.round(p.x / STEP) * STEP, y: Math.round(p.y / STEP) * STEP});
  const stand = (x: number, y: number, pose = "down0"): LayoutSlot => ({x, y, pose, z: y + 50, feet: onGrid({x: x + 17, y: y + 49})});
  const seat = (x: number, y: number, pose: string, z: number, feet: Point): LayoutSlot => ({x, y, pose, z, feet: onGrid(feet)});
  const rooms: LayoutRoom[] = [
    room("planning", 1, 0, "carpet", [seat(9, 28, "down0", 69, {x: 30, y: 140}), seat(43, 28, "down0", 69, {x: 64, y: 140}), seat(77, 28, "down0", 69, {x: 98, y: 140})]),
    room("implementing", 1, 1, "carpet", [seat(228, 52, "up0", 99, {x: 245, y: 120}), seat(318, 52, "up0", 99, {x: 345, y: 120}), stand(240, 96)]),
    room("verifying", 1, 2, "vinyl", [seat(480, 64, "up0", 113, {x: 497, y: 112}), stand(406, 96), stand(452, 96)]),
    room("reviewing", 2, 2, "carpet", [seat(516, 204, "down0", 223, {x: 520, y: 270}), seat(428, 246, "down0", 271, {x: 446, y: 306}), seat(502, 246, "down0", 271, {x: 520, y: 308})]),
    room("integrating", 2, 1, "vinyl", [seat(306, 206, "up0", 256, {x: 323, y: 254}), stand(208, 254), stand(328, 254)]),
    room("lobby", 2, 0, "checker", [seat(22, 202, "up0", 252, {x: 39, y: 252}), seat(92, 210, "down0", 231, {x: 109, y: 268}), stand(56, 240)])
  ];
  const items: LayoutItem[] = [];
  const put = (sprite: string, x: number, y: number, inRoom: RoomId, extra: {z?: number; variant?: "verify"; foot?: readonly Rect[]} = {}): void => {
    const rows = sprites[extra.variant === undefined ? sprite : sprite + "Pass"]!;
    const footprint = (extra.foot ?? [baseOf(rows)]).map(r => ({x: x + r.x, y: y + r.y, w: r.w, h: r.h})).filter(r => r.w > 0 && r.h > 0);
    items.push({sprite, x, y, z: extra.z ?? y + rows.length, room: inRoom, ...(extra.variant === undefined ? {} : {variant: extra.variant}), footprint});
  };
  // Cubicles are solid except the open front where the chair goes.
  const cubicleFoot: readonly Rect[] = [{x: 0, y: 0, w: 86, h: 46}, {x: 0, y: 46, w: 6, h: 12}, {x: 80, y: 46, w: 6, h: 12}];
  // planning: meeting table against the wall, people seated behind it
  [16, 50, 84].forEach(x => put("chairFront", x, 44, "planning"));
  put("confTable", 6, 68, "planning"); put("board", 118, 42, "planning");
  [22, 56, 90].forEach(x => put("chairBack", x, 100, "planning", {z: 128}));
  put("deskPlant", 158, 128, "planning");
  // implementing: two cubicles on the wall; the floor in front stays open so both doors connect
  put("cubicle", 198, 40, "implementing", {foot: cubicleFoot}); put("cubicleMirror", 288, 40, "implementing", {foot: cubicleFoot});
  put("chairBack", 232, 70, "implementing", {z: 100}); put("chairBack", 322, 70, "implementing", {z: 100});
  put("trash", 200, 136, "implementing"); put("plant", 300, 100, "implementing");
  // verifying: racks, a test bench and filing along the wall
  put("rackPass", 388, 46, "verifying"); put("rack", 416, 46, "verifying", {variant: "verify"});
  put("bench", 460, 54, "verifying", {variant: "verify"}); put("filing", 548, 54, "verifying");
  put("trash", 392, 136, "verifying"); put("stool", 504, 104, "verifying"); put("plant", 536, 100, "verifying");
  // reviewing: bookcase and filing on the wall, the reviewer's desk, two armchairs
  put("lowBookcase", 392, 180, "reviewing"); put("filing", 444, 178, "reviewing"); put("execDesk", 500, 222, "reviewing");
  put("armchair", 432, 270, "reviewing"); put("coffeeTable", 462, 286, "reviewing"); put("armchair", 506, 270, "reviewing"); put("plant", 536, 258, "reviewing");
  // integrating: shelving, copier, sorting table, a hand truck and stacked crates
  put("metalShelf", 200, 178, "integrating"); put("copier", 256, 194, "integrating"); put("sortTable", 296, 202, "integrating");
  put("handTruck", 356, 204, "integrating"); put("crates", 252, 258, "integrating"); put("trash", 236, 294, "integrating");
  // lobby: kitchenette on the wall, sofa, cafe table, plant by the entrance
  put("counter", 8, 184, "lobby"); put("fridge", 92, 176, "lobby"); put("vending", 116, 176, "lobby"); put("cooler", 146, 188, "lobby");
  put("sofa", 84, 230, "lobby"); put("cafeTable", 120, 270, "lobby"); put("stool", 104, 280, "lobby"); put("stool", 148, 280, "lobby");
  put("plant", 8, 258, "lobby"); put("trash", 92, 296, "lobby");

  const decor: LayoutDecor[] = [
    {sprite: "tv", x: 30, y: 3, wall: "back"}, {sprite: "frame", x: 112, y: 9, wall: "back"}, {sprite: "frame", x: 132, y: 13, wall: "back"},
    {sprite: "blinds", x: 210, y: 4, wall: "back"}, {sprite: "clock", x: 281, y: 9, wall: "back"}, {sprite: "blinds", x: 320, y: 4, wall: "back"},
    {sprite: "status", x: 400, y: 3, wall: "back", variant: "verify"}, {sprite: "poster", x: 520, y: 3, wall: "back"},
    {sprite: "diploma", x: 404, y: 160, wall: "middle"}, {sprite: "diploma", x: 424, y: 163, wall: "middle"},
    {sprite: "cubby", x: 258, y: 158, wall: "middle"}, {sprite: "clock", x: 60, y: 160, wall: "middle"}, {sprite: "frame", x: 152, y: 162, wall: "middle"}
  ];
  const side = (id: string, x: number, y: number, between: readonly [RoomId, RoomId]): LayoutDoor => ({id, kind: "side", x, y, between, gap: {x, y: y + 3, w: THICK, h: 28}});
  const doors: LayoutDoor[] = [
    side("planning-implementing", VERTICAL[0]!, 96, ["planning", "implementing"]),
    side("implementing-verifying", VERTICAL[1]!, 96, ["implementing", "verifying"]),
    {id: "verifying-reviewing", kind: "front", x: 468, y: MIDDLE.top + 2, between: ["verifying", "reviewing"], gap: {x: 470, y: MIDDLE.top, w: 26, h: MIDDLE.bottom - MIDDLE.top}},
    side("reviewing-integrating", VERTICAL[1]!, 258, ["reviewing", "integrating"]),
    side("integrating-lobby", VERTICAL[0]!, 258, ["integrating", "lobby"])
  ];
  const entrance = {x: 56, y: ROW2.bottom, w: 34, h: H - ROW2.bottom};
  return {
    width: W, height: H,
    faces: {back: {x: 0, y: 3, w: W, h: 31}, middle: {x: 0, y: MIDDLE.top + 3, w: W, h: 31}},
    walls: {back: {x: 0, y: 0, w: W, h: WALL}, middle: {x: 0, y: MIDDLE.top, w: W, h: MIDDLE.bottom - MIDDLE.top},
      vertical: VERTICAL.flatMap(x => [{x, y: ROW1.top, w: THICK, h: ROW1.bottom - ROW1.top}, {x, y: ROW2.top, w: THICK, h: ROW2.bottom - ROW2.top}]),
      sides: [{x: 0, y: WALL, w: 4, h: H - WALL}, {x: W - 4, y: WALL, w: 4, h: H - WALL}], bottom: {x: 0, y: ROW2.bottom, w: W, h: H - ROW2.bottom}},
    rooms, doors, entrance, spawn: {x: entrance.x + 17, y: ROW2.bottom - 2},
    items, decor,
    rugs: [{x: 6, y: 50, w: 120, h: 46, fill: "b", border: "c"}, {x: 426, y: 264, w: 100, h: 40, fill: "f", border: "g"}],
    board: {x: 118, y: 42},
    open: [...rooms.map(({x, y, w, h}) => ({x, y, w, h})), ...doors.map(door => door.gap), entrance],
    blocked: items.flatMap(item => item.footprint)
  };
}

/** Size of one path-finding cell, in art pixels. */
export const STEP = 2;
/** A person's feet: a 14x4 box centred on x, ending at y. */
export const FOOT = {w: 14, h: 4};

/**
 * Free cells for a person's feet. Self-contained: the page embeds it with
 * toString, so it may not reference imports or module-level values.
 */
export function walkGrid(layout: Pick<OfficeLayout, "width" | "height" | "open" | "blocked">): {cols: number; rows: number; free: number[]} {
  const step = 2, footW = 14, footH = 4, width = layout.width, height = layout.height;
  const solid: number[] = new Array(width * height).fill(1);
  layout.open.forEach(r => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < width && y < height) solid[y * width + x] = 0; });
  layout.blocked.forEach(r => { for (let y = r.y; y < r.y + r.h; y++) for (let x = r.x; x < r.x + r.w; x++) if (x >= 0 && y >= 0 && x < width && y < height) solid[y * width + x] = 1; });
  // Summed area table: a feet box is free when it covers no solid pixel.
  const sum: number[] = new Array((width + 1) * (height + 1)).fill(0);
  for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) sum[(y + 1) * (width + 1) + x + 1] = solid[y * width + x]! + sum[y * (width + 1) + x + 1]! + sum[(y + 1) * (width + 1) + x]! - sum[y * (width + 1) + x]!;
  const cols = Math.floor(width / step), rows = Math.floor(height / step), free: number[] = new Array(cols * rows).fill(0);
  for (let cy = 0; cy < rows; cy++) for (let cx = 0; cx < cols; cx++) {
    const x0 = cx * step - footW / 2, y0 = cy * step - footH, x1 = x0 + footW, y1 = y0 + footH;
    if (x0 < 0 || y0 < 0 || x1 > width || y1 > height) continue;
    const blocked = sum[y1 * (width + 1) + x1]! - sum[y0 * (width + 1) + x1]! - sum[y1 * (width + 1) + x0]! + sum[y0 * (width + 1) + x0]!;
    free[cy * cols + cx] = blocked === 0 ? 1 : 0;
  }
  return {cols, rows, free};
}

/**
 * Shortest four-way walk between two feet points, as feet points every cell,
 * or null when unreachable. Self-contained for the page, like walkGrid.
 */
export function findPath(grid: {cols: number; rows: number; free: number[]}, from: Point, to: Point): Point[] | null {
  const step = 2, cols = grid.cols, rows = grid.rows;
  const cell = (p: Point): number => Math.max(0, Math.min(rows - 1, Math.round(p.y / step))) * cols + Math.max(0, Math.min(cols - 1, Math.round(p.x / step)));
  const start = cell(from), goal = cell(to);
  if (!grid.free[start] || !grid.free[goal]) return null;
  const previous: number[] = new Array(cols * rows).fill(-1), queue: number[] = [start];
  previous[start] = start;
  for (let head = 0; head < queue.length && previous[goal] === -1; head++) {
    const current = queue[head]!, cx = current % cols, cy = Math.floor(current / cols);
    const next = [cx > 0 ? current - 1 : -1, cx < cols - 1 ? current + 1 : -1, cy > 0 ? current - cols : -1, cy < rows - 1 ? current + cols : -1];
    for (const candidate of next) if (candidate >= 0 && grid.free[candidate] && previous[candidate] === -1) { previous[candidate] = current; queue.push(candidate); }
  }
  if (previous[goal] === -1) return null;
  const path: Point[] = [];
  for (let at = goal; ; at = previous[at]!) { path.push({x: (at % cols) * step, y: Math.floor(at / cols) * step}); if (at === start) break; }
  return path.reverse();
}
