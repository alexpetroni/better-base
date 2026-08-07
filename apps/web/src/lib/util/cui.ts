/**
 * Romanian CUI (cod unic de înregistrare), with or without the RO VAT prefix:
 * 2–10 digits. Shared by the settings registry (issuer identification) and
 * the checkout's optional B2B buyer capture.
 */
export const CUI_PATTERN = /^(RO)?\d{2,10}$/i;
