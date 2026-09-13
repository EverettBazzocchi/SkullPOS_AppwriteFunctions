// Covers the shared dnsPatch.js (byte-identical in every function). It lives beside the payment
// path on purpose: this is the function that had no resolver workaround at all, and the one where
// a stall is felt by a customer standing at the till.
jest.mock("dns", () => ({
	__esModule: true,
	default: {
		resolve4: jest.fn(),
		lookup: jest.fn(),
	},
}));

const dns = require("dns").default;
const { installDnsPatch, __resetDnsPatchForTests } = require("./dnsPatch.js");

const ORIGINAL = Symbol("original-lookup-result");

beforeEach(() => {
	jest.useRealTimers();
	__resetDnsPatchForTests();
	dns.resolve4 = jest.fn();
	// Stands in for getaddrinfo. Returns a sentinel so a test can prove the ORIGINAL path ran.
	dns.lookup = jest.fn((host, options, cb) => {
		if (typeof options === "function") cb = options;
		cb(null, ORIGINAL, 4);
	});
});

const lookup = (host, options) =>
	new Promise((resolve) => {
		const cb = (err, address, family) => resolve({ err, address, family });
		if (options) dns.lookup(host, options, cb);
		else dns.lookup(host, cb);
	});

describe("installDnsPatch", () => {
	// The whole defect being fixed: the old version awaited a DNS round trip before the handler
	// ran. Installation must touch the network zero times.
	it("installs without performing any DNS query", () => {
		installDnsPatch();
		expect(dns.resolve4).not.toHaveBeenCalled();
	});

	it("is idempotent -- installing twice does not stack patches", () => {
		installDnsPatch();
		const first = dns.lookup;
		installDnsPatch();
		expect(dns.lookup).toBe(first);
	});

	it("answers from resolve4 when getaddrinfo would be the broken path", async () => {
		dns.resolve4 = jest.fn((host, cb) => cb(null, ["158.69.218.215"]));
		installDnsPatch();
		const r = await lookup("api.cloud.shotty.tech");
		expect(r.address).toBe("158.69.218.215");
		expect(r.family).toBe(4);
	});

	it("caches a success so a warm container never re-resolves", async () => {
		dns.resolve4 = jest.fn((host, cb) => cb(null, ["1.2.3.4"]));
		installDnsPatch();
		await lookup("api.stripe.com");
		await lookup("api.stripe.com");
		await lookup("api.stripe.com");
		expect(dns.resolve4).toHaveBeenCalledTimes(1);
	});

	// Falling back is the point of the design: getaddrinfo is the FAST path for api.stripe.com and
	// the broken one for this deployment's own domain. Whichever fails, the other still answers.
	it("falls back to the original resolver when resolve4 errors", async () => {
		dns.resolve4 = jest.fn((host, cb) => cb(new Error("ENOTFOUND")));
		installDnsPatch();
		const r = await lookup("example.test");
		expect(r.address).toBe(ORIGINAL);
	});

	it("falls back when resolve4 returns no addresses", async () => {
		dns.resolve4 = jest.fn((host, cb) => cb(null, []));
		installDnsPatch();
		const r = await lookup("example.test");
		expect(r.address).toBe(ORIGINAL);
	});

	// The production failure was an unbounded wait. A resolve4 that never calls back must not hang
	// the request -- it must time out and hand over to the other path.
	it("does not hang forever when resolve4 never calls back", async () => {
		jest.useFakeTimers();
		dns.resolve4 = jest.fn(() => {});
		installDnsPatch();
		const p = lookup("stuck.test");
		await Promise.resolve();
		jest.advanceTimersByTime(2001);
		jest.useRealTimers();
		const r = await p;
		expect(r.address).toBe(ORIGINAL);
	});

	// resolve4 answers A records only, so anything asking for something else must be left alone
	// rather than silently given an IPv4 answer.
	it("delegates all:true to the original resolver", async () => {
		dns.resolve4 = jest.fn((host, cb) => cb(null, ["1.2.3.4"]));
		installDnsPatch();
		const r = await lookup("example.test", { all: true });
		expect(r.address).toBe(ORIGINAL);
		expect(dns.resolve4).not.toHaveBeenCalled();
	});

	it("delegates family:6 to the original resolver", async () => {
		dns.resolve4 = jest.fn((host, cb) => cb(null, ["1.2.3.4"]));
		installDnsPatch();
		const r = await lookup("example.test", { family: 6 });
		expect(r.address).toBe(ORIGINAL);
		expect(dns.resolve4).not.toHaveBeenCalled();
	});
});
