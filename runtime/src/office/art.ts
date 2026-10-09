/**
 * Office art: the agreed 24-colour palette and every sprite as a character
 * matrix (one key per pixel, "." transparent). Sprites are drawn once on the
 * server with small shape helpers and sent to the page as data, so the page
 * never ships image files. Light comes from the top left; outlines are
 * "sel-out": the lit side takes the material's dark ramp, the shadow side ink.
 */

/** Room colours, keyed 0-9 and a-n. Ramps shift hue: shadows cooler, highlights warmer. */
export const ROOM_PALETTE: Readonly<Record<string, string>> = {
  0: "#2b241f", // ink, outlines
  1: "#5b3a2b", 2: "#8a5033", 3: "#b8743f", 4: "#d9aa72", 5: "#f0cf93", // wood
  6: "#e2cda6", 7: "#ead8b8", 8: "#f2e5c9", 9: "#fff7e6", // floor, wall, paper
  a: "#2f3f4f", b: "#4d6683", c: "#729ead", d: "#a9d3d8", // slate blue
  e: "#2e4a44", f: "#3f6b4e", g: "#6d9a5a", h: "#a8c46a", // leaves
  i: "#6b5d50", j: "#9c8d7d", // warm metal
  k: "#c86f4a", // alerts only
  l: "#f2c95c", m: "#c9bfa8", n: "#d98a7a" // lamp yellow, carpet, pink
};
/** The alert colour key; only alert sprites may use it. */
export const ALERT_KEY = "k";

export type Sprite = readonly string[];
type Ramp = readonly [string, string, string];

/** Next darker key of each material, used for shading and the lit-side outline. */
const DARK: Readonly<Record<string, string>> = {
  1: "0", 2: "1", 3: "2", 4: "3", 5: "4", 6: "4", 7: "6", 8: "6", 9: "8", a: "0", b: "a", c: "b", d: "c",
  e: "0", f: "e", g: "f", h: "g", i: "0", j: "i", k: "2", l: "3", m: "j", n: "2",
  O: "O", H: "O", I: "H", J: "I", S: "O", T: "S", U: "T", C: "O", D: "C", E: "D", P: "O", Q: "P", B: "O", K: "O", R: "S"
};

class Grid {
  readonly p: (string | null)[][];
  constructor(readonly w: number, readonly h: number) { this.p = Array.from({length: h}, () => Array<string | null>(w).fill(null)); }
  get(x: number, y: number): string | null { return x >= 0 && y >= 0 && x < this.w && y < this.h ? this.p[y]![x]! : null; }
  set(x: number, y: number, c: string | null): void { x = Math.round(x); y = Math.round(y); if (x >= 0 && y >= 0 && x < this.w && y < this.h) this.p[y]![x] = c; }
  rect(x: number, y: number, w: number, h: number, c: string | null): void { for (let j = y; j < y + h; j++) for (let i = x; i < x + w; i++) this.set(i, j, c); }
  ell(cx: number, cy: number, rx: number, ry: number, c: string): void {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const dx = (x + .5 - cx) / rx, dy = (y + .5 - cy) / ry;
      if (dx * dx + dy * dy <= 1) this.set(x, y, c);
    }
  }
  /** A blob shaded from the top left: [dark, mid, light]. */
  ball(cx: number, cy: number, rx: number, ry: number, [dark, mid, light]: Ramp, hi = .55, lo = .45): void {
    for (let y = Math.floor(cy - ry - 1); y <= cy + ry + 1; y++) for (let x = Math.floor(cx - rx - 1); x <= cx + rx + 1; x++) {
      const dx = (x + .5 - cx) / rx, dy = (y + .5 - cy) / ry;
      if (dx * dx + dy * dy > 1) continue;
      const s = dx * .6 + dy * .8;
      this.set(x, y, s < -hi ? light : s > lo ? dark : mid);
    }
  }
  line(x0: number, y0: number, x1: number, y1: number, c: string): void {
    const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0), sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
    let e = dx + dy;
    for (;;) { this.set(x0, y0, c); if (x0 === x1 && y0 === y1) break; const e2 = 2 * e; if (e2 >= dy) { e += dy; x0 += sx; } if (e2 <= dx) { e += dx; y0 += sy; } }
  }
  box(x: number, y: number, w: number, h: number, c: string): void { this.rect(x, y, w, 1, c); this.rect(x, y + h - 1, w, 1, c); this.rect(x, y, 1, h, c); this.rect(x + w - 1, y, 1, h, c); }
  rows(): string[] { return this.p.map(row => row.map(c => c ?? ".").join("")); }
}

/** Luminance of the colour a key stands for; avatar keys use one reference identity. */
const REFERENCE: Readonly<Record<string, string>> = {...ROOM_PALETTE, O: "#292633", H: "#51372f", I: "#80533d", J: "#b47c51",
  S: "#c08762", T: "#e6ae87", U: "#f5cda4", C: "#3b6658", D: "#61947b", E: "#92bea1", P: "#404958", Q: "#626e7f", B: "#2e3443", K: "#292633", R: "#e39a86"};
function luminance(key: string): number {
  const n = parseInt((REFERENCE[key] ?? "#000000").slice(1), 16);
  return (.299 * (n >> 16) + .587 * (n >> 8 & 255) + .114 * (n & 255)) / 255;
}

/** Adds a one-pixel sel-out outline around the shape, growing the sprite by 2 in each dimension. */
function outline(g: Grid): Sprite {
  const o = new Grid(g.w + 2, g.h + 2);
  for (let y = 0; y < g.h; y++) for (let x = 0; x < g.w; x++) o.p[y + 1]![x + 1] = g.p[y]![x]!;
  const src = o.p.map(row => row.slice());
  const at = (x: number, y: number): string | null => src[y]?.[x] ?? null;
  for (let y = 0; y < o.h; y++) for (let x = 0; x < o.w; x++) {
    if (at(x, y) !== null) continue;
    const right = at(x + 1, y), below = at(x, y + 1), left = at(x - 1, y), above = at(x, y - 1);
    const near = right ?? below ?? left ?? above;
    if (near === null) continue;
    const ink = /[A-Z]/u.test(near) ? "O" : "0";
    if (right !== null || below !== null) { // the pixel sits on the lit, top-left side
      const dark = DARK[DARK[near] ?? "0"] ?? "0";
      o.p[y]![x] = luminance(dark) > .5 ? ink : dark;
    } else o.p[y]![x] = ink;
  }
  return o.rows();
}
const drawn = (w: number, h: number, paint: (g: Grid) => void): Sprite => { const g = new Grid(w, h); paint(g); return outline(g); };
const flat = (w: number, h: number, paint: (g: Grid) => void): Sprite => { const g = new Grid(w, h); paint(g); return g.rows(); };

// ---------- people: 32x48 shapes keyed with avatar letters, coloured per identity ----------

