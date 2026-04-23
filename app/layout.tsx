import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ThemeProvider } from "@/components/ThemeProvider";
import { Toaster } from "sonner";
import "../src/index.css";

export const metadata: Metadata = {
  title: "Simple Accounting HRIS",
  description: "Dedicated accounting HRIS for payroll, reconciliation, and workforce operations",
  icons: {
    icon: "/icon.svg",
    shortcut: "/icon.svg",
    apple: "/favicon.png",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: ReactNode;
}>) {
  return (
    <html lang="en" className="light" suppressHydrationWarning>
      <body>
        <ThemeProvider
          attribute="class"
          defaultTheme="light"
          enableSystem={false}
          storageKey="simple-hris-ui-v4"
          disableTransitionOnChange
        >
          {children}
          <Toaster position="top-right" richColors closeButton />
        </ThemeProvider>
      </body>
    </html>
  );
}
