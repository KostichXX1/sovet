import {
  PROVIDERS, ROLES, DEFAULT_SEATS, ERROR_TEXT, askSeat, prompts, runCouncil, buildReport, reportAsText,
  estimateRequests, recordUsage, usageLine, stripThinking,
} from './engine.js';
import { readFile, combineFiles, FileProblem } from './files.js';

const SETTINGS_KEY = 'sovet.settings';
const HISTORY_KEY = 'sovet.history';
const USAGE_KEY = 'sovet.usage';
const HISTORY_LIMIT = 30;

const $ = (id) => document.getElementById(id);

function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
    else if (key in node && key !== 'list') node[key] = value;
    else node.setAttribute(key, value);
  }
  node.append(...children.flat().filter((child) => child !== null && child !== undefined && child !== false));
  return node;
}

function readJson(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch {
    return fallback;
  }
}
function writeJson(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

const settings = Object.assign(
  { keys: {}, seats: null, mode: 'full', chair: 'auto', useRoles: false, revise: true, limits: {} },
  readJson(SETTINGS_KEY, {}),
);
if (!Array.isArray(settings.seats)) settings.seats = DEFAULT_SEATS.map((seat) => ({ ...seat }));
const saveSettings = () => writeJson(SETTINGS_KEY, settings);

let usage = readJson(USAGE_KEY, null);
function noteUsage(event) {
  usage = recordUsage(usage, event);
  writeJson(USAGE_KEY, usage);
}

let history = readJson(HISTORY_KEY, []);
function saveHistory() {
  history = history.slice(0, HISTORY_LIMIT);
  while (!writeJson(HISTORY_KEY, history) && history.length > 1) history.pop();
}
function storeRun(run) {
  const index = history.findIndex((item) => item.id === run.id);
  if (index >= 0) history[index] = run;
  else history.unshift(run);
  saveHistory();
}
// Если iPhone закрыл приложение посреди совета, показываем, что успело сохраниться.
for (const run of history) {
  if (run.status === 'running') {
    run.status = 'stopped';
    run.stage = 'done';
    run.liveDecision = null;
    for (const member of Object.values(run.cells)) {
      for (const cell of Object.values(member)) {
        if (cell.status === 'work') cell.status = 'idle';
        delete cell.live;
      }
    }
  }
}
saveHistory();

/* ---------- Текст ответов моделей: строим узлы сами, HTML от моделей не вставляем ---------- */
function renderInline(text) {
  const nodes = [];
  const pattern = /(\*\*[^*\n]+\*\*|`[^`\n]+`|\*[^*\s][^*\n]*\*)/g;
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    if (token.startsWith('**')) nodes.push(h('strong', {}, token.slice(2, -2)));
    else if (token.startsWith('`')) nodes.push(h('code', {}, token.slice(1, -1)));
    else nodes.push(h('em', {}, token.slice(1, -1)));
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}
function tableCells(line) {
  return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}
function renderMarkdown(source) {
  const root = h('div', { class: 'md' });
  const lines = String(source || '').replace(/\r/g, '').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i += 1; continue; }
    if (line.trim().startsWith('```')) {
      const code = [];
      i += 1;
      while (i < lines.length && !lines[i].trim().startsWith('```')) code.push(lines[i++]);
      i += 1;
      root.append(h('pre', {}, h('code', {}, code.join('\n'))));
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      root.append(h(`h${Math.min(heading[1].length + 2, 5)}`, {}, renderInline(heading[2])));
      i += 1;
      continue;
    }
    if (line.includes('|') && /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(lines[i + 1] || '')) {
      const head = tableCells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(tableCells(lines[i++]));
      root.append(h('div', { class: 'table-wrap' }, h('table', {},
        h('thead', {}, h('tr', {}, head.map((cell) => h('th', {}, renderInline(cell))))),
        h('tbody', {}, rows.map((row) => h('tr', {}, row.map((cell) => h('td', {}, renderInline(cell)))))),
      )));
      continue;
    }
    const listPattern = /^\s*(?:[-*•]|\d+[.)])\s+(.*)$/;
    if (listPattern.test(line)) {
      const ordered = /^\s*\d/.test(line);
      const items = [];
      while (i < lines.length && listPattern.test(lines[i])) items.push(listPattern.exec(lines[i++])[1]);
      root.append(h(ordered ? 'ol' : 'ul', {}, items.map((item) => h('li', {}, renderInline(item)))));
      continue;
    }
    const paragraph = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|```|\s*(?:[-*•]|\d+[.)])\s)/.test(lines[i])) paragraph.push(lines[i++]);
    if (!paragraph.length) paragraph.push(lines[i++]);
    root.append(h('p', {}, renderInline(paragraph.join(' '))));
  }
  return root;
}

/* ---------- Участники на главном экране ---------- */
const hasKey = (seat) => Boolean((settings.keys[seat.provider] || '').trim());
const isEnabled = (seat) => hasKey(seat) && seat.enabled !== false;
const rolePrompt = (seat) => {
  if (!settings.useRoles || !seat.role) return { roleName: null, rolePrompt: null };
  if (seat.role === 'custom') {
    const text = (seat.customRole || '').trim();
    return text ? { roleName: text, rolePrompt: `Твоя роль: ${text}. Отвечай с этой точки зрения.` } : { roleName: null, rolePrompt: null };
  }
  const preset = ROLES[seat.role];
  return preset ? { roleName: preset.name, rolePrompt: preset.prompt } : { roleName: null, rolePrompt: null };
};

function renderSeats() {
  const keyed = settings.seats.filter(hasKey);
  $('seats').replaceChildren(...keyed.map((seat) => h('button', {
    type: 'button', class: 'seat',
    'aria-pressed': String(isEnabled(seat)),
    onclick: () => {
      seat.enabled = !isEnabled(seat);
      saveSettings();
      renderSeats();
    },
  }, seat.name)));
  const count = settings.seats.filter(isEnabled).length;
  let hint = '';
  if (!keyed.length) hint = 'Нужен хотя бы один ключ. Откройте настройки и добавьте его.';
  else if (count === 0) hint = 'Выберите хотя бы одного участника.';
  else if (count === 1) hint = 'С одним участником обсуждения не будет.';
  else {
    const { min, max } = estimateRequests(count, settings.mode);
    const requests = min === max ? `${min}` : `${min}–${max}`;
    hint = `Участников: ${count}. Запросов на один вопрос: примерно ${requests}.`;
  }
  $('composer-hint').textContent = hint;
  const roles = $('toggle-roles');
  roles.setAttribute('aria-pressed', String(settings.useRoles));
  roles.textContent = settings.useRoles ? 'Роли включены' : 'Роли выключены';
}
$('toggle-roles').addEventListener('click', () => {
  settings.useRoles = !settings.useRoles;
  saveSettings();
  renderSeats();
});

/* ---------- Вложения ---------- */
let attachments = [];
function renderAttachments() {
  const list = $('attachments');
  list.hidden = attachments.length === 0;
  list.replaceChildren(...attachments.map((file, index) => h('li', {},
    h('span', {}, file.name),
    h('button', {
      type: 'button', class: 'text-button', 'aria-label': `Убрать ${file.name}`,
      onclick: () => { attachments.splice(index, 1); renderAttachments(); },
    }, 'Убрать'),
  )));
}
$('file-input').addEventListener('change', async (event) => {
  const files = [...event.target.files];
  event.target.value = '';
  const hint = $('composer-hint');
  for (const file of files) {
    if (attachments.length >= 5) { hint.textContent = 'Можно приложить до 5 файлов.'; break; }
    hint.textContent = `Читаю «${file.name}»…`;
    try {
      const read = await readFile(file);
      if (!read.text && !read.images.length) throw new FileProblem(`В файле «${file.name}» нет текста.`);
      attachments.push(read);
      renderAttachments();
      hint.textContent = read.note || '';
    } catch (error) {
      hint.textContent = error instanceof FileProblem ? error.message : `Не удалось прочитать «${file.name}».`;
      return;
    }
  }
  if (!hint.textContent || hint.textContent.startsWith('Читаю')) renderSeats();
});

/* ---------- Протокол и результат ---------- */
function stageCell(cell, stage) {
  if (cell.status === 'fail') return h('span', { class: 'cell-word fail' }, 'выбыл');
  if (stage === 'vote' && cell.status === 'ok') {
    const words = { chair: 'итог', for: 'за', against: 'против', unclear: '?' };
    return h('span', { class: `cell-word ${cell.vote === 'against' ? 'against' : ''}` }, words[cell.vote] || 'итог');
  }
  const labels = { idle: 'не начато', work: 'идёт', ok: 'готово' };
  return h('span', { class: `mark ${cell.status}`, role: 'img', 'aria-label': labels[cell.status] || '' });
}

function renderProtocol(run) {
  const report = buildReport(run);
  const quick = run.mode !== 'full';
  const finished = run.status !== 'running';
  const notes = [];
  if (run.reader) notes.push(h('p', {}, `Файлы прочитал: ${run.reader.name}. Сверьте цифры с оригиналом.`));
  if (finished && report.participants.length) {
    notes.push(h('p', {}, `Участвовали: ${report.participants.map((item) => item.name).join(', ')}.`));
  }
  if (report.chair) notes.push(h('p', {}, `Итог написал: ${report.chair.name}.`));
  if (run.revised) notes.push(h('p', {}, 'Итог исправлен после возражений, голоса указаны за новый вариант.'));
  if (run.revisionFailed) notes.push(h('p', {}, 'Исправить итог не удалось, остался первый вариант.'));
  for (const item of report.against) notes.push(h('p', { class: 'against' }, `${item.name} против: ${item.reason || 'причину не назвал'}`));
  for (const item of report.unclear) notes.push(h('p', {}, `${item.name} не дал ясного голоса.`));
  for (const item of report.dropped) notes.push(h('p', {}, `${item.name} выбыл ${item.stage}: ${item.message}.`));

  return h('div', { class: 'protocol' },
    h('h2', {}, 'Протокол'),
    h('table', {},
      h('thead', {}, h('tr', {},
        h('th', { scope: 'col' }, h('span', { class: 'visually-hidden' }, 'Участник')),
        h('th', { scope: 'col' }, 'Ответ'),
        !quick && h('th', { scope: 'col' }, 'Обсуждение'),
        h('th', { scope: 'col' }, quick ? 'Итог' : 'Голос'),
      )),
      h('tbody', {}, run.members.map((member) => {
        const cells = run.cells[member.id];
        return h('tr', { class: member.out ? 'out' : '' },
          h('th', { scope: 'row' }, member.name, member.roleName && h('span', { class: 'role' }, member.roleName)),
          h('td', {}, stageCell(cells.answer, 'answer')),
          !quick && h('td', {}, stageCell(cells.discussion, 'discussion')),
          h('td', {}, stageCell(cells.vote, 'vote')),
        );
      })),
    ),
    notes.length > 0 && h('div', { class: 'protocol-notes' }, notes),
  );
}

function transcriptBlock(title, stage, run) {
  const entries = run.members
    .map((member) => ({ member, cell: run.cells[member.id][stage] }))
    .filter(({ cell }) => cell.text);
  if (!entries.length) return null;
  return h('details', {},
    h('summary', {}, title),
    h('div', { class: 'transcript' }, entries.map(({ member, cell }) => h('div', {},
      h('h4', {}, [member.name, member.roleName, member.model].filter(Boolean).join(', ')),
      h('div', { class: 'markdown' }, renderMarkdown(cell.text)),
      cell.truncated && h('p', { class: 'warning' }, 'Ответ обрезан по длине.'),
    ))),
  );
}

function stageLabel(run) {
  const labels = {
    read: 'Модель читает файлы',
    answer: 'Модели отвечают независимо друг от друга',
    discussion: 'Модели обсуждают ответы друг друга',
    chair: `Пишется итог: ${run.liveChairName || ''}`,
    vote: 'Модели голосуют за итог',
    revise: `Есть возражения, итог исправляет ${run.liveChairName || ''}`,
    revote: 'Модели голосуют за исправленный итог',
  };
  return labels[run.stage] || '';
}

/* Живой текст: при каждом новом куске обновляем только его, а не весь экран. */
let liveSeatId = null;
function liveStage(run) {
  return run.stage === 'discussion' ? 'discussion' : 'answer';
}
function liveText(run) {
  if (!liveSeatId || !run.cells[liveSeatId]) return '';
  const cell = run.cells[liveSeatId][liveStage(run)];
  return cell.live || cell.text || '';
}
function renderLivePanel(run) {
  if (!['answer', 'discussion'].includes(run.stage)) return null;
  const stage = liveStage(run);
  const speakers = run.members.filter((member) => {
    const cell = run.cells[member.id][stage];
    return cell.status === 'work' || cell.status === 'ok';
  });
  if (!speakers.length) return null;
  if (!speakers.some((member) => member.id === liveSeatId)) {
    const writing = speakers.find((member) => run.cells[member.id][stage].live);
    liveSeatId = (writing || speakers[0]).id;
  }
  return h('div', { class: 'live' },
    h('div', { class: 'live-tabs', role: 'group', 'aria-label': 'Чей ответ показать' }, speakers.map((member) => h('button', {
      type: 'button', class: 'live-tab', 'aria-pressed': String(member.id === liveSeatId),
      onclick: () => { liveSeatId = member.id; renderRun(run); },
    }, member.name))),
    h('div', { class: 'markdown live-text', id: 'live-text' }, renderMarkdown(liveText(run))),
  );
}
function updateLive(run) {
  const seatText = $('live-text');
  if (seatText) seatText.replaceChildren(renderMarkdown(liveText(run)));
  const decision = $('live-decision');
  if (decision) decision.replaceChildren(renderMarkdown(stripThinking(run.liveDecision)));
  else if (run.liveDecision) renderRun(run);
}

function renderFollowUp(run) {
  const input = h('textarea', { rows: 2, placeholder: 'Уточнить: например, а если объём вдвое меньше?', id: 'follow-up' });
  return h('form', {
    class: 'follow-up',
    onsubmit: (event) => {
      event.preventDefault();
      const question = input.value.trim();
      if (!question || activeController) { input.focus(); return; }
      const context = [...(run.context || []), { q: run.question, a: run.decision }].slice(-3);
      startCouncil(question, { context, fileText: run.fileContext || '' });
    },
  },
  h('label', { class: 'visually-hidden', htmlFor: 'follow-up' }, 'Уточняющий вопрос'),
  input,
  h('button', { type: 'submit', class: 'primary' }, 'Уточнить'));
}

function renderRun(run) {
  const report = buildReport(run);
  const running = run.status === 'running';
  const parts = [];
  if (running) {
    parts.push(h('p', { class: 'question-echo' }, `${stageLabel(run)}. Не сворачивайте приложение: iPhone приостановит запросы.`));
  }
  if (run.status === 'failed') parts.push(h('p', { class: 'warning' }, run.failure));
  if (run.status === 'stopped' && !run.decision) parts.push(h('p', { class: 'warning' }, 'Совет остановлен до итога. Ниже то, что успели сказать модели.'));

  if (run.context?.length) {
    parts.push(h('details', { class: 'earlier' },
      h('summary', {}, 'Ранее в этом разговоре'),
      h('div', { class: 'transcript' }, run.context.map((turn) => h('div', {},
        h('h4', {}, turn.q),
        h('div', { class: 'markdown' }, renderMarkdown(turn.a)),
      ))),
    ));
  }

  if (running && run.liveDecision !== null && run.liveDecision !== undefined) {
    parts.push(h('div', { class: 'decision' },
      h('p', { class: 'question-echo' }, run.question),
      h('div', { class: 'decision-body', id: 'live-decision' }, renderMarkdown(stripThinking(run.liveDecision))),
    ));
  } else if (run.decision) {
    const split = report.against.length > 0 || report.unclear.length > 0;
    parts.push(h('div', { class: 'decision' },
      h('p', { class: 'question-echo' }, run.question),
      run.fileNames?.length > 0 && h('p', { class: 'question-echo' }, `Файлы: ${run.fileNames.join(', ')}`),
      h('p', { class: `verdict${split && !running ? ' split' : ''}` }, running ? 'Черновик, идёт голосование' : report.verdict),
      h('div', { class: 'decision-body' }, renderMarkdown(run.decision)),
      run.truncated && h('p', { class: 'warning' }, 'Итог обрезан по длине. Задайте вопрос уже или разбейте его на части.'),
      !running && h('div', { class: 'decision-actions' },
        h('button', {
          type: 'button', class: 'secondary',
          onclick: async (event) => {
            const button = event.currentTarget;
            try {
              await navigator.clipboard.writeText(reportAsText(run));
              button.textContent = 'Скопировано';
            } catch {
              button.textContent = 'Не удалось скопировать';
            }
            setTimeout(() => { button.textContent = 'Скопировать'; }, 1800);
          },
        }, 'Скопировать'),
      ),
      !running && renderFollowUp(run),
    ));
  }
  // Живой текст выше протокола: при десяти участниках иначе он уйдёт за край экрана.
  if (running) {
    const panel = renderLivePanel(run);
    if (panel) parts.push(panel);
  }
  parts.push(renderProtocol(run));
  if (!running) {
    const blocks = [
      run.reader && h('details', {},
        h('summary', {}, 'Что прочитано из файлов'),
        h('div', { class: 'transcript' }, h('div', { class: 'markdown' }, renderMarkdown(run.reader.text)))),
      transcriptBlock('Первые ответы', 'answer', run),
      transcriptBlock('Обсуждение', 'discussion', run),
      run.earlierDecision && h('details', {},
        h('summary', {}, 'Первый вариант итога'),
        h('div', { class: 'transcript' }, h('div', { class: 'markdown' }, renderMarkdown(run.earlierDecision)))),
    ].filter(Boolean);
    if (blocks.length) parts.push(h('div', {}, blocks));
  }
  $('result').replaceChildren(...parts);
}

/* ---------- Запуск совета ---------- */
let activeController = null;
let hiddenCount = 0;
const visibleWaiters = [];
document.addEventListener('visibilitychange', () => {
  if (document.hidden) hiddenCount += 1;
  else while (visibleWaiters.length) visibleWaiters.shift()();
});
const pageHooks = {
  hiddenCount: () => hiddenCount,
  isHidden: () => document.hidden,
  whenVisible: () => (document.hidden ? new Promise((resolve) => visibleWaiters.push(resolve)) : Promise.resolve()),
};
const memberFor = (seat) => ({
  id: seat.id, name: seat.name, provider: seat.provider, model: seat.model, vision: seat.vision,
  key: settings.keys[seat.provider].trim(),
  ...rolePrompt(seat),
});

async function startCouncil(question, { context = [], fileText = '', images = [], fileNames = [] } = {}) {
  const members = settings.seats.filter(isEnabled).map(memberFor);
  if (!members.length) { $('composer-hint').textContent = 'Выберите хотя бы одного участника.'; return; }
  activeController = new AbortController();
  $('ask').hidden = true;
  $('stop').hidden = false;
  liveSeatId = null;
  let wakeLock = null;
  try { wakeLock = await navigator.wakeLock?.request('screen'); } catch { /* экран просто сможет погаснуть */ }
  const chair = settings.chair !== 'auto' && members.some((member) => member.id === settings.chair) ? settings.chair : 'auto';
  let shownProtocol = false;
  let liveQueued = false;
  try {
    const finished = await runCouncil({
      question, members, chair, mode: settings.mode, revise: settings.revise,
      context, fileText, images, fileNames,
      signal: activeController.signal,
      onUsage: noteUsage,
      ...pageHooks,
      onUpdate: (run, { delta }) => {
        if (delta) {
          if (liveQueued) return;
          liveQueued = true;
          setTimeout(() => { liveQueued = false; updateLive(run); }, 120);
          return;
        }
        storeRun(run);
        renderRun(run);
        // На телефоне протокол ниже первого экрана: показываем его сразу.
        if (!shownProtocol) { shownProtocol = true; $('stop').scrollIntoView({ block: 'start' }); }
      },
    });
    if (finished.status === 'done' && $('question').value.trim() === question) $('question').value = '';
  } finally {
    activeController = null;
    $('ask').hidden = false;
    $('stop').hidden = true;
    $('result').scrollIntoView({ block: 'start' });
    renderSeats();
    try { await wakeLock?.release(); } catch { /* уже отпущен */ }
  }
}

$('composer').addEventListener('submit', (event) => {
  event.preventDefault();
  const question = $('question').value.trim();
  const hint = $('composer-hint');
  if (!question && !attachments.length) { hint.textContent = 'Напишите вопрос.'; $('question').focus(); return; }
  if (!settings.seats.some(isEnabled)) {
    if (!settings.seats.some(hasKey)) openSettings();
    else hint.textContent = 'Выберите хотя бы одного участника.';
    return;
  }
  $('question').blur();
  const files = combineFiles(attachments);
  attachments = [];
  renderAttachments();
  startCouncil(question || 'Разбери приложенные файлы: что в них важного и что с этим делать?', files);
});
$('stop').addEventListener('click', () => activeController?.abort());

/* ---------- Настройки ---------- */
function roleOptions(seat) {
  return [
    h('option', { value: '', selected: !seat.role }, 'Без роли'),
    ...Object.entries(ROLES).map(([id, role]) => h('option', { value: id, selected: seat.role === id }, role.name)),
    h('option', { value: 'custom', selected: seat.role === 'custom' }, 'Своя роль'),
  ];
}
function renderProviders() {
  $('provider-list').replaceChildren(...Object.entries(PROVIDERS).map(([id, provider]) => {
    const keyId = `key-${id}`;
    return h('div', { class: 'provider' },
      h('div', { class: 'provider-head' },
        h('strong', {}, provider.name),
        h('span', { class: 'provider-price' }, provider.price),
      ),
      h('a', { href: provider.keyUrl, target: '_blank', rel: 'noopener noreferrer' }, 'Получить ключ'),
      h('div', { class: 'field' },
        h('label', { htmlFor: keyId }, 'Ключ'),
        h('input', {
          id: keyId, type: 'password', autocomplete: 'off', autocapitalize: 'off', spellcheck: false,
          value: settings.keys[id] || '',
          oninput: (event) => {
            settings.keys[id] = event.target.value.trim();
            saveSettings();
            renderSeats();
            renderSeatList();
          },
        }),
      ),
    );
  }));
}
function renderSeatList() {
  $('seat-list').replaceChildren(...settings.seats.map((seat) => {
    const provider = PROVIDERS[seat.provider];
    const roleField = h('input', {
      type: 'text', placeholder: 'Например, начальник снабжения', hidden: seat.role !== 'custom',
      'aria-label': `Своя роль: ${seat.name}`, value: seat.customRole || '',
      oninput: (event) => { seat.customRole = event.target.value; saveSettings(); },
    });
    return h('div', { class: `seat-row${hasKey(seat) ? '' : ' no-key'}` },
      h('label', { class: 'switch-row' },
        h('input', {
          type: 'checkbox', checked: seat.enabled !== false, disabled: !hasKey(seat),
          onchange: (event) => { seat.enabled = event.target.checked; saveSettings(); renderSeats(); },
        }),
        h('span', {}, h('strong', {}, seat.name), h('small', {}, hasKey(seat) ? provider.name : `${provider.name}: нет ключа`)),
      ),
      h('p', { class: 'check-result', id: `check-${seat.id}`, role: 'status' }),
      h('details', {},
        h('summary', {}, 'Роль и модель'),
        h('div', { class: 'seat-fields' },
          h('div', { class: 'field' },
            h('label', { htmlFor: `role-${seat.id}` }, 'Роль'),
            h('select', {
              id: `role-${seat.id}`,
              onchange: (event) => {
                seat.role = event.target.value || null;
                roleField.hidden = seat.role !== 'custom';
                saveSettings();
              },
            }, roleOptions(seat)),
            roleField,
          ),
          h('div', { class: 'field' },
            h('label', { htmlFor: `model-${seat.id}` }, 'Модель'),
            h('input', {
              id: `model-${seat.id}`, type: 'text', autocomplete: 'off', autocapitalize: 'off', spellcheck: false, value: seat.model,
              onchange: (event) => { seat.model = event.target.value.trim() || seat.model; event.target.value = seat.model; saveSettings(); },
            }),
          ),
          h('button', {
            type: 'button', class: 'secondary danger',
            onclick: () => {
              settings.seats = settings.seats.filter((item) => item !== seat);
              saveSettings();
              renderSeatList();
              renderChairOptions();
              renderUsage();
              renderSeats();
            },
          }, `Убрать ${seat.name}`),
        ),
      ),
    );
  }));
}
function renderChairOptions() {
  const select = $('chair');
  select.replaceChildren(
    h('option', { value: 'auto' }, 'Первый доступный'),
    ...settings.seats.map((seat) => h('option', { value: seat.id }, seat.name)),
  );
  select.value = settings.seats.some((seat) => seat.id === settings.chair) ? settings.chair : 'auto';
}
function renderUsage() {
  const limits = settings.limits.openrouter ? { openrouter: Number(settings.limits.openrouter) } : {};
  const rows = settings.seats.filter(hasKey).map((seat) => h('p', {},
    h('strong', {}, seat.name), ' ', usageLine(seat, usage, limits),
  ));
  $('usage-list').replaceChildren(...(rows.length ? rows : [h('p', { class: 'sheet-intro' }, 'Появятся после добавления ключей.')]));
}
function openSettings() {
  renderProviders();
  renderSeatList();
  renderChairOptions();
  renderUsage();
  $('mode').value = settings.mode;
  $('revise').checked = settings.revise;
  $('openrouter-limit').value = settings.limits.openrouter || '';
  $('add-provider').replaceChildren(...Object.entries(PROVIDERS).map(([id, provider]) => h('option', { value: id }, provider.name)));
  $('settings').showModal();
}
$('open-settings').addEventListener('click', openSettings);
$('settings').addEventListener('close', renderSeats);
$('mode').addEventListener('change', (event) => { settings.mode = event.target.value; saveSettings(); });
$('revise').addEventListener('change', (event) => { settings.revise = event.target.checked; saveSettings(); });
$('chair').addEventListener('change', (event) => { settings.chair = event.target.value; saveSettings(); });
$('openrouter-limit').addEventListener('input', (event) => {
  settings.limits.openrouter = event.target.value;
  saveSettings();
  renderUsage();
});

$('check-keys').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  button.textContent = 'Проверяю';
  const ctx = { timeoutMs: 45000, onUsage: noteUsage, ...pageHooks };
  await Promise.all(settings.seats.map(async (seat) => {
    const line = $(`check-${seat.id}`);
    line.className = 'check-result';
    if (!hasKey(seat)) { line.textContent = ''; return; }
    line.textContent = 'Проверяю…';
    try {
      await askSeat(ctx, memberFor(seat), prompts.check());
      line.classList.add('ok');
      line.textContent = `Работает: ${seat.model}.`;
    } catch (error) {
      line.classList.add('fail');
      line.textContent = `Не работает: ${ERROR_TEXT[error.kind] || ERROR_TEXT.other}.`;
    }
  }));
  button.disabled = false;
  button.textContent = 'Проверить участников';
  renderUsage();
});

/* Список моделей берём у самого сервиса: так названия не устаревают. */
$('load-models').addEventListener('click', async () => {
  const id = $('add-provider').value;
  const provider = PROVIDERS[id];
  const status = $('models-status');
  const key = (settings.keys[id] || '').trim();
  if (!key) { status.textContent = `Сначала добавьте ключ ${provider.name}.`; return; }
  status.textContent = 'Загружаю…';
  const headers = provider.format === 'gemini' ? { 'x-goog-api-key': key }
    : provider.format === 'anthropic' ? { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' }
      : { Authorization: `Bearer ${key}` };
  try {
    const response = await fetch(provider.modelsUrl, { headers, referrerPolicy: 'no-referrer', credentials: 'omit' });
    if (!response.ok) throw new Error(String(response.status));
    const data = await response.json();
    let names = (data.models || data.data || []).map((item) => String(item.id || item.name || '').replace(/^models\//, '')).filter(Boolean);
    if (id === 'openrouter') names = names.filter((name) => name.endsWith(':free'));
    $('model-options').replaceChildren(...names.map((name) => h('option', { value: name })));
    status.textContent = names.length ? `Найдено моделей: ${names.length}. Нажмите на поле «Модель», чтобы выбрать.` : 'Сервис не вернул моделей.';
  } catch {
    status.textContent = 'Не удалось получить список. Название модели можно вписать вручную.';
  }
});
$('add-seat').addEventListener('click', () => {
  const provider = $('add-provider').value;
  const model = $('add-model').value.trim();
  const status = $('models-status');
  if (!model) { status.textContent = 'Укажите модель.'; $('add-model').focus(); return; }
  const shortName = model.split('/').pop().replace(/:free$/, '');
  settings.seats.push({
    id: `custom-${Date.now()}`, provider, model, name: shortName, role: null, enabled: true,
    vision: false,
  });
  saveSettings();
  $('add-model').value = '';
  status.textContent = `Участник ${shortName} добавлен.`;
  renderSeatList();
  renderChairOptions();
  renderUsage();
  renderSeats();
});

function armedButton(id, confirmText, doneText, action) {
  $(id).addEventListener('click', (event) => {
    const button = event.currentTarget;
    if (button.dataset.armed !== 'yes') {
      button.dataset.armed = 'yes';
      button.textContent = confirmText;
      return;
    }
    action();
    button.dataset.armed = '';
    button.textContent = doneText;
  });
}
armedButton('clear-keys', 'Нажмите ещё раз, чтобы удалить ключи', 'Ключи удалены', () => {
  settings.keys = {};
  saveSettings();
  renderProviders();
  renderSeatList();
  renderUsage();
  renderSeats();
});
armedButton('clear-history', 'Нажмите ещё раз, чтобы удалить историю', 'История удалена', () => {
  history = [];
  saveHistory();
});

/* ---------- История ---------- */
$('open-history').addEventListener('click', () => {
  const items = history.map((run) => {
    const report = buildReport(run);
    const date = new Date(run.createdAt).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
    return h('button', {
      type: 'button', class: 'history-item',
      onclick: () => {
        $('history').close();
        renderRun(run);
        $('result').scrollIntoView();
      },
    }, h('span', {}, run.question), h('span', {}, `${date}. ${report.verdict}`));
  });
  $('history-list').replaceChildren(...(items.length ? items : [h('p', { class: 'empty' }, 'Здесь появятся ваши вопросы и решения совета.')]));
  $('history').showModal();
});
for (const button of document.querySelectorAll('[data-close]')) {
  button.addEventListener('click', () => button.closest('dialog').close());
}

/* ---------- Запуск приложения ---------- */
const isIos = /iPhone|iPad|iPod/.test(navigator.userAgent);
const installed = navigator.standalone === true || window.matchMedia('(display-mode: standalone)').matches;
$('install-note').hidden = !(isIos && !installed);
renderSeats();
navigator.storage?.persist?.().catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
