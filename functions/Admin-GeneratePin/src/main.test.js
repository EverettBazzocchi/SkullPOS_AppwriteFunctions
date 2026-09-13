jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { hashPin } = require("./main.js");
const { makeContext } = require("../../../test/helpers/handlerContext");

// Every call the admin app makes carries a real session, so Appwrite stamps x-appwrite-user-id on
// the request. A call WITHOUT it is, by construction, a project-API-key execution that walked past
// the team execute allowlist -- which is what the guard in main.js refuses (P2-12). Tests of the
// function's actual behaviour therefore go through here; the refusal itself is tested separately
// with a bare makeContext.
const adminCtx = ({ body = {}, headers = {} } = {}) =>
	makeContext({ body, headers: { "x-appwrite-user-id": "admin-user-1", ...headers } });

describe("Admin-GeneratePin", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		// Both pin pools are empty unless a test says otherwise, so every candidate is unique.
		mockDatabases.listDocuments.mockResolvedValue({ total: 0, documents: [] });
	});

	test("hashPin matches the exact digest every other copy of it in the estate produces", () => {
		// Golden vector, not a shape check. Verify-Pin (src/main.js), quick-access-login
		// (index.js, inline) and SkullAdminApp (bartenderService.ts, via expo-crypto) each
		// re-implement this; they are bound together only by producing this exact string.
		expect(hashPin("1234")).toBe("03ac674216f3e15c761ee1a5e255f067953623c8b388b4459e13f978d7c846f4");
		expect(hashPin("0000")).toBe("9af15b336e6a9619928537df30b2e6a2376569fcf9d7e773eccede65606529a0");
	});

	describe("create", () => {
		test("creates a pins row with a hashed 4-digit code and returns the raw code once", async () => {
			mockDatabases.createDocument.mockResolvedValue({ $id: "pin1" });
			const ctx = adminCtx({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.pinId).toBe("pin1");
			expect(result.body.label).toBe("Bartender");
			expect(result.body.system).toBe("pos");
			expect(result.body.pin).toMatch(/^\d{4}$/);

			const [, , , data] = mockDatabases.createDocument.mock.calls[0];
			expect(data.system).toBe("pos");
			expect(data.label).toBe("Bartender");
			expect(data.active).toBe(true);
			// the hash is still stored for verification, and the raw pin is now ALSO stored
			// (encrypted at rest) so the admin app can show it persistently, not just once.
			expect(data.hash).not.toBe(result.body.pin);
			expect(data.hash).toMatch(/^[0-9a-f]{64}$/);
			expect(data.pin).toBe(result.body.pin);
		});

		test("checks the candidate hash against BOTH pin pools before writing", async () => {
			mockDatabases.createDocument.mockResolvedValue({ $id: "pin1" });
			const ctx = adminCtx({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			const collectionsQueried = mockDatabases.listDocuments.mock.calls.map((call) => call[1]);
			expect(collectionsQueried).toEqual(expect.arrayContaining(["pins", "bartenders"]));
			// and it looked for the hash it was about to store, not something else
			const expectedHash = hashPin(result.body.pin);
			for (const [, , queries] of mockDatabases.listDocuments.mock.calls) {
				expect(queries.some((q) => q.includes(expectedHash))).toBe(true);
			}
		});

		test("re-rolls when the candidate hash is already used by a bartender pin", async () => {
			// Verify-Pin matches on hash after a system/active filter, so a bartender pin that
			// collides with a `pos` pin authenticates as the pos row -- her sales go unattributed
			// and the event-window restriction is never evaluated. The collision must never be
			// written in the first place.
			let call = 0;
			mockDatabases.listDocuments.mockImplementation((db, collectionId) => {
				call += 1;
				// first candidate: the bartenders lookup (2nd call of the first pair) hits
				if (call === 2) return Promise.resolve({ total: 1, documents: [{ $id: "bt1" }] });
				return Promise.resolve({ total: 0, documents: [] });
			});
			mockDatabases.createDocument.mockResolvedValue({ $id: "pin1" });
			const ctx = adminCtx({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			// two rounds of (pins + bartenders) lookups -- the first candidate was discarded
			expect(mockDatabases.listDocuments).toHaveBeenCalledTimes(4);
			const [, , , data] = mockDatabases.createDocument.mock.calls[0];
			expect(data.hash).toBe(hashPin(result.body.pin));
		});

		test("fails loudly rather than issuing a colliding pin when every candidate is taken", async () => {
			mockDatabases.listDocuments.mockResolvedValue({ total: 1, documents: [{ $id: "taken" }] });
			const ctx = adminCtx({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(result.body.error).toMatch(/unique pin/i);
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
		});

		test("rejects an invalid system", async () => {
			const ctx = adminCtx({ body: { action: "create", system: "bogus", label: "X" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
		});

		test("rejects a missing label", async () => {
			const ctx = adminCtx({ body: { action: "create", system: "pos" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
		});
	});

	describe("regenerate", () => {
		test("looks up the existing row, writes a new hash, and returns the new raw code", async () => {
			mockDatabases.getDocument.mockResolvedValue({ $id: "pin1", system: "ticketing", label: "Door Staff" });
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = adminCtx({ body: { action: "regenerate", pinId: "pin1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({
				pinId: "pin1",
				pin: expect.stringMatching(/^\d{4}$/),
				label: "Door Staff",
				system: "ticketing",
			});
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(
				expect.any(String),
				"pins",
				"pin1",
				expect.objectContaining({
					active: true,
					hash: expect.stringMatching(/^[0-9a-f]{64}$/),
					pin: expect.stringMatching(/^\d{4}$/),
				})
			);
		});

		test("re-rolls off a hash held by another pins row, but not off the row being regenerated", async () => {
			mockDatabases.getDocument.mockResolvedValue({ $id: "pin1", system: "pos", label: "Till" });
			mockDatabases.updateDocument.mockResolvedValue({});
			// Every pins lookup comes back holding pin1 itself -- which is not a collision, so
			// this must settle on the first candidate rather than burning all 12 attempts.
			mockDatabases.listDocuments.mockImplementation((db, collectionId) =>
				collectionId === "pins"
					? Promise.resolve({ total: 1, documents: [{ $id: "pin1" }] })
					: Promise.resolve({ total: 0, documents: [] })
			);
			const ctx = adminCtx({ body: { action: "regenerate", pinId: "pin1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(mockDatabases.listDocuments).toHaveBeenCalledTimes(2);
			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.hash).toBe(hashPin(result.body.pin));
		});

		test("refuses to regenerate onto a hash another row already holds", async () => {
			mockDatabases.getDocument.mockResolvedValue({ $id: "pin1", system: "pos", label: "Till" });
			mockDatabases.updateDocument.mockResolvedValue({});
			mockDatabases.listDocuments.mockResolvedValue({ total: 1, documents: [{ $id: "someone-else" }] });
			const ctx = adminCtx({ body: { action: "regenerate", pinId: "pin1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("404s when the pin doesn't exist", async () => {
			mockDatabases.getDocument.mockRejectedValue(new Error("not found"));
			const ctx = adminCtx({ body: { action: "regenerate", pinId: "missing" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});

		test("rejects a missing pinId", async () => {
			const ctx = adminCtx({ body: { action: "regenerate" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});
	});

	describe("revoke", () => {
		// P2-10: revoking used to write `{ active: false }` alone, so the working 4-digit code stayed
		// in `pin` indefinitely -- a code revoked *because it leaked* remained readable, and
		// flipping `active` back on re-armed it. The plaintext is destroyed as part of revoking.
		test("sets active:false AND scrubs the stored plaintext on the target row", async () => {
			mockDatabases.updateDocument.mockResolvedValue({});
			const ctx = adminCtx({ body: { action: "revoke", pinId: "pin1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body.ok).toBe(true);
			expect(mockDatabases.updateDocument).toHaveBeenCalledWith(expect.any(String), "pins", "pin1", {
				active: false,
				pin: null,
			});
		});

		test("revoking never leaves a readable code behind in the payload", async () => {
			mockDatabases.updateDocument.mockResolvedValue({});

			await handler(adminCtx({ body: { action: "revoke", pinId: "pin1" } }));

			const [, , , data] = mockDatabases.updateDocument.mock.calls[0];
			expect(data.pin).toBeNull();
			expect(Object.values(data).some((value) => typeof value === "string" && /^\d{4}$/.test(value))).toBe(false);
		});

		test("404s when the pin doesn't exist", async () => {
			mockDatabases.updateDocument.mockRejectedValue(new Error("not found"));
			const ctx = adminCtx({ body: { action: "revoke", pinId: "missing" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});

		test("rejects a missing pinId", async () => {
			const ctx = adminCtx({ body: { action: "revoke" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});
	});

	// P2-12: the team execute allowlist is not the whole defence. A project API key holding
	// `execution.write` invokes any function regardless of that allowlist, and a successful call
	// here returns a working 4-digit PIN in the response body. Appwrite only stamps
	// x-appwrite-user-id on a session-authenticated execution, so its absence is exactly the
	// key-only case.
	describe("caller identity", () => {
		test("refuses a call carrying no caller identity, before touching the database", async () => {
			const ctx = makeContext({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(403);
			expect(mockDatabases.createDocument).not.toHaveBeenCalled();
			expect(mockDatabases.listDocuments).not.toHaveBeenCalled();
		});

		test("the refusal never leaks a pin in its body", async () => {
			const ctx = makeContext({ body: { action: "create", system: "pos", label: "Bartender" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ error: "Unauthorized" });
		});

		test("revoke and regenerate are gated too, not just create", async () => {
			mockDatabases.updateDocument.mockResolvedValue({});
			mockDatabases.getDocument.mockResolvedValue({ $id: "pin1", system: "pos", label: "Till" });

			for (const body of [{ action: "revoke", pinId: "pin1" }, { action: "regenerate", pinId: "pin1" }]) {
				const result = await handler(makeContext({ body }));
				expect(result.statusCode).toBe(403);
			}
			expect(mockDatabases.updateDocument).not.toHaveBeenCalled();
		});
	});

	test("rejects an invalid action", async () => {
		const ctx = adminCtx({ body: { action: "delete" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});

	test("rejects an invalid JSON body", async () => {
		const ctx = adminCtx({ body: {} });
		ctx.req.body = "not json";

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});
});
