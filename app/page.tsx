"use client";

import { useEffect, useMemo, useRef, useState } from "react";

type Metrics = {
  code: string;
  since: string;
  checkedAt: string;
  visitors: number;
  pageviews: number;
  identifiedUsers: number;
  loginUsers: number;
  loginEvents: number;
  registrations: number;
};

type Sample = Metrics & { elapsedMinutes: number };

const STORAGE_KEY = "watcha-growth-monitor-v1";

function extractCode(value: string) {
  const input = value.trim();
  const pathMatch = input.match(/\/r\/([A-Za-z0-9]{6})/);
  if (pathMatch) return pathMatch[1];
  return /^[A-Za-z0-9]{6}$/.test(input) ? input : "";
}

function fmt(n: number) {
  return new Intl.NumberFormat("zh-CN").format(n);
}

export default function Home() {
  const [input, setInput] = useState("");
  const [code, setCode] = useState("");
  const [startedAt, setStartedAt] = useState("");
  const [samples, setSamples] = useState<Sample[]>([]);
  const [status, setStatus] = useState<"idle" | "connecting" | "online" | "offline">("idle");
  const [error, setError] = useState("");
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    const saved = localStorage.getItem(STORAGE_KEY);
    if (!saved) return;
    try {
      const state = JSON.parse(saved);
      setInput(state.code || "");
      setCode(state.code || "");
      setStartedAt(state.startedAt || "");
      setSamples(state.samples || []);
    } catch {
      localStorage.removeItem(STORAGE_KEY);
    }
  }, []);

  useEffect(() => {
    if (!code || !startedAt) return;
    localStorage.setItem(STORAGE_KEY, JSON.stringify({ code, startedAt, samples }));
  }, [code, startedAt, samples]);

  async function refresh(activeCode = code, activeStart = startedAt) {
    if (!activeCode || !activeStart) return;
    setStatus((s) => (s === "idle" ? "connecting" : s));
    try {
      const response = await fetch(
        `/api/metrics?code=${encodeURIComponent(activeCode)}&since=${encodeURIComponent(activeStart)}`,
        { cache: "no-store" },
      );
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "数据库暂时不可用");
      const elapsedMinutes = Math.max(
        0,
        Math.round((Date.now() - new Date(activeStart).getTime()) / 60000),
      );
      const sample = { ...data, elapsedMinutes } as Sample;
      setSamples((current) => {
        const last = current.at(-1);
        if (last?.checkedAt === sample.checkedAt) return current;
        return [...current, sample].slice(-180);
      });
      setStatus("online");
      setError("");
    } catch (e) {
      setStatus("offline");
      setError(e instanceof Error ? e.message : "连接失败，正在等待重试");
    }
  }

  useEffect(() => {
    if (pollRef.current) clearInterval(pollRef.current);
    if (!code || !startedAt) return;
    refresh();
    pollRef.current = setInterval(() => refresh(), 60_000);
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [code, startedAt]);

  function startMonitor() {
    const nextCode = extractCode(input);
    if (!nextCode) {
      setError("请输入6位短链码，或粘贴包含 /r/短链码 的链接");
      return;
    }
    const now = new Date().toISOString();
    setCode(nextCode);
    setStartedAt(now);
    setSamples([]);
    setStatus("connecting");
    setError("");
  }

  function stopMonitor() {
    setCode("");
    setStartedAt("");
    setSamples([]);
    setStatus("idle");
    setError("");
    localStorage.removeItem(STORAGE_KEY);
  }

  const latest = samples.at(-1);
  const maxVisitors = Math.max(1, ...samples.map((s) => s.visitors));
  const elapsed = startedAt ? Math.max(0, Math.round((Date.now() - new Date(startedAt).getTime()) / 60000)) : 0;
  const progress = Math.min(100, (elapsed / 120) * 100);

  const milestones = useMemo(
    () => [
      { label: "30分钟", sample: samples.find((s) => s.elapsedMinutes >= 30) },
      { label: "1小时", sample: samples.find((s) => s.elapsedMinutes >= 60) },
      { label: "2小时", sample: samples.find((s) => s.elapsedMinutes >= 120) },
    ],
    [samples],
  );

  return (
    <main>
      <header className="topbar">
        <div className="brand">
          <span className="brandMark">观</span>
          <div>
            <strong>渠道增长工作台</strong>
            <small>ClickHouse 直连 · 不经过 Chat2DB</small>
          </div>
        </div>
        <div className={`connection ${status}`}>
          <span />
          {status === "online" ? "数据在线" : status === "offline" ? "等待重连" : status === "connecting" ? "正在连接" : "尚未监控"}
        </div>
      </header>

      <section className="hero">
        <div>
          <p className="eyebrow">社群转载效果监控</p>
          <h1>发出去以后，<br />增长马上看得见。</h1>
          <p className="heroCopy">粘贴观猹短链，工作台会建立发布基准，持续观察未来两小时的访客、拉新与登录变化。</p>
        </div>
        <div className="startCard">
          <label htmlFor="link">短链或链接</label>
          <div className="inputRow">
            <input
              id="link"
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="例如 fWE7iV 或 https://watcha.cn/r/fWE7iV"
              onKeyDown={(e) => e.key === "Enter" && startMonitor()}
            />
            {!code ? (
              <button onClick={startMonitor}>开始监控</button>
            ) : (
              <button className="secondary" onClick={() => refresh()}>立即刷新</button>
            )}
          </div>
          <div className="hint">
            <span>每分钟刷新</span>
            <span>断线自动重试</span>
            <span>本机保存记录</span>
          </div>
          {error && <p className="error">{error}</p>}
        </div>
      </section>

      <section className="workspace">
        <div className="monitorHead">
          <div>
            <p className="eyebrow">当前监控</p>
            <h2>{code ? `/r/${code}` : "等待一条短链"}</h2>
          </div>
          {code && (
            <button className="textButton" onClick={stopMonitor}>结束本次监控</button>
          )}
        </div>

        <div className="kpis">
          <article className="kpi primary">
            <span>新增访客</span>
            <strong>{fmt(latest?.visitors ?? 0)}</strong>
            <small>发布后去重会话</small>
          </article>
          <article className="kpi">
            <span>页面浏览</span>
            <strong>{fmt(latest?.pageviews ?? 0)}</strong>
            <small>短链入口浏览量</small>
          </article>
          <article className="kpi">
            <span>可识别拉新</span>
            <strong>{fmt(latest?.identifiedUsers ?? 0)}</strong>
            <small>携带用户标识</small>
          </article>
          <article className="kpi">
            <span>登录用户</span>
            <strong>{fmt(latest?.loginUsers ?? 0)}</strong>
            <small>{fmt(latest?.loginEvents ?? 0)} 次登录事件</small>
          </article>
        </div>

        <div className="grid">
          <article className="panel trend">
            <div className="panelTitle">
              <div>
                <span>两小时增长曲线</span>
                <small>访客累计变化</small>
              </div>
              <strong>{elapsed} 分钟</strong>
            </div>
            <div className="bars" aria-label="访客增长趋势">
              {samples.length ? samples.map((sample, index) => (
                <div
                  key={`${sample.checkedAt}-${index}`}
                  className="bar"
                  style={{ height: `${Math.max(4, (sample.visitors / maxVisitors) * 100)}%` }}
                  title={`${sample.elapsedMinutes}分钟：${sample.visitors}位访客`}
                />
              )) : <div className="empty">开始监控后，增长曲线会出现在这里</div>}
            </div>
            <div className="timeline"><span>发布</span><span>1小时</span><span>2小时</span></div>
            <div className="progress"><i style={{ width: `${progress}%` }} /></div>
          </article>

          <article className="panel milestone">
            <div className="panelTitle">
              <div>
                <span>关键时间点</span>
                <small>自动留存快照</small>
              </div>
            </div>
            <div className="milestoneList">
              {milestones.map(({ label, sample }) => (
                <div key={label}>
                  <span>{label}</span>
                  <strong>{sample ? `+${fmt(sample.visitors)}` : "等待中"}</strong>
                  <small>{sample ? `${sample.identifiedUsers} 拉新 · ${sample.loginUsers} 登录` : "到点自动记录"}</small>
                </div>
              ))}
            </div>
          </article>
        </div>

        <div className="footnote">
          <span>注册事件单独显示：{fmt(latest?.registrations ?? 0)}</span>
          <span>最近检查：{latest ? new Date(latest.checkedAt).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—"}</span>
          <span>网络中断时保留最后一次结果，不写成0</span>
        </div>
      </section>
    </main>
  );
}
