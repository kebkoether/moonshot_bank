// The two background images are served by the site.
//
// They came from a Pinata gateway that answers 403 to every visitor, so the
// page asked for them on every load and showed nothing. One was a 2046 x 2727
// PNG of 8.4 MB, shown 420 px wide at 20% opacity: both are served at that
// width, as WebP.

const { request } = require("./helpers");

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

test("the page asks the site for them, not the gateway", () => {
  assert.doesNotMatch(INDEX, /mypinata\.cloud/);
  assert.match(INDEX, /<img src="\/M25_63\.webp" alt=""/);
  assert.match(INDEX, /<img src="\/M25_15\.webp" alt=""/);
});

test("the site serves them, 420 px wide and small", async () => {
  const { app } = require("../server.js");
  for (const [file, height] of [["M25_63.webp", 420], ["M25_15.webp", 560]]) {
    const res = await request(app, "GET", `/${file}`);
    assert.equal(res.status, 200, file);
    assert.match(res.headers["content-type"], /^image\/webp/);
    const b = fs.readFileSync(path.join(__dirname, "..", "public", file));
    assert.ok(b.length < 20_000, `${file}: ${b.length} bytes`);
    // A lossy WebP's size, from its VP8 frame header.
    assert.equal(b.toString("ascii", 0, 4) + b.toString("ascii", 8, 16), "RIFFWEBPVP8 ");
    assert.deepEqual([b.readUInt16LE(26) & 0x3fff, b.readUInt16LE(28) & 0x3fff], [420, height], file);
  }
});
