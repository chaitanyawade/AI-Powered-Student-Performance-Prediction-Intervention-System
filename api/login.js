const s = require("../lib/service");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const ip = String((req.headers["x-forwarded-for"] || "")).split(",")[0].trim() || (req.socket && req.socket.remoteAddress) || "";
  try { res.status(200).json(await s.login(req.body || {}, ip)); }
  catch (e) { res.status(e.code || 400).json({ error: e.message }); }
};
