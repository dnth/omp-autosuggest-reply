// Ambient shim for `bun:test` typings. @types/bun is now a devDependency that
// provides these at type-check time; this shim remains as a belt-and-suspenders
// fallback for editors that cannot resolve the package. Do not import this from
// source code.
declare module "bun:test" {
	export function describe(name: string, fn: () => void): void;
	export function test(name: string, fn: () => void | Promise<void>): void;
	export function expect<T>(value: T): {
		toBe(expected: T): void;
		toEqual(expected: unknown): void;
		toBeGreaterThan(n: number): void;
		toBeLessThan(n: number): void;
		toBeLessThanOrEqual(n: number): void;
		toHaveLength(n: number): void;
		toBeUndefined(): void;
		toBeDefined(): void;
		toBeNull(): void;
		toBeTrue(): void;
		toBeFalse(): void;
		toContain(s: string): void;
		toContainEqual(item: unknown): void;
		not: {
			toBe(expected: T): void;
			toEqual(expected: unknown): void;
			toBeGreaterThan(n: number): void;
			toBeLessThan(n: number): void;
			toBeLessThanOrEqual(n: number): void;
			toHaveLength(n: number): void;
			toBeUndefined(): void;
			toBeDefined(): void;
			toBeNull(): void;
			toContain(s: string): void;
			toContainEqual(item: unknown): void;
		};
	};
	export function beforeEach(fn: () => void): void;
	export function afterEach(fn: () => void): void;
	export function mock<T extends (...args: never[]) => unknown>(fn: T): T;
	export const vi: {
		useFakeTimers(options?: { now?: number | Date }): unknown;
		useRealTimers(): unknown;
		advanceTimersByTime(ms: number): unknown;
	};
}
