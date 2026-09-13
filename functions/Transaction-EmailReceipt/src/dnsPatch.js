import dns from 'dns';

/**
 * Makes hostname resolution survive this VPS's broken getaddrinfo path, WITHOUT ever blocking the
 * start of an execution.
 *
 * WHAT IS ACTUALLY WRONG. Measured from inside the function sandbox on 2026-09-13:
 *   lookup('api.cloud.shotty.tech')    -> EAI_AGAIN after 5007ms
 *   resolve4('api.cloud.shotty.tech')  -> 158.69.218.215 in 62ms
 *   lookup('api.stripe.com')           -> fine, 7ms
 * So getaddrinfo is not broken in general -- it is broken for THIS deployment's own domain, which
 * the container's resolv.conf routes through a Tailscale search domain (`search taile401d2.ts.net`,
 * nameserver 127.0.0.11 forwarding to the host's systemd-resolved). resolve4 asks the nameserver
 * directly and is unaffected.
 *
 * WHY THE PREVIOUS VERSION MADE THINGS WORSE. It did `await dns.promises.resolve4(host)` BEFORE
 * returning the Appwrite client -- so every cold container blocked on a DNS round trip before
 * running a single line of handler code, and `resolve4` had no timeout. Under concurrent cold
 * starts every container hits Docker's embedded resolver at once, the queries queue, and the
 * execution dies at its timeout ceiling having logged NOTHING. That is exactly the signature we
 * found in production: `status: failed`, `errors: 'Execution timed out.'`, `logs: (empty)`.
 * A workaround for flaky DNS must not itself be a blocking DNS call.
 *
 * WHAT THIS DOES INSTEAD.
 *   - Installs synchronously. Importing this module never awaits anything, so a handler starts
 *     immediately and a DNS problem can only ever slow ONE request, never the startup path.
 *   - Resolves lazily, inside the lookup callback, and only for hosts actually contacted.
 *   - Caches successes for the life of the container, so a warm container never re-resolves.
 *   - Bounds every resolve4 with a timeout, then FALLS BACK to the original getaddrinfo rather
 *     than failing. Falling back is the whole point: for api.stripe.com getaddrinfo is the fast
 *     path, and for this deployment's own domain resolve4 is. Trying one and falling back to the
 *     other means no single broken path can take a request down.
 *   - Covers EVERY host, not just the Appwrite endpoint. The old patch left api.stripe.com and
 *     api.resend.com on the unpatched path, and Stripe-CreatePaymentIntent had no patch at all --
 *     which is why a card sale could hang for the full timeout after logging its key selection.
 */

const RESOLVE_TIMEOUT_MS = 2000;
const cache = new Map();
let installed = false;

function resolveWithTimeout(host) {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ip) => {
			if (!settled) {
				settled = true;
				resolve(ip);
			}
		};
		const timer = setTimeout(() => done(null), RESOLVE_TIMEOUT_MS);
		dns.resolve4(host, (err, addrs) => {
			clearTimeout(timer);
			done(err || !addrs || !addrs.length ? null : addrs[0]);
		});
	});
}

export function installDnsPatch() {
	if (installed) return;
	installed = true;
	const originalLookup = dns.lookup;

	// Signature-compatible with dns.lookup: (hostname[, options], callback). Anything we cannot
	// confidently improve on is handed straight back to the original.
	dns.lookup = function patchedLookup(hostname, options, callback) {
		if (typeof options === 'function') {
			callback = options;
			options = {};
		}
		const opts = options || {};
		// `all: true` callers expect an array of records, and family 6 wants AAAA -- resolve4 can
		// answer neither, so those go to the original resolver untouched.
		if (opts.all || opts.family === 6 || typeof hostname !== 'string') {
			return originalLookup.call(dns, hostname, options, callback);
		}

		const hit = cache.get(hostname);
		if (hit) return process.nextTick(() => callback(null, hit, 4));

		resolveWithTimeout(hostname).then((ip) => {
			if (ip) {
				cache.set(hostname, ip);
				return callback(null, ip, 4);
			}
			return originalLookup.call(dns, hostname, options, callback);
		});
	};
}

/** Test seam: forget everything learned, so a test can assert the resolve path rather than a cache hit. */
export function __resetDnsPatchForTests() {
	cache.clear();
	installed = false;
}
