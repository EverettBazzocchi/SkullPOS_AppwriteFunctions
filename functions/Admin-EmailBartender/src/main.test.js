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
		test("sends the bartender their event time window and pin, with the admin as reply_to (not a cc)", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({ $id: "event1", name: "HAX 7.0", date: "2026-06-01T22:00:00.000Z" });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["alex@example.com"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(sentBody.cc).toBeUndefined();
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

		// --- the migrated time model -----------------------------------------------------------
		//
		// 2026-09-27T03:00:00Z is 10:00 p.m. the evening before in America/Winnipeg, and
		// 2026-09-27T07:00:00Z is 2:00 a.m. -- the same 22:00-02:00 shift the legacy row above
		// describes with `date` + barOpenTime/barCloseTime.

		test("renders the start from startsAt for a row that no longer carries a legacy date", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "The NB Afterparty",
					startsAt: "2026-09-27T03:00:00.000Z",
					endsAt: "2026-09-27T07:00:00.000Z",
					barOpensAt: "2026-09-27T03:00:00.000Z",
					barClosesAt: "2026-09-27T07:00:00.000Z",
				});

			const result = await handler(makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } }));

			expect(result.statusCode).toBe(200);
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.html).toContain("10:00");
			expect(sentBody.html).toMatch(/p\.?m\.?/i);
		});

		// `date`'s time half is junk. When both shapes are present the email must state the real
		// start, not the stored placeholder -- a bartender who reads the wrong hour shows up late.
		test("prefers startsAt over the legacy date's junk time when both are present", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "The NB Afterparty",
					date: "2026-09-27T05:00:00.000Z", // midnight local -- meaningless time
					startsAt: "2026-09-27T03:00:00.000Z", // the real 10 p.m. start
					endsAt: "2026-09-27T07:00:00.000Z",
					barOpenTime: "22:00",
					barCloseTime: "02:00",
					barOpensAt: "2026-09-27T03:00:00.000Z",
					barClosesAt: "2026-09-27T07:00:00.000Z",
				});

			await handler(makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } }));

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.html).toContain("10:00");
			expect(sentBody.html).not.toContain("12:00");
		});

		// The hours quoted to the bartender have to be the hours Verify-Pin will actually honour:
		// barOpensAt-1h to barClosesAt+1h, i.e. 9:00 p.m. to 3:00 a.m. for this shift.
		test("quotes the pin-valid window from the new instants, buffer included", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "The NB Afterparty",
					startsAt: "2026-09-27T03:00:00.000Z",
					endsAt: "2026-09-27T07:00:00.000Z",
					barOpensAt: "2026-09-27T03:00:00.000Z",
					barClosesAt: "2026-09-27T07:00:00.000Z",
				});

			await handler(makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } }));

			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.html).toContain("9:00");
			expect(sentBody.html).toContain("3:00");
			expect(sentBody.html).toContain("covers the whole event");
		});

		// This test used to assert the opposite -- that coordinators were merged into the CC of
		// the bartender's own (pin-bearing) email. That was the bug: one HTML body goes to `to`
		// and every `cc`, so every coordinator received a working till pin. The roster fact is
		// still delivered, now as its own pin-free email.
		test("tells coordinators a bartender was assigned WITHOUT ever sending them the pin", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [
						{ $id: "co1", email: "coord@example.com" },
						{ $id: "co2", email: "coord2@example.com" },
					],
				});
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			// verifies coordinators are read via a select on the event, not a (broken) query
			// against event_coordinators directly -- Appwrite rejects Query.equal on a
			// many-to-many relationship attribute outright
			const [, , , eventQueries] = mockDatabases.getDocument.mock.calls[1];
			expect(eventQueries.some((q) => q.includes("coordinators"))).toBe(true);

			expect(mockFetch).toHaveBeenCalledTimes(2);
			const toBartender = JSON.parse(mockFetch.mock.calls[0][1].body);
			const toCoordinators = JSON.parse(mockFetch.mock.calls[1][1].body);

			// the credential-bearing body reaches the bartender and nobody else -- the admin is a
			// reply_to header, which delivers no copy of the pin
			expect(toBartender.to).toEqual(["alex@example.com"]);
			expect(toBartender.cc).toBeUndefined();
			expect(toBartender.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(toBartender.html).toContain("1234");

			// the coordinators' copy names the bartender and the event, and carries no pin
			expect(toCoordinators.to).toEqual(["coord@example.com", "coord2@example.com"]);
			expect(toCoordinators.cc).toBeUndefined();
			expect(toCoordinators.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(toCoordinators.html).toContain("Alex");
			expect(toCoordinators.html).toContain("HAX 7.0");
			expect(toCoordinators.html).not.toContain("1234");
			expect(toCoordinators.subject).not.toContain("1234");
		});

		test("a pin that happens to appear in no other field still never reaches a coordinator", async () => {
			// Guards the general rule rather than the literal string "1234": whatever the
			// bartender's pin is, it must appear in exactly one of the two outgoing bodies.
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "9705" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [{ $id: "co1", email: "coord@example.com" }],
				});
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			await handler(ctx);

			const bodiesContainingPin = mockFetch.mock.calls
				.map((call) => JSON.parse(call[1].body))
				.filter((sent) => JSON.stringify(sent).includes("9705"));
			expect(bodiesContainingPin).toHaveLength(1);
			expect(bodiesContainingPin[0].to).toEqual(["alex@example.com"]);
			expect(bodiesContainingPin[0].cc).toBeUndefined();
			expect(bodiesContainingPin[0].reply_to).toBe("everett.bazzocchi@skullspace.ca");
		});

		test("drops coordinators with a missing/invalid email and sends only the bartender's copy when none are left", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [{ $id: "co1", name: "No Email" }, { $id: "co2", name: "Bad", email: "not-an-email" }],
				});
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		test("a failed coordinator notice does not fail the assignment (the bartender already got her pin)", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [{ $id: "co1", email: "coord@example.com" }],
				});
			mockFetch
				.mockResolvedValueOnce({ ok: true, text: () => Promise.resolve("{}") })
				.mockResolvedValueOnce({ ok: false, status: 500, text: () => Promise.resolve("resend down") });
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } });

			const result = await handler(ctx);

			expect(result.statusCode).toBe(200);
			expect(result.body).toEqual({ ok: true, coordinatorNoticeSent: false });
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

		test("testing:true redirects the recipient, drops the cc, and sends no coordinator notice", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [{ $id: "co1", email: "coord@example.com" }],
				});
			const ctx = makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1", testing: true } });

			const result = await handler(ctx);

			expect(result.body).toEqual({ ok: true });
			expect(mockFetch).toHaveBeenCalledTimes(1);
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["everett.bazzocchi@skullspace.ca"]);
			expect(sentBody.cc).toBeUndefined();
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
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
		test("sends a free-form message with the admin as reply_to (not a cc)", async () => {
			mockDatabases.getDocument.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com" });
			const ctx = makeContext({
				body: { action: "custom", bartenderId: "bt1", subject: "Shift change", message: "Can you cover Friday?" },
			});

			const result = await handler(ctx);

			expect(result).toEqual({ statusCode: 200, body: { ok: true } });
			const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
			expect(sentBody.to).toEqual(["alex@example.com"]);
			expect(sentBody.reply_to).toBe("everett.bazzocchi@skullspace.ca");
			expect(sentBody.cc).toBeUndefined();
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

	describe("the admin is a reply_to, never a cc", () => {
		// Guards the deliberate change away from the standing everett CC: replies still reach the
		// admin, but no copy of any of this function's three sends is delivered to that inbox. A
		// future edit that quietly reinstates the copy fails here.
		test("no send site ever puts the admin address in cc", async () => {
			mockDatabases.getDocument
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com", pin: "1234" })
				.mockResolvedValueOnce({
					$id: "event1",
					name: "HAX 7.0",
					date: "2026-06-01T22:00:00.000Z",
					coordinators: [{ $id: "co1", email: "coord@example.com" }],
				})
				.mockResolvedValueOnce({ $id: "bt1", name: "Alex", email: "alex@example.com" });

			await handler(makeContext({ body: { action: "event_assigned", bartenderId: "bt1", eventId: "event1" } }));
			await handler(
				makeContext({ body: { action: "custom", bartenderId: "bt1", subject: "Hi", message: "Hello" } }),
			);

			// bartender copy, coordinator notice, custom message
			expect(mockFetch).toHaveBeenCalledTimes(3);
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
