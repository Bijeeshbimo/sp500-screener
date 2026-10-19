// Optional relay for people whose internet provider blocks supabase.co (see README: "If Supabase is blocked").
// Paste this into a free Cloudflare Worker, then put the worker's address in docs/paper-config.js as supabaseUrl.
// It forwards ONLY sign-in and table requests for YOUR project, and only from YOUR page, so it is not an open proxy.
// Your login and trades pass through it unchanged; nothing is stored or logged here.
const TARGET = "https://qrnsadytlpqztljigqfx.supabase.co";           // your Supabase project URL
const ALLOWED_ORIGINS = ["https://bijeeshbimo.github.io"];            // where paper.html is served from
const ALLOWED_PATHS = ["/auth/v1/", "/rest/v1/"];                     // sign-in and database only

export default {
  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    if (origin && !ALLOWED_ORIGINS.includes(origin)) return new Response("Forbidden origin", { status: 403 });
    if (!ALLOWED_PATHS.some(p => url.pathname.startsWith(p))) return new Response("Not found", { status: 404 });
    const init = { method: request.method, headers: request.headers, redirect: "manual" };
    if (request.method !== "GET" && request.method !== "HEAD") { init.body = request.body; init.duplex = "half"; }
    return fetch(TARGET + url.pathname + url.search, init);          // Supabase answers CORS itself, so replies pass straight back
  },
};
