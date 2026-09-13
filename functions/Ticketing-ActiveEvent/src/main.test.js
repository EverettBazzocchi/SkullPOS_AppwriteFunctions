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
	sales: ['{"item":"Pilsner","qty":42,"revenue":33600}'],
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
	// `sales` is the per-item rollup array, not a scalar -- just as sensitive as the scalars below.
	"sales",
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

	test("returns the active event reduced to the floor-facing fields", async () => {
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
			sellsAlcohol: true,
			barOpenTime: "18:00",
			barCloseTime: "02:00",
		});
	});

	// Stronger than the financial-leak test below: this pins the allowlist *closed*, so adding any
	// new key to toPublicEvent -- financial or not -- has to be a deliberate edit here too.
	test("emits exactly the allowlisted keys and nothing else", async () => {
		mockDatabases.listDocuments.mockResolvedValue({ documents: [activeEventDoc] });
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(Object.keys(result.body.event).sort()).toEqual([
			"$id",
			"barCloseTime",
			"barOpenTime",
			"currency",
			"date",
			"description",
			"eventId",
			"isActive",
			"location",
			"name",
			"sellsAlcohol",
			"standardTicketPrice",
		]);
	});

	// The register and both menu boards gate their alcohol categories on exactly these three
	// fields; if they stop coming through, the bar silently cannot sell alcohol all night.
	test("passes the alcohol gate through so the register and menu boards can read it", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ ...activeEventDoc, barOpenTime: "20:30", barCloseTime: "02:00" }],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.event.sellsAlcohol).toBe(true);
		// Raw "HH:mm" -- the clients parse these themselves, so the strings must survive verbatim.
		expect(result.body.event.barOpenTime).toBe("20:30");
		expect(result.body.event.barCloseTime).toBe("02:00");
	});

	test("fails the alcohol gate closed when the event does not sell alcohol or has no window", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "evt3", name: "Dry Night", isActive: true }],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		// sellsAlcohol must be a hard false, never undefined -- the clients test it for truthiness
		// and a missing key would read the same, but null times are what keeps a sellsAlcohol:true
		// event with an unset window from being treated as open.
		expect(result.body.event.sellsAlcohol).toBe(false);
		expect(result.body.event.barOpenTime).toBeNull();
		expect(result.body.event.barCloseTime).toBeNull();
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
			// ...and no stray value from those columns rode along under a different key -- every
			// financial figure in the fixture, not just the two headline ones.
			expect(serialized).not.toContain(String(activeEventDoc[field]));
		}
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

	// A free event is a real thing (members' night). The old `parseInt(...) || 3000` turned it into
	// a CA$30.00 charge per patron at the door.
	test("keeps a 0-cent event free instead of falling back to the default price", async () => {
		mockDatabases.listDocuments.mockResolvedValue({
			documents: [{ $id: "evt4", name: "Free Entry Night", isActive: true, standardTicketPrice: 0 }],
		});
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.body.event.standardTicketPrice).toBe(0);
	});

	test("surfaces a 500 if the query itself fails, rather than pretending nothing is on", async () => {
		mockDatabases.listDocuments.mockRejectedValue(new Error("db down"));
		const ctx = makeContext({ body: {} });

		const result = await handler(ctx);

		expect(result.statusCode).toBe(500);
		expect(result.body.event).toBeUndefined();
	});
});
