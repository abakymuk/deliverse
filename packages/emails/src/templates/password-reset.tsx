/**
 * Password-reset email template — discriminated by `instance`.
 *
 *   - storefront variant: brand-themed header (logo or brand name + brand color),
 *     subject set by the handler to "Reset your password for <brand>".
 *   - platform variant: neutral "Deliverse" header + DELIVERSE_PRIMARY color.
 *
 * Shared chrome from `./_styles`. Per-template button styles defined inline.
 * Imports from the unified `react-email` package (ADR-0011).
 */

import type { Brand, Tenant } from '@rp/db';
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
      brand: Brand;
      tenant: Tenant;
      url: string;
    };

export function PasswordResetEmail(props: PasswordResetEmailProps) {
  const displayName = props.instance === 'storefront' ? props.brand.name : DELIVERSE_NAME;
  const primary =
    props.instance === 'storefront'
      ? (props.brand.brandingJson?.primary ?? DELIVERSE_PRIMARY)
      : DELIVERSE_PRIMARY;
  const logoUrl = props.instance === 'storefront' ? props.brand.brandingJson?.logo : undefined;

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
            <Text style={footerTextStyle}>
              {props.instance === 'storefront'
                ? `Sent by ${props.brand.name}${
                    props.tenant.name !== props.brand.name ? ` (${props.tenant.name})` : ''
                  }.`
                : `Sent by ${DELIVERSE_NAME}.`}
            </Text>
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
