// Manual mock for the `node-fetch` package (a polyfill for functions on the
// node-16.0 runtime, which predates global fetch), used via
// jest.config.js's moduleNameMapper. `import fetch from 'node-fetch'`
// resolves to this same jest.fn() everywhere -- reset it in a beforeEach.
module.exports = jest.fn();
