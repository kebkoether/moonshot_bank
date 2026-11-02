/**
 * Shared test setup.
 *
 * IMPORTANT: this module must be required before anything that reaches
 * lib/history-db.js. That module opens its SQLite file at require-time from
 * HISTORY_DB_PATH (history-db.js:13), so the env var has to be set before the
 * first require or the tests mutate whatever database the developer has locally.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const crypto = require("crypto");

process.env.NODE_ENV = "test";

// One scratch database per test process.
const DB_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "stellarscope-test-"));
process.env.HISTORY_DB_PATH = path.join(DB_DIR, "history.db");

// Keep the signed-challenge domain stable regardless of the developer's .env —
// the domain is baked into the signed message, so a stray value would make
// every signature test fail for the wrong reason.
process.env.STELLARSCOPE_DOMAIN = "stellarscope.test";
delete process.env.PROFILE_AUTH_ALLOW_HASH_VARIANTS;

const { Keypair } = require("@stellar/stellar-sdk");

function cleanup() {
  try { fs.rmSync(DB_DIR, { recursive: true, force: true }); } catch (e) { /* best effort */ }
}

/** A throwaway Stellar keypair. */
function wallet() {
  return Keypair.random();
}

/**
 * Ask profile-auth for a challenge and sign it for real — no stubbed crypto, so
 * these tests exercise the same ed25519 path production does (and will fail loudly
 * if the stellar-sdk bump changes Keypair.verify semantics).
 *
 * `variant` selects how the wallet wraps the message, mirroring the encodings
 * profile-auth accepts or rejects.
 */
function signChallenge(profileAuth, { keypair, action, slug, target, variant = "raw" }) {
  const { token, message } = profileAuth.issueChallenge({
    address: keypair.publicKey(),
    action,
    slug,
    target,
  });
  const raw = Buffer.from(message, "utf8");
  const sep53 = Buffer.concat([Buffer.from("Stellar Signed Message:\n", "utf8"), raw]);
  const sha = (b) => crypto.createHash("sha256").update(b).digest();
  const bytes = {
    raw,
    sep53,
    rawHash: sha(raw),
    sep53Hash: sha(sep53),
  }[variant];
  if (!bytes) throw new Error(`unknown signing variant: ${variant}`);
  return {
    challengeToken: token,
    // Buffer.from() is load-bearing across the stellar-sdk 15 -> 17 bump:
    // Keypair.sign() returned a Buffer in 15 and returns a plain Uint8Array in
    // 17, whose .toString("base64") is "12,34,56,…" rather than base64. Without
    // the wrap, every signature test failed with "Signature has wrong length" —
    // which is how the change was found. Production code never calls .sign()
    // (wallets do the signing and hand back base64), so only tests were
    // affected, but the failure looked alarming until traced.
    signature: Buffer.from(keypair.sign(bytes)).toString("base64"),
    address: keypair.publicKey(),
  };
}

/** Minimal in-process HTTP client for the exported express app. */
function request(app, method, url, { body, headers = {} } = {}) {
  const http = require("http");
  return new Promise((resolve, reject) => {
    const server = http.createServer(app);
    server.listen(0, () => {
      const payload = body === undefined ? null : JSON.stringify(body);
      const req = http.request(
        {
          host: "127.0.0.1",
          port: server.address().port,
          method,
          path: url,
          headers: {
            // The app gates several routes on same-origin. Tests opt in by
            // default and override explicitly when testing the gate itself.
            "Sec-Fetch-Site": "same-origin",
            ...(payload ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) } : {}),
            ...headers,
          },
        },
        (res) => {
          // Decode as a stream: `raw += chunk` decoded each Buffer chunk on its
          // own, so a multi-byte character split across two chunks (a "─" in
          // index.html, depending on where the chunks fall) came out as two
          // U+FFFD, and the inline-script hash test failed for that reason alone.
          res.setEncoding("utf8");
          let raw = "";
          res.on("data", (c) => { raw += c; });
          res.on("end", () => {
            server.close();
            let json = null;
            try { json = JSON.parse(raw); } catch (e) { /* not json */ }
            resolve({ status: res.statusCode, headers: res.headers, body: json, raw });
          });
        }
      );
      req.on("error", (e) => { server.close(); reject(e); });
      if (payload) req.write(payload);
      req.end();
    });
  });
}

module.exports = { DB_DIR, cleanup, wallet, signChallenge, request };
