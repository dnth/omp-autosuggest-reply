// Ambient shim so the TypeScript LSP can resolve `bun:test` without a local
// @types/bun install. Bun provides these at runtime; this only satisfies the
// type-checker for editor diagnostics. Do not import this from source code.
declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function expect<T>(value: T): {
		toBe(expected: T): void;
		toEqual(expected: unknown): void;
		toBeGreaterThan(n: number): void;
		toBeLessThan(n: number): void;
		toHaveLength(n: number): void;
		toBeUndefined(): void;
		toBeDefined(): void;
		toContain(s: string): void;
		toContainEqual(item: unknown): void;
		not: {
			toBe(expected: T): void;
			toEqual(expected: unknown): void;
			toBeGreaterThan(n: number): void;
			toHaveLength(n: number): void;
		};
	};
	export function beforeEach(fn: () => void): void;
	export function afterEach(fn: () => void): void;
	export function mock<T extends (...args: never[]) => unknown>(fn: T): T;
}