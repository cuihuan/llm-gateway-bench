import { renderReportMarkdown } from './report-preview.js?v=20261018-3';

const $ = (selector) => document.querySelector(selector);
const form = $('#form');
const runs = $('#runs');
const message = $('#message');
const reportDialog = $('#reportDialog');
let reportRequest = 0;
reportDialog.addEventListener('close', () => { reportRequest++; });
$('#closeReport').onclick = () => reportDialog.close();

async function previewReport(id) {
  const request = ++reportRequest;
  $('#reportRun').textContent = `Run ${id.slice(0, 8)}`;
  $('#reportContent').textContent = 'Loading report…';
  $('#reportDownload').href = `/api/router-bench/runs/${id}/report`;
  if (!reportDialog.open) reportDialog.showModal();
  try {
    const response = await fetch(`/api/router-bench/runs/${id}/report`);
    if (!response.ok) throw new Error((await response.json()).error || 'Unable to load report.');
    const markdown = await response.text();
    if (request === reportRequest) $('#reportContent').innerHTML = renderReportMarkdown(markdown);
  } catch (error) {
    if (request === reportRequest) $('#reportContent').textContent = error.message;
  }
}

const MODELS = [
  ['claude-opus-4-8', 'Claude Opus 4.8'],
  ['claude-sonnet-4-6', 'Claude Sonnet 4.6'],
  ['claude-haiku-4-5-20251001', 'Claude Haiku 4.5'],
  ['claude-opus-5', 'Claude Opus 5'],
  ['claude-sonnet-5', 'Claude Sonnet 5'],
  ['custom', 'Custom shared model ID…'],
];
const TASKS = [
  ['regex-log', 'Regex log analysis · medium'],
  ['fix-git', 'Recover a lost Git commit · easy'],
  ['log-summary-date-ranges', 'Summarize log date ranges · medium'],
  ['cobol-modernization', 'Modernize COBOL to Python · easy'],
  ['prove-plus-comm', 'Prove addition commutativity · easy'],
  ['custom', 'Custom task ID…'],
];
const stateLabels = { queued: 'queued', running: 'running', completed: 'complete', failed: 'failed', cancelled: 'cancelled' };

const esc = (value) => String(value ?? '').replace(/[&<>"]/g, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[character]);
async function api(path, options = {}) {
  const response = await fetch(`/api/router-bench${path}`, { ...options, headers: { 'content-type': 'application/json', ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Request failed');
  return data;
}
function setOptions(select, items) { select.innerHTML = items.map(([value, label]) => `<option value="${value}">${label}</option>`).join(''); }
function toggleCustom(select, input) { input.hidden = select.value !== 'custom'; input.required = select.value === 'custom'; }
function selectedModel() { return $('#modelPreset').value === 'custom' ? $('#customModel').value.trim() : $('#modelPreset').value; }
function syncModel() {
  toggleCustom($('#modelPreset'), $('#customModel'));
  const model = selectedModel();
  $('#agentHint').textContent = /^claude(?:-|$)/i.test(model)
    ? 'Claude models run through Claude Code automatically.'
    : 'Non-Claude models run through Codex automatically.';
}
setOptions($('#modelPreset'), MODELS);
setOptions($('#taskPreset'), TASKS);
$('#modelPreset').onchange = syncModel;
$('#customModel').oninput = syncModel;
$('#taskPreset').onchange = () => toggleCustom($('#taskPreset'), $('#customTask'));
syncModel();

function updateEstimate() {
  const trials = 3 * (Number(form.trials.value) || 0);
  $('#trialTotal').textContent = trials;
  $('#costEstimate').textContent = `$${(trials * 0.3).toFixed(1)}–${(trials * 0.6).toFixed(1)}`;
}
form.trials.oninput = updateEstimate;
function payload() {
  const data = new FormData(form);
  const taskPreset = data.get('taskPreset');
  return { model: selectedModel(), task: taskPreset === 'custom' ? data.get('task') : taskPreset, trials: Number(data.get('trials')), synthoraiKey: data.get('synthoraiKey'), nibrouteKey: data.get('nibrouteKey') };
}
form.onsubmit = async (event) => {
  event.preventDefault();
  const button = $('#submitButton');
  button.disabled = true; message.textContent = 'Starting…';
  try {
    await api('/runs', { method: 'POST', body: JSON.stringify(payload()) });
    document.querySelectorAll('input[type=password]').forEach((input) => { input.value = ''; });
    message.textContent = 'Comparison started'; await load();
  } catch (error) { message.textContent = error.message; } finally { button.disabled = false; }
};
function runTargets(run) {
  if (run.baseline || run.candidates) return [{ id: 'baseline-a', name: `${run.baseline?.name || 'SynthorAI'} A` }, { id: 'baseline-b', name: `${run.baseline?.name || 'SynthorAI'} B` }, ...(run.candidates || []).map((item) => ({ id: item.id, name: item.name }))];
  return [{ id: 'official-a', name: 'SynthorAI A' }, { id: 'official-b', name: 'SynthorAI B' }, { id: 'new', name: 'NIBRoute' }];
}
function runCard(run) {
  const targets = runTargets(run);
  return `<article class="run-card"><div class="run-head"><div class="run-title"><b>${esc(run.model)}</b><span class="status ${esc(run.status)}">${esc(stateLabels[run.status] || run.status)}</span></div><code>${esc(run.id.slice(0, 8))}</code></div><div class="run-meta"><span>${esc(run.agent || 'claude-code')}</span><span>${esc(run.task)}</span><span>${run.trials} trials per job</span><span>${new Date(run.createdAt).toLocaleString('en-US')}</span></div><div class="job-grid">${targets.map((target) => `<div class="job ${esc(run.progress?.[target.id] || 'queued')}">${esc(target.name)} · ${esc(stateLabels[run.progress?.[target.id]] || 'queued')}</div>`).join('')}</div>${run.error ? `<p class="error-text">${esc(run.error)}</p>` : ''}<div class="run-actions">${['completed', 'failed'].includes(run.status) ? `<button type="button" class="view-report" data-preview="${run.id}">View report</button><a href="/api/router-bench/runs/${run.id}/report" data-download>Download report →</a>` : ''}${['queued', 'running'].includes(run.status) ? `<button data-cancel="${run.id}">Cancel run</button>` : ''}</div></article>`;
}
async function load() {
  try { const data = await api('/runs'); runs.innerHTML = data.runs.length ? data.runs.map(runCard).join('') : '<div class="empty"><b>No comparison runs yet</b><span>Add both router keys to start the first run.</span></div>'; }
  catch (error) { runs.innerHTML = `<div class="empty"><b>History is locked</b><span>${esc(error.message)}</span></div>`; }
}
runs.onclick = async (event) => {
  if (event.target.dataset.preview) await previewReport(event.target.dataset.preview);
  if (event.target.dataset.cancel) { await api(`/runs/${event.target.dataset.cancel}/cancel`, { method: 'POST' }); await load(); }
  if (event.target.dataset.download !== undefined) {
    event.preventDefault(); const response = await fetch(event.target.href);
    if (!response.ok) { message.textContent = (await response.json()).error; return; }
    const blob = await response.blob(); const link = document.createElement('a'); link.href = URL.createObjectURL(blob); link.download = 'synthorai-vs-nibroute.md'; link.click(); URL.revokeObjectURL(link.href);
  }
};
$('#refresh').onclick = load;
load();
setInterval(load, 5000);
