jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const mockFetch = require("node-fetch");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

describe("Admin-EmailCoordinator", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		mockFetch.mockReset();
		mockFetch.mockResolvedValue({ ok: true, text: () => Promise.resolve("{}") });
		process.env.RESEND_API_KEY = "re_test_key";
	});

	test("sends a free-form message and CCs the admin", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "co1", name: "Sam", email: "sam@example.com" });
		const ctx = makeContext({
			body: { coordinatorId: "co1", subject: "Next First Friday", message: "Can you cover load-in?" },
		});

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { ok: true } });
		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.to).toEqual(["sam@example.com"]);
		expect(sentBody.cc).toEqual(["everett.bazzocchi@skullspace.ca"]);
		expect(sentBody.subject).toBe("Next First Friday");
		expect(sentBody.html).toContain("Can you cover load-in?");
		expect(sentBody.html).toContain("admin@skullspace.ca");
	});

	test("testing:true redirects the recipient and drops the cc", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "co1", name: "Sam" });
		const ctx = makeContext({
			body: { coordinatorId: "co1", subject: "Hi", message: "Hello", testing: true },
		});

		const result = await handler(ctx);

		expect(result.body).toEqual({ ok: true });
		const sentBody = JSON.parse(mockFetch.mock.calls[0][1].body);
		expect(sentBody.to).toEqual(["everett.bazzocchi@skullspace.ca"]);
		expect(sentBody.cc).toBeUndefined();
	});

	test("rejects a coordinator with no email on file (non-testing)", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "co1", name: "Sam" });
		const ctx = makeContext({ body: { coordinatorId: "co1", subject: "Hi", message: "Hello" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockFetch).not.toHaveBeenCalled();
	});

	test("rejects a missing subject/message", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "co1", email: "sam@example.com" });
		const ctx = makeContext({ body: { coordinatorId: "co1", subject: "", message: "" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.getDocument).not.toHaveBeenCalled();
	});

	test("rejects a missing coordinatorId", async () => {
		const ctx = makeContext({ body: { subject: "Hi", message: "Hello" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
		expect(mockDatabases.getDocument).not.toHaveBeenCalled();
	});

	test("404s when the coordinator doesn't exist", async () => {
		mockDatabases.getDocument.mockRejectedValue(new Error("nope"));
		const ctx = makeContext({ body: { coordinatorId: "missing", subject: "Hi", message: "Hello" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(404);
	});

	test("surfaces a 500 if Resend itself fails", async () => {
		mockDatabases.getDocument.mockResolvedValue({ $id: "co1", name: "Sam", email: "sam@example.com" });
		mockFetch.mockResolvedValue({ ok: false, status: 500, text: () => Promise.resolve("resend down") });
		const ctx = makeContext({ body: { coordinatorId: "co1", subject: "Hi", message: "Hello" } });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});

	test("rejects invalid JSON", async () => {
		const ctx = { req: { body: "{not json", headers: {} }, res: { json: (d, c = 200) => ({ statusCode: c, body: d }) }, log: jest.fn(), error: jest.fn() };

		const result = await handler(ctx);

		expect(result.statusCode).toBe(400);
	});
});
