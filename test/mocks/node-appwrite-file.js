// Manual mock for the `node-appwrite/file` subpath export (InputFile), used via
// jest.config.js's moduleNameMapper. Real InputFile.fromBuffer wraps a Buffer + filename for
// Storage.createFile -- this mock just needs to be a recognizable stand-in, since the (also
// mocked) Storage.createFile never actually inspects it.
const InputFile = {
	fromBuffer: (buffer, filename) => ({ buffer, filename }),
};

module.exports = { InputFile };
