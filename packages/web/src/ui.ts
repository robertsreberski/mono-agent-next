import { OPERATOR_LIMITS } from "@mono-agent/operator";

import type { WebMessage } from "./contracts.js";

const MAX_INLINE_ATTACHMENT_BYTES = 512 * 1_024;
const UPLOAD_SELECTION_RESERVE = 32 * 1_024;

export const WEB_TELEMETRY_TEXT_BOUND = 256;

/**
 * The browser embeds this exact pure function. Keeping message text separate
 * from a fixed, numeric-only telemetry description prevents metadata from
 * replacing or injecting conversation content.
 */
export function presentWebMessage(
  message: Pick<WebMessage, "text" | "telemetry">,
): { readonly body: string; readonly telemetry: readonly string[] } {
  const value = message.telemetry;
  if (value === undefined) return { body: message.text, telemetry: [] };
  const count = (candidate: unknown): string =>
    Number.isSafeInteger(candidate) && Number(candidate) >= 0 ? String(candidate) : "?";
  const lines = [
    `Usage: ${count(value.inputTokens)} input · ${count(value.outputTokens)} output`,
  ];
  if (value.contextWindow !== undefined) {
    lines.push(
      value.contextUsed === undefined
        ? `Context window: ${count(value.contextWindow)}`
        : `Context: ${count(value.contextUsed)} / ${count(value.contextWindow)}`,
    );
  }
  const events = [
    ...(value.compacted ? ["context compacted"] : []),
    ...(value.sessionEvicted ? ["provider session evicted"] : []),
  ];
  if (events.length > 0) lines.push(`Events: ${events.join(", ")}`);
  return { body: message.text, telemetry: lines };
}

