// Browser module of the review page (spec 023). Plain DOM, no framework, no build step.
// Every text from the API is put in the page as text (never as HTML).
/* global document, Element */

const token = document.querySelector('meta[name="review-token"]').content;
const view = document.getElementById('view');
const stats = document.getElementById('stats');

const state = {
  session: { approved: 0, rejected: 0 },
  queue: { items: [], total: 0, waiting: 0, problems: [] },
  index: 0,
  screen: { name: 'loading' },
  busy: false,
};

// --- helpers ---------------------------------------------------------------------------------

function h(tag, props, ...children) {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(props ?? {})) {
    if (value === false || value === null || value === undefined) continue;
    if (name.startsWith('on')) element.addEventListener(name.slice(2), value);
    else element.setAttribute(name, value === true ? '' : value);
  }
  element.append(...children.flat().filter((child) => child !== null && child !== false));
  return element;
}

function kbd(text) {
  return h('kbd', null, text);
}

function badge(text, kind) {
  return h('span', { class: `badge ${kind}` }, text);
}

function link(url) {
  if (!/^https?:\/\//.test(url)) return h('span', null, url);
  return h('a', { href: url, target: '_blank', rel: 'noopener noreferrer' }, url);
}

async function api(path, body) {
  const init =
    body === undefined
      ? {}
      : {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Review-Token': token },
          body: JSON.stringify(body),
        };
  const response = await fetch(path, init);
  const data = await response.json().catch(() => ({}));
  return { ok: response.ok, status: response.status, data };
}

const questionUrl = (id, name) => `/api/questions/${encodeURIComponent(id)}/${name}`;

// --- header ----------------------------------------------------------------------------------

function renderStats() {
  const { session, queue, index, screen } = state;
  const done = session.approved + session.rejected;
  const waiting = queue.waiting;
  const showProgress = queue.total > 0 && screen.name !== 'empty' && screen.name !== 'loading';
  stats.replaceChildren(
    showProgress
      ? h('span', { class: 'progress' }, `${done + index + 1} of ${done + queue.total}`)
      : null,
    h('span', null, `approved ${session.approved}`),
    h('span', null, `rejected ${session.rejected}`),
    h(
      'span',
      null,
      `${waiting} reviewed ${waiting === 1 ? 'draft' : 'drafts'} waiting for promote`,
    ),
  );
}

// --- screens ---------------------------------------------------------------------------------

function questionHead(q) {
  return h(
    'p',
    { class: 'meta' },
    h('span', { class: 'qid' }, q.id),
    h('span', null, `Task ${q.task}`),
    h('span', null, q.taskTitle),
  );
}

function problemsSection(open) {
  const { problems } = state.queue;
  if (problems.length === 0) return null;
  return h(
    'details',
    { class: 'problems', open },
    h(
      'summary',
      null,
      `${problems.length} ${problems.length === 1 ? 'file' : 'files'} with problems`,
    ),
    h(
      'ul',
      null,
      ...problems.map((problem) => h('li', null, `${problem.path}: ${problem.message}`)),
    ),
  );
}

function answerScreen(screen) {
  const q = screen.question;
  const multiple = q.type === 'multiple';
  const options = q.options.map((option) => {
    const input = h('input', {
      type: multiple ? 'checkbox' : 'radio',
      name: 'answer',
      value: option.key,
      onchange: () => {
        setPick(option.key, input.checked);
      },
    });
    return h(
      'label',
      { class: 'option' },
      input,
      h('span', { class: 'key' }, `${option.key}.`),
      ` ${option.text}`,
    );
  });
  const first = q.options[0].key;
  const last = q.options[q.options.length - 1].key;
  return [
    questionHead(q),
    h('p', { class: 'stem' }, q.stem),
    h('fieldset', { class: 'options' }, h('legend', null, `Choose ${q.k}`), ...options),
    h(
      'div',
      { class: 'actions' },
      h(
        'button',
        { type: 'button', class: 'primary', onclick: () => run(doReveal) },
        'Reveal ',
        kbd('Enter'),
      ),
      h('p', { class: 'hint' }, `Keys ${first} to ${last} pick an option, Enter reveals.`),
    ),
    problemsSection(false),
  ];
}

const STATE_TEXT = {
  verified: 'verified',
  changed: 'changed',
  flagged: 'flagged',
  none: 'not verified',
};

const STATE_NOTE = {
  changed: 'The question was edited after the verifier checked it.',
  flagged: 'The verifier disagrees with the key or found no support in the docs.',
};

function fact(text) {
  return h('li', null, text);
}

function verificationSection(data) {
  const v = data.verification;
  const details = [];
  if (v) {
    if (v.verifier) details.push(fact(`Verifier: ${v.verifier}`));
    if (Array.isArray(v.answer)) details.push(fact(`Verifier answer: ${v.answer.join(', ')}`));
    if (v.result) details.push(fact(`Result: ${v.result}`));
    if (v.quote_check) details.push(fact(`Quote check: ${v.quote_check}`));
    if (v.source) details.push(h('li', null, 'Source: ', link(v.source)));
  }
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Verification'),
    h(
      'p',
      null,
      badge(STATE_TEXT[data.state], `state-${data.state}`),
      STATE_NOTE[data.state] ? ` ${STATE_NOTE[data.state]}` : null,
    ),
    data.sidecarError
      ? h('p', { class: 'error' }, `Check file unreadable: ${data.sidecarError}`)
      : null,
    details.length > 0 ? h('ul', { class: 'facts' }, ...details) : null,
    v && v.quote ? h('blockquote', null, h('p', null, v.quote)) : null,
    v && Array.isArray(v.reasons) && v.reasons.length > 0
      ? h('ul', { class: 'reasons' }, ...v.reasons.map((reason) => h('li', null, reason)))
      : null,
    v && v.notes ? h('p', { class: 'notes' }, v.notes) : null,
  );
}