function head(g: Grid, back: boolean): void {
  g.ball(15.5, 12.5, 7.2, 7.2, ["S", "T", "U"]);
  if (back) { g.ball(15.5, 12, 8, 7.8, ["H", "I", "J"], .6, .3); g.rect(10, 18, 12, 1, "H"); return; }
  for (let y = 4; y <= 10; y++) for (let x = 7; x <= 24; x++) {
    const dx = (x + .5 - 15.5) / 8.2, dy = (y + .5 - 11) / 7.4; if (dx * dx + dy * dy <= 1) g.set(x, y, "I");
  }
  [10, 11, 13, 14, 17, 18, 19, 21].forEach(x => g.set(x, 11, "I")); [11, 18].forEach(x => g.set(x, 12, "I"));
  g.rect(8, 10, 2, 7, "I"); g.rect(22, 10, 2, 6, "H"); g.rect(21, 7, 3, 4, "H");
  g.rect(11, 5, 4, 1, "J"); g.rect(10, 6, 2, 1, "J"); g.set(9, 8, "J");
  g.rect(12, 13, 1, 2, "K"); g.rect(19, 13, 1, 2, "K");
  g.set(11, 16, "R"); g.set(20, 16, "R"); g.rect(15, 17, 2, 1, "S");
}
function body(g: Grid, {back = false, hand = false, lift = 0, sit = false}: {back?: boolean; hand?: boolean; lift?: number; sit?: boolean} = {}): void {
  // lift > 0 raises the left foot, lift < 0 the right one: two walking frames.
  const left = Math.max(0, lift), right = Math.max(0, -lift);
  if (sit) {
    // Seated, seen from the front: a lap, short shins, feet on the floor.
    g.rect(10, 33, 12, 4, "P"); g.rect(11, 34, 10, 1, "Q");
    g.rect(11, 37, 4, 5, "P"); g.rect(17, 37, 4, 5, "P"); g.rect(12, 37, 1, 4, "Q"); g.rect(18, 37, 1, 4, "Q");
    g.rect(10, 42, 5, 3, "B"); g.rect(17, 42, 5, 3, "B"); g.rect(11, 42, 3, 1, "Q"); g.rect(18, 42, 3, 1, "Q");
  } else {
    g.rect(11, 34, 4, 9 - left, "P"); g.rect(17, 34, 4, 9 - right, "P"); g.rect(11, 33, 10, 3, "P");
    g.rect(12, 35, 1, 6 - left, "Q"); g.rect(18, 35, 1, 6 - right, "Q");
    g.rect(10, 43 - left, 5, 3, "B"); g.rect(17, 43 - right, 5, 3, "B"); g.rect(11, 43 - left, 3, 1, "Q"); g.rect(18, 43 - right, 3, 1, "Q");
  }
  g.rect(10, 21, 12, 13, "D"); g.set(10, 21, null); g.set(21, 21, null);
  g.rect(11, 22, 1, 9, "E"); g.rect(20, 22, 2, 11, "C"); g.rect(10, 32, 12, 2, "C");
  if (back) g.rect(15, 23, 1, 8, "C");
  else { g.rect(15, 21, 2, 2, "T"); g.set(14, 21, "E"); g.set(17, 21, "E"); }
  g.rect(8, 22, 2, 7, "D"); g.set(8, 22, "E"); g.rect(8, 29, 2, 3, "T"); g.set(8, 31, "S");
  if (hand) { g.rect(22, 21, 2, 3, "C"); g.rect(24, 13, 2, 10, "C"); g.rect(24, 13, 1, 9, "D"); g.rect(24, 9, 2, 4, "T"); g.set(24, 9, "U"); }
  else { g.rect(22, 22, 2, 7, "C"); g.rect(22, 29, 2, 3, "S"); }
  g.rect(14, 19, 4, 2, "S");
}
function side(stride: boolean): Sprite {
  return drawn(32, 48, g => {
    if (stride) {
      g.rect(12, 33, 4, 10, "P"); g.rect(9, 43, 6, 3, "B"); g.rect(10, 43, 3, 1, "Q");
      g.rect(16, 33, 4, 9, "P"); g.rect(17, 34, 1, 7, "Q"); g.rect(18, 41, 3, 2, "P"); g.rect(18, 43, 7, 3, "B"); g.rect(19, 43, 4, 1, "Q");
    } else {
      g.rect(13, 33, 6, 10, "P"); g.rect(14, 34, 1, 8, "Q"); g.rect(12, 43, 9, 3, "B"); g.rect(13, 43, 5, 1, "Q");
    }
    g.rect(12, 21, 9, 13, "D"); g.rect(12, 22, 2, 10, "E"); g.rect(19, 22, 2, 11, "C"); g.rect(12, 32, 9, 2, "C");
    if (stride) { g.rect(15, 22, 1, 8, "C"); g.rect(16, 22, 3, 7, "D"); g.rect(16, 22, 1, 6, "E"); g.rect(17, 29, 3, 2, "D"); g.rect(18, 31, 3, 2, "T"); g.set(20, 31, "U"); }
    else { g.rect(15, 22, 1, 9, "C"); g.rect(16, 22, 3, 9, "D"); g.rect(16, 22, 1, 8, "E"); g.rect(16, 31, 3, 2, "T"); }
    g.rect(15, 19, 4, 2, "S");
    g.ball(16, 12.5, 7, 7.2, ["S", "T", "U"]);
    for (let y = 3; y <= 19; y++) for (let x = 7; x <= 24; x++) {
      const dx = (x + .5 - 15.5) / 8, dy = (y + .5 - 11.5) / 7.8;
      if (dx * dx + dy * dy > 1) continue;
      if (y < 9 || x < 16 || (y === 9 && x < 22)) g.set(x, y, y < 6 && x < 16 ? "J" : x < 11 ? "H" : "I");
    }
    [17, 18, 20].forEach(x => g.set(x, 10, "I")); g.set(22, 9, "I");
    g.rect(15, 12, 1, 3, "S"); g.rect(16, 13, 1, 2, "T"); // ear
    g.rect(19, 11, 3, 1, "H"); g.rect(20, 12, 1, 2, "K"); // brow, eye
    g.set(23, 13, "T"); g.set(23, 14, "T"); g.set(23, 15, "S"); // nose
    g.rect(20, 17, 2, 1, "S"); g.set(19, 16, "R"); g.rect(18, 19, 3, 1, "S");
  });
}

/**
 * Person shapes (32x48 before the outline). Facing right is drawn; the page
 * mirrors it for left. `down`/`up` walk by lifting alternate feet.
 */
export function personSprites(): Readonly<Record<string, Sprite>> {
  const front = (options: {hand?: boolean; lift?: number; sit?: boolean}) => drawn(32, 48, g => { body(g, options); head(g, false); });
  const back = (lift: number) => drawn(32, 48, g => { body(g, {back: true, lift}); head(g, true); });
  return {
    down0: front({}), down1: front({lift: 2}), down2: front({lift: -2}),
    up0: back(0), up1: back(2), up2: back(-2),
    right0: side(false), right1: side(true), right2: side(false),
    hand: front({hand: true}), sit: front({sit: true})
  };
}

