import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";
import { DefaultPackageManager } from "../src/core/package-manager.ts";
import { main } from "../src/main.ts";
import { handlePackageCommand } from "../src/package-manager-cli.ts";

describe("trusted host self-update", () => {
	let home: string;
	let exitCode: typeof process.exitCode;
	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-host-update-"));
		exitCode = process.exitCode;
		vi.stubEnv(ENV_AGENT_DIR, home);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("PI_MANAGED_INSTALL_ROOT", "");
		vi.stubGlobal(
			"fetch",
			vi.fn(() => {
				throw new Error("Stock feed must not be contacted");
			}),
		);
		vi.spyOn(console, "log").mockImplementation(() => {});
		vi.spyOn(console, "error").mockImplementation(() => {});
	});
	afterEach(() => {
		process.exitCode = exitCode;
		vi.restoreAllMocks();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(home, { recursive: true, force: true });
	});
	it.each([["update"], ["update", "self"], ["update", "pi"], ["update", "--self"], ["update", "--force"]])(
		"delegates native self-update syntax %j without stock fallback",
		async (...args) => {
			const selfUpdate = vi.fn(async () => {});
			expect(await handlePackageCommand(args, { selfUpdate })).toBe(true);
			expect(selfUpdate).toHaveBeenCalledExactlyOnceWith({ force: args.includes("--force") });
			expect(fetch).not.toHaveBeenCalled();
		},
	);
	it("fails closed on host rejection", async () => {
		const selfUpdate = vi.fn(async () => {
			throw new Error("release-hash-mismatch");
		});
		await handlePackageCommand(["update"], { selfUpdate });
		expect(process.exitCode).toBe(1);
		expect(fetch).not.toHaveBeenCalled();
	});
	it("leaves extension updates native", async () => {
		const extensions = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const selfUpdate = vi.fn(async () => {});
		await handlePackageCommand(["update", "--extensions"], { selfUpdate });
		expect(extensions).toHaveBeenCalledOnce();
		expect(selfUpdate).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("handles --all through both existing package dispatch and the trusted callback", async () => {
		const extensions = vi.spyOn(DefaultPackageManager.prototype, "update").mockResolvedValue(undefined);
		const selfUpdate = vi.fn(async () => {});
		await handlePackageCommand(["update", "--all"], { selfUpdate });
		expect(extensions).toHaveBeenCalledOnce();
		expect(selfUpdate).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("does not invoke host code for help or invalid options", async () => {
		const selfUpdate = vi.fn(async () => {});
		await handlePackageCommand(["update", "--help"], { selfUpdate });
		await handlePackageCommand(["update", "--bogus"], { selfUpdate });
		expect(selfUpdate).not.toHaveBeenCalled();
		expect(fetch).not.toHaveBeenCalled();
	});
	it("the real main entrypoint forwards the trusted host hook", async () => {
		vi.spyOn(process, "exit").mockImplementation(() => {
			throw new Error("owned-cli-exit");
		});
		const selfUpdate = vi.fn(async () => {});
		await expect(main(["update"], { selfUpdate })).rejects.toThrow("owned-cli-exit");
		expect(selfUpdate).toHaveBeenCalledOnce();
		expect(fetch).not.toHaveBeenCalled();
	});
});
