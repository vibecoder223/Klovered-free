/** @type {import('next').NextConfig} */
const PY_API_URL = process.env.PY_API_URL ?? "http://localhost:8000";

const nextConfig = {
  // Keep these out of the server bundle. pdfjs-dist in particular breaks when
  // bundled: it can't resolve its worker module ("Setting up fake worker
  // failed: Cannot find module .../pdf.worker.mjs"), which failed every PDF
  // upload. Externalized, Node loads them from node_modules and they work.
  serverExternalPackages: ["pdf-parse", "pdfkit", "pdfjs-dist", "mammoth", "docx", "docxtemplater"],
  async rewrites() {
    // Proxy the Python pipeline API so the browser keeps a single origin
    // (cookies + same-origin fetch). Routes that stay in Next (/api/session,
    // /api/auth/callback) are NOT under /api/pipeline and are unaffected.
    return [{ source: "/api/pipeline/:path*", destination: `${PY_API_URL}/api/pipeline/:path*` }];
  },
};

export default nextConfig;
