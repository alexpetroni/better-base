/**
 * The ANAF SPV submission seam. Real e-Factura submission needs things only a
 * human can produce — a qualified certificate, SPV enrollment for the CUI and
 * an OAuth registration in the ANAF developer portal (the exact steps live in
 * DEPLOYMENT.md § e-Factura and LAUNCH-CHECKLIST.md) — so the DEFAULT
 * submitter is an explicit no-op that reports `skipped`. Nothing in this
 * codebase fakes a submission: until the enrollment exists, the generated
 * XML is stored (S3) and downloadable for manual upload to the SPV web form.
 */

export interface EFacturaSubmission {
	invoiceId: string;
	displayNumber: string;
	xml: string;
}

export type EFacturaSubmitOutcome =
	/** No ANAF credentials configured — the artifact exists, nothing was sent. */
	{ status: 'skipped'; reason: string } | { status: 'submitted'; ref: string };

export interface EFacturaSubmitter {
	submit(submission: EFacturaSubmission): Promise<EFacturaSubmitOutcome>;
}

export const noopEFacturaSubmitter: EFacturaSubmitter = {
	async submit() {
		return { status: 'skipped', reason: 'anaf-not-configured' };
	}
};

/**
 * Provider selection, chat-provider style: the no-op is the default; asking
 * for the real thing before it exists is a hard error, never a silent fake.
 */
export function selectEFacturaSubmitter(
	env: Record<string, string | undefined>
): EFacturaSubmitter {
	if (env.ANAF_EFACTURA_ENABLED === 'true') {
		throw new Error(
			'ANAF_EFACTURA_ENABLED is set but the SPV submitter is not implemented: ' +
				'submission requires a qualified certificate + SPV/OAuth enrollment ' +
				'(see DEPLOYMENT.md § e-Factura). Unset the variable, or implement the ' +
				'adapter against the enrolled credentials.'
		);
	}
	return noopEFacturaSubmitter;
}
