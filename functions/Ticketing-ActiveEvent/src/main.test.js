jest.mock("./appwriteClient.js", () => ({
	createAppwriteClient: jest.fn().mockResolvedValue({}),
}));

const { mockDatabases, resetAppwriteMocks } = require("node-appwrite");
const handler = require("./main.js").default;
const { makeContext } = require("../../../test/helpers/handlerContext");

// A realistic Events row -- every financial rollup column Admin-RollupEventSales writes is
// present here on purpose, so the leak guard below is testing against the real shape.
const activeEventDoc = {
	$id: "evt1",
	eventId: "884cc628-dca7-4452-a0c3-6122dd1b0d37",
	name: "HAX 7.0",
	description: "Annual hackathon",
	date: "2026-09-10T00:00:06.000Z",
	location: "Door Entry",
	standardTicketPrice: 100,
	currency: "CAD",
	isActive: true,
	sellsAlcohol: true,
	barOpenTime: "18:00",
	barCloseTime: "02:00",
	alcohol_sales: 120000,
	food_sales: 34000,
	drink_sales: 15000,
	discount_amount: 2500,
	gift_card_amount: 4000,
	tips_earned: 18000,
	cash_sales: 60000,
	card_sales: 109000,
	pos_revenue: 169000,
	revenue: 215000,
	cogs: 64000,
	profit: 151000,
};

const FINANCIAL_FIELDS = [
	"alcohol_sales",
	"food_sales",
	"drink_sales",
	"discount_amount",
	"gift_card_amount",
	"tips_earned",
	"cash_sales",
	"card_sales",
	"pos_revenue",
	"revenue",
	"cogs",
	"profit",
];

describe("Ticketing-ActiveEvent", () => {
	beforeEach(() => {
		resetAppwriteMocks();
	});

	test("returns the active event reduced to the door-facing fields", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [activeEventDoc] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(200);
		expect(result.body.event).toEqual({
			$id: "evt1",
			eventId: "884cc628-dca7-4452-a0c3-6122dd1b0d37",
			name: "HAX 7.0",
			description: "Annual hackathon",
			date: "2026-09-10T00:00:06.000Z",
			location: "Door Entry",
			standardTicketPrice: 100,
			currency: "CAD",
			isActive: true,
		});
	});

	// The entire reason this function exists instead of a collection read permission -- if this
	// ever fails, the door devices are being handed the venue's books.
	test("never leaks a financial rollup field, even though the source document carries them all", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [activeEventDoc] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		const serialized = JSON.stringify(result.body);
		for (const field of FINANCIAL_FIELDS) {
			expect(result.body.event).not.toHaveProperty(field);
			expect(serialized).not.toContain(field);
		}
		// ...and no stray value from those columns rode along under a different key.
		expect(serialized).not.toContain("215000");
		expect(serialized).not.toContain("151000");
	});

	test("queries only for the active event", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [activeEventDoc] });
		const ctx = makeContext({ body: {} });

		await handler(ctx);

		const [, collectionId, queries] = mockDatabases.listDocuments.mock.calls[0];
		expect(collectionId).toBe("68e400210008d19bb5c9");
		expect(queries.some((q) => q.includes("isActive"))).toBe(true);
	});

	test("returns event:null (not an error) when no event is active", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result).toEqual({ statusCode: 200, body: { event: null } });
	});

	test("falls back to the client's own default price/currency when the event omits them", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "evt2", name: "Unpriced Night", isActive: true }],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.event.standardTicketPrice).toBe(3000);
		expect(result.body.event.currency).toBe("CAD");
		expect(result.body.event.eventId).toBeNull();
		expect(result.body.event.description).toBeNull();
	});

	test("surfaces a 500 if the query itself fails, rather than pretending nothing is on", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body.event).toBeUndefined();
	});
});
