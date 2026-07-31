import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.dirname(here);
const port = 4317;
const dataDirectory = path.join(root, ".data");
const dashboardStateFile = path.join(dataDirectory, "dashboard-state.json");
let postgresPool;
let collectionRunning = false;

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

function csvCell(value) {
  return `"${String(value ?? "").replaceAll("\"", "\"\"")}"`;
}

function sendCsv(res, csv, filename) {
  res.writeHead(200, {
    "Content-Type": "text/csv; charset=utf-8",
    "Content-Disposition": `attachment; filename="community-export.csv"; filename*=UTF-8''${encodeURIComponent(filename)}`,
    "Cache-Control": "no-store",
  });
  res.end(`\ufeff${csv}`);
}

function snapshotAtHour(task, hours) {
  const exact = task.milestones?.[`t${hours}`];
  if (exact) return exact;
  const limit = hours * 60;
  return [...(task.autoSamples || []), ...(task.samples || [])]
    .filter((sample) => (sample.elapsedMinutes ?? limit) <= limit)
    .at(-1) || {};
}

function exportDashboardCsv(url) {
  const hours = Math.min(4, Math.max(1, Number(url.searchParams.get("hours")) || 4));
  const daysRaw = url.searchParams.get("days") || "1";
  const filter = url.searchParams.get("filter") || "all";
  const cutoff = daysRaw === "all" ? 0 : Date.now() - Math.max(1, Number(daysRaw) || 1) * 86400000;
  const header = ["转发时间", "监控窗口", "一级分类", "内容类型", "社群画像", "社群类型", "用户画像", "转发群数", "预计覆盖人数", "链接", "链接访客", "链接会话", "链接浏览", "事件总访客", "事件总会话", "事件总浏览", "登录访客", "登录转化率", "完整文案", "运营备注"];
  const rows = [header];
  for (const task of readDashboardState().tasks) {
    if (new Date(task.since).getTime() < cutoff || (filter !== "all" && task.sourceType !== filter)) continue;
    const snapshot = snapshotAtHour(task, hours);
    const breakdown = new Map((snapshot.breakdown || []).map((item) => [item.path, item]));
    const urls = Array.isArray(task.urls) && task.urls.length ? task.urls : task.url ? [task.url] : [];
    for (const taskUrl of urls) {
      let urlPath = "";
      try { urlPath = new URL(taskUrl).pathname; } catch {}
      const link = breakdown.get(urlPath) || {};
      rows.push([
        new Date(task.since).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
        `${hours}小时`,
        task.sourceType,
        task.category,
        (task.audienceNames || []).join("、"),
        task.groupType,
        task.audience,
        task.groupCount || "",
        task.estimatedReach || "",
        taskUrl,
        link.visitors || 0,
        link.visits || 0,
        link.pageviews || 0,
        snapshot.visitors || 0,
        snapshot.visits || 0,
        snapshot.pageviews || 0,
        snapshot.loginUsers || 0,
        snapshot.visitors ? `${(snapshot.loginUsers / snapshot.visitors * 100).toFixed(1)}%` : "0%",
        task.copy || "",
        task.note || "",
      ]);
    }
  }
  return rows.map((row) => row.map(csvCell).join(",")).join("\r\n");
}

function readDashboardState() {
  try {
    const state = JSON.parse(fs.readFileSync(dashboardStateFile, "utf8"));
    return {
      tasks: Array.isArray(state.tasks) ? state.tasks : [],
      profiles: Array.isArray(state.profiles) ? state.profiles : [],
      updatedAt: state.updatedAt || null,
    };
  } catch {
    return { tasks: [], profiles: [], updatedAt: null };
  }
}