export type AvatarRole = "coordinator" | "worker" | "reviewer" | "visitor" | "viewer" | "qa" | "integrator";
/** Clothes say the role; hair and skin stay with the person. No entry is the alert red. */
const CLOTHES: Readonly<Record<AvatarRole, Ramp>> = {
  coordinator: ["#37596d", "#5687a1", "#87b3c7"], worker: ["#3b6658", "#61947b", "#92bea1"],
  reviewer: ["#625776", "#8c7da4", "#b7a9ca"], visitor: ["#5a5550", "#857d75", "#b0a89e"], viewer: ["#8a6a2b", "#bb893b", "#e3b64f"],
    qa: ["#8d99a3", "#c9d2d9", "#eef2f5"], integrator: ["#76653f", "#a38f62", "#cdbb8c"]
};
const HAIR: readonly Ramp[] = [["#302c3b", "#514757", "#756575"], ["#51372f", "#80533d", "#b47c51"], ["#745338", "#a37c4f", "#d1ad72"]];
const SKIN: readonly Ramp[] = [["#bf8264", "#e6ae87", "#f5cda4"], ["#9b624b", "#c08762", "#e0ae82"], ["#654039", "#96624e", "#bf8c68"]];

/** Avatar letter key -> colour for one person. Self-contained: the page embeds it with toString. */
export function avatarColors(identity: string, role: string): Record<string, string> {
  const clothes: Record<string, readonly string[]> = {
    coordinator: ["#37596d", "#5687a1", "#87b3c7"], worker: ["#3b6658", "#61947b", "#92bea1"],
    reviewer: ["#625776", "#8c7da4", "#b7a9ca"], visitor: ["#5a5550", "#857d75", "#b0a89e"], viewer: ["#8a6a2b", "#bb893b", "#e3b64f"],
    qa: ["#8d99a3", "#c9d2d9", "#eef2f5"], integrator: ["#76653f", "#a38f62", "#cdbb8c"]
  };
  const hairs = [["#302c3b", "#514757", "#756575"], ["#51372f", "#80533d", "#b47c51"], ["#745338", "#a37c4f", "#d1ad72"]];
  const skins = [["#bf8264", "#e6ae87", "#f5cda4"], ["#9b624b", "#c08762", "#e0ae82"], ["#654039", "#96624e", "#bf8c68"]];
  let hash = 0;
  for (let i = 0; i < identity.length; i++) hash = (Math.imul(hash, 31) + identity.charCodeAt(i)) >>> 0;
  const hair = hairs[hash % 3]!, skin = skins[Math.floor(hash / 3) % 3]!, shirt = clothes[role] ?? clothes.visitor!;
  return {O: "#292633", H: hair[0]!, I: hair[1]!, J: hair[2]!, S: skin[0]!, T: skin[1]!, U: skin[2]!,
    C: shirt[0]!, D: shirt[1]!, E: shirt[2]!, P: "#404958", Q: "#626e7f", B: "#2e3443", K: "#292633", R: "#e39a86"};
}
/** Every colour any avatar can wear, for the palette rules. */
export const AVATAR_COLOURS: readonly string[] = [...new Set([...Object.values(CLOTHES), ...HAIR, ...SKIN].flat()
  .concat(["#292633", "#404958", "#626e7f", "#2e3443", "#e39a86"]))];

// ---------- props ----------

