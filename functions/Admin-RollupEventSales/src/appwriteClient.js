import { Client } from 'node-appwrite';
import { installDnsPatch } from './dnsPatch.js';

// Install the resolver workaround at import time. This is deliberately SYNCHRONOUS and deliberately
// not awaited: the previous version awaited a DNS round trip here, before the handler ran a single
// line, and under concurrent cold starts that is what left executions dead at their timeout ceiling
// with empty logs. See dnsPatch.js for the measurements and the reasoning.
installDnsPatch();

export function createAppwriteClient(req) {
	return new Client()
		.setEndpoint(process.env.APPWRITE_FUNCTION_API_ENDPOINT)
		.setProject(process.env.APPWRITE_FUNCTION_PROJECT_ID)
		.setKey(req.headers['x-appwrite-key'] ?? '');
}
