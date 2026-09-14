const fs = require("fs");
const path = require("path");
const { execFileSync } = require("child_process");

/**
 * Every function entrypoint must actually PARSE in the module system its own package.json
 * declares. Jest cannot catch this: babel transpiles ESM and CommonJS alike, so a file mixing the
 * two passes every unit test and then fails at load time in the real node-16 runtime with
 * "Syntax error in index.js: Cannot use import statement outside a module" -- a hard 503 before a
 * single line of the handler runs.
 *
 * That is not hypothetical. An `import` was added to quick-access-login, which is CommonJS, and it
 * took the door staff's login offline while the full 939-test suite stayed green.
 */
const ROOT = path.join(__dirname, "..");
const config = JSON.parse(fs.readFileSync(path.join(ROOT, "appwrite.config.json"), "utf8"));

const entrypoints = config.functions.map((fn) => {
	const dir = fn.path.startsWith("functions/") ? fn.path : path.join("functions", fn.path);
	const file = path.join(ROOT, dir, fn.entrypoint);
	const pkgPath = path.join(ROOT, dir, "package.json");
	const pkg = fs.existsSync(pkgPath) ? JSON.parse(fs.readFileSync(pkgPath, "utf8")) : {};
	return { name: fn.name, file, isModule: pkg.type === "module" };
});

test("every function is registered with an entrypoint that exists", () => {
	const missing = entrypoints.filter((e) => !fs.existsSync(e.file)).map((e) => e.name);
	expect(missing).toEqual([]);
});

describe.each(entrypoints)("$name", ({ file, isModule }) => {
	test(`parses as ${isModule ? "ESM" : "CommonJS"}`, () => {
		// The type MUST be forced. `node --check <path>` is not enough: Node 20+ auto-detects ESM
		// syntax inside a .js file and accepts it, so the check passes locally while the node-16
		// runtime still 503s on the very same file. Piping through stdin with an explicit
		// --input-type is what actually pins the file to the module system it ships under.
		const type = isModule ? "module" : "commonjs";
		const source = fs.readFileSync(file, "utf8");
		expect(() =>
			execFileSync(process.execPath, [`--input-type=${type}`, "--check", "-"], {
				input: source,
				stdio: "pipe",
			}),
		).not.toThrow();
	});
});
