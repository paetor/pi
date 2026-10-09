import { AsyncLocalStorage } from "node:async_hooks";
import type { AuthOperationOptions, Credential, CredentialInfo, CredentialStore } from "@earendil-works/pi-ai";

/** Async credential store overlay for non-persistent runtime API keys. */
export class RuntimeCredentials implements CredentialStore {
	private readonly store: CredentialStore;
	private readonly overrides = new Map<string, string>();
	private readonly stores = new Map<string, CredentialStore>();
	private readonly scope = new AsyncLocalStorage<ReadonlyMap<string, CredentialStore>>();

	/** Pin store ownership across read/refresh/write even if the next request changes account. */
	withScope<T>(operation: () => T): T {
		return this.scope.run(this.scope.getStore() ?? new Map(this.stores), operation);
	}

	setCredentialStore(providerId: string, store: CredentialStore | undefined): CredentialStore | undefined {
		if (store && this.overrides.has(providerId))
			throw new Error("Remove the runtime API key before routing credentials.");
		const previous = this.stores.get(providerId);
		if (store) this.stores.set(providerId, store);
		else this.stores.delete(providerId);
		return previous;
	}

	getCredentialStoreProviders(): readonly string[] {
		return [...this.stores.keys()];
	}

	getCredentialStore(providerId: string): CredentialStore | undefined {
		return this.stores.get(providerId);
	}

	private selectedStore(providerId: string): CredentialStore {
		return (this.scope.getStore() ?? this.stores).get(providerId) ?? this.store;
	}

	constructor(store: CredentialStore) {
		this.store = store;
	}

	/** App-owned stores may require enrollment outside the generic provider login UI. */
	beforeLogin(providerId: string): void {
		const store: CredentialStore & { beforeLogin?: (providerId: string) => void } = this.selectedStore(providerId);
		store.beforeLogin?.(providerId);
	}

	setRuntimeApiKey(providerId: string, apiKey: string): void {
		if (this.stores.has(providerId))
			throw new Error("Remove the routed credential store before setting a runtime API key.");
		this.overrides.set(providerId, apiKey);
	}

	removeRuntimeApiKey(providerId: string): void {
		this.overrides.delete(providerId);
	}

	hasRuntimeApiKey(providerId: string): boolean {
		return this.overrides.has(providerId);
	}

	async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
		options?.signal?.throwIfAborted();
		const capturedStore = this.scope.getStore()?.get(providerId);
		if (capturedStore) return capturedStore.read(providerId, options);
		const override = this.overrides.get(providerId);
		return override ? { type: "api_key", key: override } : this.selectedStore(providerId).read(providerId, options);
	}

	async list(options?: AuthOperationOptions): Promise<readonly CredentialInfo[]> {
		const entries = new Map((await this.store.list(options)).map((entry) => [entry.providerId, entry]));
		options?.signal?.throwIfAborted();
		for (const [providerId, store] of this.scope.getStore() ?? this.stores) {
			entries.delete(providerId);
			const entry = (await store.list(options)).find((candidate) => candidate.providerId === providerId);
			if (entry) entries.set(providerId, entry);
		}
		for (const providerId of this.overrides.keys()) {
			if (this.scope.getStore()?.has(providerId)) continue;
			entries.set(providerId, { providerId, type: "api_key" });
		}
		return [...entries.values()];
	}

	modify(
		providerId: string,
		fn: (current: Credential | undefined) => Promise<Credential | undefined>,
		options?: AuthOperationOptions,
	): Promise<Credential | undefined> {
		return this.selectedStore(providerId).modify(providerId, fn, options);
	}

	async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
		options?.signal?.throwIfAborted();
		await this.selectedStore(providerId).delete(providerId, options);
		this.overrides.delete(providerId);
	}
}
