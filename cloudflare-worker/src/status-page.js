function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function fmtTime(seconds) {
  if (!seconds) return '从未';
  return new Date(seconds * 1000).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai', hour12: false });
}

function fmtDate(seconds) {
  if (!seconds) return '从未';
  return new Date(seconds * 1000).toLocaleDateString('zh-CN', { timeZone: 'Asia/Shanghai' });
}

function stateLabel(state) {
  const labels = {
    healthy: '运行正常',
    suspect: '疑似异常',
    down: '确认宕机',
    rebooting: '正在重启',
    recovering: '恢复中',
  };
  return labels[state] || '未知';
}

function isIpAddress(value) {
  return /^\d{1,3}(?:\.\d{1,3}){3}$/.test(String(value || '').trim());
}

function displayName(server) {
  return isIpAddress(server.name) || isIpAddress(server.ip) ? `服务器 #${server.id}` : server.name;
}

function checkMethod(server) {
  const value = String(server.check_method || 'api_only').toLowerCase();
  if (value === 'service_then_power') return '三步检测';
  if (value.includes('tcp')) return 'tcp';
  if (value.includes('http')) return 'http';
  return 'api';
}

function availability(server) {
  const history = Array.isArray(server.daily_history) ? server.daily_history.slice(-30) : [];
  let totalChecks = 0;
  let totalFailures = 0;

  for (const day of history) {
    const checks = Number(day.checks);
    if (!Number.isFinite(checks) || checks <= 0) continue;

    const failures = Number(day.failures);
    totalChecks += checks;
    totalFailures += Number.isFinite(failures)
      ? Math.min(checks, Math.max(0, failures))
      : 0;
  }

  if (totalChecks === 0) return '--';
  return `${(((totalChecks - totalFailures) / totalChecks) * 100).toFixed(3)}%`;
}

function duration(seconds) {
  const value = Number(seconds || 0);
  if (value < 60) return `${value}s`;
  if (value < 3600) return `${Math.round(value / 60)}m`;
  return `${Math.floor(value / 3600)}h ${Math.round((value % 3600) / 60)}m`;
}

function daySegments(server) {
  const history = (server.daily_history || []).slice(-30);
  const emptyCount = Math.max(0, 30 - history.length);
  const emptySlots = Array.from({ length: emptyCount }, () => '<span class="day-segment placeholder" aria-hidden="true"></span>').join('');
  return `${emptySlots}${history.map((day) => {
    const failures = Number(day.failures || 0);
    const level = failures === 0 ? 'ok' : Number(day.uptime_value || parseFloat(day.uptime)) <= 0 ? 'bad' : 'warn';
    const tip = escapeHtml(`${day.date}\n● ${day.uptime} 可用率\n探测 ${day.checks || 0} 次，失败 ${failures} 次\n不可用时长 ${duration(day.downtime_seconds)}`);
    const outages = escapeHtml(JSON.stringify(Array.isArray(day.outages) ? day.outages : []));
    return `<span class="day-segment ${level}" data-tip="${tip}" data-date="${escapeHtml(day.date)}" data-failures="${failures}" data-downtime="${Number(day.downtime_seconds || 0)}" data-outages="${outages}" role="button" aria-label="${escapeHtml(day.date)} 故障明细" tabindex="0"></span>`;
  }).join('')}`;
}

function probeLatency(check) {
  const value = Number(check.latency_ms || 0);
  return value > 0 ? `${value}ms` : '-';
}

function probeHeight(check) {
  if (!check.ok) return 9;
  const value = Number(check.latency_ms || 0);
  return Math.max(9, Math.min(28, 9 + Math.round(value / 500)));
}

