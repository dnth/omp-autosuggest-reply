/**
 * Test-only module augmentation for the OMP API typecheck (tsconfig.omp.json).
 *
 * OMP's canonical `@oh-my-pi/pi-coding-agent` barrel does not re-export
 * `CONFIG_DIR_NAME` — only its legacy-compat shim (which OMP serves for
 * `@earendil-works/pi-coding-agent` root imports at runtime) does. This file
 * adds that export to the mapped module so the extension source typechecks
 * against the surface OMP actually provides at runtime.
 *
 * Excluded from the normal Pi typecheck (tsconfig.json) via `exclude`.
 */
declare module "@earendil-works/pi-coding-agent" {
	export const CONFIG_DIR_NAME: string;
}

export {};
