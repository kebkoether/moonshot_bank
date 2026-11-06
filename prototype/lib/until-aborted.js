/**
 * Make a fetch body read (res.json(), res.text()) obey its request's abort signal.
 *
 * Node's fetch can leave a body read pending for good when the request's
 * abort signal fires just as a gzip body is arriving: neither resolved nor
 * rejected, even after the whole body has come in. Against a local server
 * that answers right around the timeout, 77 to 84 of 600 reads never settled
 * (none with an uncompressed body). Horizon, CoinGecko and Templar's API all
 * send gzip.
 *
 * A caller that keeps one shared request in flight (the XLM price, a wallet's
 * Templar history, the DeFi tab's refresh loop) then waits on it forever, and
 * so does every caller after it, until the server restarts. Blend's history
 * search had the same problem.
 */

/**
 * Settles like `promise`, or rejects with the signal's reason (an AbortError
 * or TimeoutError) once `signal` aborts, whichever comes first. Without a
 * signal, returns `promise` unchanged.
 */
function untilAborted(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason instanceof Error ? signal.reason : new Error("This operation was aborted"));
    // Handled either way: a read that rejects after the abort isn't an unhandled rejection.
    promise.then(
      (value) => { signal.removeEventListener("abort", onAbort); resolve(value); },
      (err) => { signal.removeEventListener("abort", onAbort); reject(err); },
    );
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  });
}

module.exports = { untilAborted };
