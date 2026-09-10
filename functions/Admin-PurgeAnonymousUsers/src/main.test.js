jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockUsers, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

function anonUser(id, accessedAt) {
	return { $id: id, email: null, phone: null, $createdAt: accessedAt, $updatedAt: accessedAt, accessedAt };
}

function namedUser(id, accessedAt) {
	return { $id: id, email: `${id}@skullspace.ca`, phone: null, $createdAt: accessedAt, $updatedAt: accessedAt, accessedAt };
}

describe("Admin-PurgeAnonymousUsers", () => {
	beforeEach(() => {
		resetAppwriteMocks();
		mockUsers.delete.mockResolvedValue({});
	});

	test("deletes anonymous users inactive 90+ days", async () => {
		mockUsers.list.mockResolvedValue({
			users: [anonUser("stale1", daysAgo(120)), anonUser("fresh1", daysAgo(5))],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.deleted).toBe(1);
		expect(result.body.staleAnonymousFound).toBe(1);
		expect(mockUsers.delete).toHaveBeenCalledWith("stale1");
		expect(mockUsers.delete).not.toHaveBeenCalledWith("fresh1");
	});

	test("never deletes a user with an email, regardless of inactivity", async () => {
		mockUsers.list.mockResolvedValue({ users: [namedUser("admin1", daysAgo(365))] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.deleted).toBe(0);
		expect(mockUsers.delete).not.toHaveBeenCalled();
	});

	test("never deletes a user with a phone but no email", async () => {
		mockUsers.list.mockResolvedValue({
			users: [{ $id: "phoneuser", email: null, phone: "+15551234567", $updatedAt: daysAgo(365), accessedAt: daysAgo(365) }],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.deleted).toBe(0);
		expect(mockUsers.delete).not.toHaveBeenCalled();
	});

	test("an anonymous user with no accessedAt falls back to $updatedAt", async () => {
		mockUsers.list.mockResolvedValue({
			users: [{ $id: "old", email: null, phone: null, $createdAt: daysAgo(200), $updatedAt: daysAgo(200) }],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.deleted).toBe(1);
	});

	test("pages through more than one page of users", async () => {
		const page1 = Array.from({ length: 100 }, (_, i) => anonUser(`old-${i}`, daysAgo(200)));
		const page2 = [anonUser("old-last", daysAgo(200))];
		mockUsers.list.mockResolvedValueOnce({ users: page1 }).mockResolvedValueOnce({ users: page2 });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(mockUsers.list).toHaveBeenCalledTimes(2);
		expect(result.body.totalUsersChecked).toBe(101);
		expect(result.body.deleted).toBe(101);
	});

	test("a failed delete is reported but doesn't stop the run", async () => {
		mockUsers.list.mockResolvedValue({
			users: [anonUser("bad", daysAgo(200)), anonUser("good", daysAgo(200))],
		});
		mockUsers.delete.mockImplementation((id) => (id === "bad" ? Promise.reject(new Error("locked")) : Promise.resolve({})));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.deleted).toBe(1);
		expect(result.body.failures).toEqual([{ userId: "bad", error: "locked" }]);
	});

	test("surfaces a 500 if listing users fails", async () => {
		mockUsers.list.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
	});
});
