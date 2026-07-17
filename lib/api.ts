// Thin client for the Klovered Python backend (replaces the Supabase client and
// this app's own /api/* route handlers). In production the tool is served from
// the SAME origin as the backend — klovered.com/app for the tool, klovered.com/
// api/* proxied to the backend by Caddy — so calls are origin-relative and the
// shared httpOnly session cookie flows automatically. For local dev against a
// separately-run backend, set NEXT_PUBLIC_API_BASE to the backend origin (and
// enable CORS-with-credentials there for the tool's dev origin).
const BASE = process.env.NEXT_PUBLIC_API_BASE ?? "";

export type Session = {
  user_id: string;
  org_id: string;
  deal_id?: string | null;
  email: string | null;
  is_anonymous: boolean;
};

export class ApiError extends Error {
  constructor(
    public status: number,
    msg: string,
  ) {
    super(msg);
    this.name = "ApiError";
  }
}

// One fetch wrapper: always sends the session cookie, JSON-encodes plain-object
// bodies (but leaves FormData alone so file uploads keep their multipart
// boundary), and turns a non-2xx into an ApiError carrying the backend's
// { error } message.
export async function apiFetch(path: string, init: RequestInit = {}): Promise<Response> {
  const isForm = init.body instanceof FormData;
  return fetch(`${BASE}${path}`, {
    ...init,
    credentials: "include",
    headers: {
      ...(init.body && !isForm ? { "Content-Type": "application/json" } : {}),
      ...(init.headers ?? {}),
    },
  });
}

export async function apiJson<T = any>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await apiFetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new ApiError(res.status, (data as { error?: string })?.error || `Request failed (${res.status})`);
  }
  return data as T;
}

export const api = {
  fetch: apiFetch,
  json: apiJson,

  // ---- auth ----
  me: () => apiJson<Session>("/api/auth/me"),
  guest: () => apiJson<Session>("/api/auth/guest", { method: "POST" }),
  signup: (email: string, password: string) =>
    apiJson<Session>("/api/auth/signup", { method: "POST", body: JSON.stringify({ email, password }) }),
  login: (email: string, password: string) =>
    apiJson<Session>("/api/auth/login", { method: "POST", body: JSON.stringify({ email, password }) }),
  logout: () => apiJson("/api/auth/logout", { method: "POST" }),
  // Full-page redirect into Google; the backend callback sets the cookie and
  // redirects back. `next` is where to return after login.
  googleStartUrl: (next: string) =>
    `${BASE}/api/auth/google/start?next=${encodeURIComponent(next)}`,

  // ---- knowledge base ----
  knowledgeList: () => apiJson("/api/knowledge"),
  knowledgeGet: (id: string) => apiJson(`/api/knowledge/${id}`),
  knowledgeDelete: (id: string) => apiJson(`/api/knowledge/${id}`, { method: "DELETE" }),

  // ---- RFP documents ----
  documentStatus: (id: string) => apiJson(`/api/pipeline/documents/${id}`),
  documentDelete: (id: string) => apiJson(`/api/pipeline/documents/${id}`, { method: "DELETE" }),

  // ---- answers ----
  dealAnswers: (dealId: string) => apiJson(`/api/pipeline/deals/${dealId}/answers`),
};
