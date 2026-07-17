/** @type {import('next').NextConfig} */
const nextConfig = {
  // Self-contained server bundle (.next/standalone) for Docker on the Droplet.
  output: "standalone",
  // The tool is served at klovered.com/app (Caddy path-routes /app -> this
  // container). basePath makes Next emit all page routes and asset URLs under
  // /app so they don't collide with the marketing site at the domain root.
  // Client fetches to "/api/*" stay origin-relative (NOT under /app) and Caddy
  // routes them to the Python backend.
  basePath: "/app",
};

export default nextConfig;
