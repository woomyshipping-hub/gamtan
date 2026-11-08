// Redis 접속 실패 시 5초 안에 기존 실패 응답(502 {error:"storage error"})과 같은 형식으로 끝낸다.
exports.handler = require("../lib/adapter")(require("../../api/state.js"), {
  timeoutMs: 5000,
  timeoutStatus: 502,
  timeoutBody: { error: "storage error" },
});
