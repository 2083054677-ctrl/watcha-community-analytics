import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

function jsonError(message: string, status = 500) {
  return NextResponse.json({ error: message }, { status });
}

export async function GET(request: NextRequest) {
  const code = request.nextUrl.searchParams.get("code")?.trim() ?? "";
  const sinceRaw = request.nextUrl.searchParams.get("since") ?? "";
  if (!/^[A-Za-z0-9]{6}$/.test(code)) return jsonError("短链码格式不正确", 400);
  const sinceDate = new Date(sinceRaw);
  if (Number.isNaN(sinceDate.getTime())) return jsonError("监控开始时间无效", 400);

  const host = process.env.CLICKHOUSE_HOST;
  const user = process.env.CLICKHOUSE_USER;
  const password = process.env.CLICKHOUSE_PASSWORD;
  const database = process.env.CLICKHOUSE_DATABASE || "umami";
  if (!host || !user || !password) return jsonError("本地数据库连接尚未配置");

  const since = sinceDate.toISOString().slice(0, 19).replace("T", " ");
  const query = `
WITH hit_sessions AS (
  SELECT session_id, min(created_at) AS first_hit
  FROM website_event
  WHERE created_at >= toDateTime('${since}', 'UTC')
    AND startsWith(url_path, '/r/${code}')
  GROUP BY session_id
),
journey AS (
  SELECT
    h.session_id,
    h.first_hit,
    w.event_name,
    w.distinct_id,
    w.url_path
  FROM hit_sessions h
  INNER JOIN website_event w ON w.session_id = h.session_id
  WHERE w.created_at >= h.first_hit
)
SELECT
  uniqExact(session_id) AS visitors,
  countIf(startsWith(url_path, '/r/${code}')) AS pageviews,
  uniqExactIf(distinct_id, notEmpty(distinct_id)) AS identified_users,
  uniqExactIf(distinct_id, notEmpty(distinct_id) AND event_name IN ('auth.login','auth.3rd.wechat.login')) AS login_users,
  countIf(event_name IN ('auth.login','auth.3rd.wechat.login')) AS login_events,
  countIf(event_name = 'auth.register') AS registrations
FROM journey
FORMAT JSONEachRow`;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 12_000);
  try {
    const endpoint = `${host}/?database=${encodeURIComponent(database)}&compress=0`;
    const auth = Buffer.from(`${user}:${password}`).toString("base64");
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "text/plain; charset=utf-8",
      },
      body: query,
      cache: "no-store",
      signal: controller.signal,
    });
    const text = await response.text();
    if (!response.ok) throw new Error(text || `ClickHouse ${response.status}`);
    const row = text.trim() ? JSON.parse(text.trim().split("\n")[0]) : {};
    return NextResponse.json({
      code,
      since: sinceDate.toISOString(),
      checkedAt: new Date().toISOString(),
      visitors: Number(row.visitors) || 0,
      pageviews: Number(row.pageviews) || 0,
      identifiedUsers: Number(row.identified_users) || 0,
      loginUsers: Number(row.login_users) || 0,
      loginEvents: Number(row.login_events) || 0,
      registrations: Number(row.registrations) || 0,
    });
  } catch (error) {
    const message = error instanceof Error && error.name === "AbortError"
      ? "ClickHouse 连接超时，请检查VPN；工作台会自动重试"
      : "ClickHouse 暂时不可用；工作台会保留旧数据并自动重试";
    return jsonError(message, 503);
  } finally {
    clearTimeout(timeout);
  }
}