function dedupeSection(data) {
  const d = data.dedupe;
  const similar = d && Array.isArray(d.similar) ? d.similar : [];
  return h(
    'section',
    { class: 'panel' },
    h('h2', null, 'Similar questions'),
    d ? h('p', null, `Threshold ${d.threshold}`) : h('p', null, 'dedupe not run'),
    d && similar.length === 0 ? h('p', null, 'No similar question found.') : null,
    similar.length > 0
      ? h(
          'ul',
          { class: 'similar' },
          ...similar.map((item) =>
            h(
              'li',
              null,
              h('span', { class: 'score' }, String(item.score)),
              h('span', { class: 'qid' }, item.id),
              h('code', null, `${item.folder}/${item.path}`),
            ),
          ),
        )
      : null,
  );
}

function optionRow(option, picked) {
  const classes = ['option', option.correct ? 'is-key' : '', picked ? 'is-picked' : ''];
  return h(
    'li',
    { class: classes.filter(Boolean).join(' ') },
    h(
      'div',
      { class: 'line' },
      h('span', { class: 'key' }, `${option.key}.`),
      h('span', { class: 'text' }, option.text),
      option.correct ? badge('Correct', 'ok') : null,
      picked ? badge('Picked', 'pick') : null,
    ),
    h('p', { class: 'why' }, option.why),
  );
}

function actionButton(label, key, handler) {
  return h('button', { type: 'button', onclick: () => run(handler) }, `${label} `, kbd(key));
}

function decisionBar(screen) {
  const { data } = screen;
  if (screen.rejecting) {
    return h(
      'div',
      { class: 'actions reason' },
      h('label', { for: 'reason' }, 'Reason for rejecting'),
      h('input', {
        id: 'reason',
        type: 'text',
        autocomplete: 'off',
        value: screen.reason,
        oninput: (event) => {
          screen.reason = event.target.value;
        },
        onkeydown: (event) => {
          if (event.key === 'Enter') {
            event.preventDefault();
            run(doReject);
          } else if (event.key === 'Escape') {
            event.preventDefault();
            screen.rejecting = false;
            screen.message = '';
            render();
          }
        },
      }),
      h('p', { class: 'hint' }, kbd('Enter'), ' to reject, ', kbd('Esc'), ' to cancel'),
    );
  }
  return h(
    'div',
    { class: 'actions' },
    screen.confirming
      ? h(
          'p',
          { class: 'warning', role: 'alert' },
          `Verification state is ${data.state}. Press A again to approve anyway, or Esc to cancel.`,
        )
      : null,
    h(
      'div',
      { class: 'buttons', role: 'group', 'aria-label': 'Decision' },
      actionButton('Approve', 'A', doApprove),
      actionButton('Edit', 'E', doEdit),
      actionButton('Reject', 'R', doStartReject),
      actionButton('Next', 'N', doNext),
    ),
  );
}