function writeDashboardState(payload) {
  const tasks = Array.isArray(payload.tasks) ? payload.tasks.slice(0, 1000) : [];
  const profiles = Array.isArray(payload.profiles) ? payload.profiles.slice(0, 500) : [];
  const state = { tasks, profiles, updatedAt: new Date().toISOString() };
  fs.mkdirSync(dataDirectory, { recursive: true });
  const temporaryFile = `${dashboardStateFile}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(state, null, 2), { mode: 0o600 });
  fs.renameSync(temporaryFile, dashboardStateFile);
  return state;
}

function getTaskPaths(task) {
  const urls = Array.isArray(task.urls) && task.urls.length ? task.urls : task.url ? [task.url] : [];
  return [...new Set(urls.map((raw) => {
    try { return safePath(new URL(raw).pathname); } catch { return ""; }
  }).filter(Boolean))].slice(0, 20);
}

function metricSnapshot(result, checkedAt, elapsedMinutes) {
  const row = result.totals || {};
  return {
    checkedAt,
    elapsedMinutes,
    visitors: Number(row.visitors) || 0,
    visits: Number(row.visits) || 0,
    pageviews: Number(row.pageviews) || 0,
    loginUsers: Number(row.login_users) || 0,
    loginEvents: Number(row.login_events) || 0,
    registrations: Number(row.registrations) || 0,
    breakdown: (result.breakdown || []).map((item) => ({
      path: item.url_path,
      visitors: Number(item.visitors) || 0,
      visits: Number(item.visits) || 0,
      pageviews: Number(item.pageviews) || 0,
    })),
  };
}

async function collectTaskWindow(task, endDate, elapsedMinutes, sinceRaw = task.since) {
  const result = await queryClickHouse({
    code: "",
    pathNames: getTaskPaths(task),
    campaign: "",
    sinceRaw,
    endRaw: endDate.toISOString(),
  });
  return metricSnapshot(result, new Date().toISOString(), elapsedMinutes);
}

async function runScheduledCollection(includeCurrent = false) {
  if (collectionRunning) return;
  collectionRunning = true;
  try {
    const state = readDashboardState();
    let changed = false;
    for (const task of state.tasks) {
      const sharedAt = new Date(task.since);
      const paths = getTaskPaths(task);
      if (Number.isNaN(sharedAt.getTime()) || !paths.length || sharedAt.getTime() > Date.now()) continue;
      if (task.collectionStatus === "completed" && task.milestones?.t4 && !includeCurrent) continue;
      const elapsedMinutes = Math.max(0, Math.floor((Date.now() - sharedAt.getTime()) / 60000));
      task.duration = "4";
      task.collectionStatus = "collecting";
      task.collectionLastAttempt = new Date().toISOString();
      task.autoSamples = Array.isArray(task.autoSamples) ? task.autoSamples : [];
      task.milestones = task.milestones && typeof task.milestones === "object" ? task.milestones : {};
      try {
        const cappedMinutes = Math.min(240, elapsedMinutes);
        const liveEnd = new Date(sharedAt.getTime() + cappedMinutes * 60000);
        const snapshot = await collectTaskWindow(task, liveEnd, cappedMinutes);
        task.autoSamples.push(snapshot);
        task.autoSamples = task.autoSamples.slice(-30);
        if (!task.milestones.t0) task.milestones.t0 = {
          checkedAt: task.since,
          elapsedMinutes: 0,
          visitors: 0,
          visits: 0,
          pageviews: 0,
          loginUsers: 0,
          loginEvents: 0,
          registrations: 0,
          breakdown: [],
        };
        if (elapsedMinutes >= 60 && !task.milestones.t1) {
          task.milestones.t1 = await collectTaskWindow(task, new Date(sharedAt.getTime() + 3600000), 60);
        }
        if (elapsedMinutes >= 120 && !task.milestones.t2) {
          task.milestones.t2 = await collectTaskWindow(task, new Date(sharedAt.getTime() + 7200000), 120);
        }
        if (elapsedMinutes >= 180 && !task.milestones.t3) {
          task.milestones.t3 = await collectTaskWindow(task, new Date(sharedAt.getTime() + 10800000), 180);
        }
        if (elapsedMinutes >= 240 && !task.milestones.t4) {
          task.milestones.t4 = await collectTaskWindow(task, new Date(sharedAt.getTime() + 14400000), 240);
        }
        if (includeCurrent) {
          task.currentSnapshot = await collectTaskWindow(
            task,
            new Date(),
            elapsedMinutes,
            task.since,
          );
        }
        task.collectionStatus = elapsedMinutes >= 240 ? "completed" : "collecting";
        task.collectionError = "";
        task.collectionUpdatedAt = new Date().toISOString();
      } catch (error) {
        task.collectionStatus = "error";
        task.collectionError = error instanceof Error ? error.message : "自动采集失败";
      }
      changed = true;
    }
    if (changed) writeDashboardState(state);
  } finally {
    collectionRunning = false;
  }
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
    if (url.pathname === "/api/state" && req.method === "GET") {
      return sendJson(res, 200, readDashboardState());
    }
    if (url.pathname === "/api/export" && req.method === "GET") {
      const hours = Math.min(4, Math.max(1, Number(url.searchParams.get("hours")) || 4));
      const filename = `社群转发监控_${hours}h_${new Date().toISOString().slice(0, 10)}.csv`;
      return sendCsv(res, exportDashboardCsv(url), filename);
    }
    if (url.pathname === "/api/state" && req.method === "PUT") {
      try {
        const incoming = await readBody(req);
        const existing = readDashboardState();
        const automaticById = new Map(existing.tasks.map((task) => [task.id, {
          autoSamples: task.autoSamples,
          milestones: task.milestones,
          collectionStatus: task.collectionStatus,
          collectionError: task.collectionError,
          collectionLastAttempt: task.collectionLastAttempt,
          collectionUpdatedAt: task.collectionUpdatedAt,
          currentSnapshot: task.currentSnapshot,
        }]));
        incoming.tasks = Array.isArray(incoming.tasks) ? incoming.tasks.map((task) => ({
          ...task,
          ...(automaticById.get(task.id) || {}),
        })) : [];
        return sendJson(res, 200, writeDashboardState(incoming));
      } catch {
        return sendJson(res, 400, { error: "历史记录保存失败" });
      }
    }
    if (url.pathname === "/api/collect" && req.method === "POST") {
      await runScheduledCollection(true);
      return sendJson(res, 200, { ok: true, checkedAt: new Date().toISOString() });
    }
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
  setTimeout(runScheduledCollection, 1500);
  setInterval(runScheduledCollection, 5 * 60 * 1000);
});
