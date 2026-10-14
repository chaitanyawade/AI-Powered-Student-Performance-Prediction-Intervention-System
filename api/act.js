// Every change the website makes goes through here: POST { op: "...", ...data }
const s = require("../lib/service");
const auth = require("../lib/auth");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  try { res.status(200).json(await s.act(auth.userFrom(req), req.body || {})); }
  catch (e) { res.status(e.code || 400).json({ error: e.message }); }
};