function revealScreen(screen) {
  const { data } = screen;
  const picked = new Set(screen.answer);
  return [
    questionHead(data),
    h(
      'p',
      { class: 'tags' },
      ...[...data.services, data.difficulty].map((tag) => h('span', { class: 'tag' }, tag)),
    ),
    h('p', { class: 'stem' }, data.stem),
    h(
      'p',
      { class: `verdict ${data.correct ? 'right' : 'wrong'}`, role: 'status' },
      `Your answer was ${data.correct ? 'right' : 'wrong'}.`,
    ),
    h(
      'ol',
      { class: 'options' },
      ...data.options.map((option) => optionRow(option, picked.has(option.key))),
    ),
    data.cue ? h('p', { class: 'cue' }, h('strong', null, 'Cue: '), data.cue) : null,
    verificationSection(data),
    dedupeSection(data),
    h(
      'section',
      { class: 'panel' },
      h('h2', null, 'References'),
      h('ul', null, ...data.references.map((url) => h('li', null, link(url)))),
    ),
    problemsSection(false),
    h(
      'div',
      { class: 'dock' },
      screen.message ? h('p', { class: 'error', role: 'alert' }, screen.message) : null,
      decisionBar(screen),
    ),
  ];
}

function editScreen(screen) {
  const { data } = screen;
  return [
    questionHead(data),
    h('label', { for: 'editor', class: 'field' }, 'Question YAML'),
    h('textarea', {
      id: 'editor',
      class: 'editor',
      spellcheck: 'false',
      wrap: 'off',
      rows: '28',
      oninput: (event) => {
        screen.text = event.target.value;
      },
      onkeydown: (event) => {
        if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
          event.preventDefault();
          run(doSave);
        } else if (event.key === 'Escape') {
          event.preventDefault();
          cancelEdit();
        }
      },
    }),
    screen.errors.length > 0
      ? h(
          'ul',
          { class: 'error list', role: 'alert' },
          ...screen.errors.map((error) => h('li', null, error)),
        )
      : null,
    h(
      'div',
      { class: 'dock' },
      h(
        'div',
        { class: 'actions' },
        h(
          'div',
          { class: 'buttons' },
          h(
            'button',
            { type: 'button', class: 'primary', onclick: () => run(doSave) },
            'Save ',
            kbd('Ctrl+Enter'),
          ),
          h('button', { type: 'button', onclick: cancelEdit }, 'Cancel ', kbd('Esc')),
        ),
      ),
    ),
  ];
}

function emptyScreen() {
  const { waiting } = state.queue;
  return [
    h('h2', null, 'The queue is empty.'),
    h(
      'p',
      null,
      waiting > 0
        ? `${waiting} reviewed ${waiting === 1 ? 'draft is' : 'drafts are'} ready. Move ${waiting === 1 ? 'it' : 'them'} to the public bank with `
        : 'Nothing is waiting. When drafts are reviewed, move them to the public bank with ',
      h('code', null, 'pnpm questions promote'),
      '.',
    ),
    problemsSection(true),
  ];
}

function messageScreen(screen) {
  return [h('p', { class: 'error', role: 'alert' }, screen.message)];
}

const SCREENS = {
  loading: () => [h('p', null, 'Loading the queue...')],
  answer: answerScreen,
  reveal: revealScreen,
  edit: editScreen,
  empty: emptyScreen,
  message: messageScreen,
};

function render() {
  const screen = state.screen;
  renderStats();
  view.replaceChildren(...SCREENS[screen.name](screen).filter((node) => node !== null));
  if (screen.name === 'answer') syncPicks();
  if (screen.name === 'edit') {
    const editor = document.getElementById('editor');
    editor.value = screen.text;
    editor.focus();
  }
  if (screen.name === 'reveal' && screen.rejecting) document.getElementById('reason').focus();
}

// --- answer phase ----------------------------------------------------------------------------

function syncPicks() {
  const { picked } = state.screen;
  for (const input of view.querySelectorAll('input[name="answer"]')) {
    input.checked = picked.has(input.value);
  }
}

function setPick(key, on) {
  const screen = state.screen;
  if (screen.name !== 'answer') return;
  if (screen.question.type === 'single') {
    screen.picked = new Set([key]);
  } else if (on) {
    screen.picked.add(key);
  } else {
    screen.picked.delete(key);
  }
  syncPicks();
}

function keyPress(key) {
  const screen = state.screen;
  if (!screen.question.options.some((option) => option.key === key)) return;
  setPick(key, !screen.picked.has(key));
}

// --- actions ---------------------------------------------------------------------------------

async function run(task) {
  if (state.busy) return;
  state.busy = true;
  try {
    await task();
  } catch {
    state.screen = {
      name: 'message',
      message: 'The review server does not answer. Is it still running?',
    };
    render();
  } finally {
    state.busy = false;
  }
}

