import type { Metadata, Viewport } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import NextAuthProvider from "@/components/auth/NextAuthProvider";
import CarlaSongToast from "@/components/common/CarlaSongToast";
import DispatchPaidToastsGlobal from "@/components/common/DispatchPaidToastsGlobal";
import { getServerSession } from "next-auth/next";
import { authOptions } from "@/lib/auth/auth-options";
import { Toaster } from "sonner";
import "../src/index.css";

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  viewportFit: "cover",
};

export const metadata: Metadata = {
  title: "Simple Accounting HRIS",
  description: "Dedicated accounting HRIS for payroll, reconciliation, and workforce operations",
  // The Employee Penny AI chat bubble heart (headset heart, `/Chatbubblev2.png`),
  // padded square and resized — the source is 538×464 so a raw reference would crop.
  icons: {
    icon: [
      { url: "/favicon-chatbubble-32.png", sizes: "32x32", type: "image/png" },
      { url: "/favicon-chatbubble-192.png", sizes: "192x192", type: "image/png" },
      { url: "/favicon-chatbubble-512.png", sizes: "512x512", type: "image/png" },
    ],
    shortcut: "/favicon-chatbubble-32.png",
    apple: "/apple-touch-icon.png",
  },
};

export default async function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  const session = await getServerSession(authOptions);
  return (
    <html lang="en" className="light" suppressHydrationWarning>
      <body className="min-h-dvh overflow-x-hidden">
        <NextAuthProvider session={session}>
          <ThemeProvider
            attribute="class"
            defaultTheme="light"
            enableSystem={false}
            storageKey="simple-hris-ui-v4"
            disableTransitionOnChange
          >
            {children}
            {/* Carla's sign-in song pill — root layout so it survives dashboard
                switches (client-side navs never remount this layout). Renders
                null for everyone else / when nothing is playing. */}
            <CarlaSongToast />
            {/* Lower-left "X paid Y $Z" cards while payroll is processing — root
                layout so EVERY dashboard shows them; the server decides who is
                authorized (Accounting → Payment Dispatch view access). */}
            <DispatchPaidToastsGlobal />
            <Toaster position="top-right" richColors closeButton />
          </ThemeProvider>
        </NextAuthProvider>
      </body>
    </html>
  );
}
