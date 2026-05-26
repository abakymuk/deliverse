/**
 * Shared layout chrome for all email templates.
 *
 * Extracted in DEL-6 once we had three templates (OTP, password reset, email
 * verification) and the same chrome was repeated. Per-template specifics
 * (OTP's `codeStyle`, password-reset/verify's `buttonStyle`) stay inline in
 * their templates.
 */

export const bodyStyle = {
  backgroundColor: '#f8fafc',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  margin: '0',
  padding: '0',
};

export const containerStyle = {
  margin: '0 auto',
  maxWidth: '480px',
  padding: '32px 16px',
};

export const headerStyle = {
  marginBottom: '24px',
  textAlign: 'center' as const,
};

export const brandHeadingStyle = {
  fontSize: '24px',
  fontWeight: '700',
  margin: '0',
};

export const contentStyle = {
  backgroundColor: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '32px 24px',
};

export const headingStyle = {
  fontSize: '20px',
  fontWeight: '600',
  margin: '0 0 16px 0',
};

export const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 24px 0',
};

export const mutedTextStyle = {
  color: '#6b7280',
  fontSize: '14px',
  lineHeight: '20px',
  margin: '0',
};

export const footerStyle = {
  marginTop: '24px',
  textAlign: 'center' as const,
};

export const footerTextStyle = {
  color: '#9ca3af',
  fontSize: '12px',
  margin: '0',
};

/**
 * Default primary color used by platform-instance variants (and as a fallback
 * for storefront-instance templates when `brand.brandingJson.primary` is unset).
 */
export const DELIVERSE_PRIMARY = '#111827';

/**
 * Display name used in platform-instance template headers. Storefront variants
 * render `brand.name` instead.
 */
export const DELIVERSE_NAME = 'Deliverse';
