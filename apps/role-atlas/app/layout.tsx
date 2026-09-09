import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
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
  title: "Role Atlas · 岗位智能工作台",
  description: "以版本化岗位快照、证据图谱和结构化引用为基础的岗位智能体工作台。",
  openGraph: {
    title: "Role Atlas · 岗位智能工作台",
    description: "从证据化岗位快照到可交互知识图谱。",
    images: [{ url: "/role-atlas-social.png", width: 1672, height: 941 }],
  },
  twitter: {
    card: "summary_large_image",
    images: ["/role-atlas-social.png"],
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN">
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased`}
      >
        {children}
        <script defer src="/site-session.js" />
      </body>
    </html>
  );
}
