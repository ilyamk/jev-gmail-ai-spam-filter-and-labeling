'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'CODE.gs'), 'utf8');

function fixture(count = 3, settings = {}) {
  const data = new Map();
  const calls = {model: 0, writes: [], full: 0};
  let serial = 0, locked = false, clock = 1000;
  const labels = [];
  const messages = Array.from({length: count}, (_, i) => ({id: String(i + 1), labelIds: ['INBOX']}));
  const props = {
    getProperty: k => data.has(k) ? data.get(k) : null,
    setProperty(k, v) {
      assert.ok(Buffer.byteLength(v) <= 9000, 'Apps Script property byte limit');
      data.set(k, v); return this;
    },
    deleteProperty: k => data.delete(k)
  };
  const ctx = {
    Date: class extends Date { static now() { return clock; } },
    PropertiesService: {getUserProperties: () => props},
    LockService: {getUserLock: () => ({tryLock() {if (locked) return false; locked = true; return true;}, releaseLock() {locked = false;}})},
    Utilities: {
      getUuid: () => 'uuid-' + (++serial),
      base64DecodeWebSafe: s => Buffer.from(s, 'base64url'),
      sleep: () => {},
      newBlob: value => ({getBytes: () => [...Buffer.from(value)], getDataAsString: () => Buffer.from(value).toString('utf8')})
    },
    Gmail: {Users: {
      Labels: {
        list: () => ({labels}),
        create: l => { const created = {...l, id: 'label-' + labels.length}; labels.push(created); return created; }
      },
      Messages: {
        list(user, options) {
          const marker = labels.find(l => l.name === 'jev-triaged');
          const eligible = messages.filter(m => !marker || !m.labelIds.includes(marker.id));
          const offset = Number(options.pageToken || 0);
          const page = eligible.slice(offset, offset + options.maxResults);
          return {messages: page.map(m => ({id: m.id})), resultSizeEstimate: settings.estimate ?? eligible.length,
            nextPageToken: offset + page.length < eligible.length ? String(offset + page.length) : undefined};
        },
        get(user, id, options) {
          clock += 10;
          const m = messages.find(m => m.id === id);
          if (options.format === 'full') calls.full++;
          const emptyBody = settings.emptyBody || (settings.emptyBodyIds || []).includes(id);
          return {...m, snippet: 'Please review this request.', payload: {mimeType: 'text/plain',
            headers: [{name: 'From', value: 'sender@example.com'}, {name: 'Subject', value: 'Message ' + id}],
            body: {data: emptyBody ? '' : Buffer.from('Please approve the requested change.').toString('base64url')}}};
        },
        batchModify(request) {
          if (settings.failWrite) {settings.failWrite = false; throw new Error('Temporary Gmail write failure');}
          calls.writes.push(request);
          for (const id of request.ids) {
            const m = messages.find(m => m.id === id);
            m.labelIds = [...new Set([...m.labelIds, ...request.addLabelIds])].filter(id => !(request.removeLabelIds || []).includes(id));
          }
        }
      }
    }},
    UrlFetchApp: {
      fetchAll(requests) {
        return requests.map(request => {
          calls.model++;
          assert.equal(request.headers.Authorization, 'Bearer ephemeral-key');
          if (settings.failModelAt === calls.model) throw new Error('Transport timeout');
          const payload = JSON.parse(request.payload);
          if (settings.modelResponder) return settings.modelResponder({payload, call: calls.model, request});
          const confidence = payload.state.evidence_stage === 'full_body' ? 0.96 : (settings.confidence ?? 0.96);
          return response({answers: {label: {choice: 'L0', confidence, probabilities: {L0: 1}}}, usage: {cost: 0.00001}});
        });
      }
    }
  };
  vm.createContext(ctx);
  vm.runInContext(source, ctx);
  const rules = [{id: 'safe', name: 'review', description: 'A message to review.', spam: !!settings.archive}];
  const options = {rules, apiKey: 'ephemeral-key', saveKey: false, limit: settings.limit || 'all',
    maxSpendUsd: settings.budget || 0.1, metadataThreshold: 0.82, archiveThreshold: 0.93,
    dryRun: settings.dryRun !== false, mode: settings.archive ? 'labels_archive' : 'labels'};
  return {ctx, data, calls, rules, options, labels, settings, advance: n => {clock += n;},
    start: () => ctx.startTriageJob(options).job,
    batch: id => ctx.processNextBatch(id, 'ephemeral-key')};
}

