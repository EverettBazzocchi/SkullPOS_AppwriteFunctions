jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockUsers, resetAppwriteMocks } = require("node-appwrite");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");
const { MAX_SENDS } = require("./sendLimit.js");

const ADMIN_TEAM_ID = "68e35aed00144b8cde9d";
const PIN_PAYMENT_TEAM_ID = "6a9cbb1c95ea7d59dd8c";
const DATABASE_ID = "67c9ffd9003d68236514";
const TRANSACTIONS_COLLECTION_ID = "68e4cd3500179ce661c6";
const RATE_LIMIT_COLLECTION_ID = "rate_limits";

const baseTransaction = (overrides = {}) => ({
	$id: "transaction1234567890",
	$createdAt: "2026-01-01T12:00:00.000Z",
	status: "complete",
	cart: JSON.stringify([{ name: "Beer", quantity: 2, price: 700 }]),
	total: 1400,
	discount: 0,
	tip: 0,
	payments: JSON.stringify([{ method: "cash", amount: 1400 }]),
	...overrides,
});

// getDocument now serves two collections -- the transaction itself and the caller's send counter
// in `rate_limits` -- so route by collection id rather than a single blanket mockResolvedValue.
// `sendState: null` is the normal case (no counter document yet), which the real API answers with
// a 404.
function mockDocuments({ transaction = baseTransaction(), transactionError = null, sendState = null } = {}) {
	mockDatabases.getDocument.mockImplementation((databaseId, collectionId) => {
		if (collectionId === RATE_LIMIT_COLLECTION_ID) {
			if (!sendState) {
				const notFound = new Error("Document not found");
				notFound.code = 404;
				return Promise.reject(notFound);
			}
			return Promise.resolve(sendState);
		}
		if (transactionError) return Promise.reject(transactionError);
		return Promise.resolve(transaction);
	});
}

function transactionWasRead() {
	return mockDatabases.getDocument.mock.calls.some((call) => call[1] === TRANSACTIONS_COLLECTION_ID);
}

// A real caller is a PIN-verified till (an anonymous account Verify-Pin joined to the PIN Payment
// Access team) or an admin-app session, executing with the platform-injected key. These tests
// used to pass no headers at all -- that unauthenticated caller is exactly the one this function
// now refuses, so every case that is not *about* authorization uses this helper.
function tillContext(body, userId = "pos-device-1") {
	return makeContext({
		body,
		headers: { "x-appwrite-user-id": userId, "x-appwrite-key": "injected-key" },
	});
}

function grantMembership(teamId = PIN_PAYMENT_TEAM_ID) {
	mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId, confirm: true }] });
}

function mockResendSuccess() {
	mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
}

