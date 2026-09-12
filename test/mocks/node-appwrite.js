// Manual mock for node-appwrite, used by every function test via
// jest.config.js's moduleNameMapper. Every `new Databases(client)` (or
// Users) anywhere in a function under test returns the SAME shared mock
// object below, so a test can configure/assert on it without caring how
// many times the function under test constructs a client.
//
// Reset the mock functions between tests with `resetAppwriteMocks()`
// (call it in a beforeEach).

const mockDatabases = {
	getDocument: jest.fn(),
	updateDocument: jest.fn(),
	createDocument: jest.fn(),
	deleteDocument: jest.fn(),
	listDocuments: jest.fn(),
};

const mockUsers = {
	listMemberships: jest.fn(),
	list: jest.fn(),
	delete: jest.fn(),
};

const mockTeams = {
	createMembership: jest.fn(),
};

const mockStorage = {
	createFile: jest.fn().mockResolvedValue({ $id: "file1" }),
};

class Client {
	setEndpoint() {
		return this;
	}
	setProject() {
		return this;
	}
	setKey() {
		return this;
	}
}

class Databases {
	constructor() {
		// Every method but listDocuments forwards straight to the shared mockDatabases spies
		// (same jest.fn() references, so `mockDatabases.getDocument.mock.calls` etc. still work
		// exactly as before). listDocuments alone goes through a validating wrapper first -- see
		// RELATIONSHIP_ATTRIBUTES_BY_COLLECTION above -- while still ultimately calling (and
		// being configurable via) the very same `mockDatabases.listDocuments` spy every test
		// already uses.
		return {
			getDocument: (...args) => mockDatabases.getDocument(...args),
			updateDocument: (...args) => mockDatabases.updateDocument(...args),
			createDocument: (...args) => mockDatabases.createDocument(...args),
			deleteDocument: (...args) => mockDatabases.deleteDocument(...args),
			listDocuments: (...args) => listDocumentsWithValidation(...args),
		};
	}
}

class Users {
	constructor() {
		return mockUsers;
	}
}

class Teams {
	constructor() {
		return mockTeams;
	}
}

class Storage {
	constructor() {
		return mockStorage;
	}
}

// Fixed (not random) so a test can assert on the exact generated barcode/file URL.
const ID = {
	unique: () => "unique-id-1",
	custom: (id) => id,
};

// Simple pass-through query builders -- good enough for asserting "was
// called with a query mentioning this field", not meant to byte-match
// Appwrite's real wire format.
const Query = {
	equal: (attr, value) => `equal("${attr}", ${JSON.stringify(value)})`,
	notEqual: (attr, value) => `notEqual("${attr}", ${JSON.stringify(value)})`,
	greaterThanEqual: (attr, value) => `greaterThanEqual("${attr}", ${JSON.stringify(value)})`,
	lessThanEqual: (attr, value) => `lessThanEqual("${attr}", ${JSON.stringify(value)})`,
	orderAsc: (attr) => `orderAsc("${attr}")`,
	orderDesc: (attr) => `orderDesc("${attr}")`,
	limit: (n) => `limit(${n})`,
	cursorAfter: (id) => `cursorAfter("${id}")`,
	select: (values) => `select(${JSON.stringify(values)})`,
};

// Known relationship attributes per collection (by $id), gathered from the live project's real
// schema (`appwrite databases list-attributes`, filtered to type:"relationship") -- this
// mock has no schema of its own to check against otherwise. This exists because the mock used to
// happily accept ANY Query.equal/etc call, including one against a *relationship* attribute --
// something the real Appwrite API rejects outright ("Cannot query on virtual relationship
// attribute"). That mismatch let a real bug (a coordinator CC silently never working, because
// the code filtered on a relationship field) sail through a fully-green test suite. Extend this
// map whenever a new relationship attribute is added to the schema.
const RELATIONSHIP_ATTRIBUTES_BY_COLLECTION = {
	// Transactions
	"68e4cd3500179ce661c6": ["events", "itemsRel", "giftcards"],
	// Events
	"68e400210008d19bb5c9": ["inventory", "djs"],
	// Inventory
	"68e3ff08002deb5d5bf4": ["ingredients", "events"],
	// Categories
	"67c9ffdd0039c4e09c9a": ["items"],
	// Items_old
	"67c9ffe6001c17071bb7": ["categories"],
	giftcards: ["events", "djs"],
	pos_items: ["categories", "menuItems", "optional_ingredients"],
	menu_items: ["posItems"],
	djs: ["events_played", "giftcards"],
	event_coordinators: ["events"],
	bartenders: ["events"],
};

// Only these Query methods put a plain attribute name first in the string they build (limit,
// cursorAfter, and select don't, so they're deliberately excluded here).
const ATTRIBUTE_QUERY_PATTERN = /^(equal|notEqual|greaterThanEqual|lessThanEqual|orderAsc|orderDesc)\("([^"]+)"/;

function findRelationshipQueryViolation(collectionId, queries) {
	const relationshipAttributes = RELATIONSHIP_ATTRIBUTES_BY_COLLECTION[collectionId];
	if (!relationshipAttributes || !Array.isArray(queries)) return null;

	for (const query of queries) {
		if (typeof query !== "string") continue;
		const match = query.match(ATTRIBUTE_QUERY_PATTERN);
		if (match && relationshipAttributes.includes(match[2])) {
			return match[2];
		}
	}
	return null;
}

// listDocuments is the one Databases method that actually receives a `queries` array, so it's
// the one wrapped to validate against RELATIONSHIP_ATTRIBUTES_BY_COLLECTION before handing off
// to the plain jest.fn() spy every test already configures via
// `mockDatabases.listDocuments.mockResolvedValue(...)` (that spy is untouched -- this only
// gate-keeps what reaches it, exactly like the real API rejects the request before ever running
// it).
function listDocumentsWithValidation(databaseId, collectionId, queries) {
	const badAttribute = findRelationshipQueryViolation(collectionId, queries);
	if (badAttribute) {
		const err = new Error(
			`Invalid query: Cannot query on virtual relationship attribute "${badAttribute}" (collection "${collectionId}")`,
		);
		err.code = 400;
		return Promise.reject(err);
	}
	return mockDatabases.listDocuments(databaseId, collectionId, queries);
}

function resetAppwriteMocks() {
	Object.values(mockDatabases).forEach((fn) => fn.mockReset());
	Object.values(mockUsers).forEach((fn) => fn.mockReset());
	Object.values(mockTeams).forEach((fn) => fn.mockReset());
	mockStorage.createFile.mockReset();
	mockStorage.createFile.mockResolvedValue({ $id: "file1" });
}

module.exports = {
	Client,
	Databases,
	Users,
	Teams,
	Storage,
	ID,
	Query,
	mockDatabases,
	mockUsers,
	mockTeams,
	mockStorage,
	resetAppwriteMocks,
};
