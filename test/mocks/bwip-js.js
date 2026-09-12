// Manual mock for the `bwip-js` package (barcode generation), used via
// jest.config.js's moduleNameMapper -- generating a real PNG in a unit test
// would just be pixel-fuzzing, not testing anything about this codebase.
// `toBuffer` resolves to a fixed, recognizable Buffer that a test can
// assert against (e.g. the resulting data URL contains its base64 form).
const mockToBuffer = jest.fn().mockResolvedValue(Buffer.from("fake-barcode-png"));

function resetBwipMocks() {
	mockToBuffer.mockReset();
	mockToBuffer.mockResolvedValue(Buffer.from("fake-barcode-png"));
}

module.exports = { toBuffer: mockToBuffer, mockToBuffer, resetBwipMocks };
