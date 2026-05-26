/**
 * Branded OTP email template (React Email v6).
 *
 * Imports come from the unified `react-email` package (ADR-0011 §Surprise #1:
 * `react-email@6.3.3` re-exports every component, the older deprecated
 * `@react-email/components` standalone is NOT installed).
 *
 * The `type` prop drives the headline + the action verb; everything else is
 * shared across the three OTP flows.
 */

import type { Brand, Tenant } from '@rp/db';
import { Body, Container, Head, Heading, Html, Img, Preview, Section, Text } from 'react-email';

export type OtpEmailProps = {
  brand: Brand;
  tenant: Tenant;
  otp: string;
  type: 'otp_login' | 'email_verify' | 'password_reset';
};

const COPY: Record<OtpEmailProps['type'], { heading: string; instruction: string }> = {
  otp_login: {
    heading: 'Your sign-in code',
    instruction: 'Enter this code to sign in.',
  },
  email_verify: {
    heading: 'Verify your email',
    instruction: 'Enter this code to verify your email address.',
  },
  password_reset: {
    heading: 'Reset your password',
    instruction: 'Enter this code to reset your password.',
  },
};

export function OtpEmail({ brand, tenant, otp, type }: OtpEmailProps) {
  const { heading, instruction } = COPY[type];
  const primary = brand.brandingJson?.primary ?? '#111827';
  const logoUrl = brand.brandingJson?.logo;

  return (
    <Html>
      <Head>
        <title>{`${heading} — ${brand.name}`}</title>
      </Head>
      <Preview>{`${heading} for ${brand.name}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            {logoUrl ? (
              <Img src={logoUrl} alt={brand.name} width={120} style={{ display: 'block' }} />
            ) : (
              <Heading as="h1" style={{ ...brandHeadingStyle, color: primary }}>
                {brand.name}
              </Heading>
            )}
          </Section>

          <Section style={contentStyle}>
            <Heading as="h2" style={{ ...headingStyle, color: primary }}>
              {heading}
            </Heading>
            <Text style={textStyle}>{instruction}</Text>
            <Text style={codeStyle}>{otp}</Text>
            <Text style={mutedTextStyle}>
              This code expires in 10 minutes. If you didn&apos;t request it, you can safely ignore
              this email.
            </Text>
          </Section>

          <Section style={footerStyle}>
            <Text style={footerTextStyle}>
              Sent by {brand.name}
              {tenant.name !== brand.name ? ` (${tenant.name})` : ''}.
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

const bodyStyle = {
  backgroundColor: '#f8fafc',
  fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', sans-serif",
  margin: '0',
  padding: '0',
};

const containerStyle = {
  margin: '0 auto',
  maxWidth: '480px',
  padding: '32px 16px',
};

const headerStyle = {
  marginBottom: '24px',
  textAlign: 'center' as const,
};

const brandHeadingStyle = {
  fontSize: '24px',
  fontWeight: '700',
  margin: '0',
};

const contentStyle = {
  backgroundColor: '#ffffff',
  border: '1px solid #e5e7eb',
  borderRadius: '8px',
  padding: '32px 24px',
};

const headingStyle = {
  fontSize: '20px',
  fontWeight: '600',
  margin: '0 0 16px 0',
};

const textStyle = {
  color: '#374151',
  fontSize: '16px',
  lineHeight: '24px',
  margin: '0 0 24px 0',
};

const codeStyle = {
  backgroundColor: '#f3f4f6',
  borderRadius: '6px',
  color: '#111827',
  fontFamily:
    "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, 'Liberation Mono', 'Courier New', monospace",
  fontSize: '32px',
  fontWeight: '600',
  letterSpacing: '8px',
  margin: '0 0 24px 0',
  padding: '16px 24px',
  textAlign: 'center' as const,
};

const mutedTextStyle = {
  color: '#6b7280',
  fontSize: '14px',
  lineHeight: '20px',
  margin: '0',
};

const footerStyle = {
  marginTop: '24px',
  textAlign: 'center' as const,
};

const footerTextStyle = {
  color: '#9ca3af',
  fontSize: '12px',
  margin: '0',
};

export default OtpEmail;
