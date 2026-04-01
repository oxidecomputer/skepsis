import { getDiff } from "./diff.ts";

const revset = process.argv[2] || "@";
const port = Number(process.env["PORT"]) || 3742;

const server = Bun.serve({
  port,
  async fetch(req) {
    const url = new URL(req.url);

    if (url.pathname === "/api/diff") {
      try {
        const patch = await getDiff(revset);
        return Response.json({ patch, revset });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        return Response.json({ error: message }, { status: 500 });
      }
    }

    return new Response("Not found", { status: 404 });
  },
});

console.log(`local-review API on http://localhost:${port} (revset: ${revset})`);
