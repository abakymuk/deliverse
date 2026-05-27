/**
 * Password-reset email template — discriminated by `instance` and (for
 * storefront) by `mode` (DEL-22).
 *
 *   - platform: neutral "Deliverse" header + DELIVERSE_PRIMARY color.
 *   - storefront + mode='brand' (legacy): brand-themed header (logo or brand
 *     name + brand color), subject "Reset your password for <brand>".
 *   - storefront + mode='tenant' (DEL-22, food-hall): storefront-themed header
 *     using storefront.brandingJson; falls back to tenant.logo, then to
 *     DELIVERSE_PRIMARY. Subject "Reset your password for <storefront>".
 *
 * Tenant-mode footer omits the parenthetical tenant name — the storefront IS
 * the tenant-facing entity (see docs/specs/ba-brand-optional.md §"API surface").
 *
 * Shared chrome from `./_styles`. Per-template button styles defined inline.
 * Imports from the unified `react-email` package (ADR-0011).
 */

import type { Brand, Storefront, Tenant } from '@rp/db';
import {
  Body,
  Button,
  Container,
  Head,
  Heading,
  Html,
  Img,
  Preview,
  Section,
  Text,
} from 'react-email';
import {
  DELIVERSE_NAME,
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

export type PasswordResetEmailProps =
  | {
      instance: 'platform';
      url: string;
    }
  | {
      instance: 'storefront';
      mode: 'brand';
      brand: Brand;
      tenant: Tenant;
      url: string;
    }
  | {
      instance: 'storefront';
      mode: 'tenant';
      storefront: Storefront;
      tenant: Tenant;
      url: string;
    };

type Rendered = {
  displayName: string;
  primary: string;
  logoUrl: string | null | undefined;
  footerLine: string;
};

function resolveBranding(props: PasswordResetEmailProps): Rendered {
  if (props.instance === 'platform') {
    return {
      displayName: DELIVERSE_NAME,
      primary: DELIVERSE_PRIMARY,
      logoUrl: undefined,
      footerLine: `Sent by ${DELIVERSE_NAME}.`,
    };
  }
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
  // mode: 'brand' (legacy storefront)
  return {
    displayName: props.brand.name,
    primary: props.brand.brandingJson?.primary ?? DELIVERSE_PRIMARY,
    logoUrl: props.brand.brandingJson?.logo,
    footerLine: `Sent by ${props.brand.name}${
      props.tenant.name !== props.brand.name ? ` (${props.tenant.name})` : ''
    }.`,
  };
}

export function PasswordResetEmail(props: PasswordResetEmailProps) {
  const { displayName, primary, logoUrl, footerLine } = resolveBranding(props);

  return (
    <Html>
      <Head>
        <title>{`Reset your password — ${displayName}`}</title>
      </Head>
      <Preview>{`Reset your password for ${displayName}`}</Preview>
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
              Reset your password
            </Heading>
            <Text style={textStyle}>Click the button below to reset your password.</Text>
            <Section style={{ textAlign: 'center', margin: '0 0 24px 0' }}>
              <Button href={props.url} style={{ ...buttonStyle, backgroundColor: primary }}>
                Reset password
              </Button>
            </Section>
            <Text style={mutedTextStyle}>
              This link expires in 1 hour. If you didn&apos;t request this, you can safely ignore
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

const buttonStyle = {
  borderRadius: '6px',
  color: '#ffffff',
  display: 'inline-block',
  fontSize: '16px',
  fontWeight: '600',
  padding: '12px 24px',
  textDecoration: 'none',
};

export default PasswordResetEmail;
