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
		return mockDatabases;
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
