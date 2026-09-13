import { installDnsPatch } from './_shared/dnsPatch.js';

// This deployment's sandbox cannot resolve its own domain through getaddrinfo (EAI_AGAIN after
// ~5s), which is the path Stripe's SDK and node-appwrite both use underneath. This function had NO
// resolver workaround at all -- it is why a card sale could log its key selection and then hang for
// the whole timeout without another line. Installed synchronously at import; it never blocks.
installDnsPatch();
/**
 * @file index.js
 * @description Appwrite Serverless Function: Quick Access Login
 *
 * Lets Door POS staff sign in with a short PIN instead of a password baked into the client app.
 * The submitted PIN is hashed and matched against active system:'ticketing' rows in the shared
 * `pins` collection (managed by the admin app's Admin-GeneratePin function -- see Verify-Pin
 * for the same pattern applied to POS/self-checkout PINs). On a correct PIN, this function mints
 * a short-lived custom token for the shared door-staff account (QUICK_ACCESS_USER_ID) via
 * Appwrite's Users API and returns { userId, secret }. The client then exchanges that token for
 * a real session via POST /account/sessions/token.
 *
 * Formerly a single QUICK_ACCESS_PIN environment variable plus an optional
 * QUICK_ACCESS_REVIEWER_PIN (a fixed credential for Stripe's app reviewer, see the "Fixed
 * authentication code that remains valid indefinitely" requirement in Stripe's Apps on Devices
 * review guidelines) -- moved to the `pins` collection so multiple named door codes (including
 * the reviewer's, now just another permanently-active row) can be generated/rotated/revoked from
 * a client instead of hand-edited via the console/CLI, and so the PIN is hashed at rest instead
 * of stored in plaintext.
 *
 * Failed attempts are throttled and persisted in the 'rate_limits' collection, since a short PIN
 * on a public endpoint is otherwise brute-forceable. Two buckets are counted per attempt (see
 * rateLimitBuckets): a small per-caller budget, and a much larger per-IP backstop keyed on the
 * *trusted* (rightmost) forwarding element. The counter itself is advanced server-side via
 * Appwrite's attribute-increment route (see recordFailureForBucket), so a concurrent burst persists
 * as N attempts rather than collapsing to one. A failed attempt that cannot be persisted refuses
 * the login rather than answering it, since an attempt that isn't counted is an attempt that
 * doesn't exist.
 *
 * Ported from ShottyTicketing's own standalone project, now that it shares SkullPOS's Appwrite
 * project: DB_ID points at the shared database's 'rate_limits'/'pins' collections, and
 * QUICK_ACCESS_USER_ID names a fresh door-staff user created directly in the shared project
 * (Appwrite user ids are project-scoped, so Ticketing's old standalone door-staff account id
 * doesn't carry over).
 *
 * Required environment variables on this function:
 *   QUICK_ACCESS_USER_ID - the Appwrite user ID of the shared door-staff account
 *   APPWRITE_API_KEY - optional; falls back to the function's own per-execution dynamic key
 *     (req.headers['x-appwrite-key']), granted by this function's configured scopes
 *     (users.write, documents.read, documents.write)
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const dns = require('dns');
const { getAppwriteEndpoints, needsHostOverride } = require('./_shared/appwriteEndpoints');
const {
  checkLockout,
  recordFailedAttempt,
  resetState,
  toPersistedState,
  MAX_ATTEMPTS,
  IP_MAX_ATTEMPTS,
  WINDOW_MS,
  LOCKOUT_MS,
} = require('./_shared/rateLimit');

// This self-hosted instance's function-execution sandbox can't resolve its own public
// hostname via the normal getaddrinfo path (used internally by Node's http/https modules) --
// dns.resolve4 (talks to nameservers directly, bypassing getaddrinfo) works fine though. Same
// workaround as the ESM functions' appwriteClient.js, needed here too since this function talks
// to the public endpoint directly via Node's http/https rather than the Appwrite SDK.
let patchedHost = null;
async function ensureDnsPatched(hostname) {
  if (patchedHost === hostname) return;
  const [ip] = await dns.promises.resolve4(hostname);
  const origLookup = dns.lookup;
  dns.lookup = (host, options, callback) => {
    if (typeof options === 'function') callback = options;
    if (host === hostname) return callback(null, ip, 4);
    return origLookup(host, options, callback);
  };
  patchedHost = hostname;
}

const DB_ID = '67c9ffd9003d68236514';
const RATE_LIMIT_COLLECTION = 'rate_limits';
const PINS_COLLECTION_ID = 'pins';

/**
 * Universal HTTP REST Client for internal Appwrite API requests.
 */
