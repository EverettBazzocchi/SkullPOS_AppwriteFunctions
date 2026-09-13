jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockUsers, resetAppwriteMocks } = require("node-appwrite");
const { mockStripe, resetStripeMocks } = require("stripe");
const handler = require("./main.js").default;
const { makeContext: makeRawContext } = require("../../../test/helpers/handlerContext");

const POS_TEAM_ID = "68ffcecc0026f78f0af8";
// Verified live on 2026-09-13 (`appwrite users list-memberships`): ShottyTicketing's shared door
// account is a confirmed member of the POS team, so it clears Appwrite's `execute` allowlist the
// same way a till does and no longer needs naming in the function's code.
const DOOR_STAFF_USER_ID = "6aa201ecd741fa3bb794";

// Every test below represents a real caller: a session-authenticated one that has already cleared
// the `execute` allowlist Appwrite enforces before this function is loaded, plus the
// platform-injected x-appwrite-key. The authorization tests drive the shortfalls explicitly.
function makeContext(opts = {}) {
	return makeRawContext({
		...opts,
		headers: { "x-appwrite-user-id": "pos-user", "x-appwrite-key": "dynamic-key", ...(opts.headers || {}) },
	});
}

describe("stripe-getConnectionToken", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		resetStripeMocks();
		process.env.testKey = "sk_test_fake";
		process.env.prodKey = "sk_live_fake";
	});

	test("SkullPOS's empty body defaults to live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body).toEqual({ secret: "tok_live", mode: "live" });
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("SkullPOS's { test: 'test' } shape selects test mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_test" });
		const ctx = makeContext({ body: { test: "test" } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("test");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
	});

	test("SkullPOS's omitted test flag selects live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: { register: "reader-1" } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("live");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("Ticketing's { isLive: true } shape selects live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: { isLive: true } });

		const result = await handler(ctx);

		expect(result.body).toEqual({ secret: "tok_live", mode: "live" });
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("Ticketing's { isLive: false } shape selects test mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_test" });
		const ctx = makeContext({ body: { isLive: false } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("test");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_test_fake");
	});

	test("Ticketing's { environment: 'live' } shape selects live mode", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: { environment: "live" } });

		const result = await handler(ctx);

		expect(result.body.mode).toBe("live");
		expect(mockStripe.lastConstructedWithKey).toBe("sk_live_fake");
	});

	test("an unparseable body falls back to live mode instead of throwing", async () => {
		mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
		const ctx = makeContext({ body: {} });
		ctx.req.body = "not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.mode).toBe("live");
	});

	test("a Stripe API failure returns a 500 with the error message", async () => {
		mockStripe.terminal.connectionTokens.create.mockRejectedValue(new Error("stripe down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body.error).toBe("stripe down");
	});

	// The one authorization decision this function still makes for itself. Appwrite enforces the
	// `execute` team allowlist before the function body runs, so a session caller has already been
	// proven to be a confirmed member of an allowed team; the only caller that gets past that list
	// is a project API key with execution.write, which carries no session user.
	describe("caller authorization -- refusing an API-key-only invocation", () => {
		test("refuses a call with no user session -- an API-key-only invocation", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeRawContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).toEqual({ error: "Unauthorized" });
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});

		// Appwrite sends x-appwrite-user-id with an empty value rather than omitting it when the
		// execution has no session user, so "" is the shape this actually arrives in.
		test("refuses an empty caller id as firmly as a missing one", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeRawContext({ body: {}, headers: { "x-appwrite-user-id": "", "x-appwrite-key": "dynamic-key" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).toEqual({ error: "Unauthorized" });
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});
	});

	// The incident of 2026-09-13 07:50 UTC: the guard re-derived team membership through the Users
	// API and refused with a 503 whenever that call could not answer, which took a live Terminal
	// reader offline. Each row below is a way that lookup used to fail or refuse. A session caller
	// has already cleared Appwrite's `execute` allowlist, so every row must still mint a token --
	// and in particular none of them may produce a 503.
	describe("a session caller is never turned away by an external lookup", () => {
		const userApiFailure = () => {
			// The literal error the live function logged, from a caller id the project's Users API
			// cannot resolve (a console-authenticated operator, say).
			const notFound = new Error("User with the requested ID could not be found.");
			notFound.code = 404;
			mockUsers.listMemberships.mockRejectedValue(notFound);
		};

		const hostileConditions = [
			["the caller id does not resolve as a project user", userApiFailure],
			["the Users API is down", () => mockUsers.listMemberships.mockRejectedValue(new Error("appwrite down"))],
			["the caller belongs to no team", () => mockUsers.listMemberships.mockResolvedValue({ memberships: [] })],
			[
				"the caller's membership is unconfirmed",
				() => mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: POS_TEAM_ID, confirm: false }] }),
			],
		];

		test.each(hostileConditions)("still mints a token when %s", async (_label, arrange) => {
			arrange();
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ secret: "tok_live", mode: "live" });
		});

		// Appwrite injects x-appwrite-key only for a function that declares scopes. Whether that
		// injection happened must not decide whether a till can take payment.
		test("still mints a token when no x-appwrite-key is injected", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeRawContext({ body: {}, headers: { "x-appwrite-user-id": "pos-user" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ secret: "tok_live", mode: "live" });
		});

		// The structural reason all of the above hold: the authorization path makes no outbound
		// call, so it has no failure mode to mishandle. Reintroducing a membership lookup here --
		// fail-closed or fail-open -- fails this test.
		test("decides authorization without consulting any external service", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeContext({ body: {} });

			await handler(ctx);

			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
		});

		test("serves the ShottyTicketing door account like any other session caller", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeContext({ body: {}, headers: { "x-appwrite-user-id": DOOR_STAFF_USER_ID } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.secret).toBe("tok_live");
		});
	});

	describe("server-side mode verification (P1-23)", () => {
		test("a missing key for the requested mode is a 500, not an opaque Stripe error", async () => {
			delete process.env.prodKey;
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("Stripe live key is not configured");
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});

		test("refuses to mint a test-mode token while telling the caller it is live", async () => {
			process.env.prodKey = "sk_test_oops";
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_test" });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("Stripe live key is misconfigured");
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});

		test("refuses a live key configured under testKey", async () => {
			process.env.testKey = "rk_live_oops";
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeContext({ body: { test: "test" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toBe("Stripe test key is misconfigured");
		});

		test("an unrecognized key format is passed through rather than blocking payments", async () => {
			process.env.prodKey = "legacy_key_with_no_mode_marker";
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(mockStripe.lastConstructedWithKey).toBe("legacy_key_with_no_mode_marker");
		});
	});
});
