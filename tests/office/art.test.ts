import assert from "node:assert/strict";
import test from "node:test";

import {ALERT_KEY, AVATAR_COLOURS, BOARD_SLOTS, NOTE_COLOURS, ROOM_PALETTE, avatarColors, notePosition, personSprites, roomSprites} from "../../runtime/src/office/art.js";

const sprites = roomSprites();
const people = personSprites();
const size = (rows: readonly string[]) => ({w: rows[0]!.length, h: rows.length});

test("the room palette has exactly 24 keys and every room sprite uses only them", () => {
  assert.deepEqual(Object.keys(ROOM_PALETTE).sort(), [..."0123456789abcdefghijklmn"].sort());
  for (const colour of Object.values(ROOM_PALETTE)) assert.match(colour, /^#[0-9a-f]{6}$/u);
  for (const [name, rows] of Object.entries(sprites)) {
    const {w} = size(rows);
    assert.ok(w > 0 && rows.every(row => row.length === w), `${name} is a rectangle`);
    for (const row of rows) for (const key of row) assert.ok(key === "." || key in ROOM_PALETTE, `${name} uses ${key}`);
  }
  for (const [name, rows] of Object.entries(people)) {
    for (const row of rows) for (const key of row) assert.match(key, /^[.OHIJSTUCDEPQBKR]$/u, `${name} uses only avatar keys`);
  }
});

test("alert red is reserved for alert sprites", () => {
  const allowed = new Set(["rackFail", "benchFail", "statusFail", "noteFail", "bubbleAlert"]);
  const users = Object.entries(sprites).filter(([, rows]) => rows.some(row => row.includes(ALERT_KEY))).map(([name]) => name);
  assert.deepEqual(users.sort(), [...allowed].sort());
  assert.equal(ROOM_PALETTE[ALERT_KEY], "#c86f4a");
});

test("doors come in three frames of one size, and the board takes one note per criterion status", () => {
  for (const kind of ["sideDoor", "frontDoor"]) {
    const frames = [0, 1, 2].map(frame => sprites[kind + frame]!);
    assert.ok(frames.every(Boolean), kind);
    assert.deepEqual(frames.map(size), [size(frames[0]!), size(frames[0]!), size(frames[0]!)], `${kind} frames share a size`);
    assert.notDeepEqual(frames[0], frames[2], `${kind} open differs from closed`);
  }
  assert.deepEqual(NOTE_COLOURS, {PASS: "h", FAIL: "k", PENDING: "l", UNKNOWN: "j"});
  for (const [status, key] of Object.entries(NOTE_COLOURS)) {
    const name = "note" + status[0] + status.slice(1).toLowerCase();
    assert.ok(sprites[name]!.some(row => row.includes(key)), `${name} is ${key}`);
  }
  assert.ok(sprites.notePlus, "a + note stands for the rest");
  const board = sprites.board!, note = size(sprites.notePass!);
  assert.equal(BOARD_SLOTS, 12);
  for (let i = 0; i < BOARD_SLOTS; i++) {
    const {x, y} = notePosition(i);
    for (let dy = 0; dy < note.h; dy++) for (let dx = 0; dx < note.w; dx++) {
      assert.match(board[y + dy]![x + dx]!, /[98]/u, `slot ${i} lies on the white board surface`);
    }
  }
});

test("avatar clothes follow the role while hair and skin follow the person, never in alert red", () => {
  const roles = ["coordinator", "worker", "reviewer", "visitor", "viewer"];
  const looks = roles.map(role => avatarColors("alice", role));
  assert.equal(new Set(looks.map(look => look.D)).size, roles.length, "each role has its own clothes");
  for (const look of looks) for (const key of ["H", "I", "J", "S", "T", "U"]) assert.equal(look[key], looks[0]![key], `${key} stays with the person`);
  assert.deepEqual(avatarColors("bob", "worker").D, avatarColors("carol", "worker").D, "one role, one shirt");
  assert.deepEqual(avatarColors("alice", "unknown-role").D, avatarColors("alice", "visitor").D, "unknown roles dress as visitors");
  const hairs = new Set(["alice", "bob", "carol", "dave", "erin", "frank"].map(name => avatarColors(name, "worker").I));
  assert.ok(hairs.size > 1, "identities differ");
  for (const colour of AVATAR_COLOURS) assert.notEqual(colour.toLowerCase(), ROOM_PALETTE[ALERT_KEY]);
  for (const look of looks) assert.ok(!Object.values(look).includes(ROOM_PALETTE[ALERT_KEY]!));
  for (const pose of ["down0", "down1", "down2", "up0", "up1", "up2", "right0", "right1", "right2", "hand"]) assert.deepEqual(size(people[pose]!), {w: 34, h: 50}, pose);
});
