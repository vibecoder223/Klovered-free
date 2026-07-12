import "./globals.css";

export const metadata = { title: "Klovered Free: answer any RFP" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
