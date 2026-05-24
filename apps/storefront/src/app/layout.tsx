import type { Metadata } from 'next';
import '@rp/ui/globals.css';

export const metadata: Metadata = {
  title: 'Restaurant',
  description: 'Order from your favorite restaurant',
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
