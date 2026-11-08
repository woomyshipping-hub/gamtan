// Supabase REST(PostgREST)를 서버 함수에서 service role 키로 호출한다.
// 새 비밀 키(sb_secret_…)는 apikey 헤더만. 예전 service_role 키(JWT, eyJ…)는 Authorization도 같이 보낸다.
function supaHeaders(key) {
  const h = { apikey: key, "Content-Type": "application/json" };
  if (!key.startsWith("sb_")) h.Authorization = `Bearer ${key}`;
  return h;
}

function makeSupa(env, fetchImpl) {
  const root = env.SUPABASE_URL.replace(/\/$/, "") + "/rest/v1/";
  const headers = supaHeaders(env.SUPABASE_SERVICE_ROLE_KEY);
  return async function rest(path, { method = "GET", body, prefer } = {}) {
    const r = await fetchImpl(root + path, {
      method,
      headers: prefer ? { ...headers, Prefer: prefer } : headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!r.ok) {
      const e = new Error(`supabase ${method} ${path.split("?")[0]} ${r.status}`);
      e.status = r.status;
      throw e;
    }
    return r.status === 204 ? null : r.json();
  };
}

module.exports = { supaHeaders, makeSupa };
