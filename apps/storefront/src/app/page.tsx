import { redirect } from 'next/navigation';

export default function HomePage() {
  // Will be handled by (shop) group
  redirect('/');
}
