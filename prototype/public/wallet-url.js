/**
 * A looked-up wallet lives in the page address: #/account/G…
 *
 * Looking a wallet up used to leave the address bar at the home page, so a
 * refresh lost the wallet, a link to it couldn't be shared, and Back didn't
 * return to it. Now a lookup adds #/account/{address} to the history, and
 * opening that URL (or going Back or Forward to it) loads the wallet.
 *
 * Plain script, no dependencies: the page loads it with <script src>, and the
 * tests require() it.
 */
(function (root) {
  const ADDRESS = /^G[A-Z2-7]{55}$/;
  const PREFIX = "#/account/";

  /** The wallet address in a location hash, or null. Only a well-formed G… address counts. */
  function accountFromHash(hash) {
    if (typeof hash !== "string" || !hash.startsWith(PREFIX)) return null;
    const address = hash.slice(PREFIX.length);
    return ADDRESS.test(address) ? address : null;
  }

  /** The hash for a wallet, or null if `address` isn't a well-formed G… address. */
  function hashForAccount(address) {
    const a = typeof address === "string" ? address.trim() : "";
    return ADDRESS.test(a) ? PREFIX + a : null;
  }

  /**
   * How to move the address bar from `fromHash` to `toHash` when the page
   * switches view: "none" if it's already there; "push" when leaving a
   * wallet, so Back returns to that wallet; otherwise "replace", as the page
   * tabs always did (switching tabs doesn't add history entries).
   */
  function historyAction(fromHash, toHash) {
    const from = fromHash || "";
    const to = toHash || "";
    if (from === to) return "none";
    return accountFromHash(from) ? "push" : "replace";
  }

  const WalletUrl = { accountFromHash, hashForAccount, historyAction };
  if (typeof module !== "undefined" && module.exports) module.exports = WalletUrl;
  else root.WalletUrl = WalletUrl;
})(typeof window !== "undefined" ? window : this);
