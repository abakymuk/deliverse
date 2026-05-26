/**
 * Email-verification template — platform-only today.
 *
 * Props discriminated by `instance` (single arm today) so a future storefront
 * variant slots in symmetrically with `password-reset.tsx` (DEL-6 spec §4
 * decision #5).
 *
 * Shared chrome from `./_styles`. Imports from the unified `react-email`
 * package (ADR-0011).
 */

import { Body, Button, Container, Head, Heading, Html, Preview, Section, Text } from 'react-email';
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

export type EmailVerificationEmailProps = {
  instance: 'platform';
  url: string;
};

export function EmailVerificationEmail(props: EmailVerificationEmailProps) {
  return (
    <Html>
      <Head>
        <title>{`Verify your email — ${DELIVERSE_NAME}`}</title>
      </Head>
      <Preview>{`Verify your email for ${DELIVERSE_NAME}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            <Heading as="h1" style={{ ...brandHeadingStyle, color: DELIVERSE_PRIMARY }}>
              {DELIVERSE_NAME}
            </Heading>
          </Section>

          <Section style={contentStyle}>
            <Heading as="h2" style={{ ...headingStyle, color: DELIVERSE_PRIMARY }}>
              Verify your email
            </Heading>
            <Text style={textStyle}>Click the button below to verify your email address.</Text>
            <Section style={{ textAlign: 'center', margin: '0 0 24px 0' }}>
              <Button
                href={props.url}
                style={{ ...buttonStyle, backgroundColor: DELIVERSE_PRIMARY }}
              >
                Verify email
              </Button>
            </Section>
            <Text style={mutedTextStyle}>
              This link expires in 1 hour. If you didn&apos;t request this, you can safely ignore
              this email.
            </Text>
          </Section>

          <Section style={footerStyle}>
            <Text style={footerTextStyle}>{`Sent by ${DELIVERSE_NAME}.`}</Text>
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

export default EmailVerificationEmail;
