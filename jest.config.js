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
		"^node-appwrite/file$": "<rootDir>/test/mocks/node-appwrite-file.js",
		"^stripe$": "<rootDir>/test/mocks/stripe.js",
		"^node-fetch$": "<rootDir>/test/mocks/node-fetch.js",
		"^bwip-js$": "<rootDir>/test/mocks/bwip-js.js",
	},
};
