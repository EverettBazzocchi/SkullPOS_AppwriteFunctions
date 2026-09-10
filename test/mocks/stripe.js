// Manual mock for the `stripe` package, used by every function test via
// jest.config.js's moduleNameMapper. Every `new Stripe(key)` anywhere in a
// function under test returns the SAME shared mock object below.
//
// Reset the mock functions between tests with `resetStripeMocks()` (call
// it in a beforeEach).

const mockStripe = {
	paymentIntents: {
		retrieve: jest.fn(),
		create: jest.fn(),
	},
	refunds: {
		create: jest.fn(),
	},
	terminal: {
		connectionTokens: {
			create: jest.fn(),
		},
	},
};

class Stripe {
	constructor(apiKey) {
		mockStripe.lastConstructedWithKey = apiKey;
		return mockStripe;
	}
}

function resetStripeMocks() {
	mockStripe.paymentIntents.retrieve.mockReset();
	mockStripe.paymentIntents.create.mockReset();
	mockStripe.refunds.create.mockReset();
	mockStripe.terminal.connectionTokens.create.mockReset();
	mockStripe.lastConstructedWithKey = undefined;
}

module.exports = Stripe;
module.exports.mockStripe = mockStripe;
module.exports.resetStripeMocks = resetStripeMocks;