function httpRequest(urlStr, method = 'GET', headers = {}, bodyObj = null, timeoutMs = 10000) {
  return new Promise((resolve, reject) => {
    try {
      const parsedUrl = new URL(urlStr);
      const postData = bodyObj ? JSON.stringify(bodyObj) : null;

      const reqHeaders = {
        ...headers,
        ...(postData ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData) } : {}),
      };

      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (parsedUrl.protocol === 'https:' ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers: reqHeaders,
        timeout: timeoutMs,
      };

      const clientModule = parsedUrl.protocol === 'https:' ? https : http;

      const req = clientModule.request(options, (res) => {
        let bodyText = '';
        res.on('data', (chunk) => (bodyText += chunk));
        res.on('end', () => {
          try {
            const parsed = JSON.parse(bodyText);
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: parsed });
          } catch {
            resolve({ ok: res.statusCode >= 200 && res.statusCode < 300, status: res.statusCode, data: bodyText });
          }
        });
      });

      req.on('timeout', () => {
        req.destroy(new Error(`HTTP request timeout after ${timeoutMs}ms: ${urlStr}`));
      });

      req.on('error', (err) => reject(err));
      if (postData) req.write(postData);
      req.end();
    } catch (err) {
      reject(err);
    }
  });
}

/** Appwrite document IDs must be a restricted charset; a short hash keeps this valid regardless
 * of the raw value's format (IPv4, IPv6, or an Appwrite user id). */
function rateLimitDocId(prefix, value) {
  return prefix + crypto.createHash('sha1').update(value).digest('hex').slice(0, 16);
}

/**
 * The **rightmost** element of x-forwarded-for, not the leftmost. Each proxy appends the address
 * it received the request from, so the last element is the one written by the trusted proxy in
 * front of this runtime; everything to its left is whatever the caller chose to send. That matters
 * because Appwrite's own createExecution API lets a caller supply an arbitrary `headers` map, so
 * the leftmost element is literally attacker-authored - keying the throttle on it meant every
 * attempt landed in a fresh bucket, and that a chosen value could pin a lockout on somebody else's
 * bucket (P0-4b).
 *
 * Assumption: exactly one trusted proxy appends to this header in front of the function runtime,
 * which is what the deployment behind api.cloud.shotty.tech does. If another proxy is ever put in
 * front, the trusted element moves and this must take the Nth-from-last instead.
 */
function extractClientIp(req) {
  const forwarded = (req.headers && req.headers['x-forwarded-for']) || '';
  const chain = String(forwarded)
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  if (chain.length > 0) return chain[chain.length - 1];
  // x-real-ip is written by the proxy as a single value (no chain to pick from). Only reached
  // when there is no x-forwarded-for at all.
  const realIp = (req.headers && req.headers['x-real-ip']) || '';
  return String(realIp).trim() || 'unknown';
}

/**
 * Two buckets are checked and written on every failed attempt:
 *
 *   caller (`qa_c_`, MAX_ATTEMPTS) - the calling session where there is one, else the trusted IP.
 *     A caller can mint a fresh anonymous session to get a fresh bucket, so this can only ever
 *     *narrow* the budget, never escape it.
 *   ip (`qa_ip_`, IP_MAX_ATTEMPTS) - the trusted proxy-supplied address. The ceiling that cannot be
 *     walked away from, which is why it, not the caller bucket, is the real brute-force limit.
 */
function rateLimitBuckets(ip, callerId) {
  return [
    { id: rateLimitDocId('qa_c_', callerId || ip), max: MAX_ATTEMPTS, label: callerId ? 'caller' : 'caller(ip)' },
    { id: rateLimitDocId('qa_ip_', ip), max: IP_MAX_ATTEMPTS, label: 'ip' },
  ];
}

/**
 * Finds a reachable Appwrite endpoint and fetches every rate-limit doc named in `docIds`.
 * Returns null if every endpoint is unreachable. The caller fails OPEN on a correct PIN (a DB
 * hiccup must never lock door staff out of the app) but fails CLOSED on an incorrect one, since
 * an attempt that cannot be counted is an attempt that does not exist.
 */
