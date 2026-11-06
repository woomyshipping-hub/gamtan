// 작업별 입력값(jobs)과 정산 기준(settings)을 Redis(REDIS_URL)에 저장한다.
const { createClient } = require("redis");
const JOBS = "settle:jobs";
const SETTINGS = "settle:settings";

const num = v => (typeof v === "number" && Number.isFinite(v) && Math.abs(v) <= 1e9 ? v : null);

function cleanJob(d) {
  const o = {};
  for (const k of ["extra", "recvOverride", "hanOverride"]) if (num(d[k]) !== null) o[k] = d[k];
  if ([1, 2, 3].includes(d.crew)) o.crew = d.crew;
  for (const k of ["paidIn", "paidHan", "solo", "exclude"]) if (typeof d[k] === "boolean") o[k] = d[k];
  return o;
}

function cleanSettings(d) {
  const o = {};
  for (const k of Object.keys(d).slice(0, 40)) if (/^[A-Za-z0-9]{1,32}$/.test(k) && num(d[k]) !== null) o[k] = d[k];
  return o;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (!process.env.REDIS_URL) return res.status(503).json({ error: "storage not configured" });
  const db = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 5000 } });
  db.on("error", () => {});
  try {
    await db.connect();
    if (req.method === "GET") {
      const raw = await db.hGetAll(JOBS);
      const jobs = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, JSON.parse(v)]));
      const st = await db.get(SETTINGS);
      return res.status(200).json({ jobs, settings: st ? JSON.parse(st) : {} });
    }
    if (req.method === "PUT") {
      const b = req.body || {};
      if (b.kind === "job" && typeof b.id === "string" && /^[A-Za-z0-9_-]{1,100}$/.test(b.id) && b.data && typeof b.data === "object") {
        await db.hSet(JOBS, b.id, JSON.stringify(cleanJob(b.data)));
        return res.status(200).json({ ok: true });
      }
      if (b.kind === "settings" && b.data && typeof b.data === "object") {
        await db.set(SETTINGS, JSON.stringify(cleanSettings(b.data)));
        return res.status(200).json({ ok: true });
      }
      return res.status(400).json({ error: "bad request" });
    }
    res.setHeader("Allow", "GET, PUT");
    res.status(405).json({ error: "method not allowed" });
  } catch (e) {
    res.status(502).json({ error: "storage error" });
  } finally {
    db.quit().catch(() => {});
  }
};
