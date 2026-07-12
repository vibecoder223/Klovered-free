/** @type {import('next').NextConfig} */
const nextConfig = {
  // Keep these out of the server bundle. pdfjs-dist in particular breaks when
  // bundled: it can't resolve its worker module ("Setting up fake worker
  // failed: Cannot find module .../pdf.worker.mjs"), which failed every PDF
  // upload. Externalized, Node loads them from node_modules and they work.
  serverExternalPackages: ["pdf-parse", "pdfkit", "pdfjs-dist", "mammoth", "docx", "docxtemplater"],
};

export default nextConfig;