async function loadRateLimitState(headersBase, docIds, log) {
  for (const endpoint of getAppwriteEndpoints()) {
    const headers = { ...headersBase };
    if (needsHostOverride(endpoint)) headers['Host'] = 'api.cloud.shotty.tech';

    try {
      const states = {};
      for (const docId of docIds) {
        const result = await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents/${docId}`, 'GET', headers);
        if (result.status === 404) {
          states[docId] = null;
          continue;
        }
        if (result.ok) {
          states[docId] = result.data;
          continue;
        }
        throw new Error(`[HTTP ${result.status}] ${JSON.stringify(result.data)}`);
      }
      return { endpoint, headers, states };
    } catch (err) {
      if (log) log(`Rate-limit lookup via ${endpoint} failed: ${err.message}. Trying next...`);
    }
  }
  return null;
}

/**
 * Persists one bucket's counter. Returns true only if the write actually landed.
 *
 * `httpRequest` resolves (rather than rejecting) on a non-2xx, and this function used to ignore
 * `result.ok` entirely - so every write silently failed and nothing was ever logged. It was
 * failing on every single call: `justLocked` (a control flag, not one of the collection's three
 * attributes) was passed straight through as a document field and Appwrite 400'd the payload, so
 * `rate_limits` held zero rows and this endpoint had no brute-force protection whatsoever (P0-4a).
 * Only `toPersistedState`'s three attributes are ever sent now, and a non-2xx is surfaced loudly.
 */
async function saveRateLimitState(endpoint, headers, docId, existed, state, log, error) {
  const data = toPersistedState(state);
  const report = (message) => {
    if (error) error(message);
    else if (log) log(message);
  };

  try {
    let result;
    if (existed) {
      result = await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents/${docId}`, 'PATCH', headers, { data });
    } else {
      result = await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents`, 'POST', headers, { documentId: docId, data });
      // 409: a concurrent execution created this bucket between our read and our write. That is
      // someone else's failed attempt, not a reason to drop ours.
      if (result.status === 409) {
        result = await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents/${docId}`, 'PATCH', headers, { data });
      }
    }

    if (!result.ok) {
      report(
        `RATE-LIMIT-WRITE-FAILED doc=${docId} via ${endpoint} [HTTP ${result.status}] ` +
          (typeof result.data === 'string' ? result.data : JSON.stringify(result.data))
      );
      return false;
    }
    return true;
  } catch (err) {
    report(`RATE-LIMIT-WRITE-FAILED doc=${docId} via ${endpoint}: ${err.message}`);
    return false;
  }
}

// An Appwrite older than 1.7 has no `.../{attribute}/increment` route at all; these are the
// statuses that mean "no such route" rather than "the write was rejected". Anything else from the
// increment is a genuine write failure and fails closed like any other.
const INCREMENT_UNSUPPORTED_STATUSES = [404, 405, 501];

/**
 * Records one failed attempt against one bucket and reports whether the counter actually moved.
 *
 * The counter increment is done SERVER-side (`PATCH .../documents/{id}/attempts/increment`, served
 * by Appwrite 1.7+; this instance runs 1.9.0) rather than as a read-modify-write. The old shape --
 * read `attempts`, add one in JS, write the successor back -- had no conditional write and no
 * version check, so a burst of concurrent executions all read the same value and all wrote the same
 * successor: fire 200 requests in parallel with 200 candidate PINs and every one of them reads
 * `attempts: 0`, passes the lockout check, tries its PIN, and writes back `attempts: 1`. Repeat and
 * the whole 4-digit space falls while the persisted counter never exceeds 1, no matter how the
 * bucket key is derived (P2-16). With a server-side increment, N concurrent failures persist as N.
 *
 * Two paths are still plain writes, because there is nothing to add to yet:
 *   - no row for this bucket -- create the opening counter. A concurrent creator wins the 409 and
 *     this attempt hands off to the increment instead of clobbering theirs with its own `1`.
 *   - the 15-minute window has aged out -- the counter starts over. Reachable at most once per
 *     window per bucket, so the race it leaves is bounded to a window rollover instead of being
 *     the steady state.
 *
 * @returns {Promise<{persisted: boolean, lockedUntil: string|null}>} `persisted: false` means the
 *   attempt left no trace, which the caller turns into a refusal (fail closed).
 */
