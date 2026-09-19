import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import Script from "next/script";
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
  title: "Anvil — local AI filmmaking workspace",
  description:
    "Anvil is a local desktop workspace for AI-generated short films, social videos, and ads. Bring your own agent, bring your own API keys, and keep project files on your machine.",
  icons: {
    icon: [
      { url: "/favicon.ico", sizes: "any" },
      { url: "/favicon-32x32.png", type: "image/png", sizes: "32x32" },
    ],
    apple: { url: "/apple-touch-icon.png", sizes: "180x180" },
  },
};

const devPerformanceMeasureGuard = `
(() => {
  if (typeof performance === "undefined" || typeof performance.measure !== "function") return;
  const originalMeasure = performance.measure.bind(performance);
  performance.measure = function guardedMeasure(name, startOrMeasureOptions, endMark) {
    try {
      return originalMeasure(name, startOrMeasureOptions, endMark);
    } catch (error) {
      const message = error && typeof error === "object" && "message" in error
        ? String(error.message)
        : "";
      const label = String(name || "");
      if (
        message.includes("cannot have a negative time stamp") &&
        label.includes("ProjectWorkspacePage")
      ) {
        return undefined;
      }
      throw error;
    }
  };
})();
`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html
      lang="en"
      className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}
      suppressHydrationWarning
    >
      <body className="min-h-full bg-background text-foreground flex flex-col" suppressHydrationWarning>
        {process.env.NODE_ENV === "development" ? (
          <Script
            id="next-dev-performance-measure-guard"
            strategy="beforeInteractive"
            dangerouslySetInnerHTML={{ __html: devPerformanceMeasureGuard }}
          />
        ) : null}
        {children}
      </body>
    </html>
  );
}