export const WEB_INDEX_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>mono-agent web</title><link rel="stylesheet" href="/styles.css"></head>
<body><header><strong>mono-agent</strong><span id="status">Connecting…</span><button id="notifications" type="button">Enable notifications</button></header>
<main><aside><label>Agent<select id="agents"></select></label><button id="new-thread">New conversation</button>
<div class="toolbar"><button id="config" type="button">Config</button><button id="health" type="button">Health</button><button id="replay" type="button">Replay</button><button id="delete" type="button">Delete</button></div>
<nav id="threads"></nav></aside>
<section><div id="view" hidden></div><div id="messages"><p class="empty">Choose or create a conversation.</p></div><div id="ask"></div>
<div id="draft"></div><form id="composer"><textarea id="text" aria-label="Message" placeholder="Message the selected agent"></textarea>
<div><input id="files" type="file" multiple hidden><input id="model" aria-label="Model override" placeholder="Model"><input id="effort" aria-label="Effort override" placeholder="Effort"><button id="attach" type="button">Attach</button><button type="submit">Send</button><button id="cancel" type="button">Cancel</button></div></form></section></main>
<script src="/app.js" defer></script></body></html>`;

export const WEB_STYLES = `:root{color-scheme:dark;font:15px/1.45 ui-sans-serif,system-ui;background:#111;color:#eee}*{box-sizing:border-box}body{margin:0}header{height:52px;padding:0 20px;display:flex;align-items:center;gap:12px;border-bottom:1px solid #333}header #status{margin-left:auto}main{height:calc(100vh - 52px);display:grid;grid-template-columns:300px 1fr}aside{padding:16px;border-right:1px solid #333;overflow:auto}label,select,button,textarea,input{font:inherit}select,button,textarea,input{color:inherit;background:#1d1d1d;border:1px solid #444;border-radius:7px}select,button{padding:8px}button:disabled{opacity:.45}label{display:grid;gap:5px}#new-thread{width:100%;margin:12px 0}.toolbar{display:grid;grid-template-columns:1fr 1fr;gap:5px;margin-bottom:12px}.thread{display:block;width:100%;text-align:left;margin:5px 0}.thread.active{border-color:#8ab4ff}.thread.proactive{border-left:3px solid #d0a5ff}.thread small{display:block;color:#aaa}section{min-width:0;display:grid;grid-template-rows:auto 1fr auto auto auto}#messages{padding:24px;overflow:auto}.message{position:relative;max-width:760px;margin:0 auto 14px;padding:12px 15px;border-radius:12px;white-space:pre-wrap}.user{background:#224b70}.assistant{background:#222}.message.failed{border:1px solid #a44}.meta,.telemetry{font-size:12px;color:#aaa;margin-bottom:5px}.telemetry{margin-top:8px;margin-bottom:0}.attachment{display:inline-block;margin:8px 5px 0 0;padding:3px 7px;border:1px solid #555;border-radius:5px;font-size:12px}.quote{border-left:3px solid #88a;padding-left:8px;color:#ccd;margin-bottom:8px}.quote-button{float:right;padding:3px 6px}.empty{color:#999}#ask,#draft{padding:0 16px}#ask form,#view{max-width:760px;margin:8px auto;padding:12px;border:1px solid #665b2c;background:#25210f;border-radius:8px}#ask fieldset{margin:8px 0;border:1px solid #555}#ask label{display:block;margin:5px}#view{max-height:35vh;overflow:auto;border-color:#355}#view pre{white-space:pre-wrap}#view .replay-row{display:flex;gap:8px;align-items:start;margin:6px 0}#view .replay-row span{flex:1;white-space:pre-wrap}#draft{color:#bbb}form#composer{border-top:1px solid #333;padding:14px;display:flex;gap:10px}textarea{flex:1;min-height:64px;padding:10px;resize:vertical}form#composer>div{display:flex;flex-wrap:wrap;gap:8px;align-items:flex-end}#model,#effort{width:120px;padding:8px}@media(max-width:700px){main{grid-template-columns:1fr;grid-template-rows:auto 1fr}aside{border-right:0;border-bottom:1px solid #333;max-height:230px}}`;

export const WEB_APP_JS = `(() => {
  const presentMessage = ${presentWebMessage.toString()};
  const maxAttachmentBytes = ${MAX_INLINE_ATTACHMENT_BYTES};
  const maxAttachmentUrlCharacters = ${OPERATOR_LIMITS.attachmentUrlCharacters};
  const maxRequestBytes = ${OPERATOR_LIMITS.requestBytes};
  const uploadSelectionBudget = ${OPERATOR_LIMITS.requestBytes - UPLOAD_SELECTION_RESERVE};
  const api = async (path, options = {}) => {
    let token = sessionStorage.getItem("mono-agent-web-token");
    if (!token) { token = prompt("Web authentication token") || ""; sessionStorage.setItem("mono-agent-web-token", token); }
    const response = await fetch(path, { ...options, headers: { authorization: "Bearer " + token, ...(options.body ? { "content-type": "application/json" } : {}), ...(options.headers || {}) } });
    if (response.status === 401) { sessionStorage.removeItem("mono-agent-web-token"); throw new Error("Authentication failed. Reload to retry."); }
    if (!response.ok) { const body = await response.json().catch(() => ({})); throw new Error(body.error?.message || "Request failed: " + response.status); }
    return response;
  };
  const state = { bootstrap: null, detail: null, threadId: null, attachments: [], quote: null };
  const agents = document.querySelector("#agents"), threads = document.querySelector("#threads"), messages = document.querySelector("#messages");
  const status = document.querySelector("#status"), text = document.querySelector("#text"), ask = document.querySelector("#ask");
  const draft = document.querySelector("#draft"), files = document.querySelector("#files"), view = document.querySelector("#view");
  const model = document.querySelector("#model"), effort = document.querySelector("#effort");
  const selectedThread = () => state.detail?.thread;
  const selectedAgent = () => state.bootstrap?.agents.find(agent => agent.id === (selectedThread()?.agentId || agents.value));
  const capability = name => selectedAgent()?.capabilities?.[name] === true;
  const localId = () => globalThis.crypto?.randomUUID?.() || ("web-" + Date.now() + "-" + Math.random().toString(16).slice(2));
  const showError = error => { status.textContent = error.message || String(error); };
  const renderBootstrap = () => {
    const selectedAgentId = selectedThread()?.agentId || agents.value;
    agents.replaceChildren(...state.bootstrap.agents.map(agent => Object.assign(document.createElement("option"), { value: agent.id, textContent: agent.label + (agent.online ? "" : " (offline)") })));
    if (selectedAgentId) agents.value = selectedAgentId;
    threads.replaceChildren(...state.bootstrap.threads.map(thread => {
      const button = document.createElement("button");
      button.className = "thread" + (thread.id === state.threadId ? " active" : "") + (thread.proactive ? " proactive" : "");
      button.dataset.id = thread.id;
      button.textContent = thread.title;
      const small = document.createElement("small");
      small.textContent = (thread.proactive ? "proactive · " : "") + thread.status;
      button.append(small);
      return button;
    }));
    renderControls();
  };
  const renderControls = () => {
    const running = selectedThread()?.status === "running";
    document.querySelector("#cancel").disabled = !running || !capability("cancellation");
    document.querySelector("#attach").disabled = running || !capability("attachments");
    document.querySelector("#replay").disabled = !selectedThread() || !capability("replay");
    document.querySelector("#delete").disabled = !selectedThread() || running;
    document.querySelector("#config").disabled = !selectedAgent() || !capability("configView");
    document.querySelector("#health").disabled = !selectedAgent() || !capability("health");
    model.disabled = running || !capability("runtimeOverrides");
    effort.disabled = running || !capability("runtimeOverrides");
    text.placeholder = running && capability("liveInput") ? "Offer live input to the active turn" : "Message the selected agent";
  };
  const renderDraft = () => {
    const parts = [];
    if (state.quote) parts.push("Quoting " + state.quote.messageId);
    if (state.attachments.length) parts.push(state.attachments.length + " attachment(s)");
    draft.textContent = parts.join(" · ");
  };
  const chooseQuote = (thread, message) => {
    state.quote = {
      conversationId: thread.operatorConversationId || "web:" + thread.id,
      messageId: message.operatorMessageId || message.id,
      text: message.text,
    };
    renderDraft();
  };
  const renderAsk = detail => {
    ask.replaceChildren();
    const pending = detail.thread.pendingAsk;
    if (!pending) return;
    const form = document.createElement("form");
    const heading = document.createElement("strong"); heading.textContent = "Agent needs your answer"; form.append(heading);
    pending.questions.forEach(question => {
      const fieldset = document.createElement("fieldset"); fieldset.dataset.question = question.id;
      const legend = document.createElement("legend"); legend.textContent = question.prompt; fieldset.append(legend);
      (question.choices || []).forEach(choice => {
        const label = document.createElement("label"), input = document.createElement("input");
        input.type = question.multiple ? "checkbox" : "radio"; input.name = "choice-" + question.id; input.value = choice.value;
        label.append(input, document.createTextNode(" " + choice.label + (choice.description ? " — " + choice.description : ""))); fieldset.append(label);
      });
      if (question.allowFreeText) {
        const input = document.createElement("input"); input.type = "text"; input.dataset.freeText = "true"; input.placeholder = "Other answer"; fieldset.append(input);
      }
      form.append(fieldset);
    });
    const submit = document.createElement("button"); submit.type = "submit"; submit.textContent = "Answer"; form.append(submit);
    form.addEventListener("submit", async event => {
      event.preventDefault();
      const answers = {};
      form.querySelectorAll("fieldset").forEach(fieldset => {
        const values = [...fieldset.querySelectorAll("input:checked")].map(input => input.value);
        const free = fieldset.querySelector("input[data-free-text]")?.value.trim();
        if (free) values.push(free);
        if (values.length) answers[fieldset.dataset.question] = values;
      });
      if (!Object.keys(answers).length) return;
      await api("/api/v1/threads/" + encodeURIComponent(detail.thread.id) + "/ask", { method: "POST", body: JSON.stringify({ interactionId: pending.interactionId, answers }) });
      await refreshThread();
    });
    ask.append(form);
  };
  const renderThread = detail => {
    state.detail = detail; state.threadId = detail.thread.id;
    view.hidden = true;
    messages.replaceChildren(...detail.messages.map(message => {
      const presentation = presentMessage(message);
      const div = document.createElement("div"); div.className = "message " + message.role + " " + message.status;
      const meta = document.createElement("div"); meta.className = "meta"; meta.textContent = message.role + " · " + message.status;
      if (message.operatorMessageId && capability("quotes") && detail.thread.status !== "running") {
        const quoteButton = document.createElement("button"); quoteButton.type = "button"; quoteButton.className = "quote-button"; quoteButton.textContent = "Quote";
        quoteButton.addEventListener("click", () => chooseQuote(detail.thread, message));
        meta.append(quoteButton);
      }
      if (message.quote) { const quoted = document.createElement("div"); quoted.className = "quote"; quoted.textContent = message.quote.text || ("Message " + message.quote.messageId); div.append(meta, quoted); } else div.append(meta);
      const body = document.createElement("div"); body.textContent = presentation.body || (message.status === "running" ? "…" : ""); div.append(body);
      if (presentation.telemetry.length) { const telemetry = document.createElement("div"); telemetry.className = "telemetry"; telemetry.textContent = presentation.telemetry.join(" · "); div.append(telemetry); }
      (message.attachments || []).forEach(file => { const item = document.createElement("span"); item.className = "attachment"; item.textContent = file.name; div.append(item); });
      return div;
    }));
    messages.scrollTop = messages.scrollHeight; renderAsk(detail); renderBootstrap(); renderDraft();
  };
  const notifyNew = bootstrap => {
    if (!("Notification" in window) || Notification.permission !== "granted") return;
    bootstrap.newProactiveThreadIds.forEach(id => {
      const thread = bootstrap.threads.find(item => item.id === id);
      if (thread) new Notification(thread.title, { body: "New proactive update from mono-agent", tag: "mono-agent-" + id });
    });
  };
  const load = async (notify = false) => {
    const bootstrap = await (await api("/api/v1/bootstrap")).json();
    state.bootstrap = bootstrap; renderBootstrap(); if (notify) notifyNew(bootstrap); status.textContent = "Ready";
  };
  const refreshThread = async () => {
    if (!state.threadId) return;
    renderThread(await (await api("/api/v1/threads/" + encodeURIComponent(state.threadId))).json());
  };
  const showView = async path => {
    const body = await (await api(path)).json();
    const pre = document.createElement("pre"); pre.textContent = JSON.stringify(body, null, 2);
    view.replaceChildren(pre); view.hidden = false;
  };
  const showReplayView = async () => {
    const thread = selectedThread();
    if (!state.threadId || !thread) return;
    const replay = await (await api("/api/v1/threads/" + encodeURIComponent(state.threadId) + "/replay")).json();
    const heading = document.createElement("strong"); heading.textContent = "Conversation replay";
    const rows = replay.messages.map(message => {
      const row = document.createElement("div"); row.className = "replay-row";
      const body = document.createElement("span"); body.textContent = message.role + (message.id ? " · " + message.id : "") + "\\n" + message.text;
      row.append(body);
      if (message.id && capability("quotes")) {
        const button = document.createElement("button"); button.type = "button"; button.textContent = "Quote";
        button.addEventListener("click", () => chooseQuote(thread, { ...message, operatorMessageId: message.id }));
        row.append(button);
      }
      return row;
    });
    view.replaceChildren(heading, ...rows); view.hidden = false;
  };
  threads.addEventListener("click", async event => { const button = event.target.closest("button[data-id]"); if (!button) return; renderThread(await (await api("/api/v1/threads/" + encodeURIComponent(button.dataset.id))).json()); });
  document.querySelector("#new-thread").addEventListener("click", async () => { if (!agents.value) return; const thread = await (await api("/api/v1/threads", { method: "POST", body: JSON.stringify({ agentId: agents.value }) })).json(); await load(); renderThread(await (await api("/api/v1/threads/" + encodeURIComponent(thread.id))).json()); });
  document.querySelector("#notifications").addEventListener("click", async () => { if (!("Notification" in window)) return; const permission = await Notification.requestPermission(); status.textContent = permission === "granted" ? "Notifications enabled" : "Notifications not enabled"; });
  document.querySelector("#attach").addEventListener("click", () => files.click());
  files.addEventListener("change", async () => {
    for (const file of [...files.files].slice(0, 4)) {
      if (file.size > maxAttachmentBytes) { status.textContent = file.name + " exceeds the 512 KiB product attachment bound"; continue; }
      const url = await new Promise((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsDataURL(file); });
      if (url.length > maxAttachmentUrlCharacters) { status.textContent = file.name + " exceeds the encoded operator attachment bound"; continue; }
      if (state.attachments.reduce((total, item) => total + item.url.length, 0) + url.length > uploadSelectionBudget) { status.textContent = "Queued attachments exceed the shared operator request budget"; continue; }
      state.attachments.push({ id: localId(), name: file.name, mediaType: file.type || "application/octet-stream", sizeBytes: file.size, url });
    }
    files.value = ""; renderDraft();
  });
  document.querySelector("#composer").addEventListener("submit", async event => {
    event.preventDefault(); if (!state.threadId) return;
    const value = text.value.trim();
    if (selectedThread()?.status === "running") {
      if (!value || !capability("liveInput")) return;
      const result = await (await api("/api/v1/threads/" + encodeURIComponent(state.threadId) + "/live-input", { method: "POST", body: JSON.stringify({ text: value }) })).json();
      text.value = ""; status.textContent = "Live input " + result.status; return;
    }
    if (!value && !state.attachments.length) return;
    const payload = { text: value, ...(state.attachments.length ? { attachments: state.attachments } : {}), ...(state.quote ? { quote: state.quote } : {}), ...(model.value.trim() ? { model: model.value.trim() } : {}), ...(effort.value.trim() ? { effort: effort.value.trim() } : {}) };
    if (new TextEncoder().encode(JSON.stringify(payload)).byteLength > maxRequestBytes) { status.textContent = "Input exceeds the shared operator request bound"; return; }
    text.value = ""; status.textContent = "Running";
    const response = await api("/api/v1/threads/" + encodeURIComponent(state.threadId) + "/turns", { method: "POST", body: JSON.stringify(payload) });
    state.attachments = []; state.quote = null; renderDraft();
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = "";
    while (true) { const item = await reader.read(); if (item.done) break; buffer += decoder.decode(item.value, { stream: true }); const lines = buffer.split("\\n"); buffer = lines.pop() || ""; for (const line of lines) if (line) { const streamEvent = JSON.parse(line); if (streamEvent.detail) renderThread(streamEvent.detail); } }
    status.textContent = "Ready"; await load();
  });
  document.querySelector("#cancel").addEventListener("click", async () => { if (!state.threadId) return; renderThread(await (await api("/api/v1/threads/" + encodeURIComponent(state.threadId) + "/cancel", { method: "POST", body: "{}" })).json()); });
  document.querySelector("#delete").addEventListener("click", async () => { if (!state.threadId || !confirm("Delete this local web conversation and its messages?")) return; await api("/api/v1/threads/" + encodeURIComponent(state.threadId), { method: "DELETE", body: "{}" }); state.threadId = null; state.detail = null; state.quote = null; await load(); messages.innerHTML = '<p class="empty">Conversation deleted.</p>'; });
  document.querySelector("#config").addEventListener("click", () => { const agent = selectedAgent(); if (agent) showView("/api/v1/agents/" + encodeURIComponent(agent.id) + "/config").catch(showError); });
  document.querySelector("#health").addEventListener("click", () => { const agent = selectedAgent(); if (agent) showView("/api/v1/agents/" + encodeURIComponent(agent.id) + "/health").catch(showError); });
  document.querySelector("#replay").addEventListener("click", () => { showReplayView().catch(showError); });
  load(true).catch(showError);
  setInterval(() => { load(true).catch(showError); }, 5000);
})();`;
