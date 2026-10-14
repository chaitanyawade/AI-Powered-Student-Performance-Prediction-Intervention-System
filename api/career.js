// POST { prn } -> one student's role fit, skill gap and roadmap (the student themself, the TPO, or admin)
const s = require("../lib/service");
const auth = require("../lib/auth");
module.exports = async (req, res) => {
  if (req.method !== "POST") return res.status(405).json({ error: "POST only" });
  const u = auth.userFrom(req);
  if (!u) return res.status(401).json({ error: "Please sign in." });
  try { res.status(200).json(await s.careerOf(u, req.body || {})); }
  catch (e) { res.status(e.code || 400).json({ error: e.message }); }
};
