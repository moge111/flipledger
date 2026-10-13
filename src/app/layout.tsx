import type { Metadata } from "next";
import { Archivo, JetBrains_Mono } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/layout/Sidebar";

// Archivo is variable (wdth 62–125, all weights): no `weight` option
const archivo = Archivo({
  subsets: ["latin"],
  axes: ["wdth"],
  variable: "--font-archivo",
  display: "swap",
});

const mono = JetBrains_Mono({
  subsets: ["latin"],
  variable: "--font-jbmono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "FlipLedger — Multi-marketplace Profit Tracking",
  description: "Profit tracking and bookkeeping for Amazon, Walmart, and eBay resellers",
};

// Light/dark before first paint: the saved ◐ choice if there is one, else the OS setting.
const themeScript = `(function(){var r=document.documentElement,s=null;
try{s=localStorage.getItem("fl-theme")}catch(e){}
var m=matchMedia("(prefers-color-scheme: dark)");
function a(){r.dataset.mode=s||(m.matches?"dark":"light")}a();
m.addEventListener&&m.addEventListener("change",a)})();`;

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning className={`${archivo.variable} ${mono.variable} h-full`}>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeScript }} />
      </head>
      <body className="font-sans h-full bg-bg-root text-text-primary antialiased">
        <div className="flex h-full flex-col lg:flex-row">
          <Sidebar />
          <main className="flex-1 overflow-y-auto">
            <div className="p-4 sm:p-6 lg:p-8">
              {children}
            </div>
          </main>
        </div>
      </body>
    </html>
  );
}
