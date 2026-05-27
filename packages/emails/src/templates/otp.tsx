/**
 * Branded OTP email template (React Email v6) — discriminated by `mode`
 * (DEL-22).
 *
 *   - mode='brand' (legacy): brand-themed header (logo or brand name + brand
 *     color), footer attributes "Sent by ${brand.name}".
 *   - mode='tenant' (DEL-22, food-hall): storefront-themed header using
 *     storefront.brandingJson; falls back to tenant.logo, then to
 *     DELIVERSE_PRIMARY. Footer attributes "Sent by ${storefront.name}".
 *
 * The `type` prop drives the headline + the action verb; everything else is
 * shared across the three OTP flows.
 *
 * Imports come from the unified `react-email` package (ADR-0011 §Surprise #1:
 * `react-email@6.3.3` re-exports every component).
 *
 * Shared layout chrome lives in `./_styles`. OTP-specific `codeStyle` stays inline.
 */

import type { Brand, Storefront, Tenant } from '@rp/db';
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

export type OtpEmailProps =
  | {
      mode: 'brand';
      brand: Brand;
      tenant: Tenant;
      otp: string;
      type: 'otp_login' | 'email_verify' | 'password_reset';
    }
  | {
      mode: 'tenant';
      storefront: Storefront;
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

type Rendered = {
  displayName: string;
  primary: string;
  logoUrl: string | null | undefined;
  footerLine: string;
};

function resolveBranding(props: OtpEmailProps): Rendered {
  if (props.mode === 'tenant') {
    // DEL-22 tenant-default branding fallback chain:
    //   storefront.brandingJson.{primary,logo} → tenant.logo / DELIVERSE_PRIMARY.
    const displayName = props.storefront.name || props.tenant.name;
    return {
      displayName,
      primary: props.storefront.brandingJson?.primary ?? DELIVERSE_PRIMARY,
      logoUrl: props.storefront.brandingJson?.logo ?? props.tenant.logo,
      footerLine: `Sent by ${displayName}.`,
    };
  }
  // mode: 'brand'
  return {
    displayName: props.brand.name,
    primary: props.brand.brandingJson?.primary ?? DELIVERSE_PRIMARY,
    logoUrl: props.brand.brandingJson?.logo,
    footerLine: `Sent by ${props.brand.name}${
      props.tenant.name !== props.brand.name ? ` (${props.tenant.name})` : ''
    }.`,
  };
}

export function OtpEmail(props: OtpEmailProps) {
  const { heading, instruction } = COPY[props.type];
  const { displayName, primary, logoUrl, footerLine } = resolveBranding(props);

  return (
    <Html>
      <Head>
        <title>{`${heading} — ${displayName}`}</title>
      </Head>
      <Preview>{`${heading} for ${displayName}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            {logoUrl ? (
              <Img src={logoUrl} alt={displayName} width={120} style={{ display: 'block' }} />
            ) : (
              <Heading as="h1" style={{ ...brandHeadingStyle, color: primary }}>
                {displayName}
              </Heading>
            )}
          </Section>

          <Section style={contentStyle}>
            <Heading as="h2" style={{ ...headingStyle, color: primary }}>
              {heading}
            </Heading>
            <Text style={textStyle}>{instruction}</Text>
            <Text style={codeStyle}>{props.otp}</Text>
            <Text style={mutedTextStyle}>
              This code expires in 10 minutes. If you didn&apos;t request it, you can safely ignore
              this email.
            </Text>
          </Section>

          <Section style={footerStyle}>
            <Text style={footerTextStyle}>{footerLine}</Text>
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
