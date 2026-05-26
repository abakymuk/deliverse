/**
 * Branded OTP email template (React Email v6).
 *
 * Imports come from the unified `react-email` package (ADR-0011 §Surprise #1:
 * `react-email@6.3.3` re-exports every component, the older deprecated
 * `@react-email/components` standalone is NOT installed).
 *
 * The `type` prop drives the headline + the action verb; everything else is
 * shared across the three OTP flows.
 *
 * Shared layout chrome lives in `./_styles` (extracted in DEL-6 once we had
 * three templates). OTP-specific `codeStyle` stays inline.
 */

import type { Brand, Tenant } from '@rp/db';
import { Body, Container, Head, Heading, Html, Img, Preview, Section, Text } from 'react-email';
import {
  DELIVERSE_PRIMARY,
  bodyStyle,
  brandHeadingStyle,
  containerStyle,
  contentStyle,
  footerStyle,
  footerTextStyle,
  headerStyle,
  headingStyle,
  mutedTextStyle,
  textStyle,
} from './_styles';

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
  const primary = brand.brandingJson?.primary ?? DELIVERSE_PRIMARY;
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

export default OtpEmail;