function bars(server, count = 60) {
  const checks = Array.isArray(server.recent_checks) ? server.recent_checks.slice(0, count).reverse() : [];
  const emptyCount = Math.max(0, count - checks.length);
  const emptySlots = Array.from({ length: emptyCount }, () => '<span class="probe-placeholder" style="height:9px" aria-hidden="true"></span>').join('');
  const realSlots = checks.map((check) => {
    const ok = Boolean(check.ok);
    const label = ok ? '运行正常' : '探测失败';
    const tip = escapeHtml(`${fmtTime(check.created_at)}\n● ${label} · ${probeLatency(check)}`);
    return `<span class="${ok ? 'ok' : 'bad'}" style="height:${probeHeight(check)}px" data-tip="${tip}" tabindex="0"></span>`;
  }).join('');
  return `${emptySlots}${realSlots}`;
}

function latency(server) {
  const value = Number(server.last_latency_ms || server.latency_ms || 0);
  const text = value > 0 ? `${value}ms` : '-';
  return { best: text, avg: text, worst: text };
}

function eventRow(event) {
  const level = escapeHtml(event.level || 'info');
  return `<li class="timeline-item level-${level}">
    <time>${escapeHtml(fmtTime(event.created_at))}</time>
    <span class="timeline-dot"></span>
    <div><b>${escapeHtml(event.server_name || '')}${event.server_name ? ' · ' : ''}${escapeHtml(event.label || '状态变更')}</b><p>${escapeHtml(stateLabel(event.old_state))} -> ${escapeHtml(stateLabel(event.new_state))}</p></div>
  </li>`;
}

function eventHistory(servers) {
  const events = servers.flatMap((server) => (server.events || []).map((event) => ({ ...event, server_name: displayName(server) })))
    .sort((a, b) => Number(b.created_at || 0) - Number(a.created_at || 0))
    .slice(0, 2);
  if (!events.length) {
    return '<section class="history"><div class="history-head"><h2>事件历史</h2><a class="more" href="/admin">查看更多</a></div><div class="history-card"><p class="history-empty">暂无历史事件</p></div></section>';
  }
  return `<section class="history"><div class="history-head"><h2>事件历史</h2><a class="more" href="/admin">查看更多</a></div><div class="history-card"><ol>${events.map(eventRow).join('')}</ol></div></section>`;
}

function row(server) {
  const state = server.state || 'unknown';
  const safeName = escapeHtml(displayName(server));
  const stats = latency(server);
  const method = checkMethod(server);
  const dayTitle = '近 30 天可用性';
  return `<article class="status-card status-card--${state}" role="listitem">
    <div class="card-head">
      <div class="name-row"><span class="dot"></span><div><h3>${safeName}</h3><p>${method}</p></div></div>
      <div class="badges"><span class="uptime">● ${availability(server)}</span><span class="state">${stateLabel(state)}</span></div>
    </div>
    <p class="caption">${dayTitle}</p>
    <div class="day-track" aria-label="${dayTitle}">${daySegments(server) || '<span class="day-empty">暂无真实探测记录</span>'}</div>
    <p class="caption">最近 60 次探测</p>
    <div class="probe-bars" aria-label="最近探测详情">${bars(server)}</div>
    <div class="card-foot"><span>最快 ${stats.best}</span><span>平均 ${stats.avg}</span><span>最慢 ${stats.worst}</span><span>${fmtTime(server.last_check_time).slice(-5)}</span></div>
    <div class="sr-meta">24 小时重启 ${server.reboot_count_today ?? 0} 次；最后重启 ${fmtTime(server.last_reboot_time)}</div>
  </article>`;
}

