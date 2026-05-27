/**
 * Sanitizes a `?next=` redirect path so the form is safe to use as the sole
 * navigation target after BA sign-in succeeds.
 *
 * DEL-17 removed `callbackURL` from `signIn.email` calls (BA's redirect
 * plugin was racing the form's `router.push`), which means the form now
 * owns redirect safety end-to-end. Without sanitization, `?next=//evil.com`
 * → `router.push('//evil.com')` would navigate the browser off-site.
 *
 * Accepts only paths that resolve to the synthetic base origin (i.e. truly
 * relative paths). Rejects: null/empty, protocol-relative `//host`,
 * absolute URLs, `javascript:` and other schemes, raw or URL-encoded
 * backslashes, and values with leading/trailing whitespace.
 */
export function safeNextPath(value: string | null, fallback: string): string {
  if (!value || value !== value.trim()) return fallback;
  try {
    const parsed = new URL(value, 'http://internal.local');
    if (parsed.origin !== 'http://internal.local') return fallback;
    if (!parsed.pathname.startsWith('/') || parsed.pathname.startsWith('//')) return fallback;
    if (parsed.pathname.includes('\\') || /%5c/i.test(parsed.pathname)) return fallback;
    return `${parsed.pathname}${parsed.search}${parsed.hash}`;
  } catch {
    return fallback;
  }
}
