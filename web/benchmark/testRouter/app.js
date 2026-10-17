const $ = (selector) => document.querySelector(selector);
const form = $('#form');
const runs = $('#runs');
const message = $('#message');
const token = $('#accessToken');

const MODELS = {
  'claude-code': [['claude-opus-4-8', 'Claude Opus 4.8'], ['claude-sonnet-4-6', 'Claude Sonnet 4.6'], ['claude-haiku-4-5', 'Claude Haiku 4.5'], ['custom', 'Custom model ID…']],
  codex: [['gpt-6-astra', 'GPT-6 Astra'], ['gpt-6.1-sol', 'GPT-6.1 Sol'], ['gpt-6-luna', 'GPT-6 Luna'], ['gpt-6', 'GPT-6'], ['gpt-6-sol', 'GPT-6 Sol'], ['gpt-5.6-sol', 'GPT-5.6 Sol'], ['custom', 'Custom model ID or route alias…']],
};
const TASKS = [['regex-log', 'Regex log analysis · medium'], ['fix-git', 'Recover a lost Git commit · easy'], ['log-summary-date-ranges', 'Summarize log date ranges · medium'], ['cobol-modernization', 'Modernize COBOL to Python · easy'], ['prove-plus-comm', 'Prove addition commutativity · easy'], ['custom', 'Custom task ID…']];
const AGENT_COPY = {
  'claude-code': { hint: 'Claude Code uses an Anthropic-compatible endpoint.', placeholder: 'https://api.anthropic.com' },
  codex: { hint: 'Codex uses an OpenAI-compatible endpoint.', placeholder: 'https://api.openai.com/v1' },
};
const stateLabels = { queued: 'queued', running: 'running', completed: 'complete', failed: 'failed', cancelled: 'cancelled' };
let nextCandidateNumber = 1;

