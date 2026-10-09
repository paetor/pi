import type { CredentialStore, OAuthCredential } from "@earendil-works/pi-ai";
import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import { afterEach, expect, test, vi } from "vitest";
import { AuthStorage } from "../src/core/auth-storage.ts";
import { ModelRegistry } from "../src/core/model-registry.ts";
import { ModelRuntime } from "../src/core/model-runtime.ts";

const credential = (access: string, expires = Date.now() + 3600000): OAuthCredential => ({
	type: "oauth",
	access,
	refresh: `refresh-${access}`,
	expires,
});
afterEach(() => vi.restoreAllMocks());

async function fixture() {
	vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("Network disabled in routing tests"));
	const original = AuthStorage.inMemory({ openai: credential("original") });
	const runtime = await ModelRuntime.create({ credentials: original, modelsPath: null, allowModelNetwork: false });
	const native = builtinProviders().find((p) => p.id === "openai");
	if (!native?.auth.oauth) throw new Error("Native OAuth missing");
	const refresh = vi.fn(async (c: OAuthCredential) => credential(`${c.access}-renewed`));
	runtime.registerNativeProvider({
		...native,
		auth: { ...native.auth, oauth: { ...native.auth.oauth, refresh, toAuth: async (c) => ({ apiKey: c.access }) } },
	});
	await runtime.refresh({ allowNetwork: false });
	return { runtime, registry: new ModelRegistry(runtime), original, refresh };
}

test("public registry routes OAuth without modifying default credentials or losing subscription filtering", async () => {
	const { runtime, registry, original, refresh } = await fixture();
	const henk = AuthStorage.inMemory({ openai: credential("henk") });
	const harrie = AuthStorage.inMemory({ openai: credential("harrie") });
	await registry.setCredentialStore("openai", henk);
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("henk");
	expect(runtime.isUsingSubscription("openai")).toBe(true);
	expect(await runtime.getAvailableOfType("classifier", "openai")).toEqual([]);
	await registry.setCredentialStore("openai", harrie);
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("harrie");
	expect((await original.read("openai"))?.type).toBe("oauth");
	expect(await original.read("openai")).toMatchObject({ access: "original" });
	expect(refresh).not.toHaveBeenCalled();
	expect(globalThis.fetch).not.toHaveBeenCalled();
});

test("an auth operation pins read and rotated write to its original account during a competing switch", async () => {
	const { runtime, registry, original, refresh } = await fixture();
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((r) => {
		entered = r;
	});
	const blocked = new Promise<void>((r) => {
		release = r;
	});
	const expired = credential("henk", 1);
	const henk = AuthStorage.inMemory({ openai: expired });
	const harrie = AuthStorage.inMemory({ openai: credential("harrie") });
	refresh.mockImplementation(async (c) => {
		entered();
		await blocked;
		return credential(`${c.access}-renewed`);
	});
	await registry.setCredentialStore("openai", henk);
	const resolving = runtime.getAuth("openai");
	await started;
	await registry.setCredentialStore("openai", harrie);
	release();
	expect((await resolving)?.auth.apiKey).toBe("henk-renewed");
	expect(await henk.read("openai")).toMatchObject({ access: "henk-renewed" });
	expect(await harrie.read("openai")).toMatchObject({ access: "harrie" });
	expect(await original.read("openai")).toMatchObject({ access: "original" });
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("harrie");
});

test("a broken target store rolls back instead of silently leaving the wrong account selected", async () => {
	const { runtime, registry } = await fixture();
	const henk = AuthStorage.inMemory({ openai: credential("henk") });
	await registry.setCredentialStore("openai", henk);
	const broken: CredentialStore = {
		read: async () => {
			throw new Error("unreadable");
		},
		list: async () => [],
		modify: async () => undefined,
		delete: async () => {},
	};
	await expect(registry.setCredentialStore("openai", broken)).rejects.toThrow();
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("henk");
});

