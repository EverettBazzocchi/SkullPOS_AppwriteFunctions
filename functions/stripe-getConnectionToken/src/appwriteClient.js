import { Client } from 'node-appwrite';
import dns from 'dns';

// This self-hosted instance's function-execution sandbox can't resolve its
// own public hostname via the normal getaddrinfo path (used internally by
// fetch/http under the hood) -- dns.resolve4 (talks to nameservers
// directly, bypassing getaddrinfo) works fine though. Patch the global
// lookup so any HTTP client resolving this hostname gets the known-good IP
// instead of hanging/EAI_AGAIN; the URL/Host header is untouched, only the
// DNS step is bypassed.
let patchedHost = null;

async function ensureDnsPatched(hostname) {
	if (patchedHost === hostname) return;
	const [ip] = await dns.promises.resolve4(hostname);
	const origLookup = dns.lookup;
	dns.lookup = (host, options, callback) => {
		if (typeof options === 'function') callback = options;
		if (host === hostname) return callback(null, ip, 4);
		return origLookup(host, options, callback);
	};
	patchedHost = hostname;
}

export async function createAppwriteClient(req) {
	const endpoint = process.env.APPWRITE_FUNCTION_API_ENDPOINT;
	await ensureDnsPatched(new URL(endpoint).hostname);
	return new Client()
		.setEndpoint(endpoint)
		.setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
		.setKey(req.headers['x-appwrite-key'] ?? '');
}