describe("Transaction-EmailReceipt", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		mockFetch.mockReset();
		grantMembership();
		process.env.RESEND_API_KEY = "re_test_key";
	});

	test("sends a receipt for a completed transaction", async () => {
		mockDocuments();
		mockResendSuccess();
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		expect(mockFetch).toHaveBeenCalledWith(
			"https://api.resend.com/emails",
			expect.objectContaining({
				method: "POST",
				headers: expect.objectContaining({ Authorization: "Bearer re_test_key" }),
			}),
		);
		const [, options] = mockFetch.mock.calls[0];
		const sentBody = JSON.parse(options.body);
		expect(sentBody.from).toBe("SkullPOS <SkullPOS@mail.shotty.tech>");
		expect(sentBody.to).toEqual(["customer@example.com"]);
		expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		expect(sentBody.cc).toBeUndefined();
		expect(sentBody.html).toContain("Beer");
		expect(sentBody.html).toContain("$14.00");
		expect(sentBody.html).toContain("admin@skullspace.ca");
	});

	// Guards the deliberate change away from the standing everett CC: the admin can still be
	// replied to, but no copy of a customer's receipt is delivered to that inbox. A future edit
	// that quietly reinstates the copy fails here.
	test("never puts the admin address in cc", async () => {
		mockDocuments();
		mockResendSuccess();
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		await handler(ctx);

		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.cc || []).not.toContain("everett.bazzocchi@skullspace.ca");
		expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
	});

	test("sends a receipt for a refunded transaction, noting the refund", async () => {
		mockDocuments({ transaction: baseTransaction({ status: "refunded" }) });
		mockResendSuccess();
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.html).toMatch(/refunded/i);
	});

	test("rejects a pending transaction -- nothing to receipt yet", async () => {
		mockDocuments({ transaction: baseTransaction({ status: "pending" }) });
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(result.body.error).toMatch(/completed or refunded/i);
	});

	test("rejects a cancelled transaction", async () => {
		mockDocuments({ transaction: baseTransaction({ status: "cancelled" }) });
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("rejects a missing transactionId", async () => {
		mockDocuments();
		const ctx = tillContext({ email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.getDocument).not.toHaveBeenCalled();
	});

	test.each(["", "not-an-email", "missing-at-sign.com", "no-domain@"])(
		"rejects an invalid email (%p)",
		async (email) => {
			mockDocuments();
			const ctx = tillContext({ transactionId: "t1", email });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		},
	);

	test("invalid JSON request body is rejected with 400", async () => {
		const ctx = tillContext({});
		ctx.req.body = "{not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("404s when the transaction doesn't exist", async () => {
		mockDocuments({ transactionError: new Error("not found") });
		const ctx = tillContext({ transactionId: "missing", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
	});

	test("surfaces a 500 when Resend rejects the request", async () => {
		mockDocuments();
		mockFetch.mockResolvedValue({ ok: false, status: 422, text: () => Promise.resolve("bad request") });
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	test("surfaces a 500 when the network call itself throws", async () => {
		mockDocuments();
		mockFetch.mockRejectedValue(new Error("network down"));
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	test("a legacy transaction (no payments array) still builds a receipt via the fallback derivation", async () => {
		mockDocuments({ transaction: baseTransaction({ payments: null, stripe_id: "pi_legacy", payment_due: 1400 }) });
		mockResendSuccess();
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.html).toContain("Card");
	});

	test("a legacy transaction shows the real card amount, not $0.00, even when payment_due was left at 0", async () => {
		// The actual bug: a completed legacy transaction's payment_due had gone stale at 0 --
		// the receipt must still show the real (non-zero) amount, derived from `total`.
		mockDocuments({ transaction: baseTransaction({ payments: null, stripe_id: "pi_legacy", total: 1400, payment_due: 0 }) });
		mockResendSuccess();
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		await handler(ctx);

		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.html).toContain("Card");
		expect(sentBody.html).not.toContain("$0.00");
		expect(sentBody.html).toContain("$14.00");
	});

	test("malformed cart JSON doesn't crash -- renders with no line items", async () => {
		mockDocuments({ transaction: baseTransaction({ cart: "{not valid json" }) });
		mockResendSuccess();
		const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
	});

	// The one authorization decision this function still makes for itself. Appwrite enforces the
	// `execute` team allowlist before the function body runs, so a session caller has already been
	// proven to be a confirmed member of an allowed team; the only caller that gets past that list
	// is a project API key with execution.write, which carries no session user.
	describe("caller authorization -- refusing an API-key-only invocation", () => {
		test("no caller id at all (a raw API-key invocation) is refused", async () => {
			mockDocuments();
			mockResendSuccess();
			const ctx = makeContext({ body: { transactionId: "t1", email: "attacker@example.com" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
			expect(transactionWasRead()).toBe(false);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		// Appwrite sends x-appwrite-user-id with an empty value rather than omitting it when the
		// execution has no session user, so "" is the shape this actually arrives in.
		test("an empty caller id is refused as firmly as a missing one", async () => {
			mockDocuments();
			mockResendSuccess();
			const ctx = makeContext({
				body: { transactionId: "t1", email: "attacker@example.com" },
				headers: { "x-appwrite-user-id": "", "x-appwrite-key": "injected-key" },
			});

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(transactionWasRead()).toBe(false);
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	// The incident of 2026-09-13: the guard re-derived team membership through the Users API and
	// refused with a 503 whenever that call could not answer. This function still calls the Users
	// API, but only to decide the admin EXEMPTIONS -- never whether the caller may be served -- so
	// every row below must still send the receipt, and none of them may produce a 503.
	describe("a session caller is never turned away by an external lookup", () => {
		const hostileConditions = [
			[
				"the caller id does not resolve as a project user",
				() => {
					// The literal error the live function logged.
					const notFound = new Error("User with the requested ID could not be found.");
					notFound.code = 404;
					mockUsers.listMemberships.mockRejectedValue(notFound);
				},
			],
			["the Users API is down", () => mockUsers.listMemberships.mockRejectedValue(new Error("users api down"))],
			["the caller belongs to no team", () => mockUsers.listMemberships.mockResolvedValue({ memberships: [] })],
			[
				"the caller's membership is unconfirmed",
				() => mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: PIN_PAYMENT_TEAM_ID, confirm: false }] }),
			],
		];

		test.each(hostileConditions)("still sends the receipt when %s", async (_label, arrange) => {
			arrange();
			mockDocuments();
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			expect(JSON.parse(mockFetch.mock.calls[0][1].body).to).toEqual(["customer@example.com"]);
		});

		// Appwrite injects x-appwrite-key only for a function that declares scopes. Whether that
		// injection happened must not decide whether a till can hand a customer their receipt.
		test("still sends the receipt when no x-appwrite-key is injected", async () => {
			mockDocuments();
			mockResendSuccess();
			const ctx = makeContext({
				body: { transactionId: "t1", email: "customer@example.com" },
				headers: { "x-appwrite-user-id": "pos-device-1" },
			});

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			expect(mockUsers.listMemberships).not.toHaveBeenCalled();
		});

		// A caller the admin lookup could not classify is treated as an ordinary till -- which means
		// the send cap still applies to them. Degraded privilege, not a refusal.
		test("a caller the admin lookup could not classify is still counted against the send cap", async () => {
			mockUsers.listMemberships.mockRejectedValue(new Error("users api down"));
			mockDocuments();
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			await handler(ctx);

			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				DATABASE_ID,
				RATE_LIMIT_COLLECTION_ID,
				expect.stringMatching(/^rcp_/),
				expect.objectContaining({ attempts: 1 }),
			);
		});
	});

	describe("recipient binding", () => {
		test("a sale attached to a member can only be receipted to the address on the sale", async () => {
			mockDocuments({ transaction: baseTransaction({ member_email: "alice@example.com" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "attacker@example.com" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("the member's own address is accepted, case-insensitively", async () => {
			mockDocuments({ transaction: baseTransaction({ member_email: "Alice@Example.com" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "alice@example.com" });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			expect(JSON.parse(mockFetch.mock.calls[0][1].body).to).toEqual(["alice@example.com"]);
		});

		test("a walk-up sale names nobody, so the address typed at the till is still used", async () => {
			mockDocuments({ transaction: baseTransaction({ member_email: "" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
		});

		test("an admin may redirect a member's receipt (they can read the sale anyway)", async () => {
			grantMembership(ADMIN_TEAM_ID);
			mockDocuments({ transaction: baseTransaction({ member_email: "alice@example.com" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "alice-new@example.com" }, "admin-1");

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
		});

		// The admin exemption is the one thing still derived from a membership, so `confirm` still
		// has to mean something here: an invitation that was never accepted is not an admin.
		test("an unconfirmed admin membership does not grant the redirect exemption", async () => {
			mockUsers.listMemberships.mockResolvedValue({ memberships: [{ teamId: ADMIN_TEAM_ID, confirm: false }] });
			mockDocuments({ transaction: baseTransaction({ member_email: "alice@example.com" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "alice-new@example.com" }, "admin-1");

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		// The deliberate residual of deciding admin status from a lookup that may fail. An admin
		// mid-outage falls back to the safe default -- the address the sale already names -- instead
		// of the endpoint going down. The send itself still works (below), only the redirect does
		// not; if this ever needs to change, change it here and not by making the guard fail closed.
		test("an admin cannot redirect a member receipt while the admin lookup is failing", async () => {
			mockUsers.listMemberships.mockRejectedValue(new Error("users api down"));
			mockDocuments({ transaction: baseTransaction({ member_email: "alice@example.com" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "alice-new@example.com" }, "admin-1");

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("but the same failing lookup still lets that receipt go to the address on the sale", async () => {
			mockUsers.listMemberships.mockRejectedValue(new Error("users api down"));
			mockDocuments({ transaction: baseTransaction({ member_email: "alice@example.com" }) });
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "alice@example.com" }, "admin-1");

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
		});
	});

	describe("send quota", () => {
		test("a successful send is counted against the calling device", async () => {
			mockDocuments();
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			await handler(ctx);

			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				DATABASE_ID,
				RATE_LIMIT_COLLECTION_ID,
				expect.stringMatching(/^rcp_/),
				{ attempts: 1, windowStart: expect.any(String), lockedUntil: null },
			);
		});

		test("a caller at the cap is refused before the transaction is even read", async () => {
			mockDocuments({
				sendState: { attempts: MAX_SENDS, windowStart: new Date().toISOString(), lockedUntil: null },
			});
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "attacker@example.com" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(429);
			expect(mockFetch).not.toHaveBeenCalled();
			expect(transactionWasRead()).toBe(false);
		});

		test("an existing counter inside the window is incremented, not replaced", async () => {
			mockDocuments({
				sendState: { attempts: 3, windowStart: new Date(Date.now() - 60 * 1000).toISOString(), lockedUntil: null },
			});
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			await handler(ctx);

			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				DATABASE_ID,
				RATE_LIMIT_COLLECTION_ID,
				expect.stringMatching(/^rcp_/),
				expect.objectContaining({ attempts: 4 }),
			);
		});

		test("two different devices are counted independently", async () => {
			mockDocuments();
			mockResendSuccess();

			await handler(tillContext({ transactionId: "t1", email: "a@example.com" }, "pos-device-1"));
			await handler(tillContext({ transactionId: "t1", email: "b@example.com" }, "pos-device-2"));

			const [firstId, secondId] = mockDatabases.createDocument.mock.calls.map((call) => call[2]);
			expect(firstId).not.toBe(secondId);
		});

		// The send is reserved before the mail goes out. Counting afterwards could not enforce
		// anything: the mail is already gone by the time the counter is touched, so a caller whose
		// writes fail sends without limit -- which is exactly the state this shipped in. One slot
		// per Resend failure is the price of a cap that actually holds.
		test("the send is counted before Resend is called, not after", async () => {
			mockDocuments();
			mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("boom") });
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(mockDatabases.createDocument).toHaveBeenCalledWith(
				DATABASE_ID,
				RATE_LIMIT_COLLECTION_ID,
				expect.stringMatching(/^rcp_/),
				expect.objectContaining({ attempts: 1 }),
			);
		});

		test("an admin is not quota-limited", async () => {
			grantMembership(ADMIN_TEAM_ID);
			mockDocuments({
				sendState: { attempts: MAX_SENDS, windowStart: new Date().toISOString(), lockedUntil: null },
			});
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" }, "admin-1");

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("a send that cannot be counted is not sent", async () => {
			mockDocuments();
			mockDatabases.createDocument.mockRejectedValue(new Error("no documents.write scope"));
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(mockFetch).not.toHaveBeenCalled();
			expect(ctx.error).toHaveBeenCalledWith(expect.stringContaining("documents.write"));
		});

		test("a counter that cannot be read is refused before the transaction is read", async () => {
			const unreadable = new Error("rate_limits unavailable");
			unreadable.code = 500;
			mockDocuments();
			mockDatabases.getDocument.mockRejectedValue(unreadable);
			mockResendSuccess();
			const ctx = tillContext({ transactionId: "t1", email: "customer@example.com" });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(503);
			expect(mockFetch).not.toHaveBeenCalled();
			expect(transactionWasRead()).toBe(false);
		});
	});
});