function response(json, status = 200) {
  return {getResponseCode: () => status, getContentText: () => JSON.stringify(json)};
}

test('unsaved API key processes without persisting it; preview never writes Gmail', () => {
  const f = fixture(); const job = f.start(); const res = f.batch(job.id);
  assert.equal(res.job.status, 'completed'); assert.equal(res.job.processed, 3);
  assert.equal(f.calls.writes.length, 0); assert.equal(f.labels.length, 0);
  assert.ok(![...f.data.values()].some(v => v.includes('ephemeral-key')));
});

test('All ignores underestimated Gmail totals and consumes every page exactly once', () => {
  const f = fixture(19, {estimate: 1}); let job = f.start();
  for (let i = 0; i < 5 && job.status === 'running'; i++) job = f.batch(job.id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 19); assert.equal(f.calls.model, 19);
});

test('numeric limit follows actual pages rather than the approximate total', () => {
  const f = fixture(19, {estimate: 1, limit: 10}); let job = f.start();
  job = f.batch(job.id).job; job = f.batch(job.id).job;
  assert.equal(job.processed, 10); assert.equal(job.status, 'completed');
});

test('write failure resumes a persisted decision without another paid request', () => {
  const f = fixture(1, {dryRun: false, failWrite: true}); let job = f.start();
  job = f.batch(job.id).job; assert.equal(job.status, 'error'); assert.equal(f.calls.model, 1);
  f.ctx.resumeTriageJob(job.id); job = f.batch(job.id).job;
  assert.equal(job.processed, 1); assert.equal(f.calls.model, 1); assert.equal(f.calls.writes.length, 1);
});

test('a transient model transport failure retries once and continues the batch', () => {
  const f = fixture(10, {failModelAt: 2}); let job = f.start();
  let batch = f.batch(job.id); job = batch.job;
  assert.equal(job.processed, 8); assert.equal(job.status, 'running'); assert.equal(job.providerRetries, 1);
  assert.ok(batch.events.some(event => /Retrying once/.test(event.message)));
  job = f.batch(job.id).job;
  assert.equal(job.processed, 10); assert.equal(job.status, 'completed'); assert.equal(f.calls.model, 11);
});

test('low confidence requires full content, and archive uses the final confidence', () => {
  const f = fixture(1, {dryRun: false, archive: true, confidence: 0.8}); let job = f.start();
  job = f.batch(job.id).job;
  assert.equal(f.calls.full, 1); assert.equal(f.calls.model, 2); assert.equal(job.archived, 1);
  assert.ok(f.calls.writes[0].removeLabelIds.includes('INBOX'));
});

test('unavailable required body is skipped safely and later messages continue', () => {
  const f = fixture(19, {dryRun: false, confidence: 0.5, emptyBodyIds: ['1']}); let job = f.start();
  const events = [], results = [];
  for (let i = 0; i < 6 && job.status === 'running'; i++) {
    const batch = f.batch(job.id); job = batch.job; events.push(...batch.events); results.push(...batch.results);
  }
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 18);
  assert.equal(job.skipped, 1); assert.equal(job.failed, 0); assert.equal(job.target, 19);
  assert.equal(f.calls.model, 37); assert.equal(f.calls.full, 19); assert.equal(f.calls.writes.length, 18);
  assert.ok(!f.calls.writes.some(request => request.ids.includes('1')));
  assert.ok(events.some(event => event.level === 'warn' && /No labels or archive actions/.test(event.message)));
  assert.ok(results.some(row => row.subject === 'Message 1' && row.action === 'skipped-no-content'));
  assert.ok(Buffer.byteLength(f.data.get('JEV_CURRENT_JOB_V2')) <= 9000);
});

