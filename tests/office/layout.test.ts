import assert from "node:assert/strict";
import test from "node:test";

import {roomSprites} from "../../runtime/src/office/art.js";
import {ROOM_ORDER, findPath, officeLayout, walkGrid, type Rect} from "../../runtime/src/office/layout.js";

const layout = officeLayout();
const sprites = roomSprites();
const sizeOf = (name: string, variant?: string) => { const rows = sprites[variant === undefined ? name : name + "Pass"]!; return {w: rows[0]!.length, h: rows.length}; };
const overlaps = (a: Rect, b: Rect) => a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;

test("wall decor hangs inside its wall face", () => {
  for (const item of layout.decor) {
    const face = layout.faces[item.wall], {w, h} = sizeOf(item.sprite, item.variant);
    assert.ok(sprites[item.variant === undefined ? item.sprite : item.sprite + "Pass"], item.sprite);
    assert.ok(item.x >= face.x && item.x + w <= face.x + face.w, `${item.sprite} at ${item.x},${item.y} fits the ${item.wall} wall horizontally`);
    // The face runs from its top to the rail two pixels below it.
    assert.ok(item.y >= face.y && item.y + h <= face.y + face.h + 2, `${item.sprite} at ${item.x},${item.y} (${h} tall) stays on the ${item.wall} wall face`);
  }
});

test("furniture stays inside one room, below the wall behind it, and never overlaps", () => {
  const roomOf = new Map(layout.rooms.map(room => [room.id, room]));
  for (const item of layout.items) {
    const room = roomOf.get(item.room)!, {w, h} = sizeOf(item.sprite, item.variant);
    const wallTop = room.y === 40 ? layout.faces.back.y : layout.faces.middle.y;
    assert.ok(item.x >= room.x && item.x + w <= room.x + room.w, `${item.sprite} at ${item.x} stays between the ${item.room} walls`);
    assert.ok(item.y + h <= room.y + room.h, `${item.sprite} at ${item.y} ends on the ${item.room} floor`);
    assert.ok(item.y >= wallTop, `${item.sprite} at ${item.y} is not taller than the wall behind it (${wallTop})`);
    for (const foot of item.footprint) assert.ok(foot.x >= room.x && foot.x + foot.w <= room.x + room.w && foot.y >= room.y && foot.y + foot.h <= room.y + room.h, `${item.sprite} footprint inside ${item.room}`);
  }
  layout.items.forEach((a, i) => layout.items.slice(i + 1).forEach(b => {
    for (const fa of a.footprint) for (const fb of b.footprint) assert.ok(!overlaps(fa, fb), `${a.sprite}@${a.x},${a.y} and ${b.sprite}@${b.x},${b.y} overlap`);
  }));
});

test("rooms follow the S flow and each pair of consecutive phases shares a door", () => {
  assert.deepEqual(layout.rooms.map(room => room.id), ROOM_ORDER);
  const top = layout.rooms.filter(room => room.y === 40).map(room => room.id), bottom = layout.rooms.filter(room => room.y !== 40).sort((a, b) => b.x - a.x).map(room => room.id);
  assert.deepEqual([...top, ...bottom], ROOM_ORDER, "left to right on top, right to left below");
  for (let i = 0; i < ROOM_ORDER.length - 1; i++) {
    assert.ok(layout.doors.some(door => door.between[0] === ROOM_ORDER[i] && door.between[1] === ROOM_ORDER[i + 1]), `${ROOM_ORDER[i]} -> ${ROOM_ORDER[i + 1]}`);
  }
  assert.equal(layout.doors.length, ROOM_ORDER.length - 1);
});

test("every standing or sitting place is reachable on foot from the entrance", () => {
  const grid = walkGrid(layout);
  for (const room of layout.rooms) {
    assert.equal(room.slots.length, 3, room.id);
    for (const slot of room.slots) {
      assert.ok(slot.feet.x % 2 === 0 && slot.feet.y % 2 === 0, `${room.id} feet lie on the walking grid`);
      const path = findPath(grid, layout.spawn, slot.feet);
      assert.ok(path !== null, `${room.id} slot at ${slot.feet.x},${slot.feet.y} is reachable`);
      assert.ok(path!.length > 1);
    }
  }
  // Walls are solid: a point inside a wall is never a free cell, and walking between rooms goes through a door.
  assert.equal(findPath(grid, layout.spawn, {x: 190, y: 60}), null, "the planning/implementing wall is solid away from its door");
  const across = findPath(grid, layout.rooms[0]!.slots[0]!.feet, layout.rooms[2]!.slots[1]!.feet)!;
  for (const door of layout.doors.filter(d => d.id === "planning-implementing" || d.id === "implementing-verifying")) {
    assert.ok(across.some(p => p.x >= door.gap.x - 2 && p.x <= door.gap.x + door.gap.w + 2 && p.y >= door.gap.y && p.y <= door.gap.y + door.gap.h + 4), `the walk passes the ${door.id} door`);
  }
});
