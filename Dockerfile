# Klovered Free (Next.js) — the guest-first RFP tool, served at klovered.com/app.
# Thin client: no Supabase, no pipeline. All auth + data go to the Python backend
# via /api/* (Caddy routes those, same origin). Multi-stage build to a lean
# standalone runtime listening on 3100.

FROM node:20-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm install --no-audit --no-fund

FROM node:20-alpine AS builder
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY . .
# NEXT_PUBLIC_* is inlined at build time. API base is empty by default (the tool
# and backend share the klovered.com origin in production); the marketing URL is
# the domain root.
ARG NEXT_PUBLIC_API_BASE=""
ARG NEXT_PUBLIC_MARKETING_URL="/"
ARG NEXT_PUBLIC_UMAMI_WEBSITE_ID=""
ENV NEXT_PUBLIC_API_BASE=${NEXT_PUBLIC_API_BASE} \
    NEXT_PUBLIC_MARKETING_URL=${NEXT_PUBLIC_MARKETING_URL} \
    NEXT_PUBLIC_UMAMI_WEBSITE_ID=${NEXT_PUBLIC_UMAMI_WEBSITE_ID}
RUN npm run build

FROM node:20-alpine AS runner
WORKDIR /app
ENV NODE_ENV=production
ENV PORT=3100
ENV HOSTNAME=0.0.0.0
COPY --from=builder /app/public ./public
COPY --from=builder /app/.next/standalone ./
COPY --from=builder /app/.next/static ./.next/static
EXPOSE 3100
CMD ["node", "server.js"]