test('skipped messages count toward a numeric run limit', () => {
  const f = fixture(19, {dryRun: false, confidence: 0.5, emptyBodyIds: ['1'], limit: 10}); let job = f.start();
  for (let i = 0; i < 4 && job.status === 'running'; i++) job = f.batch(job.id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 9);
  assert.equal(job.skipped, 1); assert.equal(job.target, 10); assert.equal(f.calls.writes.length, 9);
});

test('budget prevents dispatch and all Gmail message writes', () => {
  const f = fixture(1, {dryRun: false, budget: 0.000001}); const job = f.start();
  assert.equal(f.batch(job.id).job.status, 'budget'); assert.equal(f.calls.model, 0); assert.equal(f.calls.writes.length, 0);
});

test('new start and clear cannot overwrite an active session; stop is terminal', () => {
  const f = fixture(); const job = f.start();
  assert.throws(() => f.start(), /already active/); assert.throws(() => f.ctx.clearFinishedJob(), /Stop processing/);
  f.ctx.cancelTriageJob(job.id); assert.equal(f.batch(job.id).job.status, 'cancelled'); assert.equal(f.calls.model, 0);
});

test('frozen rules remain independent from user edits', () => {
  const f = fixture(1); const job = f.start();
  f.ctx.saveLabelRules([{id: 'new', name: 'different', description: 'Different definition', spam: true}]);
  assert.equal(f.batch(job.id).results[0].label, 'review');
});

test('missing frozen rules fail closed', () => {
  const f = fixture(); const job = f.start(); f.data.delete('JEV_CURRENT_JOB_RULES_V2');
  assert.equal(f.batch(job.id).job.status, 'error'); assert.equal(f.calls.model, 0);
});

test('confidence is not replaced by selected probability; malformed confidence fails closed', () => {
  const f = fixture();
  const json = {answers: {label: {choice: 'L0', confidence: 0.4, probabilities: {L0: 0.9, L1: 0.1}}}, usage: {cost: null}};
  const rules = [f.rules[0], {...f.rules[0], id: 'second'}];
  let parsed = f.ctx.parseJevResponse_(response(json), rules, 0.01);
  assert.equal(parsed.confidence, 0.4); assert.equal(parsed.costUsd, 0.01);
  for (const bad of [null, '0.99', -1, 2]) {
    json.answers.label.confidence = bad;
    assert.equal(f.ctx.parseJevResponse_(response(json), rules, 0.01).ok, false);
  }
});

test('Jev payload follows the Decisions Choice contract and keeps the latest model alias', () => {
  let captured;
  const f = fixture(1, {modelResponder({payload}) {
    captured = payload;
    return response({answers: {label: {choice: 'L0', confidence: 1, probabilities: {L0: 1}}}});
  }});
  const result = f.batch(f.start().id);
  assert.equal(result.job.status, 'completed');
  assert.equal(captured.model, '~typesafe/jev-latest');
  assert.equal(captured.questions.label.type, 'choice');
  assert.equal(typeof captured.questions.label.instructions, 'object');
  assert.equal(captured.questions.label.criteria.L0.gmail_label, 'review');
  assert.equal(captured.questions.label.criteria.L0.assign_when, 'A message to review.');
  assert.equal(captured.state.evidence_stage, 'metadata_only');
  assert.equal(captured.state.email.subject, 'Message 1');
});

test('probability validation reports precise contract failures and permits boundary noise', () => {
  const f = fixture();
  const rules = [f.rules[0], {...f.rules[0], id: 'second'}];
  const parse = probabilities => f.ctx.parseJevResponse_(response({answers: {label: {
    choice: 'L0', confidence: 0.8, probabilities
  }}}), rules, 0.01);
  assert.equal(parse({L0: 0.7}).code, 'missing_probabilities');
  assert.equal(parse({L0: 0.7, L1: 0.3, other: 0}).code, 'unexpected_probability_keys');
  assert.equal(parse({L0: 0.7, L1: 0.27}).code, 'probability_sum_mismatch');
  assert.equal(parse({L0: 0.51, L1: 0.5}).ok, true);
});