test("a switch between read and modify cannot refresh or return the new account", async () => {
	const { runtime, registry } = await fixture();
	const henk = AuthStorage.inMemory({ openai: credential("henk", 1) });
	const harrie = AuthStorage.inMemory({ openai: credential("harrie") });
	await registry.setCredentialStore("openai", henk);
	let entered!: () => void, release!: () => void;
	const started = new Promise<void>((resolve) => {
		entered = resolve;
	});
	const blocked = new Promise<void>((resolve) => {
		release = resolve;
	});
	const read = henk.read.bind(henk);
	vi.spyOn(henk, "read").mockImplementationOnce(async (...args) => {
		const value = await read(...args);
		entered();
		await blocked;
		return value;
	});
	const resolving = runtime.getAuth("openai");
	await started;
	await registry.setCredentialStore("openai", harrie);
	release();
	expect((await resolving)?.auth.apiKey).toBe("henk-renewed");
	expect(await harrie.read("openai")).toMatchObject({ access: "harrie" });
});

test("store inspection is explicit and native provider definitions never carry credentials", async () => {
	const parent = await fixture();
	const henk = AuthStorage.inMemory({ openai: credential("credential-secret-only-in-store") });
	await parent.registry.setCredentialStore("openai", henk);
	expect(parent.registry.getCredentialStore("openai")).toBe(henk);
	const native = parent.registry.getRegisteredNativeProvider("openai");
	if (!native) throw new Error("Registered provider missing");
	expect(JSON.stringify(native)).not.toContain("credential-secret-only-in-store");
	expect(Object.getOwnPropertyDescriptor(native, "credentialStore")).toBeUndefined();
});

test("managed routes and runtime API-key overrides cannot silently replace one another", async () => {
	const { runtime, registry } = await fixture();
	await registry.setCredentialStore("openai", AuthStorage.inMemory({ openai: credential("henk") }));
	expect(registry.getCredentialStoreProviders()).toEqual(["openai"]);
	await expect(runtime.setRuntimeApiKey("openai", "sk-fixture")).rejects.toThrow("Remove the routed");
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("henk");
	await registry.setCredentialStore("openai", undefined);
	await runtime.setRuntimeApiKey("openai", "sk-fixture");
	await expect(registry.setCredentialStore("openai", AuthStorage.inMemory({}))).rejects.toThrow("Remove the runtime");
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("sk-fixture");
});

test("app-owned login policy rejects before generic OAuth or API-key interaction", async () => {
	const { runtime, registry } = await fixture();
	const store = Object.assign(AuthStorage.inMemory({ openai: credential("henk") }), {
		beforeLogin() {
			throw new Error("account-command-required");
		},
	});
	await registry.setCredentialStore("openai", store);
	for (const type of ["oauth", "api_key"] as const) {
		await expect(
			runtime.login("openai", type, {
				notify() {
					throw new Error("must not notify");
				},
				async prompt() {
					throw new Error("must not prompt");
				},
			}),
		).rejects.toThrow("account-command-required");
	}
	expect((await runtime.getAuth("openai"))?.auth.apiKey).toBe("henk");
});

test("restoring an unavailable persisted binding fails closed rather than using default auth", async () => {
	const { runtime, registry } = await fixture();
	const missing: CredentialStore = {
		read: async () => {
			throw new Error("account unavailable");
		},
		list: async () => [],
		modify: async () => undefined,
		delete: async () => {},
	};
	await expect(registry.setCredentialStore("openai", missing, { retainOnFailure: true })).rejects.toThrow();
	await expect(runtime.getAuth("openai")).rejects.toThrow("account unavailable");
});

test("separate runtimes remain independent and managed logout never deletes default auth", async () => {
	const a = await fixture(),
		b = await fixture();
	const henk = AuthStorage.inMemory({ openai: credential("henk") }),
		harrie = AuthStorage.inMemory({ openai: credential("harrie") });
	await a.registry.setCredentialStore("openai", henk);
	await b.registry.setCredentialStore("openai", harrie);
	await a.runtime.logout("openai");
	expect(await henk.read("openai")).toBeUndefined();
	expect(await a.original.read("openai")).toMatchObject({ access: "original" });
	expect((await b.runtime.getAuth("openai"))?.auth.apiKey).toBe("harrie");
});
