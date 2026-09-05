module.exports = {
	testEnvironment: "node",
	testMatch: ["<rootDir>/functions/**/*.test.js"],
	// Each function has its own package.json/node_modules for deployment,
	// but none of them are actually npm-installed locally (Appwrite runs
	// `npm i` on its side at deploy time) -- node-appwrite and stripe are
	// mocked globally instead of relying on real installed packages, so
	// tests don't need a network call or a heavy local install to run.
	moduleNameMapper: {
		"^node-appwrite$": "<rootDir>/test/mocks/node-appwrite.js",
		"^stripe$": "<rootDir>/test/mocks/stripe.js",
	},
};
