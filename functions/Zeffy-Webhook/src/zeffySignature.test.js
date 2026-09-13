/**
 * Adversarial coverage for the Zeffy webhook signature gate.
 *
 * PROVENANCE: salvaged verbatim (only the require path changed, to sit beside the implementation
 * the way main.test.js does) from ShottyTicketing's deleted
 * `appwrite-functions/_shared/__tests__/zeffySignature.test.js`. It guarded a fork of this logic
 * that has now been removed; this is the live copy of that logic, and Zeffy-Webhook's own
 * main.test.js only exercises "no signature", "bad signature" and the fail-closed-with-no-secret
 * path. Everything below - replay/staleness, tampered body, re-serialized body, wrong secret,
 * malformed headers - is otherwise untested, on the path that decides whether an unauthenticated
 * POST gets to mint paid tickets.
 */

const crypto = require("crypto");
const { isZeffySignatureValid } = require("./zeffySignature.js");

const SECRET = "whsec_test_secret_value";

function sign(rawBody, t, secret = SECRET) {
	const v1 = crypto.createHmac("sha256", secret).update(`${t}.${rawBody}`).digest("hex");
	return `t=${t},v1=${v1}`;
}

describe("isZeffySignatureValid", () => {
	test("accepts a correctly signed, fresh delivery", () => {
		const now = 1700000000;
		const rawBody = '{"id":"evt_1","type":"payment.completed"}';
		const header = sign(rawBody, now);
		expect(isZeffySignatureValid(rawBody, header, SECRET, now)).toBe(true);
	});

	test("rejects a tampered body", () => {
		const now = 1700000000;
		const header = sign('{"amount":100}', now);
		expect(isZeffySignatureValid('{"amount":999999}', header, SECRET, now)).toBe(false);
	});

	test("rejects the wrong secret", () => {
		const now = 1700000000;
		const rawBody = '{"amount":100}';
		const header = sign(rawBody, now, "whsec_wrong_secret");
		expect(isZeffySignatureValid(rawBody, header, SECRET, now)).toBe(false);
	});

	test("rejects a re-serialized body even with the same logical content", () => {
		const now = 1700000000;
		const original = '{"a":1,"b":2}';
		const reserialized = '{"b":2,"a":1}';
		const header = sign(original, now);
		expect(isZeffySignatureValid(reserialized, header, SECRET, now)).toBe(false);
	});

	test("rejects a signature older than the tolerance window (replay protection)", () => {
		const signedAt = 1700000000;
		const rawBody = '{"id":"evt_1"}';
		const header = sign(rawBody, signedAt);
		const now = signedAt + 6 * 60; // 6 minutes later, beyond the 5-minute default tolerance
		expect(isZeffySignatureValid(rawBody, header, SECRET, now)).toBe(false);
	});

	test("accepts a signature right at the edge of the tolerance window", () => {
		const signedAt = 1700000000;
		const rawBody = '{"id":"evt_1"}';
		const header = sign(rawBody, signedAt);
		const now = signedAt + 4 * 60;
		expect(isZeffySignatureValid(rawBody, header, SECRET, now)).toBe(true);
	});

	test("rejects missing, empty, or malformed headers", () => {
		expect(isZeffySignatureValid("body", undefined, SECRET, 1700000000)).toBe(false);
		expect(isZeffySignatureValid("body", "", SECRET, 1700000000)).toBe(false);
		expect(isZeffySignatureValid("body", "not-a-valid-header", SECRET, 1700000000)).toBe(false);
		expect(isZeffySignatureValid("body", "t=abc,v1=xyz", SECRET, 1700000000)).toBe(false);
	});

	test("rejects when no secret is configured", () => {
		const now = 1700000000;
		const rawBody = '{"id":"evt_1"}';
		const header = sign(rawBody, now);
		expect(isZeffySignatureValid(rawBody, header, "", now)).toBe(false);
	});
});
