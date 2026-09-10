/**
 * @file index.js
 * @description Appwrite Serverless Function: Quick Access Login
 *
 * Lets Door POS staff sign in with a short PIN instead of a password baked into the client app.
 * The PIN is compared against QUICK_ACCESS_PIN (an environment variable on this function - it is
 * never shipped to the client, unlike a hardcoded password would be). On a correct PIN, this
 * function mints a short-lived custom token for the shared door-staff account
 * (QUICK_ACCESS_USER_ID) via Appwrite's Users API and returns { userId, secret }. The client then
 * exchanges that token for a real session via POST /account/sessions/token.
 *
 * QUICK_ACCESS_REVIEWER_PIN is an optional second PIN accepted alongside the real one - a fixed
 * credential to hand to Stripe's app reviewer (see the "Fixed authentication code that remains
 * valid indefinitely" requirement in Stripe's Apps on Devices review guidelines), so real staff
 * PINs never need to be shared with or rotated because of a review.
 *
 * Failed attempts are throttled per source IP (see _shared/rateLimit.js) and persisted in the
 * 'rate_limits' collection, since a short PIN on a public endpoint is otherwise brute-forceable.
 *
 * Ported from ShottyTicketing's own standalone project, now that it shares SkullPOS's Appwrite
 * project: DB_ID points at the shared database's 'rate_limits' collection, and
 * QUICK_ACCESS_USER_ID names a fresh door-staff user created directly in the shared project
 * (Appwrite user ids are project-scoped, so Ticketing's old standalone door-staff account id
 * doesn't carry over).
 *
 * Required environment variables on this function:
 *   QUICK_ACCESS_PIN    - the PIN staff enter for quick access
 *   QUICK_ACCESS_USER_ID - the Appwrite user ID of the shared door-staff account
 *   QUICK_ACCESS_REVIEWER_PIN - optional, additional PIN reserved for Stripe's app reviewer
 *   APPWRITE_API_KEY - optional; falls back to the function's own per-execution dynamic key
 *     (req.headers['x-appwrite-key']), granted by this function's configured scopes
 *     (users.write, documents.read, documents.write)
 */

const http = require('http');
const https = require('https');
const crypto = require('crypto');
const { getAppwriteEndpoints, needsHostOverride } = require('./_shared/appwriteEndpoints');
const { checkLockout, recordFailedAttempt, resetState } = require('./_shared/rateLimit');

const DB_ID = '67c9ffd9003d68236514';
const RATE_LIMIT_COLLECTION = 'rate_limits';

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
 * of the raw IP format (IPv4, IPv6, or a comma-separated x-forwarded-for chain). */
function rateLimitDocId(ip) {
  return 'qa_' + crypto.createHash('sha1').update(ip).digest('hex').slice(0, 16);
}

function extractClientIp(req) {
  const forwarded = (req.headers && (req.headers['x-forwarded-for'] || req.headers['x-real-ip'])) || '';
  return String(forwarded).split(',')[0].trim() || 'unknown';
}

/**
 * Finds a reachable Appwrite endpoint and fetches the rate-limit doc for this key, if any.
 * Returns null (fail-open) if every endpoint is unreachable, so a DB hiccup never locks staff
 * out of the app entirely - the PIN check itself still uses the same trusted secret comparison.
 */
async function loadRateLimitState(headersBase, docId, log) {
  for (const endpoint of getAppwriteEndpoints()) {
    const headers = { ...headersBase };
    if (needsHostOverride(endpoint)) headers['Host'] = 'api.cloud.shotty.tech';

    try {
      const result = await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents/${docId}`, 'GET', headers);
      if (result.status === 404) {
        return { endpoint, headers, state: null };
      }
      if (result.ok) {
        return { endpoint, headers, state: result.data };
      }
      throw new Error(`[HTTP ${result.status}] ${JSON.stringify(result.data)}`);
    } catch (err) {
      if (log) log(`Rate-limit lookup via ${endpoint} failed: ${err.message}. Trying next...`);
    }
  }
  return null;
}

async function saveRateLimitState(endpoint, headers, docId, existed, data, log) {
  try {
    if (existed) {
      await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents/${docId}`, 'PATCH', headers, { data });
    } else {
      await httpRequest(`${endpoint}/databases/${DB_ID}/collections/${RATE_LIMIT_COLLECTION}/documents`, 'POST', headers, { documentId: docId, data });
    }
  } catch (err) {
    if (log) log(`Failed to persist rate-limit state via ${endpoint}: ${err.message}`);
  }
}

module.exports = async function (context) {
  const req = context ? context.req : arguments[0];
  const res = context ? context.res : arguments[1];
  const log = context ? context.log : console.log;
  const error = context ? context.error : console.error;

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
  const expectedPin = process.env.QUICK_ACCESS_PIN;
  const reviewerPin = process.env.QUICK_ACCESS_REVIEWER_PIN;
  const quickAccessUserId = process.env.QUICK_ACCESS_USER_ID;

  if (!expectedPin || !quickAccessUserId) {
    const msg = 'Quick access is not configured on the server (missing QUICK_ACCESS_PIN or QUICK_ACCESS_USER_ID).';
    if (error) error(msg);
    return res.json({ error: msg }, 500);
  }

  const apiKey = process.env.APPWRITE_API_KEY || (req.headers && req.headers['x-appwrite-key']);
  if (!apiKey) {
    const msg = 'APPWRITE_API_KEY environment variable is required.';
    if (error) error(msg);
    return res.json({ error: msg }, 500);
  }

  const projectId = process.env.APPWRITE_FUNCTION_PROJECT_ID || '68f2ac7b00002e7563a8';
  const headersBase = { 'x-appwrite-project': projectId, 'x-appwrite-key': apiKey };

  const ip = extractClientIp(req);
  const docId = rateLimitDocId(ip);
  const now = Date.now();

  const rateLimitLookup = await loadRateLimitState(headersBase, docId, log);
  if (rateLimitLookup) {
    const { locked, retryAfterMs } = checkLockout(rateLimitLookup.state, now);
    if (locked) {
      const retryAfterSec = Math.ceil(retryAfterMs / 1000);
      if (log) log(`Quick access locked out for ${ip} - ${retryAfterSec}s remaining.`);
      return res.json({ error: 'Too many incorrect PIN attempts. Please wait and try again.', retryAfterSeconds: retryAfterSec }, 429);
    }
  } else if (log) {
    log('⚠️ Could not reach Appwrite Database to check rate limit - proceeding without throttling for this request.');
  }

  const pinIsValid = !!submittedPin && (submittedPin === expectedPin || (!!reviewerPin && submittedPin === reviewerPin));

  if (!pinIsValid) {
    if (rateLimitLookup) {
      const nextState = recordFailedAttempt(rateLimitLookup.state, now);
      await saveRateLimitState(rateLimitLookup.endpoint, rateLimitLookup.headers, docId, !!rateLimitLookup.state, nextState, log);
      if (nextState.justLocked) {
        if (log) log(`Quick access now locked out for ${ip} after repeated incorrect PIN attempts.`);
        return res.json({ error: 'Too many incorrect PIN attempts. Please wait and try again.', retryAfterSeconds: Math.ceil((Date.parse(nextState.lockedUntil) - now) / 1000) }, 429);
      }
    }
    return res.json({ error: 'Incorrect PIN' }, 401);
  }

  if (rateLimitLookup && rateLimitLookup.state) {
    await saveRateLimitState(rateLimitLookup.endpoint, rateLimitLookup.headers, docId, true, resetState(), log);
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
        if (log) log(`Issued quick-access session token via ${endpoint}`);
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
