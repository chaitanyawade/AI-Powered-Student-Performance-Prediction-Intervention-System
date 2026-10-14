const s = require("../lib/service");
const auth = require("../lib/auth");
module.exports = async (req, res) => {
  const u = auth.userFrom(req);
  if (!u) return res.status(401).json({ error: "Please sign in." });
  try { res.status(200).json(await s.snapshot(u)); }
  catch (e) { res.status(e.code || 500).json({ error: e.message }); }
};
