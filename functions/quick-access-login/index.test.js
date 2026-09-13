// quick-access-login is the project's other `execute: ["any"]` endpoint: a 4-digit PIN, no
// session required, and on success it mints a token for the shared door-staff account
// (QUICK_ACCESS_USER_ID) that holds `update("user:6aa201ec...")` on `tickets` -- i.e. the ability
// to flip any ticket to USED or void. It had no tests at all.
//
// Unlike the ESM functions, it talks to Appwrite over raw node http/https rather than the SDK, so
// there is no node-appwrite mock to lean on. Instead this suite stands up a fake Appwrite behind
// a mocked `https` module and drives the real httpRequest/endpoint-fallback code, with the
// `rate_limits` collection enforcing its real three-attribute schema -- a payload carrying
// anything else 400s here exactly as it does live, which is what P0-4a turned on.

jest.mock('dns', () => ({
	lookup: jest.fn(),
	promises: { resolve4: jest.fn().mockResolvedValue(['203.0.113.10']) },
}));
jest.mock('https', () => ({ request: jest.fn() }));

const { EventEmitter } = require('events');
const crypto = require('crypto');
const https = require('https');
const handler = require('./index.js');
const { makeContext } = require('../../test/helpers/handlerContext');

const QUICK_ACCESS_USER_ID = 'door-staff-user';
const RATE_LIMIT_ATTRIBUTES = ['attempts', 'windowStart', 'lockedUntil'];

const sha256 = (value) => crypto.createHash('sha256').update(String(value)).digest('hex');

/**
 * A fake Appwrite REST API. Routes on method+path the way the real one does, keeps `rate_limits`
 * documents in memory, and rejects an off-schema document payload with the same 400 the live
 * structure validator returns.
 */
function makeAppwrite({ pins = [], tokenStatus = 201, rateLimitWriteStatus = null } = {}) {
	const state = { rateLimits: {}, requests: [] };

	function handleRateLimitWrite(docId, data) {
		if (rateLimitWriteStatus) {
			return { status: rateLimitWriteStatus, body: { message: 'forced failure' } };
		}
		const unknown = Object.keys(data || {}).filter((key) => !RATE_LIMIT_ATTRIBUTES.includes(key));
		if (unknown.length > 0) {
			return {
				status: 400,
				body: { message: `Invalid document structure: Unknown attribute: "${unknown[0]}"`, type: 'document_invalid_structure' },
			};
		}
		state.rateLimits[docId] = { ...(state.rateLimits[docId] || {}), ...data, $id: docId };
		return { status: 200, body: state.rateLimits[docId] };
	}

	return {
		state,
		route(request) {
			state.requests.push(request);
			const { method, path, body } = request;

			const rateLimitDoc = path.match(/\/collections\/rate_limits\/documents\/([^/?]+)/);
			if (rateLimitDoc) {
				const docId = rateLimitDoc[1];
				if (method === 'GET') {
					return state.rateLimits[docId]
						? { status: 200, body: state.rateLimits[docId] }
						: { status: 404, body: { message: 'Document not found' } };
				}
				if (method === 'PATCH') return handleRateLimitWrite(docId, body.data);
			}
			if (method === 'POST' && /\/collections\/rate_limits\/documents$/.test(path)) {
				if (state.rateLimits[body.documentId] && !rateLimitWriteStatus) {
					return { status: 409, body: { message: 'Document already exists' } };
				}
				return handleRateLimitWrite(body.documentId, body.data);
			}

			if (method === 'GET' && /\/collections\/pins\/documents/.test(path)) {
				const queries = decodeQueries(path);
				const wanted = (attribute) => {
					const found = queries.find((query) => query.attribute === attribute);
					return found ? found.values[0] : undefined;
				};
				const documents = pins.filter(
					(pin) =>
						pin.system === wanted('system') && pin.hash === wanted('hash') && pin.active === wanted('active'),
				);
				return { status: 200, body: { total: documents.length, documents } };
			}

			if (method === 'POST' && new RegExp(`/users/${QUICK_ACCESS_USER_ID}/tokens$`).test(path)) {
				if (tokenStatus !== 201) return { status: tokenStatus, body: { message: 'token minting failed' } };
				return { status: 201, body: { userId: QUICK_ACCESS_USER_ID, secret: 'tok_secret_123' } };
			}

			return { status: 404, body: { message: `no route for ${method} ${path}` } };
		},
	};
}

function decodeQueries(path) {
	const search = path.slice(path.indexOf('?') + 1);
	return search
		.split('&')
		.filter((part) => part.startsWith('queries[]='))
		.map((part) => JSON.parse(decodeURIComponent(part.slice('queries[]='.length))));
}

