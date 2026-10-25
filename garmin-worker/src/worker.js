const GARMIN_BASE_URL = "https://personal.connectapi.garmin.com";
const TOKEN_PATH = "/personalapitoken-service/personal-api/personal-api-key/token";

let tokenCache = { value: "", expiresAt: 0 };

export default {
  async fetch(request, env) {
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGINS);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    try {
      assertConfigured(env);
      assertAllowedOrigin(origin, env.ALLOWED_ORIGINS);
      assertAccessCode(request, env.STRION_ACCESS_CODE);

      const url = new URL(request.url);
      if (request.method === "GET" && url.pathname === "/api/health") {
        await getGarminToken(env.GARMIN_API_KEY);
        return json({ ok: true, message: "Garmin Personal API 인증이 확인되었습니다." }, 200, cors);
      }

      if (request.method === "GET" && url.pathname === "/api/activities") {
        const query = new URLSearchParams();
        for (const key of ["start", "limit", "startDate", "endDate", "activityType"]) {
          if (url.searchParams.has(key)) query.set(key, url.searchParams.get(key));
        }
        if (!query.has("start")) query.set("start", "0");
        if (!query.has("limit")) query.set("limit", "30");
        const response = await garminFetch(`/activitylist-service/activities/search/activities?${query}`, env);
        return proxyResponse(response, cors, "application/json; charset=utf-8");
      }

      const downloadMatch = url.pathname.match(/^\/api\/activities\/(\d+)\/fit$/);
      if (request.method === "GET" && downloadMatch) {
        const response = await garminFetch(`/download-service/files/activity/${downloadMatch[1]}`, env, "application/zip, application/x-zip-compressed, application/octet-stream");
        return proxyResponse(response, cors, response.headers.get("Content-Type") || "application/zip");
      }

      return json({ error: "요청한 STRION Garmin 경로를 찾을 수 없습니다." }, 404, cors);
    } catch (error) {
      const status = Number(error.status) || 500;
      return json({ error: error.message || "Garmin 동기화 중 오류가 발생했습니다." }, status, cors);
    }
  },
};

async function garminFetch(path, env, accept = "application/json") {
  let token = await getGarminToken(env.GARMIN_API_KEY);
  let response = await fetch(`${GARMIN_BASE_URL}${path}`, {
    headers: { Accept: accept, Authorization: `Bearer ${token}` },
  });
  if (response.status === 401) {
    tokenCache = { value: "", expiresAt: 0 };
    token = await getGarminToken(env.GARMIN_API_KEY);
    response = await fetch(`${GARMIN_BASE_URL}${path}`, {
      headers: { Accept: accept, Authorization: `Bearer ${token}` },
    });
  }
  if (!response.ok) throw await garminHttpError(response);
  return response;
}

async function getGarminToken(apiKey) {
  if (tokenCache.value && tokenCache.expiresAt - Date.now() > 5 * 60 * 1000) return tokenCache.value;
  const response = await fetch(`${GARMIN_BASE_URL}${TOKEN_PATH}`, {
    method: "POST",
    headers: { Accept: "*/*", Authorization: `ApiKey ${apiKey}` },
  });
  if (!response.ok) throw await garminHttpError(response);
  const token = (await response.text()).trim();
  tokenCache = { value: token, expiresAt: readJwtExpiry(token) };
  return token;
}

function readJwtExpiry(token) {
  try {
    const payload = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const decoded = JSON.parse(atob(payload.padEnd(Math.ceil(payload.length / 4) * 4, "=")));
    return Number(decoded.exp) * 1000;
  } catch {
    return Date.now() + 23 * 60 * 60 * 1000;
  }
}

function assertConfigured(env) {
  if (!env.GARMIN_API_KEY || !env.STRION_ACCESS_CODE) {
    throw Object.assign(new Error("Worker 비밀값 설정이 완료되지 않았습니다."), { status: 503 });
  }
}

function assertAccessCode(request, expected) {
  const supplied = request.headers.get("Authorization") || "";
  if (supplied !== `Bearer ${expected}`) {
    throw Object.assign(new Error("STRION 접근 코드가 올바르지 않습니다."), { status: 401 });
  }
}

function assertAllowedOrigin(origin, allowedOrigins) {
  if (!origin) return;
  const allowed = String(allowedOrigins || "").split(",").map((item) => item.trim()).filter(Boolean);
  if (!allowed.includes(origin)) {
    throw Object.assign(new Error("허용되지 않은 웹사이트에서 요청했습니다."), { status: 403 });
  }
}

function corsHeaders(origin, allowedOrigins) {
  const allowed = String(allowedOrigins || "").split(",").map((item) => item.trim()).filter(Boolean);
  const selected = allowed.includes(origin) ? origin : (allowed[0] || "https://zionkoo.github.io");
  return {
    "Access-Control-Allow-Origin": selected,
    "Access-Control-Allow-Headers": "Authorization, Content-Type",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
}

async function garminHttpError(response) {
  const detail = (await response.text()).slice(0, 300);
  const message = response.status === 401
    ? "Garmin API 키가 올바르지 않거나 만료되었습니다."
    : `Garmin API 오류 (${response.status})${detail ? `: ${detail}` : ""}`;
  return Object.assign(new Error(message), { status: response.status });
}

function proxyResponse(response, cors, contentType) {
  const headers = new Headers(cors);
  headers.set("Content-Type", contentType);
  const disposition = response.headers.get("Content-Disposition");
  if (disposition) headers.set("Content-Disposition", disposition);
  return new Response(response.body, { status: response.status, headers });
}

function json(value, status, cors) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { ...cors, "Content-Type": "application/json; charset=utf-8" },
  });
}
