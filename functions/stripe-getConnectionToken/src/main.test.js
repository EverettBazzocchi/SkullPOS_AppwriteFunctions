jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockUsers, resetAppwriteMocks } = require("node-appwrite");
const { mockStripe, resetStripeMocks } = require("stripe");
const handler = require("./main.js").default;
const { makeContext: makeRawContext } = require("../../../test/helpers/handlerContext");

const POS_TEAM_ID = "68ffcecc0026f78f0af8";
const ADMIN_TEAM_ID = "68e35aed00144b8cde9d";

// Every test below represents a real till: a session-authenticated caller, the
// platform-injected x-appwrite-key (which Appwrite only supplies once the
// function declares the users.read scope), and a confirmed POS-team
// membership. Anything less than that is refused now, so the authorization
// tests below drive the shortfalls explicitly.
function makeContext(opts = {}) {
	mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: POS_TEAM_ID, confirm: true }] });
	return makeRawContext({
		...opts,
		headers: { "x-appwrite-user-id": "pos-user", "x-appwrite-key": "dynamic-key", ...(opts.headers || {}) },
	});
}

function makeTeamCheckedContext(memberships, opts = {}) {
	mockUsers.listMemberships.mockResolvedValue({ memberships });
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

	describe("caller authorization (P0-10)", () => {
		test("refuses a call with no user session -- an API-key-only invocation", async () => {
			const ctx = makeRawContext({ body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(result.body).toEqual({ error: "Unauthorized" });
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});

		test("refuses a session that is in none of the allowed teams -- the anonymous-session case", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeTeamCheckedContext([], { body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});

		test("refuses a membership that has not been confirmed", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeTeamCheckedContext([{ teamId: POS_TEAM_ID, confirm: false }], { body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
		});

		test("allows a confirmed member of an allowed team", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeTeamCheckedContext([{ teamId: ADMIN_TEAM_ID, confirm: true }], { body: {} });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.secret).toBe("tok_live");
		});

		test("allows the ShottyTicketing door account, which belongs to no team", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeTeamCheckedContext([], { body: {}, headers: { "x-appwrite-user-id": "6aa201ecd741fa3bb794" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
		});

		// The two "the check couldn't run" states. Both used to return true --
		// and with this function's scopes empty, the first one was every single
		// request in production, so the gate never refused anybody (P0-10).
		test("a Users API failure refuses rather than minting a live token unverified", async () => {
			mockUsers.listMemberships.mockRejectedValue(new Error("appwrite down"));
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeRawContext({
				body: {},
				headers: { "x-appwrite-user-id": "pos-user", "x-appwrite-key": "dynamic-key" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
			expect(ctx.error).toHaveBeenCalled();
		});

		test("no injected x-appwrite-key refuses, and names the missing scope in the log", async () => {
			mockStripe.terminal.connectionTokens.create.mockResolvedValue({ secret: "tok_live" });
			const ctx = makeRawContext({ body: {}, headers: { "x-appwrite-user-id": "anonymous-session" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(mockStripe.terminal.connectionTokens.create).not.toHaveBeenCalled();
			expect(ctx.error).toHaveBeenCalledWith(expect.stringMatching(/users\.read/));
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
