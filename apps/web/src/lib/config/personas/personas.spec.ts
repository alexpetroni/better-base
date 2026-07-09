import { describe, expect, it } from 'vitest';
import { resolveSiteConfig } from '../index.ts';
import { CANONICAL_PILLARS } from '../pillars.ts';
import { resolvePersona } from './index.ts';

describe('chat personas', () => {
	it('sleep boot resolves the sleep-coach persona', () => {
		const site = resolveSiteConfig('sleep');
		const persona = resolvePersona(site.chatPersonaKey);
		expect(persona.key).toBe('sleep-coach');
	});

	it('life boot resolves the life-coach persona', () => {
		const site = resolveSiteConfig('life');
		const persona = resolvePersona(site.chatPersonaKey);
		expect(persona.key).toBe('life-coach');
	});

	it('the two site personas differ', () => {
		const sleep = resolvePersona(resolveSiteConfig('sleep').chatPersonaKey);
		const life = resolvePersona(resolveSiteConfig('life').chatPersonaKey);
		const input = { siteName: 'X' };
		expect(sleep.systemPrompt(input)).not.toBe(life.systemPrompt(input));
	});

	it('throws on an unknown persona key', () => {
		expect(() => resolvePersona('nope')).toThrow(/Unknown chat persona/);
	});

	it('sleep-coach is scoped to sleep, brand-free until interpolated', () => {
		const prompt = resolvePersona('sleep-coach').systemPrompt({ siteName: 'Better Sleep' });
		expect(prompt).toContain('Better Sleep');
		expect(prompt).toMatch(/somn/i);
		// The required stances: no medical advice, off-topic refusal, quiz funnel.
		expect(prompt).toMatch(/NU oferi sfaturi medicale/);
		expect(prompt).toMatch(/refuz[aă]/i);
		expect(prompt).toMatch(/chestionar/i);
	});

	it('life-coach covers all nine pillars', () => {
		const prompt = resolvePersona('life-coach').systemPrompt({ siteName: 'Better Life' });
		expect(prompt).toContain('Better Life');
		for (const pillar of CANONICAL_PILLARS) {
			expect(prompt.toLowerCase()).toContain(pillar.name.toLowerCase());
		}
		expect(prompt).toMatch(/NU oferi sfaturi medicale/);
		expect(prompt).toMatch(/refuz[aă]/i);
		expect(prompt).toMatch(/chestionar/i);
	});

	it('both sites enable the chat widget via config', () => {
		expect(resolveSiteConfig('sleep').chatWidget).toBe(true);
		expect(resolveSiteConfig('life').chatWidget).toBe(true);
	});
});
