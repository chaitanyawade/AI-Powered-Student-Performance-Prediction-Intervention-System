const s = require("../lib/service");
const M = require("../lib/model");
module.exports = (req, res) => res.status(200).json({ ok: true, store: s.store, demo: s.demo, model: M.base.version, metrics: M.base.metrics });
