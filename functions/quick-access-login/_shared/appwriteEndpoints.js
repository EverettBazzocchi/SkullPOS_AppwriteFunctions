/**
 * Ordered list of endpoints to try when calling the Appwrite Database from inside a function
 * running alongside this self-hosted instance: the function-provided endpoint first, then the
 * public endpoint. Ticketing's own original copy of this file also tried several internal
 * Docker-network address guesses ('http://appwrite/v1', '172.x:8066', etc.) between these two --
 * dropped here because in this shared project's actual hosting environment none of them ever
 * resolve/route (confirmed live: each one either DNS-fails or 404s, adding several seconds of
 * dead-end retries per lookup before falling through to the public endpoint, which is the only
 * one that has ever actually worked in production here).
 */
function getAppwriteEndpoints() {
	return [process.env.APPWRITE_FUNCTION_ENDPOINT, 'https://api.cloud.shotty.tech/v1'].filter(
		(endpoint, idx, arr) => endpoint && arr.indexOf(endpoint) === idx
	);
}

/** Internal Docker/compose-network endpoints sit behind a reverse proxy that routes by Host
 * header, so requests to them need a spoofed Host header matching the public domain. */
function needsHostOverride(endpoint) {
	return endpoint.includes('172.') || endpoint.includes('docker') || endpoint.includes('appwrite');
}

module.exports = { getAppwriteEndpoints, needsHostOverride };
