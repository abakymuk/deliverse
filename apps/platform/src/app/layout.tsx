import type { Metadata } from 'next';
import '@rp/ui/globals.css';

export const metadata: Metadata = {
  title: 'Restaurant Platform — Admin',
  description: 'Platform administration',
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
