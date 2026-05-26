/**
 * Invitation email template — platform-only (DEL-13).
 *
 * Neutral Deliverse branding per AC #4 ("no brand context"). Props discriminated
 * by `instance` (single arm today) so a future storefront variant slots in
 * symmetrically with `password-reset.tsx` / `email-verify.tsx` (DEL-6 spec §4
 * decision #5). Shared chrome from `./_styles`; imports from unified
 * `react-email` package (ADR-0011).
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

export type InvitationEmailProps = {
  instance: 'platform';
  inviterName: string;
  organizationName: string;
  url: string;
};

export function InvitationEmail(props: InvitationEmailProps) {
  const { inviterName, organizationName, url } = props;
  return (
    <Html>
      <Head>
        <title>{`You're invited to join ${organizationName} — ${DELIVERSE_NAME}`}</title>
      </Head>
      <Preview>{`${inviterName} invited you to join ${organizationName} on ${DELIVERSE_NAME}`}</Preview>
      <Body style={bodyStyle}>
        <Container style={containerStyle}>
          <Section style={headerStyle}>
            <Heading as="h1" style={{ ...brandHeadingStyle, color: DELIVERSE_PRIMARY }}>
              {DELIVERSE_NAME}
            </Heading>
          </Section>

          <Section style={contentStyle}>
            <Heading as="h2" style={{ ...headingStyle, color: DELIVERSE_PRIMARY }}>
              {`You're invited to join ${organizationName}`}
            </Heading>
            <Text style={textStyle}>
              {`${inviterName} invited you to join ${organizationName} on ${DELIVERSE_NAME}.`}
            </Text>
            <Section style={{ textAlign: 'center', margin: '0 0 24px 0' }}>
              <Button href={url} style={{ ...buttonStyle, backgroundColor: DELIVERSE_PRIMARY }}>
                Accept invitation
              </Button>
            </Section>
            <Text style={mutedTextStyle}>
              This invitation expires in 48 hours. If you didn&apos;t expect this, you can safely
              ignore this email.
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

export default InvitationEmail;
