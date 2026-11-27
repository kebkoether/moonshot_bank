// The Stellar mark in the header and on the home page has a transparent
// background, so it sits on the header's own colour.
//
// public/stellar-mark.png was a black mark on a white square, with no alpha.
// In the dark theme the page inverts it (--logo-filter: invert(1)) to make the
// mark white, and the white square became a black one on the navy header.
// The mark is also drawn bolder than Stellar's thin one, to read at 30 px.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const zlib = require("zlib");

const FILE = path.join(__dirname, "..", "public", "stellar-mark.png");

/** An 8-bit, non-interlaced PNG's size, colour type and RGBA pixels. */
function decodePng(buf) {
  assert.equal(buf.subarray(0, 8).toString("hex"), "89504e470d0a1a0a", "a PNG");
  let pos = 8;
  let width, height, bitDepth, colorType, interlace;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString("ascii", pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === "IDAT") idat.push(data);
    pos += 12 + len;
  }
  const channels = { 6: 4, 2: 3, 0: 1, 4: 2 }[colorType];
  if (bitDepth !== 8 || interlace !== 0 || !channels) return { width, height, colorType };
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const px = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const v = raw[y * (stride + 1) + 1 + x];
      const a = x >= channels ? px[y * stride + x - channels] : 0;
      const b = y > 0 ? px[(y - 1) * stride + x] : 0;
      const c = x >= channels && y > 0 ? px[(y - 1) * stride + x - channels] : 0;
      const p = a + b - c;
      const pr = Math.abs(p - a) <= Math.abs(p - b) && Math.abs(p - a) <= Math.abs(p - c) ? a : Math.abs(p - b) <= Math.abs(p - c) ? b : c;
      px[y * stride + x] = (v + [0, a, b, (a + b) >> 1, pr][filter]) & 0xff;
    }
  }
  return { width, height, colorType, channels, px };
}

test("the mark has a transparent background and an opaque mark", () => {
  const png = decodePng(fs.readFileSync(FILE));
  assert.equal(png.colorType, 6, "RGBA: it has an alpha channel");
  const { width, height, px } = png;
  const alpha = (x, y) => px[(y * width + x) * 4 + 3];
  for (const [x, y] of [[0, 0], [width - 1, 0], [0, height - 1], [width - 1, height - 1], [width >> 1, height >> 1]]) {
    assert.equal(alpha(x, y), 0, `transparent at ${x},${y}`);
  }
  let opaque = 0;
  let dark = true;
  for (let i = 0; i < width * height; i++) {
    if (px[i * 4 + 3] === 255) {
      opaque++;
      if (px[i * 4] > 32 || px[i * 4 + 1] > 32 || px[i * 4 + 2] > 32) dark = false;
    }
  }
  assert.ok(opaque > 0.1 * width * height, `${opaque} opaque pixels: the mark is there`);
  assert.ok(dark, "the mark is black, so the dark theme's invert(1) turns it white");
});

test("the mark is bold: thick strokes, with the gaps between them still open", () => {
  // Down the middle column the mark crosses four strokes: the ring, the two
  // bars, the ring. The thin mark's were 8 px of 128; these are 12 to 13.
  const { width, height, px } = decodePng(fs.readFileSync(FILE));
  const x = width >> 1;
  const runs = [];
  let ink = false, n = 0;
  for (let y = 0; y < height; y++) {
    const on = px[(y * width + x) * 4 + 3] >= 128;
    if (on !== ink) { runs.push([ink, n]); ink = on; n = 0; }
    n++;
  }
  runs.push([ink, n]);
  const strokes = runs.filter(([on]) => on).map(([, len]) => len);
  const gaps = runs.slice(1, -1).filter(([on]) => !on).map(([, len]) => len);
  assert.equal(strokes.length, 4, `strokes ${strokes}`);
  for (const s of strokes) assert.ok(s >= 11, `a stroke ${s} px thick: bold is 11 or more`);
  for (const g of gaps) assert.ok(g >= 4, `a gap of ${g} px: still open`);
});

test("the page still shows it in the header and on the home page, inverted in the dark theme", () => {
  const html = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");
  assert.equal((html.match(/<img src="\/stellar-mark\.png" alt="Stellar" class="stellar-mark"/g) || []).length, 2);
  assert.match(html, /--logo-filter: invert\(1\);/);
  assert.match(html, /\.stellar-mark \{[^}]*filter: var\(--logo-filter\);/);
});
