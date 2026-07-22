export const WEB_INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mono-agent web</title><link rel="stylesheet" href="/styles.css"></head>
<body><header><strong>mono-agent</strong><span id="status">Connecting…</span></header>
<main><aside><label>Agent<select id="agents"></select></label><button id="new-thread">New conversation</button><nav id="threads"></nav></aside>
<section><div id="messages"><p class="empty">Choose or create a conversation.</p></div>
<form id="composer"><textarea id="text" aria-label="Message" placeholder="Message the selected agent" required></textarea><div><button type="submit">Send</button><button id="cancel" type="button">Cancel</button></div></form></section></main>
<script src="/app.js" defer></script></body></html>`;

export const WEB_STYLES = `:root{color-scheme:dark;font:15px/1.45 ui-sans-serif,system-ui;background:#111;color:#eee}*{box-sizing:border-box}body{margin:0}header{height:52px;padding:0 20px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid #333}main{height:calc(100vh - 52px);display:grid;grid-template-columns:280px 1fr}aside{padding:16px;border-right:1px solid #333;overflow:auto}label,select,button,textarea{font:inherit}select,button,textarea{color:inherit;background:#1d1d1d;border:1px solid #444;border-radius:7px}select,button{padding:8px}label{display:grid;gap:5px}#new-thread{width:100%;margin:12px 0}.thread{display:block;width:100%;text-align:left;margin:5px 0}.thread.active{border-color:#8ab4ff}.thread small{display:block;color:#aaa}section{min-width:0;display:grid;grid-template-rows:1fr auto}#messages{padding:24px;overflow:auto}.message{max-width:760px;margin:0 auto 14px;padding:12px 15px;border-radius:12px;white-space:pre-wrap}.user{background:#224b70}.assistant{background:#222}.message.failed{border:1px solid #a44}.meta{font-size:12px;color:#aaa;margin-bottom:5px}.empty{color:#999}form{border-top:1px solid #333;padding:14px;display:flex;gap:10px}textarea{flex:1;min-height:64px;padding:10px;resize:vertical}form div{display:flex;gap:8px;align-items:flex-end}@media(max-width:700px){main{grid-template-columns:1fr;grid-template-rows:auto 1fr}aside{border-right:0;border-bottom:1px solid #333;max-height:210px}}`;

export const WEB_APP_JS = `(() => {
  const api = async (path, options = {}) => {
    let token = sessionStorage.getItem("mono-agent-web-token");
    if (!token) { token = prompt("Web authentication token") || ""; sessionStorage.setItem("mono-agent-web-token", token); }
    const response = await fetch(path, { ...options, headers: { authorization: "Bearer " + token, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    if (response.status === 401) { sessionStorage.removeItem("mono-agent-web-token"); throw new Error("Authentication failed. Reload to retry."); }
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "Request failed: " + response.status); }
    return response;
  };
  const state = { bootstrap: null, threadId: null };
  const agents = document.querySelector("#agents"), threads = document.querySelector("#threads"), messages = document.querySelector("#messages"), status = document.querySelector("#status"), text = document.querySelector("#text");
  const renderBootstrap = () => {
    agents.replaceChildren(...state.bootstrap.agents.map(agent => Object.assign(document.createElement("option"), { value: agent.id, textContent: agent.label + (agent.online ? "" : " (offline)") })));
    threads.replaceChildren(...state.bootstrap.threads.map(thread => { const button = document.createElement("button"); button.className = "thread" + (thread.id === state.threadId ? " active" : ""); button.dataset.id = thread.id; button.textContent = thread.title; const small = document.createElement("small"); small.textContent = thread.status; button.append(small); return button; }));
  };
  const renderThread = detail => { state.threadId = detail.thread.id; messages.replaceChildren(...detail.messages.map(message => { const div = document.createElement("div"); div.className = "message " + message.role + " " + message.status; const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = message.role + " · " + message.status; const body = document.createElement("div"); body.textContent = message.text || (message.status === "running" ? "…" : ""); div.append(meta, body); return div; })); messages.scrollTop = messages.scrollHeight; renderBootstrap(); };
  const load = async () => { state.bootstrap = await (await api("/api/v1/bootstrap")).json(); renderBootstrap(); status.textContent = "Ready"; };
  threads.addEventListener("click", async event => { const button = event.target.closest("button[data-id]"); if (!button) return; renderThread(await (await api("/api/v1/threads/" + encodeURIComponent(button.dataset.id))).json()); });
  document.querySelector("#new-thread").addEventListener("click", async () => { if (!agents.value) return; const thread = await (await api("/api/v1/threads", { method: "POST", body: JSON.stringify({ agentId: agents.value }) })).json(); await load(); renderThread(await (await api("/api/v1/threads/" + encodeURIComponent(thread.id))).json()); });
  document.querySelector("#composer").addEventListener("submit", async event => { event.preventDefault(); if (!state.threadId || !text.value.trim()) return; const value = text.value; text.value = ""; status.textContent = "Running"; const response = await api("/api/v1/threads/" + encodeURIComponent(state.threadId) + "/turns", { method: "POST", body: JSON.stringify({ text: value }) }); const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = ""; while (true) { const item = await reader.read(); if (item.done) break; buffer += decoder.decode(item.value, { stream: true }); const lines = buffer.split("\n"); buffer = lines.pop() || ""; for (const line of lines) if (line) { const event = JSON.parse(line); if (event.detail) renderThread(event.detail); } } status.textContent = "Ready"; await load(); });
  document.querySelector("#cancel").addEventListener("click", async () => { if (!state.threadId) return; const detail = await (await api("/api/v1/threads/" + encodeURIComponent(state.threadId) + "/cancel", { method: "POST", body: "{}" })).json(); renderThread(detail); });
  load().catch(error => { status.textContent = error.message; });
})();`;