async function showCurrent() {
  const queue = await api('/api/queue');
  state.queue = queue.data;
  if (state.queue.items.length === 0) {
    state.screen = { name: 'empty' };
    return render();
  }
  if (state.index >= state.queue.items.length || state.index < 0) state.index = 0;
  const item = state.queue.items[state.index];
  const blind = await api(questionUrl(item.id, 'blind'));
  if (!blind.ok) {
    state.screen = {
      name: 'message',
      message: blind.data.error ?? 'The question could not be loaded.',
    };
    return render();
  }
  state.screen = { name: 'answer', question: blind.data, picked: new Set() };
  render();
}

async function showReveal(question, answer, message) {
  const response = await api(questionUrl(question.id, 'reveal'), { answer });
  if (!response.ok) {
    state.screen = {
      name: 'message',
      message: response.data.error ?? 'The question could not be loaded.',
    };
    return render();
  }
  state.screen = {
    name: 'reveal',
    data: response.data,
    answer,
    confirming: false,
    rejecting: false,
    reason: '',
    message: message ?? '',
  };
  render();
}

async function doReveal() {
  const screen = state.screen;
  await showReveal(screen.question, [...screen.picked].sort());
}

/** A refusal: shows its message; when the file changed on disk, loads the question again. */
async function refused(screen, response) {
  const message = response.data.error ?? 'The request was refused.';
  if (response.status === 409) return showReveal(screen.data, screen.answer, message);
  screen.message = message;
  screen.confirming = false;
  render();
}

async function doApprove() {
  const screen = state.screen;
  if (screen.name !== 'reveal' || screen.rejecting) return;
  if (screen.data.state !== 'verified' && !screen.confirming) {
    screen.confirming = true;
    screen.message = '';
    return render();
  }
  const response = await api(questionUrl(screen.data.id, 'approve'), {
    etag: screen.data.etag,
    answer: screen.answer,
    confirm: screen.confirming,
  });
  if (!response.ok) return refused(screen, response);
  state.session.approved += 1;
  await showCurrent();
}

async function doNext() {
  state.index += 1;
  await showCurrent();
}

function doStartReject() {
  const screen = state.screen;
  screen.rejecting = true;
  screen.confirming = false;
  screen.message = '';
  render();
}

async function doReject() {
  const screen = state.screen;
  const reason = screen.reason.trim();
  if (reason === '') {
    screen.message = 'Write a reason before rejecting.';
    return render();
  }
  const response = await api(questionUrl(screen.data.id, 'reject'), {
    etag: screen.data.etag,
    answer: screen.answer,
    reason,
  });
  if (!response.ok) return refused(screen, response);
  state.session.rejected += 1;
  await showCurrent();
}

async function doEdit() {
  const screen = state.screen;
  screen.confirming = false;
  const response = await api(questionUrl(screen.data.id, 'source'));
  if (!response.ok) return refused(screen, response);
  state.screen = {
    name: 'edit',
    data: screen.data,
    back: screen,
    etag: response.data.etag,
    text: response.data.text,
    errors: [],
  };
  render();
}

function cancelEdit() {
  state.screen = state.screen.back;
  render();
}

async function doSave() {
  const screen = state.screen;
  const response = await api(questionUrl(screen.data.id, 'edit'), {
    etag: screen.etag,
    text: screen.text,
  });
  if (response.ok) return showReveal(screen.data, screen.back.answer);
  screen.errors = response.data.errors ?? [response.data.error ?? 'The draft was not saved.'];
  render();
}

// --- keyboard --------------------------------------------------------------------------------

function inTextField(target) {
  return target instanceof Element && target.matches('textarea, input[type="text"]');
}

document.addEventListener('keydown', (event) => {
  if (event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey)
    return;
  if (state.busy || inTextField(event.target)) return;
  const screen = state.screen;
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  const onButton = event.target instanceof Element && event.target.closest('button') !== null;
  let handled = true;

  if (screen.name === 'answer') {
    if (key === 'Enter' && !onButton) run(doReveal);
    else if (/^[A-F]$/.test(key)) keyPress(key);
    else handled = false;
  } else if (screen.name === 'reveal' && !screen.rejecting) {
    if (key === 'A') run(doApprove);
    else if (key === 'E') run(doEdit);
    else if (key === 'R') run(doStartReject);
    else if (key === 'N') run(doNext);
    else if (key === 'Escape' && screen.confirming) {
      screen.confirming = false;
      render();
    } else handled = false;
  } else if (screen.name === 'reveal' && key === 'Escape') {
    screen.rejecting = false;
    render();
  } else if (screen.name === 'edit' && key === 'Escape') {
    cancelEdit();
  } else {
    handled = false;
  }
  if (handled) event.preventDefault();
});

run(showCurrent);
