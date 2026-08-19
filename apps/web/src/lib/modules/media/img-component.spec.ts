import { render } from 'svelte/server';
import { describe, expect, it } from 'vitest';
import type { ImageSources } from './image.ts';
import Img from './Img.svelte';

// SSR contract for the blurhash placeholder: with one, the <img> paints it as
// its background before the real bytes arrive; without one, the markup is
// byte-for-byte what it was before the feature (no style attribute at all).
const BASE: ImageSources = {
	src: 'http://imgproxy.test/sig/plain/s3://bucket/a.jpg@webp',
	srcsetWebp: 'http://imgproxy.test/w 320w',
	srcsetAvif: 'http://imgproxy.test/a 320w',
	width: 320,
	height: 200,
	alt: 'O poză',
	placeholder: null
};

const PLACEHOLDER = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg';

describe('<Img> blurhash placeholder', () => {
	it('paints the placeholder as the image background when present', () => {
		const { body } = render(Img, { props: { image: { ...BASE, placeholder: PLACEHOLDER } } });
		expect(body).toContain(`background-image: url(${PLACEHOLDER})`);
		expect(body).toContain('background-size: cover');
	});

	it('renders no style attribute when the row has no blurhash (unchanged behavior)', () => {
		const { body } = render(Img, { props: { image: BASE } });
		expect(body).not.toContain('style=');
		expect(body).not.toContain('background-image');
		expect(body).toContain('alt="O poză"');
	});
});
