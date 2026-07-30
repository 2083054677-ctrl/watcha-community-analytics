import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const port = 4317;
let postgresPool;

function readEnv() {
  const result = {};
  const envPath = path.join(root, ".env.local");
  if (!fs.existsSync(envPath)) return result;
  for (const line of fs.readFileSync(envPath, "utf8").split(/\r?\n/)) {
    const match = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (match) result[match[1]] = match[2];
  }
  return result;
}

function sendJson(res, status, data) {
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(data));
}

async function readBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function safeCode(value) {
  const match = String(value || "").match(/^[A-Za-z0-9]{6}$/);
  return match ? match[0] : "";
}

function safePath(value) {
  const text = String(value || "").trim();
  return text.startsWith("/") && text.length <= 500 && !text.includes("'") ? text : "";
}

function safeCampaign(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9_-]{4,80}$/.test(text) ? text : "";
}

function getPostgresPool() {
  if (postgresPool) return postgresPool;
  const env = readEnv();
  postgresPool = new pg.Pool({
    host: env.POSTGRES_HOST,
    port: Number(env.POSTGRES_PORT || 5432),
    user: env.POSTGRES_USER,
    password: env.POSTGRES_PASSWORD,
    database: env.POSTGRES_DATABASE,
    ssl: false,
    max: 2,
    connectionTimeoutMillis: 8000,
    idleTimeoutMillis: 15000,
  });
  return postgresPool;
}

async function queryRegistrations(sinceRaw, endRaw) {
  const since = new Date(sinceRaw);
  const end = new Date(endRaw);
  if (Number.isNaN(since.getTime()) || Number.isNaN(end.getTime())) throw new Error("注册统计时间不正确");
  const result = await getPostgresPool().query({
    text: `select count(*)::bigint as registrations
      from "user"
      where is_deleted = false
        and create_at >= $1
        and create_at < $2`,
    values: [since.toISOString(), end.toISOString()],
    statement_timeout: 12000,
  });
  return {
    registrations: Number(result.rows[0]?.registrations) || 0,
    syncedAt: new Date().toISOString(),
    scope: "sitewide",
  };
}

function curlWithInput(args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn("curl", args, { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => code === 0 ? resolve(stdout) : reject(new Error(stderr || `curl exited ${code}`)));
    child.stdin.end(input);
  });
}

async function queryClickHouse({ code, pathNames, campaign, sinceRaw, endRaw }) {
  const env = readEnv();
  const sinceDate = new Date(sinceRaw);
  const endDate = new Date(endRaw || Date.now());
  const pathValues = [...new Set([
    ...(safeCode(code) ? [`/r/${safeCode(code)}`] : []),
    ...(Array.isArray(pathNames) ? pathNames : []).map(safePath).filter(Boolean),
  ])].slice(0, 20);
  const campaignValue = safeCampaign(campaign);
  if (!pathValues.length || Number.isNaN(sinceDate.getTime()) || Number.isNaN(endDate.getTime())) throw new Error("分享链接或监控时间不正确");
  const since = sinceDate.toISOString().slice(0, 19).replace("T", " ");
  const end = endDate.toISOString().slice(0, 19).replace("T", " ");
  const pathSql = pathValues.map((value) => `'${value}'`).join(", ");
  const attribution = campaignValue
    ? `utm_campaign = '${campaignValue}'`
    : `url_path IN (${pathSql})`;
  const query = `
WITH attributed_visits AS (
  SELECT visit_id, any(session_id) AS visitor_id, min(created_at) AS first_hit
  FROM website_event
  WHERE created_at >= toDateTime('${since}', 'UTC')
    AND created_at < toDateTime('${end}', 'UTC')
    AND empty(event_name)
    AND ${attribution}
  GROUP BY visit_id
),
journey AS (
  SELECT a.visit_id, a.visitor_id, w.event_name, w.url_path, w.event_type
  FROM attributed_visits a
  INNER JOIN website_event w ON w.visit_id = a.visit_id
  WHERE w.created_at >= a.first_hit
    AND w.created_at < toDateTime('${end}', 'UTC')
)
SELECT
  uniqExact(visitor_id) AS visitors,
  uniqExact(visit_id) AS visits,
  countIf(empty(event_name) AND url_path IN (${pathSql})) AS pageviews,
  uniqExactIf(visitor_id, event_name IN ('auth.login','auth.3rd.wechat.login')) AS login_users,
  countIf(event_name IN ('auth.login','auth.3rd.wechat.login')) AS login_events,
  countIf(event_name = 'auth.register') AS registrations
FROM journey
FORMAT JSONEachRow`;
  const endpoint = `${env.CLICKHOUSE_HOST}/?database=${encodeURIComponent(env.CLICKHOUSE_DATABASE || "umami")}&compress=0`;
  const text = await curlWithInput([
    "--silent",
    "--show-error",
    "--max-time", "12",
    "--user", `${env.CLICKHOUSE_USER}:${env.CLICKHOUSE_PASSWORD}`,
    "--data-binary", "@-",
    endpoint,
  ], query);
  const totals = text.trim() ? JSON.parse(text.trim().split("\n")[0]) : {};
  const breakdownQuery = `
SELECT
  url_path,
  uniqExact(session_id) AS visitors,
  uniqExact(visit_id) AS visits,
  count() AS pageviews
FROM website_event
WHERE created_at >= toDateTime('${since}', 'UTC')
  AND created_at < toDateTime('${end}', 'UTC')
  AND empty(event_name)
  AND event_type = 1
  AND url_path IN (${pathSql})
GROUP BY url_path
ORDER BY pageviews DESC
FORMAT JSONEachRow`;
  const breakdownText = await curlWithInput([
    "--silent",
    "--show-error",
    "--max-time", "12",
    "--user", `${env.CLICKHOUSE_USER}:${env.CLICKHOUSE_PASSWORD}`,
    "--data-binary", "@-",
    endpoint,
  ], breakdownQuery);
  return {
    totals,
    breakdown: breakdownText.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)),
    paths: pathValues,
  };
}