export function renderStatusPage(servers, settings = {}) {
  const siteTitle = String(settings.site_title || '服务器自动监控');
  const documentTitle = String(settings.site_title || 'ZJMF 服务器监控');
  const siteDescription = String(settings.site_description || 'Cloudflare Worker 按探测间隔执行 API / HTTP(S) / TCP 检测；连续失败 3 次后确认异常并执行重启。');
  const cards = servers.length
    ? `<section class="service-group"><h2 class="group-title">未分组</h2><div class="grid" role="list">${servers.map(row).join('')}</div></section>`
    : '<p class="empty">暂无启用的监控服务器。</p>';
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(documentTitle)}</title>
  <style>
    :root{--bg:#f6f8fb;--panel:#fff;--ink:#0f1b2d;--muted:#7b8da8;--line:#d9e2ef;--track:#e8eef7;--ok:#10c98f;--bad:#ef5267;--warn:#f59e0b;--blue:#2563eb}
    *{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 12% 0,rgba(16,201,143,.12),transparent 28%),linear-gradient(180deg,#fff,var(--bg));color:var(--ink);font-family:"Bahnschrift","Aptos Display","Microsoft YaHei UI",sans-serif}
    main{width:min(760px,calc(100% - 32px));margin:0 auto;padding:54px 0}.pageNav{display:flex;justify-content:flex-end;margin-bottom:22px}.adminLink{border:1px solid var(--line);background:#fff;color:#0f1b2d;text-decoration:none;border-radius:999px;padding:10px 16px;font-weight:800;box-shadow:0 12px 28px rgba(15,27,45,.08)}
    .hero{display:flex;align-items:end;justify-content:space-between;gap:18px;margin-bottom:24px}.tag{color:#0b9f75;letter-spacing:.18em;font-size:12px;font-weight:900;text-transform:uppercase}h1{font-size:34px;margin:10px 0 6px;letter-spacing:-.05em}.lead{color:var(--muted);line-height:1.65;margin:0}
    .service-title{font-size:28px;margin:22px 0 12px}.group-title{font-size:22px;margin:0 0 10px}.grid{display:grid;gap:14px;width:min(100%,600px)}.status-card{min-width:0;border:1px solid #cfd9e8;background:linear-gradient(180deg,#fff,#f9fbff);box-shadow:0 18px 44px rgba(15,27,45,.09);border-radius:20px;padding:18px;animation:rise .45s ease both}.status-card--healthy{border-color:#b9e9d9}.status-card--down,.status-card--recovering,.status-card--rebooting{border-color:#ffc4cc}
    .card-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px}.name-row{display:flex;gap:12px;align-items:flex-start}.dot{width:10px;height:10px;border-radius:99px;background:var(--ok);margin-top:8px;box-shadow:0 0 0 4px rgba(16,201,143,.13)}.status-card--down .dot,.status-card--rebooting .dot{background:var(--bad);box-shadow:0 0 0 4px rgba(239,82,103,.13)}h3{margin:0;font-size:22px}.name-row p{margin:2px 0 0;color:#5f718c}.badges{display:flex;gap:8px;flex-wrap:wrap;justify-content:flex-end}.uptime,.state{border:1px solid #b8ecd8;background:#ecfdf6;color:#047857;border-radius:999px;padding:4px 10px;font-size:13px}
    .caption{color:var(--muted);margin:18px 0 8px}.day-track{height:28px;border-radius:8px;background:var(--track);padding:0 3px;display:flex;gap:2px;align-items:stretch;overflow:visible}.day-segment{position:relative;flex:1;min-width:0;border-radius:6px;background:#cdd8e7;outline:0;transition:transform .16s ease,box-shadow .16s ease}.day-segment.placeholder{background:#dce5f2;opacity:.75}.day-segment.ok{background:linear-gradient(90deg,#34d399,#10c98f)}.day-segment.warn{background:#fbbf24}.day-segment.bad{background:var(--bad)}.day-empty{display:grid;place-items:center;width:100%;color:var(--muted);font-size:13px}
    .probe-bars{height:30px;background:var(--track);border-radius:8px;padding:5px 6px;display:flex;gap:4px;align-items:end}.probe-bars span{position:relative;display:block;width:6px;border-radius:2px;outline:0;transition:transform .16s ease,box-shadow .16s ease}.probe-bars .ok{background:#10c98f}.probe-bars .bad{background:var(--bad)}.probe-bars .probe-placeholder{background:#d9e4f2;opacity:.85}.day-segment[data-tip]:hover,.day-segment[data-tip]:focus,.probe-bars span[data-tip]:hover,.probe-bars span[data-tip]:focus{box-shadow:0 0 0 2px #fff,0 0 0 4px rgba(15,27,45,.20);transform:translateY(-7px);z-index:4}
    .day-track span[data-tip]:hover:after,.day-track span[data-tip]:focus:after,.probe-bars span[data-tip]:hover:after,.probe-bars span[data-tip]:focus:after{content:attr(data-tip);position:absolute;left:50%;bottom:30px;transform:translateX(-50%);z-index:6;white-space:pre;min-width:180px;background:#fff;border:1px solid var(--line);box-shadow:0 18px 36px rgba(15,27,45,.16);border-radius:12px;padding:10px 12px;color:var(--ink);font-size:13px}.day-track span[data-tip]:hover:before,.day-track span[data-tip]:focus:before,.probe-bars span[data-tip]:hover:before,.probe-bars span[data-tip]:focus:before{content:"";position:absolute;left:50%;bottom:24px;border:7px solid transparent;border-top-color:#fff;transform:translateX(-50%);z-index:7}
    .card-foot{display:flex;gap:12px;flex-wrap:wrap;color:#6f819c;margin-top:10px}.sr-meta{font-size:12px;color:#8ba0bd;margin-top:8px}.history{margin-top:28px}.history-head{display:flex;align-items:baseline;justify-content:space-between;gap:16px;margin:26px 0 12px}.history h2{font-size:24px;margin:0}.more{color:var(--blue);text-decoration:none;font-weight:700}.history-card{padding:0}.history-card ol{list-style:none;margin:0;padding:0;display:grid;gap:10px}.timeline-item{display:grid;grid-template-columns:156px 18px 1fr;gap:12px;align-items:start;padding:14px;border:1px solid var(--line);background:#fff;border-radius:16px}.timeline-item time{color:var(--muted);font-size:13px}.timeline-dot{width:10px;height:10px;border-radius:99px;background:var(--blue);margin-top:4px}.level-critical .timeline-dot{background:var(--bad)}.level-warning .timeline-dot{background:var(--warn)}.level-info .timeline-dot{background:var(--ok)}.timeline-item b{display:block}.timeline-item p{margin:4px 0 0;color:var(--muted)}.history-empty{padding:28px;border:1px dashed var(--line);border-radius:22px;color:var(--muted);background:#fff;text-align:center}.empty{padding:28px;border:1px dashed var(--line);border-radius:22px;color:var(--muted);background:#fff}footer{margin-top:26px;color:var(--muted);font-size:13px}.api{color:var(--blue);text-decoration:none}
    .outage-modal[hidden]{display:none}.outage-modal{position:fixed;inset:0;z-index:50;display:grid;place-items:center;padding:24px;background:rgba(15,27,45,.56);backdrop-filter:blur(5px)}.outage-dialog{width:min(660px,100%);max-height:min(680px,calc(100vh - 48px));overflow:auto;background:#fff;border:1px solid rgba(217,226,239,.9);border-radius:28px;padding:28px 32px 32px;box-shadow:0 32px 90px rgba(15,27,45,.28)}.outage-head{display:flex;align-items:flex-start;justify-content:space-between;gap:24px}.outage-kicker{margin:0 0 6px;color:#8a9bb4}.outage-date{margin:0;font-size:28px;letter-spacing:0}.outage-close{border:0;background:transparent;color:#43536b;font:inherit;font-size:17px;padding:8px;cursor:pointer}.outage-summary{margin:8px 0 22px;color:#52647e;font-size:17px}.outage-list{display:grid;gap:10px}.outage-row{display:flex;align-items:center;justify-content:space-between;gap:24px;padding:17px 18px;border-radius:12px;background:#f6f8fb;color:#273851;font-size:17px}.outage-empty{margin:0;color:#60728d;font-size:17px}.day-segment[role="button"]{cursor:pointer}
    @keyframes rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:translateY(0)}}@media(max-width:760px){.hero{display:block}.summary{justify-content:flex-start;margin-top:16px}.card-head{display:block}.badges{justify-content:flex-start;margin-top:12px}.history-head{display:block}.timeline-item{grid-template-columns:156px 18px 1fr}.outage-modal{padding:16px}.outage-dialog{padding:24px 22px;border-radius:22px}.outage-row{font-size:15px}}
  </style>
</head>
<body>
  <main>
    <nav class="pageNav"><a class="adminLink" href="/admin">管理面板</a></nav>
    <section class="hero">
      <div><span class="tag">ZJMF Monitor</span><h1>${escapeHtml(siteTitle)}</h1><p class="lead">${escapeHtml(siteDescription)}</p></div>
    </section>
    ${cards}
    ${eventHistory(servers)}
    <footer>数据接口：<a class="api" href="/api/status">/api/status</a></footer>
  </main>
  <div id="outageModal" class="outage-modal" role="dialog" aria-modal="true" aria-labelledby="outageModalTitle" hidden>
    <section class="outage-dialog">
      <div class="outage-head"><div><p class="outage-kicker">故障明细</p><h2 id="outageModalTitle" class="outage-date"></h2></div><button id="outageClose" class="outage-close" type="button">关闭</button></div>
      <p id="outageSummary" class="outage-summary"></p>
      <div id="outageList" class="outage-list"></div>
    </section>
  </div>
  <script>
    const outageModal=document.getElementById('outageModal');
    const outageTitle=document.getElementById('outageModalTitle');
    const outageSummary=document.getElementById('outageSummary');
    const outageList=document.getElementById('outageList');
    const outageClose=document.getElementById('outageClose');
    let outageTrigger=null;
    function outageDuration(seconds){const value=Math.max(0,Number(seconds||0));if(value<60)return value+'s';if(value<3600)return Math.round(value/60)+'m';return Math.floor(value/3600)+'h '+Math.round(value%3600/60)+'m'}
    function outageDate(value){const parts=String(value||'').split('-').map(Number);return parts.length===3?parts[0]+'/'+parts[1]+'/'+parts[2]:String(value||'')}
    function outageTime(seconds){return new Date(Number(seconds||0)*1000).toLocaleTimeString('zh-CN',{timeZone:'Asia/Shanghai',hour:'2-digit',minute:'2-digit',hour12:false})}
    function closeOutageModal(){outageModal.hidden=true;if(outageTrigger)outageTrigger.focus();outageTrigger=null}
    function openOutageModal(segment){outageTrigger=segment;let outages=[];try{outages=JSON.parse(segment.dataset.outages||'[]')}catch{}const total=Number(segment.dataset.downtime||0);const failures=Number(segment.dataset.failures||0);outageTitle.textContent=outageDate(segment.dataset.date);outageSummary.textContent='总计: '+outageDuration(total);if(outages.length){outageList.innerHTML=outages.map(item=>'<div class="outage-row"><span>'+outageTime(item.start_at)+' – '+outageTime(item.end_at)+'</span><b>'+outageDuration(item.duration_seconds)+'</b></div>').join('')}else{outageList.innerHTML='<p class="outage-empty">'+(failures?'当天有故障记录，但暂无可显示的详细时段。':'当天没有记录到故障。')+'</p>'}outageModal.hidden=false;outageClose.focus()}
    document.addEventListener('click',event=>{const segment=event.target.closest('.day-segment[data-date]');if(segment)openOutageModal(segment)});
    document.addEventListener('keydown',event=>{if((event.key==='Enter'||event.key===' ')&&event.target.matches('.day-segment[data-date]')){event.preventDefault();openOutageModal(event.target)}if(event.key==='Escape'&&!outageModal.hidden)closeOutageModal()});
    outageClose.addEventListener('click',closeOutageModal);
    outageModal.addEventListener('click',event=>{if(event.target===outageModal)closeOutageModal()});
  </script>
</body>
</html>`;
}
