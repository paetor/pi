import { setupCli } from "./cli/setup.ts";
import { type MainOptions, main } from "./main.ts";

export type { MainOptions } from "./main.ts";

/** Run the normal CLI with host-owned initialization, without changing installed files. */
export async function runCli(args: string[], options: MainOptions = {}): Promise<void> {
	setupCli();
	await main(args, options);
}
