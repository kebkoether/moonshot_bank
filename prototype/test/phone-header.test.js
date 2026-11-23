// On phones the header scrolls away with the page instead of staying on top.
//
// At 600 px and below the header's rows wrap, and it is about 190 px tall:
// close to a third of a 664 px phone screen. Kept on top while scrolling, it
// covered that much of every page and slid over the Portfolio / DeFi / RWAs
// tabs. There is no browser in these tests, so this checks the stylesheet.

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const INDEX = fs.readFileSync(path.join(__dirname, "..", "public", "index.html"), "utf8");

/** The body of the first `@media (max-width: 600px)` block that holds `marker`. */
function phoneBlock(marker) {
  let from = 0;
  for (;;) {
    const start = INDEX.indexOf("@media (max-width: 600px) {", from);
    assert.ok(start >= 0, `no phone block holds ${marker}`);
    let depth = 0;
    let i = INDEX.indexOf("{", start);
    const open = i;
    for (; i < INDEX.length; i++) {
      if (INDEX[i] === "{") depth++;
      else if (INDEX[i] === "}" && --depth === 0) break;
    }
    const body = INDEX.slice(open + 1, i);
    if (body.includes(marker)) return body;
    from = i;
  }
}

test("on phones the header isn't sticky", () => {
  const block = phoneBlock(".header-right { flex-wrap: wrap;");
  assert.match(block, /^\s*\.header \{ position: static; \}/m);
});

test("above 600 px it still is", () => {
  const base = INDEX.slice(INDEX.indexOf("    .header {"), INDEX.indexOf("}", INDEX.indexOf("    .header {")));
  assert.match(base, /position: sticky;/);
  assert.match(base, /top: 0;/);
});
