jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, mockStorage, resetAppwriteMocks } = require("node-appwrite");
const { mockToBuffer, resetBwipMocks } = require("bwip-js");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Admin-EmailDj", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		resetBwipMocks();
		mockFetch.mockReset();
		mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
		process.env.RESEND_API_KEY = "re_test_key";
		process.env.APPWRITE_FUNCTION_API_ENDPOINT = "https://api.cloud.shotty.tech/v1";
		process.env.APPWRITE_FUNCTION_PROJECT_ID = "proj1";
	});

	describe("voucher action", () => {
		test("sends the DJ their voucher barcode with the admin as reply_to (not a cc)", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123456789", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0" });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			expect(mockToBuffer).toHaveBeenCalledWith(expect.objectContaining({ text: "75855123456789", bcid: "code128" }));
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["dj@example.com"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(sentBody.cc).toBeUndefined();
			expect(sentBody.html).toContain("HAX 7.0");
			expect(sentBody.html).toContain("$20.00");
			expect(sentBody.html).toContain("75855123456789");
			expect(sentBody.html).toContain("admin@skullspace.ca");
			expect(sentBody.html).toMatch(/any item/i);
			expect(sentBody.html).toMatch(/doesn't have to be used all at once/i);
			// the barcode is uploaded to a public Storage bucket and linked to, not embedded as a
			// data: URI (Gmail and most clients strip inline base64 images outright)
			expect(mockStorage.createFile).toHaveBeenCalledWith(
				"voucher-barcodes",
				"unique-id-1",
				expect.objectContaining({ filename: "unique-id-1.png" }),
				['read("any")'],
			);
			expect(sentBody.html).toContain(
				"https://api.cloud.shotty.tech/v1/storage/buckets/voucher-barcodes/files/unique-id-1/view?project=proj1",
			);
			expect(sentBody.html).not.toContain("data:image/png;base64,");
		});

		test("never names the uploaded barcode file after the giftcard code", async () => {
			// The bucket is served with a bucket-level read permission, and Appwrite grants list
			// from that same permission -- so whatever this file is *named* is readable by every
			// principal that can read the bucket. Naming it after the code made the bucket an
			// enumerable index of live voucher codes; the random fileId must be the only
			// identifier that ever reaches the object store.
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855666666666", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0" });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			await handler(ctx);

			const [bucketId, fileId, file] = mockStorage.createFile.mock.calls[0];
			expect(bucketId).toBe("voucher-barcodes");
			expect(fileId).not.toContain("75855666666666");
			expect(file.filename).not.toContain("75855666666666");
			expect(file.filename).toBe(`${fileId}.png`);
			// the code still has to be *inside* the barcode -- that's what the bar scans
			expect(mockToBuffer).toHaveBeenCalledWith(expect.objectContaining({ text: "75855666666666" }));
		});

		test("grants public read on the file, never relying on a bucket-wide read", async () => {
			// A random fileId is only a bearer token while the set of fileIds stays secret, and a
			// bucket carrying read("any") is also listable -- which hands that whole set out, and
			// each image prints its code in plaintext under the bars. So the grant has to travel
			// with the file (bucket fileSecurity:true, no bucket-level read("any")); if this
			// argument is ever dropped, the bucket has to go back to being world-readable for the
			// Gmail <img> to work and the enumeration is back.
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855666666666", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0" });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			await handler(ctx);

			const permissions = mockStorage.createFile.mock.calls[0][3];
			expect(permissions).toEqual(['read("any")']);
			// read only -- nobody gets to overwrite or delete a voucher barcode by URL
			expect(permissions.some((p) => /update|delete|write|create/.test(p))).toBe(false);
		});

		test("rejects a giftcard with no linked dj", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123", balance: 2000 });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("rejects a dj with no email on file (non-testing)", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123", balance: 2000, djs: "dj1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test" });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/no email on file/i);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("testing:true redirects the recipient and drops the cc, even with no dj email", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0" });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1", testing: true } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.cc).toBeUndefined();
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		test("CCs event coordinators -- they are real recipients, unlike the old standing admin copy", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123456789", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					coordinators: [
						{ $id: "co1", name: "Coordinator One", email: "coord1@example.com" },
						{ $id: "co2", name: "Coordinator Two", email: "coord2@example.com" },
					],
				});
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			// verifies coordinators are read via a select on the event, not a (broken) query
			// against event_coordinators directly -- Appwrite rejects Query.equal on a
			// many-to-many relationship attribute outright
			const [, , , eventQueries] = mockDatabases.getDocument.mock.calls[2];
			expect(eventQueries.some((q) => q.includes("coordinators"))).toBe(true);
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.cc).toEqual(expect.arrayContaining(["coord1@example.com", "coord2@example.com"]));
			expect(sentBody.cc).toHaveLength(2);
			// the standing admin copy is gone -- the admin is reachable on reply_to instead
			expect(sentBody.cc).not.toContain("everett.bazzocchi@skullspace.ca");
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		test("de-dupes a repeated coordinator email, and drops one with no/invalid email", async () => {
			// The admin address here belongs to a coordinator actually assigned to this event, so
			// it is a genuine recipient and still gets CC'd -- that is not the old standing copy,
			// which is gone (see the reply_to assertion). Listing it twice must still yield one CC.
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123456789", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					coordinators: [
						{ $id: "co1", name: "Duplicate", email: "everett.bazzocchi@skullspace.ca" },
						{ $id: "co2", name: "No Email" },
						{ $id: "co3", name: "Bad Email", email: "not-an-email" },
						{ $id: "co4", name: "Duplicate Again", email: "everett.bazzocchi@skullspace.ca" },
					],
				});
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.cc).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		test("still sends (with a generic event name and no coordinator CC) if the linked event can't be read", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockRejectedValueOnce(new Error("not found"));
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.html).toContain("your event");
			expect(sentBody.cc).toBeUndefined();
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		test("404s when the giftcard doesn't exist", async () => {
			mockDatabases.getDocument.mockRejectedValueOnce(new Error("nope"));
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "missing" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});

		test("surfaces a 500 if Resend itself fails", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0" });
			mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("resend down") });
			const ctx = makeContext({ body: { action: "voucher", giftcardId: "gc1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(500);
		});
	});

	describe("custom action", () => {
		test("sends a free-form message with the admin as reply_to (not a cc)", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" });
			const ctx = makeContext({
				body: { action: "custom", djId: "dj1", subject: "Load in time", message: "Please arrive by 9pm." },
			});

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["dj@example.com"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(sentBody.cc).toBeUndefined();
			expect(sentBody.subject).toBe("Load in time");
			expect(sentBody.html).toContain("Please arrive by 9pm.");
			expect(sentBody.html).toContain("admin@skullspace.ca");
		});

		test("rejects a missing subject/message", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "dj1", email: "dj@example.com" });
			const ctx = makeContext({ body: { action: "custom", djId: "dj1", subject: "", message: "" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("rejects a dj with no email on file (non-testing)", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test" });
			const ctx = makeContext({ body: { action: "custom", djId: "dj1", subject: "Hi", message: "Hi there" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockFetch).not.toHaveBeenCalled();
		});
	});

	describe("the admin is a reply_to, never a cc", () => {
		// Guards the deliberate change away from the standing everett CC: replies still reach the
		// admin, but no copy is delivered to that inbox. Coordinators (a real recipient list) are
		// deliberately still CC'd -- see the coordinator tests above. A future edit that quietly
		// reinstates the admin copy fails here.
		test("no send site puts the admin address in cc when the admin is not a coordinator", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "gc1", UPC: "75855123456789", balance: 2000, djs: "dj1", events: "event1" })
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					coordinators: [{ $id: "co1", name: "Coordinator One", email: "coord1@example.com" }],
				})
				.mockResolvedValueOnce({ $id: "dj1", name: "DJ Test", email: "dj@example.com" });

			await handler(makeContext({ body: { action: "voucher", giftcardId: "gc1" } }));
			await handler(makeContext({ body: { action: "custom", djId: "dj1", subject: "Hi", message: "Hello" } }));

			expect(mockFetch).toHaveBeenCalledTimes(2);
			mockFetch.mock.calls
				.map((call) => JSON.parse(call[1].body))
				.forEach((sentBody) => {
					expect(sentBody.cc || []).not.toContain("everett.bazzocchi@skullspace.ca");
					expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
				});
		});
	});

	describe("general validation", () => {
		test("rejects an invalid action", async () => {
			const ctx = makeContext({ body: { action: "delete-everything" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		});

		test("rejects invalid JSON", async () => {
			const ctx = { req: { body: "{not json", headers: {} }, res: { json: (d, c = 200) => ({ statusCode: c, body: d }) }, log: jest.fn(), error: jest.fn() };

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
		});
	});
});
