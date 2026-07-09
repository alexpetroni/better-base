import { describe, expect, it } from 'vitest';
import { MEDIA_REFERENCE_CHECKS } from './media-library.ts';

// Regression guard for the audit's hidden-global finding: media-delete
// protection is now an explicit list, and this pins it — dropping a module's
// check (or a tree-shake/import-order change) fails here, not in production.
describe('MEDIA_REFERENCE_CHECKS', () => {
	it('wires every media-referencing module into deleteMedia', () => {
		expect(MEDIA_REFERENCE_CHECKS.map((c) => c.name).sort()).toEqual(['articles', 'products']);
	});
});
