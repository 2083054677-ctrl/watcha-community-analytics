import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "观猹渠道增长工作台",
  description: "直接连接 ClickHouse 的本地渠道增长监控工作台",
  icons: { icon: "/favicon.svg" },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="zh-CN">
      <body>{children}</body>
    </html>
  );
}