function installAppwrite(appwrite) {
	https.request.mockImplementation((options, callback) => {
		const req = new EventEmitter();
		let written = '';
		req.write = (chunk) => {
			written += chunk;
		};
		req.destroy = (err) => req.emit('error', err);
		req.end = () => {
			setImmediate(() => {
				const outcome = appwrite.route({
					method: options.method,
					path: options.path,
					headers: options.headers,
					body: written ? JSON.parse(written) : null,
				});
				const res = new EventEmitter();
				res.statusCode = outcome.status;
				callback(res);
				setImmediate(() => {
					res.emit('data', JSON.stringify(outcome.body));
					res.emit('end');
				});
			});
		};
		return req;
	});
	return appwrite;
}

const activeTicketingPin = (pin, extra = {}) => ({
	$id: 'pin-door-1',
	system: 'ticketing',
	label: 'Door Staff',
	hash: sha256(pin),
	active: true,
	...extra,
});

const loginCtx = (pin, headers = {}) =>
	makeContext({ body: { pin }, headers: { 'x-forwarded-for': '10.0.0.5', ...headers } });

describe('quick-access-login', () => {
	beforeEach(() => {
		jest.clearAllMocks();
		process.env.QUICK_ACCESS_USER_ID = QUICK_ACCESS_USER_ID;
		process.env.APPWRITE_API_KEY = 'test-api-key';
		delete process.env.APPWRITE_FUNCTION_ENDPOINT;
	});

	describe('the PIN gate', () => {
		test('a correct, active ticketing PIN mints a session token', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ userId: QUICK_ACCESS_USER_ID, secret: 'tok_secret_123' });
		});

		test('a wrong PIN is rejected with 401 and no token is ever minted', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			const result = await handler(loginCtx('9999'));

			expect(result.statusCode).toBe(401);
			expect(result.body).toEqual({ error: 'Incorrect PIN' });
			expect(appwrite.state.requests.some((request) => request.path.includes('/tokens'))).toBe(false);
		});

		test('an empty PIN is rejected before anything is queried', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			const result = await handler(loginCtx(''));

			expect(result.statusCode).toBe(401);
			expect(appwrite.state.requests).toHaveLength(0);
		});

		test('a whitespace-only PIN cannot pass as a match', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('   ')] }));

			const result = await handler(loginCtx('   '));

			expect(result.statusCode).toBe(401);
		});

		test('the PIN is only ever sent as a sha256 hash', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			await handler(loginCtx('4321'));

			const pinsRequest = appwrite.state.requests.find((request) => request.path.includes('/collections/pins/'));
			expect(pinsRequest.path).toContain(sha256('4321'));
			expect(decodeURIComponent(pinsRequest.path)).not.toContain('"4321"');
		});

		test('the lookup is scoped to active system:ticketing rows only', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			await handler(loginCtx('4321'));

			const pinsRequest = appwrite.state.requests.find((request) => request.path.includes('/collections/pins/'));
			const queries = decodeQueries(pinsRequest.path);
			expect(queries).toEqual(
				expect.arrayContaining([
					{ method: 'equal', attribute: 'system', values: ['ticketing'] },
					{ method: 'equal', attribute: 'active', values: [true] },
				]),
			);
		});

		test('a revoked (active:false) PIN row no longer logs in', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321', { active: false })] }));

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(401);
		});

		test("a POS PIN (system:'pos') cannot be used on the door endpoint", async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321', { system: 'pos' })] }));

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(401);
		});

		test('an unreachable pins collection fails closed with 500, never a token', async () => {
			const appwrite = makeAppwrite({ pins: [activeTicketingPin('4321')] });
			const route = appwrite.route.bind(appwrite);
			appwrite.route = (request) => {
				if (request.path.includes('/collections/pins/')) return { status: 500, body: { message: 'db down' } };
				return route(request);
			};
			installAppwrite(appwrite);

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(500);
			expect(appwrite.state.requests.some((request) => request.path.includes('/tokens'))).toBe(false);
		});

		test('a token-minting failure surfaces as 500, not as a half-success', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')], tokenStatus: 500 }));

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(500);
			expect(result.body.secret).toBeUndefined();
		});

		test('a missing QUICK_ACCESS_USER_ID refuses to serve rather than guessing an account', async () => {
			delete process.env.QUICK_ACCESS_USER_ID;
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(500);
		});

		test('a missing API key refuses to serve', async () => {
			delete process.env.APPWRITE_API_KEY;
			const ctx = loginCtx('4321');
			ctx.req.headers['x-appwrite-key'] = undefined;
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
		});

		test('a malformed body is treated as no PIN, not as a crash', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));
			const ctx = loginCtx('4321');
			ctx.req.body = '{not json';

			const result = await handler(ctx);

			expect(result.statusCode).toBe(401);
		});

		test('the token is short-lived and single-use (length 6, expire 60)', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			await handler(loginCtx('4321'));

			const tokenRequest = appwrite.state.requests.find((request) => request.path.includes('/tokens'));
			expect(tokenRequest.body).toEqual({ length: 6, expire: 60 });
		});
	});

	describe('rate limiting', () => {
		// P0-4a: the counter document is written with EXACTLY the three attributes the collection
		// has. Before this, `justLocked` rode along in the payload, Appwrite 400'd every write,
		// `httpRequest` resolved (rather than threw) on the non-2xx, and nothing checked
		// `result.ok` -- so `rate_limits` stayed empty forever and this endpoint had no
		// brute-force protection at all.
		test('a failed attempt is actually stored, with only the collection’s three attributes', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			await handler(loginCtx('9999'));

			const writes = appwrite.state.requests.filter(
				(request) => request.method !== 'GET' && request.path.includes('/collections/rate_limits/'),
			);
			expect(writes.length).toBeGreaterThan(0);
			for (const write of writes) {
				expect(Object.keys(write.body.data).sort()).toEqual(['attempts', 'lockedUntil', 'windowStart']);
			}
			expect(Object.values(appwrite.state.rateLimits).some((row) => row.attempts === 1)).toBe(true);
		});

		test('the counter increments across executions', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			await handler(loginCtx('9999'));
			await handler(loginCtx('8888'));

			expect(Object.values(appwrite.state.rateLimits).some((row) => row.attempts === 2)).toBe(true);
		});

		test('five wrong PINs lock the caller out with 429', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			let result;
			for (let i = 0; i < 5; i++) {
				result = await handler(loginCtx('9999'));
			}

			expect(result.statusCode).toBe(429);
			expect(result.body.retryAfterSeconds).toBeGreaterThan(0);
		});

		test('a locked-out caller is refused before the PIN is even looked up -- a correct PIN will not clear it', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));
			for (let i = 0; i < 5; i++) {
				await handler(loginCtx('9999'));
			}
			appwrite.state.requests.length = 0;

			const result = await handler(loginCtx('4321'));

			expect(result.statusCode).toBe(429);
			expect(appwrite.state.requests.some((request) => request.path.includes('/collections/pins/'))).toBe(false);
			expect(appwrite.state.requests.some((request) => request.path.includes('/tokens'))).toBe(false);
		});

		test('a successful login clears the caller’s counter', async () => {
			const appwrite = installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			for (let i = 0; i < 3; i++) {
				await handler(loginCtx('9999'));
			}
			await handler(loginCtx('4321'));

			const callerRow = Object.entries(appwrite.state.rateLimits).find(([docId]) => docId.startsWith('qa_c_'))[1];
			expect(callerRow.attempts).toBe(0);
			expect(callerRow.lockedUntil).toBeNull();
		});

		// P0-4b: x-forwarded-for is a chain each proxy appends to, and Appwrite's createExecution
		// API lets a caller supply headers outright -- so the LEFTMOST element is attacker-authored.
		test('a spoofed leftmost x-forwarded-for cannot buy fresh attempts', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			let result;
			for (let i = 0; i < 5; i++) {
				result = await handler(loginCtx('9999', { 'x-forwarded-for': `1.2.3.${i}, 10.0.0.5` }));
			}

			expect(result.statusCode).toBe(429);
		});

		test('a chosen leftmost element cannot pin a lockout on somebody else’s bucket', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			for (let i = 0; i < 5; i++) {
				await handler(loginCtx('9999', { 'x-forwarded-for': '10.0.0.5, 203.0.113.9' }));
			}

			const result = await handler(loginCtx('4321', { 'x-forwarded-for': '10.0.0.5' }));

			expect(result.statusCode).toBe(200);
			expect(result.body.secret).toBe('tok_secret_123');
		});

		test('different trusted IPs keep independent budgets', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')] }));

			for (let i = 0; i < 5; i++) {
				await handler(loginCtx('9999', { 'x-forwarded-for': '198.51.100.7' }));
			}

			const result = await handler(loginCtx('9999', { 'x-forwarded-for': '10.0.0.5' }));

			expect(result.statusCode).toBe(401);
		});

		// Fail CLOSED: an attempt that cannot be counted is an attempt that does not exist, and
		// this endpoint mints door-staff sessions on a 4-digit PIN.
		test('a rate-limit WRITE failure refuses the login with 503 instead of answering 401', async () => {
			installAppwrite(makeAppwrite({ pins: [activeTicketingPin('4321')], rateLimitWriteStatus: 400 }));

			const result = await handler(loginCtx('9999'));

			expect(result.statusCode).toBe(503);
			expect(result.body.error).toMatch(/temporarily unavailable/i);
		});

		test('an unreachable rate-limit store refuses a wrong PIN but still honours a correct one', async () => {
			const appwrite = makeAppwrite({ pins: [activeTicketingPin('4321')] });
			const route = appwrite.route.bind(appwrite);
			appwrite.route = (request) => {
				if (request.path.includes('/collections/rate_limits/')) return { status: 500, body: { message: 'db down' } };
				return route(request);
			};
			installAppwrite(appwrite);

			expect((await handler(loginCtx('9999'))).statusCode).toBe(503);
			expect((await handler(loginCtx('4321'))).statusCode).toBe(200);
		});
	});
});