test('an invalid Jev distribution is retried once and a valid retry is used', () => {
  const f = fixture(1, {modelResponder({call}) {
    const probabilities = call === 1 ? {L0: 0.98} : {L0: 1};
    return response({answers: {label: {choice: 'L0', confidence: 0.95, probabilities}}, usage: {cost: 0.00001}});
  }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'completed');
  assert.equal(batch.job.processed, 1); assert.equal(batch.job.skipped, 0);
  assert.equal(batch.job.providerRetries, 1); assert.equal(f.calls.model, 2);
  assert.ok(batch.events.some(event => /probability_sum_mismatch/.test(event.message)));
});

test('a persistently invalid Jev response skips only that message and continues safely', () => {
  const settings = {dryRun: false};
  settings.modelResponder = ({payload}) => {
    const bad = payload.state.email.subject === 'Message 1';
    return response({answers: {label: {choice: 'L0', confidence: 0.95,
      probabilities: bad ? {L0: 0.98} : {L0: 1}}}, usage: {cost: 0.00001}});
  };
  const f = fixture(2, settings); let job = f.start(); const results = [];
  for (let i = 0; i < 3 && job.status === 'running'; i++) {
    const batch = f.batch(job.id); job = batch.job; results.push(...batch.results);
  }
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 1); assert.equal(job.skipped, 1);
  assert.equal(job.modelResponseSkips, 1); assert.equal(job.providerRetries, 1); assert.equal(job.failed, 0);
  assert.equal(f.calls.model, 3); assert.equal(f.calls.writes.length, 1);
  assert.ok(!f.calls.writes.some(request => request.ids.includes('1')));
  assert.ok(results.some(row => row.subject === 'Message 1' && row.action === 'skipped-invalid-model-response'));
});

