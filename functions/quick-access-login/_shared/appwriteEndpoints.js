/**
 * Ordered list of endpoints to try when calling the Appwrite Database from inside a function
 * running alongside this self-hosted instance: the function-provided endpoint first, then
 * internal Docker addresses, then the public endpoint as a last resort. Ported verbatim from
 * ShottyTicketing's own copy of this file (appwrite-functions/<function>/_shared/appwriteEndpoints.js).
 */
function getAppwriteEndpoints() {
	return [
		process.env.APPWRITE_FUNCTION_ENDPOINT,
		'http://appwrite/v1',
		'http://172.20.0.1:8066/v1',
		'http://172.17.0.1:8066/v1',
		'http://172.20.0.1/v1',
		'http://host.docker.internal:8066/v1',
		'https://api.cloud.shotty.tech/v1',
	].filter((endpoint, idx, arr) => endpoint && arr.indexOf(endpoint) === idx);
}

/** Internal Docker/compose-network endpoints sit behind a reverse proxy that routes by Host
 * header, so requests to them need a spoofed Host header matching the public domain. */
function needsHostOverride(endpoint) {
	return endpoint.includes('172.') || endpoint.includes('docker') || endpoint.includes('appwrite');
}

module.exports = { getAppwriteEndpoints, needsHostOverride };
