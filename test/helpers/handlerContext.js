// Builds the {req, res, log, error} args every function's default export
// takes, matching Appwrite's real runtime shape closely enough for tests:
// req.body is a JSON string, req.headers is a plain object, and res.json
// returns {statusCode, body} so a test can just assert on the handler's
// return value.
function makeContext({ body = {}, headers = {} } = {}) {
	const log = jest.fn();
	const error = jest.fn();
	const req = { body: JSON.stringify(body), headers };
	const res = {
		json: (data, statusCode = 200) => ({ statusCode, body: data }),
	};
	return { req, res, log, error };
}

module.exports = { makeContext };
