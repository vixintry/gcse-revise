import type { Metadata, Viewport } from 'next';
import Link from 'next/link';
import './globals.css';
import { ThemeToggle } from '@/components/ThemeToggle';
import { SyncBadge, SyncProvider } from '@/components/SyncProvider';

export const metadata: Metadata = { title: 'Retain: GCSE revision', description: 'Adaptive spaced-repetition flashcards for GCSE revision' };
export const viewport: Viewport = { width: 'device-width', initialScale: 1 };

const themeScript = `try{var t=localStorage.getItem('theme');if(t)document.documentElement.dataset.theme=t}catch(e){}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en-GB" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: themeScript }} /></head>
      <body>
        <SyncProvider>
        <header className="nav">
          <div className="nav-in">
            <Link href="/" className="brand">Retain</Link>
            <span className="row"><SyncBadge /><Link href="/memory" className="small">Notes</Link><ThemeToggle /></span>
          </div>
        </header>
        <main className="wrap">{children}</main>
        </SyncProvider>
      </body>
    </html>
  );
}