function monitor(g: Grid, x: number, y: number, lines: readonly (readonly [number, number, string])[]): void {
  g.rect(x, y, 26, 17, "a"); g.rect(x + 2, y + 2, 22, 13, "b"); g.rect(x + 2, y + 2, 22, 1, "c");
  lines.forEach(([dx, w, c], i) => g.rect(x + 3 + dx, y + 4 + i * 2, w, 1, c));
  g.rect(x + 11, y + 17, 4, 5, "i"); g.rect(x + 11, y + 17, 1, 5, "j"); g.rect(x + 7, y + 21, 12, 2, "i"); g.rect(x + 7, y + 21, 12, 1, "j");
}
function crate(g: Grid, x: number, y: number, w: number, h: number): void {
  g.rect(x, y, w, 3, "5"); g.rect(x, y + 3, w, h - 3, "4"); g.rect(x + w - 2, y + 3, 2, h - 3, "3"); g.rect(x, y + h - 1, w, 1, "3");
  const m = x + (w >> 1) - 1; g.rect(m, y, 2, 3, "8"); g.rect(m, y + 3, 2, 3, "8"); g.rect(x + 2, y + 6, 4, 3, "9"); g.rect(x + 2, y + 8, 4, 1, "8");
  g.rect(x, y + 3, w, 1, "3");
}
function plant(): Sprite {
  return drawn(32, 48, g => {
    for (let y = 36; y <= 46; y++) { const inset = Math.floor((y - 36) / 4); g.rect(9 + inset, y, 14 - 2 * inset, 1, "3"); g.set(9 + inset, y, "4"); g.rect(20 - inset, y, 2, 1, "2"); }
    g.rect(8, 34, 16, 3, "4"); g.rect(8, 34, 16, 1, "5"); g.rect(8, 36, 16, 1, "2"); g.rect(10, 35, 12, 1, "1");
    g.rect(15, 20, 2, 15, "2"); g.rect(15, 20, 1, 15, "3"); g.line(16, 27, 20, 23, "2"); g.line(15, 25, 11, 21, "2");
    const leaf: Ramp = ["f", "g", "h"], shade: Ramp = ["e", "f", "g"];
    g.ball(9, 19, 5.5, 4.5, shade); g.ball(23, 18, 5.5, 4.5, shade);
    g.ball(16, 9, 8, 6.5, leaf); g.ball(10, 14, 6, 5, leaf); g.ball(22, 13, 6, 5, leaf); g.ball(16, 17, 6, 4, shade);
    [[13, 5], [18, 6], [11, 11], [20, 10], [15, 13], [8, 15], [24, 14]].forEach(([x, y]) => g.set(x!, y!, "h"));
    [[17, 12], [12, 16], [21, 16], [14, 19], [19, 19]].forEach(([x, y]) => g.set(x!, y!, "e"));
  });
}
function rack(fail: boolean): Sprite {
  return drawn(26, 48, g => {
    g.rect(0, 0, 26, 47, "a"); g.rect(0, 0, 26, 1, "b"); g.rect(0, 0, 1, 47, "b");
    for (let u = 0; u < 6; u++) {
      const y = 3 + u * 7; g.rect(2, y, 22, 6, "b"); g.rect(2, y, 22, 1, "c"); g.rect(2, y + 5, 22, 1, "a");
      for (let x = 4; x <= 12; x += 2) g.set(x, y + 3, "a");
      g.set(18, y + 2, "h"); g.set(20, y + 2, fail && u === 2 ? "k" : u % 2 ? "h" : "g"); g.set(22, y + 2, "g");
    }
    g.rect(1, 46, 4, 2, "0"); g.rect(21, 46, 4, 2, "0");
  });
}
function testBench(fail: boolean): Sprite {
  return drawn(72, 36, g => {
    g.rect(0, 20, 72, 6, "j"); g.rect(0, 20, 72, 1, "9"); g.rect(0, 26, 72, 3, "i"); g.rect(2, 29, 3, 7, "i"); g.rect(67, 29, 3, 7, "i");
    g.rect(2, 2, 26, 17, "a"); g.rect(4, 4, 22, 12, "0");
    let py = 13;
    for (let x = 5; x < 25; x++) { const ny = 6 + Math.round(3 * Math.sin(x * .7)) + (x > 18 ? 2 : 0); g.line(x - 1, py, x, ny, fail && x > 18 ? "k" : "h"); py = ny; }
    g.rect(13, 19, 4, 2, "i");
    g.rect(34, 6, 18, 12, "a"); g.rect(35, 7, 16, 10, fail ? "b" : "f");
    [8, 11, 14].forEach((y, i) => { g.set(37, y, fail && i === 1 ? "k" : "h"); g.rect(39, y, 9, 1, "d"); });
    g.rect(32, 18, 22, 3, "j"); g.rect(32, 18, 22, 1, "9");
    g.rect(57, 14, 12, 7, "f"); g.rect(57, 14, 12, 1, "g"); [59, 62, 65].forEach(x => g.set(x, 16, "l")); g.rect(60, 18, 5, 2, "0");
    g.rect(28, 12, 4, 8, "0"); g.rect(29, 13, 2, 5, "d");
    g.line(10, 26, 8, 33, "0"); g.line(60, 26, 63, 32, "0");
  });
}
function statusBoard(fail: boolean): Sprite {
  return drawn(60, 28, g => {
    g.rect(0, 0, 60, 28, "a"); g.rect(2, 2, 56, 22, "0"); g.rect(2, 2, 56, 1, "b");
    for (let i = 0; i < 8; i++) { const h = 4 + (i * 5) % 11; g.rect(5 + i * 6, 20 - h, 4, h, fail && i === 5 ? "k" : i % 3 ? "g" : "h"); }
    for (let i = 0; i < 6; i++) g.rect(5 + i * 9, 21, 6, 1, "f");
    g.rect(26, 25, 8, 3, "i");
  });
}
function cubicle(mirror: boolean): Sprite {
  return drawn(84, 56, g => {
    g.rect(0, 0, 84, 2, "j"); g.rect(0, 0, 84, 1, "9"); g.rect(0, 2, 84, 14, "c"); g.rect(0, 14, 84, 2, "b");
    for (let x = 3; x < 84; x += 6) g.rect(x, 4, 1, 9, "b");
    g.rect(0, 0, 4, 42, "j"); g.rect(0, 0, 1, 42, "9"); g.rect(0, 42, 4, 13, "c"); g.rect(0, 53, 4, 2, "b");
    g.rect(80, 0, 4, 42, "j"); g.rect(83, 0, 1, 42, "i"); g.rect(80, 42, 4, 13, "c"); g.rect(80, 53, 4, 2, "b");
    g.rect(8, 4, 5, 5, "l"); g.rect(14, 6, 5, 5, "n"); g.rect(66, 4, 9, 7, "9"); g.rect(67, 5, 7, 4, "d"); g.ball(70.5, 9, 3, 2, ["f", "g", "h"]);
    g.rect(4, 16, 76, 10, "4"); g.rect(4, 16, 76, 1, "5"); g.rect(4, 26, 76, 3, "3");
    const wing = mirror ? 56 : 4;
    g.rect(wing, 16, 24, 26, "4"); g.rect(wing, 42, 24, 3, "3"); g.rect(wing + (mirror ? 0 : 23), 16, 1, 26, "5");
    g.rect(mirror ? 57 : 6, 30, 10, 8, "9"); g.rect(mirror ? 58 : 7, 31, 8, 1, "j"); g.rect(mirror ? 58 : 7, 33, 6, 1, "j");
    monitor(g, 30, 1, [[0, 8, "d"], [2, 11, "h"], [2, 6, "l"], [0, 10, "d"], [2, 4, "c"]]);
    g.rect(31, 22, 22, 3, "j"); g.rect(31, 22, 22, 1, "9");
    g.rect(mirror ? 12 : 64, 18, 5, 5, "9"); g.rect(mirror ? 12 : 64, 20, 5, 1, "n");
    g.rect(mirror ? 70 : 8, 12, 6, 6, "3"); g.rect(mirror ? 70 : 8, 12, 6, 1, "4"); g.ball(mirror ? 73 : 11, 9, 4, 3.5, ["f", "g", "h"]);
  });
}
function bubble(kind: "alert" | "done" | "busy" | "fail"): Sprite {
  return drawn(12, 14, g => {
    g.rect(1, 0, 10, 10, "9"); g.rect(0, 1, 12, 8, "9"); g.rect(4, 10, 3, 1, "9"); g.set(5, 11, "9"); g.rect(1, 8, 10, 1, "8");
    if (kind === "alert") { g.rect(5, 2, 2, 4, "k"); g.rect(5, 7, 2, 1, "k"); }
    else if (kind === "fail") { g.line(3, 2, 8, 7, "k"); g.line(4, 2, 9, 7, "k"); g.line(8, 2, 3, 7, "k"); g.line(9, 2, 4, 7, "k"); }
    else if (kind === "done") { g.line(3, 5, 5, 7, "g"); g.line(5, 7, 9, 3, "g"); g.line(3, 4, 5, 6, "g"); g.line(5, 6, 8, 3, "g"); }
    else { g.set(3, 5, "i"); g.set(6, 5, "i"); g.set(9, 5, "i"); }
  });
}
/** Door in a north-south wall seen from above (frames: 0 closed, 1 ajar, 2 open); the leaf swings into the right room. */
function sideDoor(frame: 0 | 1 | 2): Sprite {
  return drawn(18, 34, g => {
    g.rect(0, 0, 8, 3, "1"); g.rect(0, 31, 8, 3, "1");
    if (frame === 0) { g.rect(1, 3, 6, 28, "3"); g.rect(1, 3, 1, 28, "5"); g.rect(6, 3, 1, 28, "2"); g.rect(3, 6, 2, 8, "4"); g.rect(3, 18, 2, 9, "4"); g.rect(5, 15, 2, 3, "l"); return; }
    g.rect(0, 3, 8, 28, "7"); g.rect(0, 3, 8, 1, "6"); g.rect(0, 30, 8, 1, "6");
    if (frame === 1) { for (let y = 0; y < 28; y++) { const x = 8 + Math.floor(y / 5); g.rect(x, 3 + y, 4, 1, "3"); g.set(x, 3 + y, "4"); } g.set(11, 17, "l"); }
    else { g.rect(8, 3, 3, 28, "3"); g.rect(8, 3, 1, 28, "4"); g.rect(10, 3, 1, 28, "2"); g.set(10, 17, "l"); }
  });
}
/** Door in an east-west wall seen from the front; the leaf swings towards the viewer, hinge on the left. */
function frontDoor(frame: 0 | 1 | 2): Sprite {
  return drawn(30, 36, g => {
    g.rect(0, 0, 30, 36, "1"); g.rect(2, 2, 26, 34, "0");
    if (frame === 0) {
      g.rect(2, 2, 26, 34, "3"); g.rect(2, 2, 26, 1, "4"); g.box(5, 5, 20, 12, "2"); g.box(5, 20, 20, 13, "2"); g.rect(8, 7, 14, 7, "d"); g.rect(8, 7, 14, 1, "9"); g.rect(23, 20, 2, 3, "l");
      return;
    }
    g.rect(2, 2, 26, 34, "6"); g.rect(2, 2, 26, 10, "8"); g.rect(2, 12, 26, 2, "4"); g.rect(2, 14, 26, 1, "2");
    const w = frame === 1 ? 14 : 5;
    g.rect(2, 2, w, 34, "3"); g.rect(2, 2, w, 1, "4"); g.rect(2 + w - 1, 2, 1, 34, "2");
    if (frame === 1) { g.rect(4, 6, 8, 6, "d"); g.rect(10, 20, 2, 3, "l"); }
  });
}

