import { lifeCoach } from './life-coach.ts';
import { sleepCoach } from './sleep-coach.ts';
import type { Persona } from './types.ts';

export type { Persona } from './types.ts';

const PERSONAS: Record<string, Persona> = {
	[sleepCoach.key]: sleepCoach,
	[lifeCoach.key]: lifeCoach
};

/** Resolve a persona from a site config's `chatPersonaKey` (fails fast). */
export function resolvePersona(key: string): Persona {
	const persona = PERSONAS[key];
	if (!persona) {
		throw new Error(
			`Unknown chat persona key "${key}". Expected one of: ` + Object.keys(PERSONAS).join(', ')
		);
	}
	return persona;
}