async function recordFailureForBucket(endpoint, headers, bucket, now, log, error) {
  const collectionPath = `${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents`;
  const report = (message) => {
    if (error) error(message);
    else if (log) log(message);
  };

  const openingState = () => ({ attempts: 1, windowStart: new Date(now).toISOString(), lockedUntil: null });

  if (!bucket.state) {
    let created;
    try {
      created = await httpRequest(collectionPath, 'POST', headers, {
        documentId: bucket.id,
        data: toPersistedState(openingState()),
      });
    } catch (err) {
      report(`RATE-LIMIT-WRITE-FAILED doc=${bucket.id} via ${endpoint}: ${err.message}`);
      return { persisted: false, lockedUntil: null };
    }
    if (created.ok) return { persisted: true, lockedUntil: null };
    if (created.status !== 409) {
      report(
        `RATE-LIMIT-WRITE-FAILED doc=${bucket.id} via ${endpoint} [HTTP ${created.status}] ` +
          (typeof created.data === 'string' ? created.data : JSON.stringify(created.data))
      );
      return { persisted: false, lockedUntil: null };
    }
    // 409: another execution opened this bucket between our read and our write. Count against
    // theirs rather than replacing it.
  } else {
    const windowStartMs = Date.parse(bucket.state.windowStart);
    const windowIsLive = !isNaN(windowStartMs) && now - windowStartMs <= WINDOW_MS;
    if (!windowIsLive) {
      const persisted = await saveRateLimitState(endpoint, headers, bucket.id, true, openingState(), log, error);
      return { persisted, lockedUntil: null };
    }
  }

  let incremented;
  try {
    incremented = await httpRequest(`${collectionPath}/${bucket.id}/attempts/increment`, 'PATCH', headers, { value: 1 });
  } catch (err) {
    report(`RATE-LIMIT-INCREMENT-FAILED doc=${bucket.id} via ${endpoint}: ${err.message}`);
    return { persisted: false, lockedUntil: null };
  }

  if (!incremented.ok) {
    if (INCREMENT_UNSUPPORTED_STATUSES.includes(incremented.status)) {
      // Server predates the increment route. Fall back to the old read-modify-write so the limiter
      // still counts (racily) instead of failing the endpoint closed on every wrong PIN.
      if (log) log(`Rate-limit increment unsupported (HTTP ${incremented.status}); falling back to read-modify-write.`);
      const next = recordFailedAttempt(bucket.state, now, bucket.max);
      const persisted = await saveRateLimitState(endpoint, headers, bucket.id, !!bucket.state, next, log, error);
      return { persisted, lockedUntil: persisted && next.justLocked ? next.lockedUntil : null };
    }
    report(
      `RATE-LIMIT-INCREMENT-FAILED doc=${bucket.id} via ${endpoint} [HTTP ${incremented.status}] ` +
        (typeof incremented.data === 'string' ? incremented.data : JSON.stringify(incremented.data))
    );
    return { persisted: false, lockedUntil: null };
  }

  const attempts = Number(incremented.data && incremented.data.attempts);
  if (!Number.isFinite(attempts)) {
    // The write landed but we cannot read the resulting count, so we cannot tell whether this
    // caller is now over the line. Treated as unrecorded rather than assumed safe.
    report(`RATE-LIMIT-INCREMENT-FAILED doc=${bucket.id} via ${endpoint}: no attempts value in the response`);
    return { persisted: false, lockedUntil: null };
  }
  if (attempts < bucket.max) return { persisted: true, lockedUntil: null };

  const lockedUntil = new Date(now + LOCKOUT_MS).toISOString();
  const windowStart = (bucket.state && bucket.state.windowStart) || new Date(now).toISOString();
  const persisted = await saveRateLimitState(
    endpoint,
    headers,
    bucket.id,
    true,
    { attempts, windowStart, lockedUntil },
    log,
    error
  );
  return { persisted, lockedUntil: persisted ? lockedUntil : null };
}

function encodeQuery(method, values, attribute) {
  return encodeURIComponent(JSON.stringify({ method, attribute, values }));
}