/** Whiteboard without notes; notes are laid on it per room from the criteria. */
function boardBase(): Sprite {
  return drawn(64, 48, g => {
    g.rect(9, 30, 2, 14, "i"); g.rect(53, 30, 2, 14, "i"); g.rect(9, 30, 1, 14, "j"); g.rect(53, 30, 1, 14, "j");
    g.rect(4, 43, 12, 2, "i"); g.rect(48, 43, 12, 2, "i"); [5, 14, 49, 58].forEach(x => g.rect(x, 45, 2, 2, "a"));
    g.rect(1, 1, 62, 32, "j"); g.rect(61, 1, 2, 32, "i"); g.rect(1, 31, 62, 2, "i");
    g.rect(3, 3, 57, 27, "9"); g.rect(3, 27, 57, 3, "8"); g.line(5, 26, 12, 4, "8");
    g.rect(6, 33, 52, 2, "j"); g.rect(6, 34, 52, 1, "i"); g.rect(14, 32, 5, 1, "b"); g.rect(21, 32, 5, 1, "g");
  });
}
/** One sticky note (7x9 with its pin) per criterion status. */
function note(colour: string): Sprite {
  return flat(7, 9, g => {
    g.rect(0, 1, 7, 8, colour); g.rect(0, 8, 7, 1, DARK[colour]!); g.rect(6, 2, 1, 7, DARK[colour]!);
    g.rect(1, 3, 4, 1, DARK[DARK[colour]!]!); g.rect(1, 5, 3, 1, DARK[DARK[colour]!]!); g.set(3, 0, "b");
  });
}
export const NOTE_COLOURS: Readonly<Record<string, string>> = {PASS: "h", FAIL: "k", PENDING: "l", UNKNOWN: "j"};
/** Where note i sits on the board sprite (outline included); 12 slots, the 12th becomes "+" when more remain. */
export function notePosition(index: number): {x: number; y: number} { return {x: 6 + (index % 6) * 9, y: 5 + Math.floor(index / 6) * 11}; }
export const BOARD_SLOTS = 12;

function wallBlock(capped: boolean): Sprite {
  // 24 wide so the stripe (8) and panel (24) rhythms tile seamlessly; 40 tall like every wall.
  return flat(24, 40, g => {
    if (capped) { g.rect(0, 0, 24, 3, "2"); g.rect(0, 0, 24, 1, "1"); }
    g.rect(0, 3, 24, 29, "8"); for (let x = 4; x < 24; x += 8) g.rect(x, 3, 1, 29, "9");
    g.rect(0, 32, 24, 2, "4"); g.rect(0, 32, 24, 1, "5"); g.rect(0, 34, 24, 3, "4"); g.rect(0, 34, 1, 3, "3");
    g.rect(0, 37, 24, 3, "2");
  });
}

