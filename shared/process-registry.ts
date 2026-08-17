/**
 * Process-wide slots for state that has to cross extension boundaries.
 *
 * Pi loads every extension entry point through its own jiti instance with module caching disabled
 * (`core/extensions/loader.js`), so a module two extensions both import is evaluated twice and its
 * module-scoped state is not shared. Anything safety, plan-mode, and confirm-bash must agree on
 * therefore hangs off a `Symbol.for` slot on `globalThis`, which is the only scope every copy of a
 * module reaches.
 *
 * Keys carry a version suffix. A copy of this package left behind by a partial reload must not read
 * a differently shaped value written by a newer one; bump the suffix whenever a slot's shape changes.
 */

export function sharedState<T extends object>(key: string, create: () => T): T {
	const slot = Symbol.for(`pidantic.${key}`);
	const host = globalThis as unknown as Record<symbol, T | undefined>;
	const existing = host[slot];
	if (existing) return existing;
	const created = create();
	host[slot] = created;
	return created;
}
