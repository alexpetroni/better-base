import prettier from 'eslint-config-prettier';
import path from 'node:path';
import js from '@eslint/js';
import svelte from 'eslint-plugin-svelte';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import ts from 'typescript-eslint';

const gitignorePath = path.resolve(import.meta.dirname, '.gitignore');

export default defineConfig(
	includeIgnoreFile(gitignorePath),
	js.configs.recommended,
	ts.configs.recommended,
	svelte.configs.recommended,
	prettier,
	svelte.configs.prettier,
	{
		languageOptions: { globals: { ...globals.browser, ...globals.node } },
		rules: {
			// typescript-eslint strongly recommend that you do not use the no-undef lint rule on TypeScript projects.
			// see: https://typescript-eslint.io/troubleshooting/faqs/eslint/#i-get-errors-from-the-no-undef-rule-about-global-variables-not-being-defined-even-though-there-are-no-typescript-errors
			'no-undef': 'off'
		}
	},
	{
		files: ['**/*.svelte', '**/*.svelte.ts', '**/*.svelte.js'],
		languageOptions: {
			parserOptions: {
				projectService: true,
				extraFileExtensions: ['.svelte'],
				parser: ts.parser
			}
		}
	},
	{
		rules: {
			// Module boundaries: cross-module code is imported ONLY via the barrel
			// ($lib/modules/<name>); within a module, use relative imports.
			'no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$lib/modules/*/*', '$lib/modules/*/*/**', '!$lib/modules/*/server'],
							message:
								'Cross-module imports must go through a module barrel: $lib/modules/<name> (universal) or $lib/modules/<name>/server (server-only)'
						}
					]
				}
			]
		}
	},
	{
		// Inside a module, a `../<sibling>/…` import reaches into ANOTHER module's
		// internals. Allowed cross-module coupling (see docs/STATE.md):
		//   - `../<module>/schema.ts` at runtime — FK relations/joins in one shared
		//     db make table objects unavoidable;
		//   - `import type` of anything — erased at runtime, rename-safe via tsc.
		// Every other cross-module import must go through $lib/util, $lib/db,
		// $lib/server or the module's barrel ($lib/modules/<name>[/server]).
		// Integration specs are exempt: they deliberately wire several modules
		// together (e.g. the quiz funnel against a real dry-run email sender).
		files: ['src/lib/modules/**/*.ts', 'src/lib/modules/**/*.svelte'],
		ignores: ['src/lib/modules/**/*.spec.ts'],
		rules: {
			'no-restricted-imports': 'off',
			'@typescript-eslint/no-restricted-imports': [
				'error',
				{
					patterns: [
						{
							group: ['$lib/modules/*/*', '$lib/modules/*/*/**', '!$lib/modules/*/server'],
							message:
								'Cross-module imports must go through a module barrel: $lib/modules/<name> (universal) or $lib/modules/<name>/server (server-only)'
						},
						{
							group: ['../*/*', '../*/**', '!../../**', '!../*/schema.ts'],
							allowTypeImports: true,
							message:
								"Runtime imports of a sibling module's internals are limited to its schema.ts (FK relations). Use $lib/util, $lib/db, $lib/server or the module's barrel instead; `import type` is always fine."
						}
					]
				}
			]
		}
	}
);
