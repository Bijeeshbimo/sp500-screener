// Run: node paper/test_worker.mjs   (no packages; fakes the upstream so nothing leaves the machine)
import assert from "assert";
import worker from "./cloudflare-worker.js";
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url, init }); return new Response('{"ok":true}', { status: 200, headers: { "content-type": "application/json" } }); };
const ORIGIN = "https://bijeeshbimo.github.io";
let n = 0; const t = async (name, fn) => { await fn(); n++; console.log("ok   " + name); };

await t("forwards a sign-in POST to the Supabase project with method, query, headers and body", async () => {
  const req = new Request("https://relay.example.workers.dev/auth/v1/token?grant_type=password", { method: "POST", headers: { apikey: "pk", "content-type": "application/json", origin: ORIGIN }, body: '{"email":"a@b.c","password":"x"}' });
  const res = await worker.fetch(req);
  assert.strictEqual(res.status, 200); assert.deepStrictEqual(await res.json(), { ok: true });
  const c = calls.at(-1);
  assert.strictEqual(c.url, "https://qrnsadytlpqztljigqfx.supabase.co/auth/v1/token?grant_type=password");
  assert.strictEqual(c.init.method, "POST"); assert.strictEqual(c.init.headers.get("apikey"), "pk");
  assert.strictEqual(await new Response(c.init.body).text(), '{"email":"a@b.c","password":"x"}');
});
await t("forwards a table read (GET with Range) without a body", async () => {
  await worker.fetch(new Request("https://relay.example.workers.dev/rest/v1/paper_ledger?select=*", { headers: { apikey: "pk", range: "0-999", origin: ORIGIN } }));
  const c = calls.at(-1); assert.strictEqual(c.url, "https://qrnsadytlpqztljigqfx.supabase.co/rest/v1/paper_ledger?select=*");
  assert.strictEqual(c.init.body, undefined); assert.strictEqual(c.init.headers.get("range"), "0-999");
});
await t("passes the browser's CORS preflight through", async () => {
  await worker.fetch(new Request("https://relay.example.workers.dev/rest/v1/paper_orders", { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } }));
  assert.strictEqual(calls.at(-1).init.method, "OPTIONS");
});
await t("refuses other websites, and paths that are not sign-in or database", async () => {
  const before = calls.length;
  assert.strictEqual((await worker.fetch(new Request("https://relay.example.workers.dev/rest/v1/x", { headers: { origin: "https://evil.example" } }))).status, 403);
  assert.strictEqual((await worker.fetch(new Request("https://relay.example.workers.dev/storage/v1/object/list", { headers: { origin: ORIGIN } }))).status, 404);
  assert.strictEqual((await worker.fetch(new Request("https://relay.example.workers.dev/", { headers: { origin: ORIGIN } }))).status, 404);
  assert.strictEqual(calls.length, before, "nothing was forwarded");
});
console.log(`\n${n} worker tests passed`);
