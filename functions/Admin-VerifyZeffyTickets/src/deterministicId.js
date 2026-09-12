import { createHash } from 'crypto';

/**
 * Kept in sync by hand with the identical copy in
 * functions/Admin-VerifyZeffyTickets/src/deterministicId.js (same convention as zeffyPersist.js).
 *
 * Derives a stable, Appwrite-document-ID-safe identifier from an arbitrary external id (a Zeffy
 * transaction or line-item id), for use as the *document ID itself* rather than `ID.unique()`.
 * This turns "check whether a document for this external id already exists, then create one"
 * (two separate calls -- racy under near-simultaneous webhook redeliveries, which Zeffy's own
 * retry policy can genuinely produce) into a single `createDocument` call that fails atomically
 * on Appwrite's own document-uniqueness constraint when the same external id is seen twice.
 *
 * Hashing (rather than using the external id directly) sidesteps Appwrite's document ID rules --
 * max 36 chars, must match [a-zA-Z0-9._-], can't start with a special char -- that an arbitrary
 * external id (Zeffy's own id format is undocumented and not guaranteed stable) might not satisfy.
 *
 * @param {string} namespace - short alphanumeric prefix distinguishing what kind of thing this id
 *   is for ('zfo' for a Zeffy order, 'zft' for a Zeffy ticket) -- keeps the two collections from
 *   ever colliding on the same derived id even given the same externalId.
 * @param {string|number} externalId - the external id to derive a document id from.
 * @returns {string} a deterministic id, <= 36 chars, matching Appwrite's document-id charset.
 */
export function deriveDeterministicId(namespace, externalId) {
	if (!namespace || !/^[a-zA-Z][a-zA-Z0-9]*$/.test(namespace)) {
		throw new Error(`deriveDeterministicId: namespace must be a short alphanumeric prefix, got "${namespace}"`);
	}
	const hash = createHash('sha256').update(String(externalId)).digest('hex').slice(0, 32);
	return `${namespace}_${hash}`;
}