test('three consecutive invalid Jev responses open the circuit breaker without consuming the inbox', () => {
  const f = fixture(4, {dryRun: false, modelResponder() {
    return response({answers: {label: {choice: 'L0', confidence: 0.95, probabilities: {L0: 0.98}}}});
  }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'paused');
  assert.equal(batch.job.stopReason, 'jev-response-circuit-breaker');
  assert.equal(batch.job.processed, 0); assert.equal(batch.job.skipped, 2);
  assert.equal(batch.job.modelResponseSkips, 2); assert.equal(batch.job.providerRetries, 3);
  assert.equal(f.calls.model, 6); assert.equal(f.calls.writes.length, 0);
  assert.match(batch.job.lastError, /3 consecutive messages/);
});

test('a persistent provider outage pauses instead of skipping messages or failing the session', () => {
  const f = fixture(2, {modelResponder() { throw new Error('Provider connection reset'); }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'paused'); assert.equal(batch.job.stopReason, 'provider-temporary');
  assert.equal(batch.job.processed, 0); assert.equal(batch.job.skipped, 0); assert.equal(batch.job.failed, 0);
  assert.equal(batch.job.providerRetries, 1); assert.equal(f.calls.model, 2);
  assert.match(batch.job.lastError, /could not be reached/);
});

test('authentication failures remain session-level and are not retried', () => {
  const f = fixture(1, {modelResponder() { return response({error: 'unauthorized'}, 401); }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'error'); assert.equal(batch.job.failed, 1);
  assert.equal(batch.job.providerRetries, 0); assert.equal(f.calls.model, 1);
  assert.match(batch.job.lastError, /rejected the API key/);
});

test('large Unicode rule sets fit property limits and survive read/reset', () => {
  const f = fixture();
  const rules = Array.from({length: 12}, (_, i) => ({id: 'r' + i, name: 'rule-' + i, description: '漢'.repeat(400), spam: false}));
  f.ctx.saveLabelRules(rules); assert.equal(f.ctx.getSavedRules_()[11].description.length, 400);
  f.ctx.resetLabelRules(); assert.equal(f.ctx.getSavedRules_().length, 10);
});

test('internal marker rejected, ordinary prototype-like names supported', () => {
  const f = fixture();
  assert.throws(() => f.ctx.validateAndNormalizeRules_([{...f.rules[0], name: 'jev-triaged'}]), /internal/);
  assert.equal(f.ctx.validateAndNormalizeRules_([{...f.rules[0], name: 'constructor'}])[0].name, 'constructor');
});

test('text attachments excluded from message classification body', () => {
  const f = fixture(); const enc = s => Buffer.from(s).toString('base64url');
  const body = f.ctx.extractMessageText_({payload: {parts: [
    {mimeType: 'text/plain', body: {data: enc('Actual body')}},
    {mimeType: 'text/plain', filename: 'private.txt', body: {data: enc('Secret attachment')}}
  ]}});
  assert.equal(body, 'Actual body');
});

test('idle time between batches is excluded from processing duration', () => {
  const f = fixture(10); let job = f.start(); job = f.batch(job.id).job;
  const elapsed = job.elapsedMs; f.advance(60000);
  assert.equal(f.ctx.getJobElapsedMs_(f.ctx.loadJob_()), elapsed);
  job = f.batch(job.id).job; assert.ok(job.elapsedMs < 1000);
});

test('all bundled playbooks and embedded browser script parse', () => {
  const f = fixture();
  vm.runInContext('LABEL_PLAYBOOKS.forEach(p => validateAndNormalizeRules_(p.rules));', f.ctx);
  const html = f.ctx.getHtml_();
  for (const script of html.matchAll(/<script>([\s\S]*?)<\/script>/g)) new vm.Script(script[1]);
});

test('preview archive predictions do not increment the actual archive counter', () => {
  const f = fixture(1, {archive: true}); const result = f.batch(f.start().id);
  assert.equal(result.job.archived, 0); assert.equal(result.results[0].action, 'would archive');
  assert.equal(f.calls.writes.length, 0);
});

test('body parts stored by attachment ID are retrieved, file attachments are not', () => {
  const f = fixture(); const requests = [];
  f.ctx.Gmail.Users.Messages.Attachments = {get: (user, id, attachmentId) => {
    requests.push(attachmentId); return {data: Buffer.from('External message body').toString('base64url')};
  }};
  const result = f.ctx.extractMessageText_({id: '1', payload: {parts: [
    {mimeType: 'text/plain', body: {attachmentId: 'body'}},
    {mimeType: 'text/plain', filename: 'secret.txt', body: {attachmentId: 'file'}}
  ]}});
  assert.equal(result, 'External message body'); assert.deepEqual(requests, ['body']);
});

test('write-mode All drains the changing Gmail query without skipping messages', () => {
  const f = fixture(19, {estimate: 2, dryRun: false}); let job = f.start();
  for (let i = 0; i < 5 && job.status === 'running'; i++) job = f.batch(job.id).job;
  assert.equal(job.processed, 19); assert.equal(job.status, 'completed'); assert.equal(f.calls.model, 19);
  assert.equal(new Set(f.calls.writes.flatMap(r => r.ids)).size, 19);
});

test('session mutations cannot run concurrently with a held processing lock', () => {
  const f = fixture(); const job = f.start(); const lock = f.ctx.LockService.getUserLock(); lock.tryLock();
  assert.throws(() => f.ctx.cancelTriageJob(job.id), /batch is still running/);
  assert.throws(() => f.ctx.resumeTriageJob(job.id), /batch is still running/);
  assert.throws(() => f.ctx.clearFinishedJob(), /batch is still running/);
  lock.releaseLock(); assert.equal(f.ctx.loadJob_().status, 'running');
});

test('archiving threshold cannot be weaker than metadata threshold', () => {
  const f = fixture();
  assert.throws(() => f.ctx.normalizeRunOptions_({...f.options, archiveThreshold: 0.6}), /at least as high/);
});
