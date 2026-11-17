import type { Metadata, Viewport } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";
import { AppShell } from "@/components/app-shell";
import { OpenPongCopilotProvider } from "@/components/copilot-provider";

const geistSans = Geist({ variable: "--font-geist-sans", subsets: ["latin"] });
const geistMono = Geist_Mono({ variable: "--font-geist-mono", subsets: ["latin"] });

export const metadata: Metadata = {
  title: {
    default: "OpenPong — Table Tennis Manager",
    template: "%s · OpenPong",
  },
  description:
    "An open, agent-first table tennis manager: ratings, matches, tournaments and coaching in one dashboard.",
  applicationName: "OpenPong",
  manifest: "/manifest.webmanifest",
  appleWebApp: {
    capable: true,
    title: "OpenPong",
    statusBarStyle: "black-translucent",
  },
  icons: {
    icon: [
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
      { url: "/icons/icon-512.png", sizes: "512x512", type: "image/png" },
    ],
    apple: [{ url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" }],
  },
  openGraph: {
    title: "OpenPong — Table Tennis Manager",
    description: "Ratings, matches, tournaments and an agent that runs them for you.",
    siteName: "OpenPong",
    type: "website",
  },
};

export const viewport: Viewport = {
  themeColor: "#070b0d",
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} antialiased`}>
        <OpenPongCopilotProvider>
          <AppShell>{children}</AppShell>
        </OpenPongCopilotProvider>
      </body>
    </html>
  );
}
