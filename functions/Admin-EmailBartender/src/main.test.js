jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Admin-EmailBartender", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		mockFetch.mockReset();
		mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
		process.env.RESEND_API_KEY = "re_test_key";
	});

	describe("event_assigned action", () => {
		test("sends the bartender their event time window and pin, CCs the admin", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0", date: "2026-06-01T22:00:00.000Z" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["alex@example.com"]);
			expect(sentBody.cc).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.subject).toContain("HAX 7.0");
			expect(sentBody.html).toContain("1234");
			expect(sentBody.html).toContain("admin@skullspace.ca");
		});

		test("shows the event time in the venue's local timezone, not UTC", async () => {
			// 2026-09-27T03:00:00Z is 10:00 PM the evening before in America/Winnipeg (CDT,
			// UTC-5) -- matches this event's real barOpenTime of 22:00. Rendering without an
			// explicit timeZone would show 3:00 a.m. (or whatever the server's own zone is)
			// instead, which is the exact bug this guards against.
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({ $id: "event1", name: "The NB Afterparty", date: "2026-09-27T03:00:00.000Z" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			await handler(ctx);

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.html).toContain("10:00");
			expect(sentBody.html).toMatch(/p\.?m\.?/i);
			expect(sentBody.html).not.toContain("3:00");
		});

		test("CCs event coordinators alongside the admin (read from the event's own coordinators field)", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [{ $id: "co1", email: "coord@example.com" }],
				});
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			await handler(ctx);

			// verifies coordinators are read via a select on the event, not a (broken) query
			// against event_coordinators directly -- Appwrite rejects Query.equal on a
			// many-to-many relationship attribute outright
			const [, , , eventQueries] = mockDatabases.getDocument.mock.calls[1];
			expect(eventQueries.some((q) => q.includes("coordinators"))).toBe(true);
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.cc).toEqual(expect.arrayContaining(["everett.bazzocchi@skullspace.ca", "coord@example.com"]));
		});

		test("rejects a bartender with no pin generated yet", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(result.body.error).toMatch(/no pin/i);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("rejects a bartender with no email on file (non-testing)", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "bt1", name: "Alex", pin: "1234" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("testing:true redirects the recipient and drops the cc", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", pin: "1234" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0", date: "2026-06-01T22:00:00.000Z" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1", testing: true } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.cc).toBeUndefined();
		});

		test("rejects an event with no date set", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockFetch).not.toHaveBeenCalled();
		});

		test("404s when the bartender doesn't exist", async () => {
			mockDatabases.getDocument.mockRejectedValueOnce(new Error("nope"));
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "missing", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});

		test("404s when the event doesn't exist", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockRejectedValueOnce(new Error("nope"));
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "missing" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(404);
		});

		test("rejects missing bartenderId/eventId", async () => {
			const ctx = makeContext({ body: { action: "event_assigned" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockDatabases.getDocument).not.toHaveBeenCalled();
		});
	});

	describe("custom action", () => {
		test("sends a free-form message and CCs the admin", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com" });
			const ctx = makeContext({
				body: { action: "custom", bartenderId: "bt1", subject: "Shift change", message: "Can you cover Friday?" },
			});

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["alex@example.com"]);
			expect(sentBody.cc).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.html).toContain("Can you cover Friday?");
			expect(sentBody.html).toContain("admin@skullspace.ca");
		});

		test("rejects a missing subject/message", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "bt1", email: "alex@example.com" });
			const ctx = makeContext({ body: { action: "custom", bartenderId: "bt1", subject: "", message: "" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(400);
			expect(mockFetch).not.toHaveBeenCalled();
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