/** Every room sprite by name. Generated once; the page receives it as JSON. */
export function roomSprites(): Readonly<Record<string, Sprite>> {
  const sprites: Record<string, Sprite> = {
    plant: plant(),
    deskPlant: drawn(16, 16, g => { g.rect(4, 10, 8, 5, "3"); g.rect(4, 10, 8, 1, "4"); g.rect(4, 10, 1, 5, "4"); g.rect(10, 11, 2, 4, "2"); g.ball(8, 6, 5, 4, ["f", "g", "h"]); g.ball(4.5, 8, 3, 2.5, ["e", "f", "g"]); g.ball(11.5, 8, 3, 2.5, ["e", "f", "g"]); }),
    chairBack: drawn(24, 28, g => {
      g.rect(3, 1, 18, 14, "b"); g.rect(4, 0, 16, 1, "b"); g.rect(3, 1, 2, 13, "c"); g.rect(18, 2, 3, 13, "a"); g.rect(4, 14, 16, 1, "a");
      g.rect(2, 16, 20, 4, "a"); g.rect(3, 16, 18, 1, "b"); g.rect(11, 20, 2, 4, "i"); g.rect(3, 23, 18, 2, "i"); g.rect(3, 23, 18, 1, "j");
      [3, 11, 19].forEach(x => g.rect(x, 25, 2, 2, "0"));
    }),
    chairFront: drawn(18, 22, g => {
      g.rect(2, 0, 14, 12, "b"); g.rect(3, 0, 12, 1, "c"); g.rect(2, 1, 2, 10, "c"); g.rect(13, 2, 3, 10, "a");
      g.rect(1, 11, 16, 5, "c"); g.rect(1, 11, 16, 1, "d"); g.rect(1, 15, 16, 1, "a"); g.rect(8, 16, 2, 3, "i"); g.rect(2, 19, 14, 2, "i"); [2, 8, 14].forEach(x => g.rect(x, 21, 2, 1, "0"));
    }),
    confTable: drawn(112, 30, g => {
      g.rect(2, 0, 108, 18, "3"); g.rect(0, 2, 112, 14, "3"); g.rect(2, 1, 108, 14, "4"); g.rect(4, 2, 104, 2, "5");
      g.rect(0, 16, 112, 4, "2"); g.rect(2, 18, 108, 2, "1"); g.rect(14, 20, 4, 10, "1"); g.rect(94, 20, 4, 10, "1");
      [[12, 5], [44, 6], [78, 5]].forEach(([x, y]) => { g.rect(x!, y!, 12, 7, "j"); g.rect(x!, y!, 12, 1, "9"); g.rect(x! + 4, y! + 3, 4, 2, "9"); });
      [[30, 6], [64, 7], [96, 6]].forEach(([x, y]) => { g.rect(x!, y!, 7, 8, "9"); g.rect(x! + 1, y! + 2, 5, 1, "d"); g.rect(x! + 1, y! + 4, 4, 1, "d"); });
      g.ell(58, 9, 5, 2.5, "a"); g.set(58, 8, "h"); [[26, 3], [90, 4]].forEach(([x, y]) => { g.rect(x!, y!, 2, 6, "d"); g.set(x!, y!, "9"); });
    }),
    cubicle: cubicle(false), cubicleMirror: cubicle(true),
    rackPass: rack(false), rackFail: rack(true), benchPass: testBench(false), benchFail: testBench(true),
    statusPass: statusBoard(false), statusFail: statusBoard(true),
    filing: drawn(18, 36, g => {
      g.rect(0, 0, 18, 36, "j"); g.rect(0, 0, 18, 1, "9"); g.rect(16, 0, 2, 36, "i");
      for (let d = 0; d < 4; d++) { const y = 2 + d * 8; g.rect(2, y, 13, 7, "8"); g.rect(2, y + 6, 13, 1, "j"); g.rect(6, y + 2, 5, 1, "i"); g.rect(7, y + 4, 3, 1, "9"); }
      g.rect(1, 34, 2, 2, "0"); g.rect(15, 34, 2, 2, "0");
    }),
    stool: drawn(12, 18, g => { g.ell(6, 3, 5.5, 2.8, "3"); g.ell(6, 2.5, 5, 2.2, "4"); g.rect(5, 5, 2, 10, "i"); g.rect(2, 15, 8, 2, "i"); }),
    trash: drawn(10, 12, g => { g.rect(0, 0, 10, 2, "j"); g.rect(1, 2, 8, 10, "i"); g.rect(1, 2, 2, 10, "j"); g.rect(4, 0, 3, 1, "9"); }),
    execDesk: drawn(64, 32, g => {
      g.rect(0, 8, 64, 6, "3"); g.rect(0, 8, 64, 1, "4"); g.rect(0, 14, 64, 18, "2"); g.rect(0, 14, 64, 1, "1");
      g.box(4, 17, 26, 12, "1"); g.box(34, 17, 26, 12, "1"); g.rect(15, 22, 4, 1, "l"); g.rect(45, 22, 4, 1, "l");
      g.rect(4, 6, 8, 2, "l"); g.rect(3, 1, 10, 4, "f"); g.rect(3, 1, 10, 1, "g"); g.rect(7, 5, 2, 2, "i");
      g.rect(24, 0, 18, 9, "j"); g.rect(24, 0, 18, 1, "9"); g.set(33, 4, "9");
      g.rect(46, 5, 10, 4, "9"); g.rect(47, 4, 10, 4, "9"); g.rect(48, 5, 6, 1, "j"); g.rect(16, 6, 6, 2, "0"); g.rect(17, 6, 4, 1, "l");
    }),
    armchair: drawn(26, 26, g => {
      g.rect(3, 0, 20, 12, "2"); g.rect(4, 0, 18, 2, "3"); g.rect(12, 2, 1, 9, "1");
      g.rect(0, 8, 5, 15, "2"); g.rect(0, 8, 5, 2, "3"); g.rect(21, 8, 5, 15, "1"); g.rect(21, 8, 5, 2, "2");
      g.rect(5, 12, 16, 7, "3"); g.rect(5, 12, 16, 2, "4"); g.rect(5, 19, 16, 4, "2"); g.rect(2, 23, 2, 3, "0"); g.rect(22, 23, 2, 3, "0");
    }),
    coffeeTable: drawn(38, 18, g => {
      g.rect(0, 0, 38, 8, "4"); g.rect(0, 0, 38, 1, "5"); g.rect(0, 8, 38, 3, "3"); g.rect(2, 11, 3, 7, "2"); g.rect(33, 11, 3, 7, "2");
      g.rect(5, 2, 9, 5, "9"); g.rect(6, 1, 9, 5, "9"); g.rect(7, 3, 6, 1, "j"); g.rect(22, 2, 5, 5, "9"); g.rect(22, 4, 5, 1, "n"); g.rect(30, 2, 4, 4, "l");
    }),
    lowBookcase: drawn(48, 26, g => {
      g.rect(0, 0, 48, 26, "2"); g.rect(0, 0, 48, 2, "3"); g.rect(2, 4, 44, 9, "1"); g.rect(2, 15, 44, 9, "1"); g.rect(2, 13, 44, 2, "3");
      const spines = ["b", "g", "n", "l", "c", "3", "h", "f", "d"];
      [4, 15].forEach((y, s) => { let x = 3; for (let b = 0; x < 42; b++) { const w = 2 + (b + s) % 2, h = 6 + (b * 3 + s) % 4, c = spines[(b * 2 + s) % spines.length]!; if ((b + s) % 6 === 5) { x += 3; continue; } g.rect(x, y + 9 - h, w, h, c); g.rect(x + w - 1, y + 9 - h, 1, h, DARK[c]!); x += w; } });
    }),
    metalShelf: drawn(50, 46, g => {
      g.rect(0, 0, 2, 46, "i"); g.rect(48, 0, 2, 46, "i");
      for (let s = 0; s < 4; s++) { const y = 2 + s * 14; g.rect(0, y, 50, 2, "j"); g.rect(0, y + 1, 50, 1, "i"); }
      [[3, 4, 12, 12], [16, 7, 14, 9], [32, 5, 13, 11], [4, 22, 18, 8], [24, 19, 10, 11], [36, 21, 10, 9], [3, 33, 13, 11], [18, 36, 26, 8]].forEach(([x, y, w, h]) => crate(g, x!, y!, w!, h!));
    }),
    copier: drawn(34, 32, g => {
      g.rect(0, 4, 34, 28, "9"); g.rect(31, 4, 3, 28, "8"); g.rect(0, 4, 34, 1, "8"); g.rect(2, 0, 26, 5, "j"); g.rect(2, 0, 26, 1, "9"); g.rect(4, 2, 22, 2, "a");
      g.rect(22, 7, 9, 5, "a"); g.rect(23, 8, 5, 3, "d"); g.set(30, 9, "h"); g.rect(2, 13, 28, 1, "j"); g.rect(2, 20, 28, 1, "j"); g.rect(10, 16, 10, 1, "i"); g.rect(10, 23, 10, 1, "i");
      g.rect(0, 7, 3, 4, "9"); g.rect(1, 29, 3, 3, "0"); g.rect(28, 29, 3, 3, "0");
    }),
    sortTable: drawn(56, 26, g => {
      g.rect(0, 8, 56, 6, "4"); g.rect(0, 8, 56, 1, "5"); g.rect(0, 14, 56, 3, "3"); g.rect(2, 17, 3, 9, "2"); g.rect(51, 17, 3, 9, "2");
      [[2, 0], [16, 1], [30, 0]].forEach(([x, y]) => { g.rect(x!, y! + 3, 12, 6, "b"); g.rect(x!, y! + 3, 12, 1, "c"); g.rect(x! + 2, y! + 1, 8, 3, "9"); g.rect(x! + 3, y!, 6, 2, "8"); });
      g.rect(44, 2, 9, 7, "4"); g.rect(44, 2, 9, 2, "5"); g.rect(48, 2, 1, 7, "8"); g.rect(16, 10, 8, 4, "9"); g.rect(18, 11, 4, 1, "j"); g.rect(28, 10, 7, 3, "n");
    }),
    handTruck: drawn(20, 42, g => {
      g.rect(14, 0, 2, 38, "i"); g.rect(14, 0, 1, 38, "j"); g.rect(12, 0, 5, 2, "i"); g.rect(0, 37, 16, 2, "i");
      crate(g, 0, 22, 13, 15); crate(g, 1, 10, 12, 12); g.ell(14, 38, 3.5, 3.5, "a"); g.set(13, 37, "j");
    }),
    crates: drawn(64, 48, g => {
      crate(g, 1, 33, 15, 13); crate(g, 16, 33, 15, 13); crate(g, 31, 33, 15, 13); crate(g, 8, 20, 15, 13); crate(g, 23, 20, 15, 13); crate(g, 16, 7, 15, 13);
      g.rect(60, 8, 2, 37, "i"); g.rect(60, 8, 1, 37, "j"); g.rect(57, 6, 5, 2, "i"); g.rect(49, 44, 12, 2, "i"); crate(g, 48, 31, 12, 13); g.ell(58, 45, 3, 3, "a");
    }),
    counter: drawn(80, 34, g => {
      g.rect(0, 10, 80, 5, "9"); g.rect(0, 10, 80, 1, "8"); g.rect(0, 15, 80, 1, "j"); g.rect(0, 16, 80, 18, "4"); g.rect(78, 16, 2, 18, "3");
      for (let d = 0; d < 5; d++) { g.box(2 + d * 16, 18, 14, 14, "3"); g.rect(d % 2 ? 4 + d * 16 : 12 + d * 16, 23, 1, 4, "5"); }
      g.rect(4, 0, 14, 12, "a"); g.rect(4, 0, 14, 1, "b"); g.rect(6, 3, 6, 3, "0"); g.set(14, 4, "h"); g.rect(8, 8, 5, 3, "9"); g.rect(9, 9, 3, 1, "2");
      g.rect(26, 2, 22, 10, "j"); g.rect(26, 2, 22, 1, "9"); g.rect(28, 4, 13, 6, "a"); g.rect(29, 5, 5, 1, "b"); g.rect(43, 4, 3, 6, "i"); g.set(44, 5, "h");
      g.rect(54, 10, 16, 3, "j"); g.rect(55, 11, 14, 1, "i"); g.rect(61, 5, 2, 6, "i"); g.rect(61, 5, 5, 1, "i");
      g.rect(72, 6, 4, 5, "n"); g.rect(76, 7, 1, 2, "n"); g.rect(20, 7, 4, 4, "9"); g.rect(20, 8, 4, 1, "c");
    }),
    fridge: drawn(22, 44, g => {
      g.rect(0, 0, 22, 44, "9"); g.rect(19, 0, 3, 44, "8"); g.rect(0, 14, 22, 1, "j"); g.rect(16, 4, 1, 8, "i"); g.rect(16, 18, 1, 12, "i");
      g.rect(4, 20, 4, 4, "l"); g.rect(9, 24, 3, 3, "n"); g.rect(4, 27, 5, 6, "9"); g.box(4, 27, 5, 6, "j"); g.rect(1, 42, 3, 2, "0"); g.rect(18, 42, 3, 2, "0");
    }),
    vending: drawn(26, 46, g => {
      g.rect(0, 0, 26, 46, "b"); g.rect(0, 0, 26, 2, "c"); g.rect(24, 0, 2, 46, "a"); g.rect(2, 4, 16, 30, "d");
      const goods = ["n", "l", "h", "9", "3", "c"];
      for (let r = 0; r < 5; r++) { g.rect(2, 9 + r * 6, 16, 1, "j"); for (let c = 0; c < 4; c++) g.rect(3 + c * 4, 5 + r * 6, 3, 4, goods[(r + c * 2) % goods.length]!); }
      g.line(3, 31, 10, 5, "9"); g.rect(19, 6, 4, 10, "a"); for (let i = 0; i < 4; i++) g.rect(20, 7 + i * 2, 2, 1, "j"); g.rect(20, 18, 2, 3, "0");
      g.rect(3, 37, 14, 5, "a"); g.rect(4, 38, 12, 3, "0");
    }),
    cooler: drawn(14, 36, g => {
      g.ball(7, 6, 6, 6, ["c", "d", "9"]); g.rect(5, 11, 4, 2, "c"); g.rect(1, 13, 12, 22, "9"); g.rect(11, 13, 2, 22, "8"); g.rect(1, 13, 12, 1, "8");
      g.rect(3, 17, 2, 2, "c"); g.rect(9, 17, 2, 2, "n"); g.rect(2, 21, 10, 1, "j"); g.rect(3, 28, 8, 1, "8");
    }),
    cafeTable: drawn(24, 22, g => {
      g.ell(12, 6, 11.5, 5.5, "9"); g.ell(12, 7, 11.5, 5, "8"); g.ell(12, 5.5, 10.5, 4, "9"); g.rect(11, 11, 3, 8, "i"); g.rect(6, 19, 13, 2, "i"); g.rect(7, 3, 4, 3, "n"); g.rect(15, 4, 3, 3, "l");
    }),
    sofa: drawn(48, 28, g => {
      g.rect(4, 2, 40, 12, "f"); g.rect(4, 2, 40, 2, "g"); g.rect(5, 1, 38, 1, "g"); g.rect(24, 3, 1, 11, "e");
      g.rect(0, 8, 6, 16, "f"); g.rect(0, 8, 6, 2, "g"); g.rect(42, 8, 6, 16, "e"); g.rect(42, 8, 6, 2, "f");
      g.rect(6, 13, 36, 7, "g"); g.rect(6, 13, 36, 2, "h"); g.rect(24, 13, 1, 7, "f"); g.rect(6, 20, 36, 4, "f"); g.rect(2, 24, 3, 3, "1"); g.rect(43, 24, 3, 3, "1");
    }),
    // wall decor
    tv: drawn(52, 26, g => {
      g.rect(0, 0, 52, 26, "a"); g.rect(2, 2, 48, 20, "9"); g.rect(2, 2, 48, 5, "b"); g.rect(4, 3, 18, 2, "9");
      [[6, 8], [13, 11], [20, 6], [27, 13]].forEach(([x, h]) => g.rect(x!, 20 - h!, 5, h!, x === 27 ? "g" : "c"));
      g.rect(36, 10, 11, 1, "j"); g.rect(36, 13, 9, 1, "j"); g.rect(36, 16, 11, 1, "j"); g.rect(22, 23, 8, 3, "i");
    }),
    blinds: drawn(48, 24, g => {
      g.rect(0, 0, 48, 22, "9"); g.rect(46, 0, 2, 22, "8"); g.rect(3, 3, 42, 16, "d"); g.rect(3, 12, 42, 7, "c");
      g.ball(14, 19, 9, 4, ["f", "g", "h"]); g.ball(38, 20, 7, 3, ["e", "f", "g"]);
      for (let y = 3; y < 11; y += 2) { g.rect(3, y, 42, 1, "8"); g.rect(3, y + 1, 42, 1, "6"); }
      g.rect(3, 11, 42, 1, "j"); g.rect(40, 12, 1, 5, "i"); g.rect(0, 20, 48, 3, "9"); g.rect(0, 23, 48, 1, "6");
    }),
    poster: drawn(22, 28, g => {
      g.rect(0, 0, 22, 28, "a"); g.rect(2, 2, 18, 18, "d"); g.rect(2, 12, 18, 8, "c");
      g.line(2, 17, 9, 7, "f"); g.line(9, 7, 14, 13, "f"); g.line(12, 11, 16, 8, "f"); g.line(16, 8, 19, 12, "f");
      for (let y = 8; y < 20; y++) for (let x = 2; x < 20; x++) if (g.get(x, y - 1) === "f" || g.get(x, y - 1) === "g") g.set(x, y, "g");
      g.set(9, 7, "9"); g.rect(8, 8, 3, 1, "9"); g.set(16, 8, "9"); g.rect(15, 4, 3, 3, "l"); g.rect(4, 22, 14, 2, "9"); g.rect(6, 25, 10, 1, "j");
    }),
    corkboard: drawn(36, 24, g => {
      g.rect(0, 0, 36, 24, "3"); g.rect(2, 2, 32, 20, "4");
      for (let i = 0; i < 30; i++) g.set(3 + (i * 7) % 30, 3 + (i * 5) % 18, "5");
      [[4, 4, "9"], [14, 5, "l"], [24, 3, "n"], [6, 13, "d"], [17, 13, "9"], [26, 12, "l"]].forEach(([x, y, c]) => { g.rect(+x!, +y!, 7, 7, String(c)); g.rect(+x! + 1, +y! + 3, 4, 1, "j"); g.set(+x! + 3, +y!, "b"); });
    }),
    frame: drawn(14, 11, g => { g.rect(0, 0, 14, 11, "2"); g.rect(2, 2, 10, 7, "d"); g.ball(7, 8, 5, 3, ["f", "g", "h"]); g.rect(9, 3, 2, 2, "l"); }),
    diploma: drawn(16, 12, g => { g.rect(0, 0, 16, 12, "2"); g.rect(2, 2, 12, 8, "9"); g.rect(4, 4, 8, 1, "j"); g.rect(5, 6, 6, 1, "j"); g.ell(11, 8, 1.5, 1.5, "l"); }),
    clock: drawn(16, 16, g => { g.ell(8, 8, 7.5, 7.5, "2"); g.ell(8, 8, 6.5, 6.5, "3"); g.ell(8, 8, 5.5, 5.5, "9"); g.set(7, 3, "0"); g.set(12, 7, "0"); g.set(7, 12, "0"); g.set(3, 7, "0"); g.rect(7, 4, 1, 4, "0"); g.rect(8, 7, 3, 1, "0"); }),
    cubby: drawn(40, 18, g => {
      g.rect(0, 0, 40, 18, "3"); g.rect(0, 0, 40, 1, "4");
      for (let r = 0; r < 2; r++) for (let c = 0; c < 5; c++) { const x = 2 + Math.floor(c * 7.6), y = 2 + r * 8; g.rect(x, y, 6, 6, "1"); if ((r * 5 + c) % 3 !== 1) { g.rect(x + 1, y + 2, 4, 4, (r + c) % 4 ? "9" : "n"); g.rect(x + 1, y + 2, 4, 1, "8"); } }
    }),
    // whiteboard driven by criteria
    board: boardBase(), notePass: note("h"), noteFail: note("k"), notePending: note("l"), noteUnknown: note("j"),
    notePlus: flat(7, 9, g => { g.rect(0, 1, 7, 8, "a"); g.rect(3, 3, 1, 4, "9"); g.rect(1, 5, 5, 1, "9"); g.set(3, 0, "b"); }),
    // head bubbles and doors
    bubbleAlert: bubble("alert"), bubbleDone: bubble("done"), bubbleBusy: bubble("busy"), bubbleFail: bubble("fail"),
    sideDoor0: sideDoor(0), sideDoor1: sideDoor(1), sideDoor2: sideDoor(2), frontDoor0: frontDoor(0), frontDoor1: frontDoor(1), frontDoor2: frontDoor(2),
    // tiles: walls (24x40, repeat in x), floors (repeat in both)
    wall: wallBlock(true),
    wood: flat(96, 16, g => { g.rect(0, 0, 96, 16, "7"); g.rect(0, 7, 96, 1, "6"); g.rect(0, 15, 96, 1, "6"); g.rect(30, 0, 1, 7, "6"); g.rect(78, 8, 1, 7, "6"); g.rect(8, 3, 14, 1, "8"); g.rect(50, 4, 9, 1, "8"); g.rect(40, 11, 18, 1, "8"); g.rect(84, 12, 6, 1, "8"); }),
    carpet: flat(32, 32, g => {
      g.rect(0, 0, 32, 32, "m");
      for (let y = 0; y < 32; y++) for (let x = 0; x < 32; x++) { const r = (Math.imul(x, 73856093) ^ Math.imul(y, 19349663)) >>> 0; if (r % 37 === 0) g.set(x, y, "6"); else if (r % 71 === 0) g.set(x, y, "j"); }
      g.rect(0, 0, 32, 1, "6"); g.rect(0, 0, 1, 32, "6");
    }),
    vinyl: flat(16, 16, g => { g.rect(0, 0, 16, 16, "8"); g.rect(0, 0, 16, 1, "6"); g.rect(0, 0, 1, 16, "6"); }),
    checker: flat(24, 24, g => { g.rect(0, 0, 24, 24, "9"); g.rect(12, 0, 12, 12, "7"); g.rect(0, 12, 12, 12, "7"); }),
    rugBlue: flat(16, 16, g => { g.rect(0, 0, 16, 16, "b"); g.rect(0, 0, 16, 1, "c"); }),
    rugGreen: flat(16, 16, g => { g.rect(0, 0, 16, 16, "f"); g.rect(0, 0, 16, 1, "g"); })
  };
  return sprites;
}
