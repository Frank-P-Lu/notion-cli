import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { CallbackServer } from "./callback-server.js";
import { NotionOAuthProvider } from "./provider.js";
import { TokenStore } from "./token-store.js";

describe("NotionOAuthProvider", () => {
	let tmpDir: string;
	let store: TokenStore;
	let provider: NotionOAuthProvider;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "ncli-provider-test-"));
		store = new TokenStore(tmpDir);
		provider = new NotionOAuthProvider(store, { port: 51234 } as CallbackServer);
	});

	afterEach(() => {
		fs.rmSync(tmpDir, { recursive: true, force: true });
	});

	it("invalidates stale OAuth tokens so auth can restart without manual logout", async () => {
		store.saveTokens({ access_token: "old", refresh_token: "stale" });
		store.saveClientInfo({ client_id: "client-1" });
		store.saveCodeVerifier("verifier");

		await provider.invalidateCredentials("tokens");

		expect(store.readTokens()).toBeUndefined();
		expect(store.readClientInfo()).toEqual({ client_id: "client-1" });
		expect(store.readCodeVerifier()).toBe("verifier");
	});

	it("invalidates all MCP OAuth state without deleting the REST integration token", async () => {
		store.saveTokens({ access_token: "old", refresh_token: "stale" });
		store.saveClientInfo({ client_id: "client-1" });
		store.saveCodeVerifier("verifier");
		store.saveRestToken("ntn_rest_token");

		await provider.invalidateCredentials("all");

		expect(store.readTokens()).toBeUndefined();
		expect(store.readClientInfo()).toBeUndefined();
		expect(store.readCodeVerifier()).toBeUndefined();
		expect(store.readRestToken()).toBe("ntn_rest_token");
	});
});
