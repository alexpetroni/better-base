/**
 * Svelte action for plain (non-`use:enhance`) POST forms: the moment a submit
 * is accepted, disable every submit button in the form so a double-click (or
 * an impatient re-click while the server is slow) can't fire the request
 * twice. Without JS the browser's native single navigation applies — this is
 * progressive enhancement, never a functional gate.
 *
 * `pageshow` re-enables the buttons: a bfcache restore (back button) would
 * otherwise bring the page back with dead buttons.
 */
export function singleSubmit(form: HTMLFormElement) {
	const buttons = () =>
		form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
			'button[type="submit"], input[type="submit"]'
		);
	const disable = () => {
		for (const button of buttons()) button.disabled = true;
	};
	const enable = () => {
		for (const button of buttons()) button.disabled = false;
	};
	form.addEventListener('submit', disable);
	window.addEventListener('pageshow', enable);
	return {
		destroy() {
			form.removeEventListener('submit', disable);
			window.removeEventListener('pageshow', enable);
		}
	};
}