/**
 * Looks up an active 'ticketing' PIN row matching the given hash in the shared `pins`
 * collection (managed by the admin app's Admin-GeneratePin function). Unlike the rate-limit
 * lookup above, this does NOT fail open -- if every endpoint is unreachable, the login is
 * rejected, since there is no way to verify a PIN without it.
 *
 * `preferredEndpoint` (the endpoint the rate-limit lookup above already found reachable, if
 * any) is tried first -- without this, every internal Docker candidate that 404s/times out
 * gets retried from scratch on top of the rate-limit lookup's own retries, and the combined
 * latency can blow past this function's timeout before ever reaching the real endpoint.
 */
async function findTicketingPin(headersBase, pinHash, log, preferredEndpoint) {
  const queryString = [
    encodeQuery('equal', ['ticketing'], 'system'),
    encodeQuery('equal', [pinHash], 'hash'),
    encodeQuery('equal', [true], 'active'),
    encodeQuery('limit', [1]),
  ]
    .map((q) => `queries[]=${q}`)
    .join('&');

  const allEndpoints = getAppwriteEndpoints();
  const endpointsToTry = preferredEndpoint
    ? [preferredEndpoint, ...allEndpoints.filter((e) => e !== preferredEndpoint)]
    : allEndpoints;

  for (const endpoint of endpointsToTry) {
    const headers = { ...headersBase };
    if (needsHostOverride(endpoint)) headers['Host'] = 'api.cloud.shotty.tech';

    try {
      const result = await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${PINS_COLLECTION_ID}/documents?${queryString}`, 'GET', headers);
      if (result.ok) {
        return { found: true, doc: (result.data.documents || [])[0] || null };
      }
      throw new Error(`[HTTP ${result.status}] ${JSON.stringify(result.data)}`);
    } catch (err) {
      if (log) log(`Pins lookup via ${endpoint} failed: ${err.message}. Trying next...`);
    }
  }
  return { found: false, doc: null };
}

module.exports = async function (context) {
  const req = context ? context.req : arguments[0];
  const res = context ? context.res : arguments[1];
  const log = context ? context.log : console.log;
  const error = context ? context.error : console.error;

  await ensureDnsPatched('api.cloud.shotty.tech');

  let payload = {};
  try {
    if (req.bodyRaw) {
      payload = JSON.parse(req.bodyRaw);
    } else if (typeof req.body === 'string' && req.body.trim()) {
      payload = JSON.parse(req.body);
    } else if (req.body) {
      payload = req.body;
    }
  } catch (e) {
    payload = {};
  }

  const submittedPin = String(payload.pin || '').trim();
  const quickAccessUserId = process.env.QUICK_ACCESS_USER_ID;

  if (!quickAccessUserId) {
    const msg = 'Quick access is not configured on the server (missing QUICK_ACCESS_USER_ID).';
    if (error) error(msg);
    return res.json({ error: msg }, 500);
  }
  if (!submittedPin) {
    return res.json({ error: 'Incorrect PIN' }, 401);
  }

  const apiKey = process.env.APPWRITE_API_KEY || (req.headers && req.headers['x-appwrite-key']);
  if (!apiKey) {
    const msg = 'APPWRITE_API_KEY environment variable is required.';
    if (error) error(msg);
    return res.json({ error: msg }, 500);
  }

  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID || '68f2ac7b00002e7563a8';
  const headersBase = { 'x-appwrite-project': projectId, 'x-appwrite-key': apiKey };

  const callerId = req.headers && req.headers['x-appwrite-user-id'];
  const ip = extractClientIp(req);
  const buckets = rateLimitBuckets(ip, callerId);
  const now = Date.now();

  const rateLimitLookup = await loadRateLimitState(headersBase, buckets.map((bucket) => bucket.id), log);
  if (rateLimitLookup) {
    for (const bucket of buckets) {
      bucket.state = rateLimitLookup.states[bucket.id] || null;
    }
    const lockedBucket = buckets.find((bucket) => checkLockout(bucket.state, now).locked);
    if (lockedBucket) {
      const retryAfterSec = Math.ceil(checkLockout(lockedBucket.state, now).retryAfterMs / 1000);
      if (log) log(`Quick access locked out (${lockedBucket.label} bucket) for ${ip} - ${retryAfterSec}s remaining.`);
      return res.json({ error: 'Too many incorrect PIN attempts. Please wait and try again.', retryAfterSeconds: retryAfterSec }, 429);
    }
  } else if (error) {
    error('RATE-LIMIT-UNAVAILABLE could not reach the rate_limits collection - a correct PIN will still be honoured, an incorrect one will be refused.');
  }

  const submittedPinHash = crypto.createHash('sha256').update(submittedPin).digest('hex');
  const pinLookup = await findTicketingPin(headersBase, submittedPinHash, log, rateLimitLookup ? rateLimitLookup.endpoint : null);
  if (!pinLookup.found) {
    const msg = 'Failed to verify PIN across all available endpoints.';
    if (error) error(msg);
    return res.json({ error: msg }, 500);
  }
  const pinIsValid = !!pinLookup.doc;

  if (!pinIsValid) {
    let persistedAll = !!rateLimitLookup;
    let locked = null;

    if (rateLimitLookup) {
      for (const bucket of buckets) {
        const { persisted, lockedUntil } = await recordFailureForBucket(
          rateLimitLookup.endpoint,
          rateLimitLookup.headers,
          bucket,
          now,
          log,
          error
        );
        persistedAll = persistedAll && persisted;
        if (lockedUntil && !locked) locked = { lockedUntil };
      }
    }

    // Fail CLOSED: if the counter could not be written, this attempt leaves no trace and the next
    // one starts from zero - i.e. this endpoint, which mints a session token for the shared
    // door-staff account on a 4-digit PIN, is running with no brute-force defence at all. Refusing
    // to answer turns a silent, permanent hole into a visible outage. A *correct* PIN is still
    // honoured above, so a database hiccup never locks real door staff out of the app.
    if (!persistedAll) {
      if (error) error('RATE-LIMIT-UNAVAILABLE refusing quick-access login: a failed attempt could not be recorded.');
      return res.json({ error: 'Quick access is temporarily unavailable. Please try again shortly.' }, 503);
    }

    if (locked) {
      if (log) log(`Quick access now locked out for ${ip} after repeated incorrect PIN attempts.`);
      return res.json({ error: 'Too many incorrect PIN attempts. Please wait and try again.', retryAfterSeconds: Math.ceil((Date.parse(locked.lockedUntil) - now) / 1000) }, 429);
    }
    return res.json({ error: 'Incorrect PIN' }, 401);
  }

  // Clear this caller's accumulated failures. Deliberately only the caller bucket: the shared-IP
  // backstop keeps counting (it expires on its own window), so one successful login can't wipe the
  // venue-wide evidence of a brute-force walk in progress from the same egress.
  if (rateLimitLookup && buckets[0].state) {
    await saveRateLimitState(rateLimitLookup.endpoint, rateLimitLookup.headers, buckets[0].id, true, resetState(), log, error);
  }

  const allEndpoints = getAppwriteEndpoints();
  const endpointsToTry = rateLimitLookup
    ? [rateLimitLookup.endpoint, ...allEndpoints.filter((e) => e !== rateLimitLookup.endpoint)]
    : allEndpoints;

  for (const endpoint of endpointsToTry) {
    try {
      const headers = { ...headersBase };
      if (needsHostOverride(endpoint)) headers['Host'] = 'api.cloud.shotty.tech';

      // Custom token: a short-lived, single-use secret the client exchanges for a real session
      // via POST /account/sessions/token. This never requires knowing the account's password.
      const result = await httpRequest(
        `${endpoint}/users/${quickAccessUserId}/tokens`,
        'POST',
        headers,
        { length: 6, expire: 60 },
        8000
      );

      if (result.ok && result.data && result.data.secret) {
        // Every ticketing PIN resolves to the same shared door-staff account, so the session
        // itself carries no attribution. Logging which PIN row minted it is the only per-
        // credential trail that exists - and the only handle for revocation after the fact, since
        // marking the row `active: false` does NOT end a session it already granted (P1-2: the
        // token's 60s expiry bounds the *token*, not the session the client exchanges it for).
        const matched = pinLookup.doc || {};
        if (log) log(`Issued quick-access session token via ${endpoint} for pin=${matched.$id || 'unknown'} label=${matched.label || 'unlabeled'}`);
        return res.json({ userId: result.data.userId, secret: result.data.secret });
      }

      throw new Error(`[HTTP ${result.status}] ${typeof result.data === 'string' ? result.data : JSON.stringify(result.data)}`);
    } catch (endpointErr) {
      if (log) log(`Endpoint ${endpoint} failed: ${endpointErr.message}. Trying next...`);
    }
  }

  const msg = 'Failed to issue quick-access session token across all available endpoints.';
  if (error) error(msg);
  return res.json({ error: msg }, 500);
};
