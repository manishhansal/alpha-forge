import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";

import { Providers } from "@/components/providers";
import { THEME_INIT_SCRIPT } from "@/components/theme-provider";

import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: {
    default: "Alphaforge — Multi-market trading desk",
    template: "%s · Alphaforge",
  },
  description:
    "Alphaforge is a multi-market trading desk: live crypto + NSE F&O prices, futures and options analytics, AI signals, multi-strategy scalping, conversational strategy lab, and 5-year backtests — all in one screen.",
  applicationName: "Alphaforge",
  appleWebApp: { capable: true, statusBarStyle: "black-translucent", title: "Alphaforge" },
};

export const viewport: Viewport = {
  // Reported value is light by default; ThemeProvider keeps the live
  // `<html data-theme>` attribute in sync after hydration so PWA chrome
  // matches the active theme.
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#fafafa" },
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0a" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full`}
      suppressHydrationWarning
    >
      <head>
        {/* Apply the user's theme preference before React hydrates so the
            very first paint is already in the right palette — prevents a
            flash of incorrect theme on light-mode reloads. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_INIT_SCRIPT }} />
      </head>
      <body
        className="min-h-full bg-[var(--color-bg)] font-sans text-[var(--color-fg)] antialiased"
        suppressHydrationWarning
      >
        <Providers>{children}</Providers>
      </body>
    </html>
  );
}
