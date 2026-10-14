// Local dev server: serves /public and runs the same /api functions Vercel will run.
// No dependencies. Start with:  npm start
const http = require("http");
const fs = require("fs");
const path = require("path");

// tiny .env loader (so you don't need any packages)
try {
  fs.readFileSync(path.join(__dirname, ".env"), "utf8").split(/\r?\n/).forEach(line => {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2].replace(/^["']|["']$/g, "");
  });
} catch { /* no .env file: local-file mode */ }

const PORT = process.env.PORT || 3000;
const PUBLIC = path.join(__dirname, "public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
                ".json": "application/json", ".png": "image/png", ".svg": "image/svg+xml", ".ico": "image/x-icon" };

http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname.startsWith("/api/")) {
    const name = url.pathname.slice(5).replace(/[^a-z]/g, "");
    const file = path.join(__dirname, "api", name + ".js");
    if (!fs.existsSync(file)) { res.writeHead(404); return res.end('{"error":"not found"}'); }
    let raw = ""; for await (const c of req) raw += c;
    try { req.body = raw ? JSON.parse(raw) : {}; } catch { req.body = {}; }
    res.status = code => { res.statusCode = code; return res; };
    res.json = obj => { res.setHeader("Content-Type", "application/json"); res.end(JSON.stringify(obj)); };
    delete require.cache[require.resolve(file)];          // pick up edits without restarting
    return require(file)(req, res);
  }

  let p = path.normalize(url.pathname === "/" ? "/index.html" : url.pathname);
  const full = path.join(PUBLIC, p);
  if (!full.startsWith(PUBLIC) || !fs.existsSync(full) || fs.statSync(full).isDirectory()) { res.writeHead(404); return res.end("Not found"); }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(full)] || "application/octet-stream" });
  fs.createReadStream(full).pipe(res);
}).listen(PORT, () => {
  const db = process.env.SUPABASE_URL ? "Supabase" : "local file (data/local-db.json)";
  console.log(`EduPlus AI running at http://localhost:${PORT}   storage: ${db}`);
});