token.value = sessionStorage.getItem('benchmarkToken') || '';
token.onchange = () => sessionStorage.setItem('benchmarkToken', token.value);
const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
const headers = () => ({ 'content-type': 'application/json', 'x-benchmark-token': token.value });
async function api(path, options = {}) {
  const response = await fetch(`/api/router-bench${path}`, { ...options, headers: { ...headers(), ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function setOptions(select, items) { select.innerHTML = items.map(([value, label]) => `<option value="${value}">${label}</option>`).join(''); }
function toggleCustom(select, input) { input.hidden = select.value !== 'custom'; input.required = select.value === 'custom'; }
function syncAgent() {
  const agent = $('#agent').value;
  setOptions($('#modelPreset'), MODELS[agent]);
  toggleCustom($('#modelPreset'), $('#customModel'));
  $('#agentHint').textContent = AGENT_COPY[agent].hint;
  form.baselineUrl.placeholder = AGENT_COPY[agent].placeholder;
  document.querySelectorAll('.candidate-url').forEach((input) => { input.placeholder = AGENT_COPY[agent].placeholder; });
}
setOptions($('#taskPreset'), TASKS);
syncAgent();
$('#agent').onchange = syncAgent;
$('#modelPreset').onchange = () => toggleCustom($('#modelPreset'), $('#customModel'));
$('#taskPreset').onchange = () => toggleCustom($('#taskPreset'), $('#customTask'));

function candidateCards() { return [...document.querySelectorAll('.target-card.candidate')]; }
function syncCandidateControls() {
  const cards = candidateCards();
  cards.forEach((card) => { card.querySelector('.remove-route').disabled = cards.length === 1; });
  $('#addCandidate').disabled = cards.length >= 6;
  $('#addCandidate').textContent = cards.length >= 6 ? 'Route limit reached' : '+ Add route';
}
function addCandidate(values = {}) {
  if (candidateCards().length >= 6) return;
  const routeNumber = nextCandidateNumber++;
  const card = document.createElement('div');
  card.className = 'target-card candidate';
  card.innerHTML = `<label><span>Label</span><input value="${esc(values.name || `Route ${routeNumber}`)}" aria-label="Candidate route name"></label><label><span>Base URL</span><input class="candidate-url" type="url" required value="${esc(values.url || '')}" placeholder="${AGENT_COPY[$('#agent').value].placeholder}" aria-label="Candidate route URL"></label><label><span>API key</span><input type="password" required autocomplete="new-password" placeholder="API key" aria-label="Candidate route API key"></label><button type="button" class="remove-route" aria-label="Remove candidate route">×</button>`;
  card.querySelector('.remove-route').onclick = () => {
    if (candidateCards().length === 1) return;
    card.remove(); syncCandidateControls(); updateEstimate();
  };
  $('#candidates').append(card);
  syncCandidateControls(); updateEstimate();
}
$('#addCandidate').onclick = () => addCandidate();
addCandidate();

function updateEstimate() {
  const jobs = 2 + candidateCards().length;
  const trials = jobs * (Number(form.trials.value) || 0);
  $('#routeCount').textContent = jobs; $('#trialTotal').textContent = trials; $('#costEstimate').textContent = `$${(trials * 0.3).toFixed(1)}–${(trials * 0.6).toFixed(1)}`;
}
form.trials.oninput = updateEstimate;
function payload() {
  const data = new FormData(form);
  const modelPreset = data.get('modelPreset'); const taskPreset = data.get('taskPreset');
  return { agent: data.get('agent'), model: modelPreset === 'custom' ? data.get('model') : modelPreset, task: taskPreset === 'custom' ? data.get('task') : taskPreset, trials: Number(data.get('trials')), baseline: { name: data.get('baselineName'), url: data.get('baselineUrl'), key: data.get('baselineKey') }, candidates: candidateCards().map((card) => { const fields = card.querySelectorAll('input'); return { name: fields[0].value, url: fields[1].value, key: fields[2].value }; }) };
}
form.onsubmit = async (event) => {
  event.preventDefault(); const button = $('#submitButton'); button.disabled = true; message.textContent = 'Starting…';
  try {
    await api('/runs', { method: 'POST', body: JSON.stringify(payload()) });
    document.querySelectorAll('input[type=password]:not(#accessToken)').forEach((input) => { input.value = ''; });
    message.textContent = 'Benchmark started'; await load();
  } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
};
function runTargets(run) {
  if (run.baseline || run.candidates) return [{ id: 'baseline-a', name: `${run.baseline?.name || 'Baseline'} A` }, { id: 'baseline-b', name: `${run.baseline?.name || 'Baseline'} B` }, ...(run.candidates || []).map((item) => ({ id: item.id, name: item.name }))];
  return [{ id: 'official-a', name: 'Official A' }, { id: 'official-b', name: 'Official B' }, { id: 'new', name: 'Candidate' }];
}
function runCard(run) {
  const targets = runTargets(run);
  return `<article class="run-card"><div class="run-head"><div class="run-title"><b>${esc(run.model)}</b><span class="status ${esc(run.status)}">${esc(stateLabels[run.status] || run.status)}</span></div><code>${esc(run.id.slice(0, 8))}</code></div><div class="run-meta"><span>${esc(run.agent || 'claude-code')}</span><span>${esc(run.task)}</span><span>${run.trials} trials per route</span><span>${new Date(run.createdAt).toLocaleString('en-US')}</span></div><div class="job-grid">${targets.map((target) => `<div class="job ${esc(run.progress?.[target.id] || 'queued')}">${esc(target.name)} · ${esc(stateLabels[run.progress?.[target.id]] || 'queued')}</div>`).join('')}</div>${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}<div class="run-actions">${run.status === 'completed' ? `<a href="/api/router-bench/runs/${run.id}/report" data-download>Download report →</a>` : ''}${['queued', 'running'].includes(run.status) ? `<button data-cancel="${run.id}">Cancel run</button>` : ''}</div></article>`;
}
async function load() {
  try { const data = await api('/runs'); runs.innerHTML = data.runs.length ? data.runs.map(runCard).join('') : '<div class="empty"><b>No benchmark runs yet</b><span>Configure your first comparison above.</span></div>'; }
  catch (error) { runs.innerHTML = `<div class="empty"><b>History is locked</b><span>${esc(error.message)}</span></div>`; }
}
runs.onclick = async (event) => {
  if (event.target.dataset.cancel) { await api(`/runs/${event.target.dataset.cancel}/cancel`, { method: 'POST' }); await load(); }
  if (event.target.dataset.download !== undefined) {
    event.preventDefault(); const response = await fetch(event.target.href, { headers: headers() });
    if (!response.ok) { message.textContent = (await response.json()).error; return; }
    const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'router-benchmark.md'; link.click(); URL.revokeObjectURL(link.href);
  }
};
$('#refresh').onclick = load;
load();
setInterval(load, 5000);