function readCcSwitchProvider() {
  const db = path.join(process.env.HOME || "/Users/luoluo", ".cc-switch", "cc-switch.db");
  const raw = execFileSync("sqlite3", [
    db,
    "SELECT settings_config FROM providers WHERE app_type='claude' AND is_current=1 LIMIT 1;",
  ], { encoding: "utf8" }).trim();
  const config = JSON.parse(raw);
  return {
    baseUrl: config.env?.ANTHROPIC_BASE_URL,
    apiKey: config.env?.ANTHROPIC_API_KEY,
    model: config.env?.ANTHROPIC_DEFAULT_SONNET_MODEL || config.env?.ANTHROPIC_DEFAULT_OPUS_MODEL || "claude-sonnet-4-5",
  };
}

async function analyzeWithCcSwitch(payload) {
  const provider = readCcSwitchProvider();
  if (!provider.baseUrl || !provider.apiKey) throw new Error("CC Switch 当前模型配置不完整");
  const endpoint = `${provider.baseUrl.replace(/\/$/, "")}/v1/messages`;
  const prompt = `你是社群运营数据分析助手。根据下面一次社群转发后的增量数据，给出简短、具体、可执行的中文分析。
只回答三部分：1. 当前表现；2. 是否还在增长；3. 接下来30分钟建议。
不要暴露模型、供应商或技术配置。registrations是失效埋点，仅供参考；siteRegistrations若存在，表示同一时间窗口内的全站真实注册，不代表该链接带来的注册。
社群画像表示本次转发覆盖的人群组合，不代表每个群的精确贡献。

数据：
${JSON.stringify(payload)}`;
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "x-api-key": provider.apiKey,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: provider.model,
      max_tokens: 700,
      temperature: 0.2,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error?.message || "模型接口调用失败");
  return {
    model: provider.model,
    text: Array.isArray(result.content) ? result.content.map((x) => x.text || "").join("\n") : String(result.content || ""),
  };
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${req.headers.host}`);
    if (url.pathname === "/api/metrics") {
      const code = safeCode(url.searchParams.get("code"));
      const pathNames = url.searchParams.getAll("path").map(safePath).filter(Boolean);
      const campaign = safeCampaign(url.searchParams.get("campaign"));
      const since = url.searchParams.get("since");
      const end = url.searchParams.get("end");
      if ((!code && !pathNames.length) || !since) return sendJson(res, 400, { error: "请输入正确的分享链接" });
      try {
        const result = await queryClickHouse({ code, pathNames, campaign, sinceRaw: since, endRaw: end });
        const row = result.totals;
        return sendJson(res, 200, {
          code: code || "",
          path: result.paths[0],
          paths: result.paths,
          breakdown: result.breakdown.map((item) => ({
            path: item.url_path,
            visitors: Number(item.visitors) || 0,
            visits: Number(item.visits) || 0,
            pageviews: Number(item.pageviews) || 0,
          })),
          campaign: campaign || "",
          since,
          checkedAt: new Date().toISOString(),
          visitors: Number(row.visitors) || 0,
          visits: Number(row.visits) || 0,
          pageviews: Number(row.pageviews) || 0,
          loginUsers: Number(row.login_users) || 0,
          loginEvents: Number(row.login_events) || 0,
          registrations: Number(row.registrations) || 0,
        });
      } catch {
        return sendJson(res, 503, { error: "数据库暂时不可用；请确认网络后等待自动重试" });
      }
    }
    if (url.pathname === "/api/registrations") {
      const since = url.searchParams.get("since");
      const end = url.searchParams.get("end");
      if (!since || !end) return sendJson(res, 400, { error: "缺少注册统计时间" });
      try {
        return sendJson(res, 200, await queryRegistrations(since, end));
      } catch {
        return sendJson(res, 503, {
          error: "镜像数据库暂时不可用",
          scope: "sitewide",
        });
      }
    }
    if (url.pathname === "/api/analyze" && req.method === "POST") {
      try {
        return sendJson(res, 200, await analyzeWithCcSwitch(await readBody(req)));
      } catch (error) {
        return sendJson(res, 503, { error: error instanceof Error ? error.message : "AI分析暂时不可用" });
      }
    }
    if (url.pathname === "/" || url.pathname === "/index.html") {
      const html = fs.readFileSync(path.join(here, "index.html"));
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      return res.end(html);
    }
    res.writeHead(404);
    res.end("Not found");
  } catch (error) {
    sendJson(res, 500, { error: error instanceof Error ? error.message : "服务错误" });
  }
});

server.listen(port, "127.0.0.1", () => {
  console.log(`观猹社群数据工作台已启动：http://127.0.0.1:${port}`);
});
