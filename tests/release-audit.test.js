'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
const source = fs.readFileSync(path.join(__dirname, '..', 'CODE.gs'), 'utf8');

function fixture(count = 3, settings = {}) {
  const data = new Map();
  const calls = {model: 0, writes: [], writeAttempts: 0, full: 0, fetchAll: 0,
    gmailBatches: 0, gmailBatchItems: [], propertyWrites: 0};
  let serial = 0, locked = false, clock = 1000;
  const labels = [];
  const messages = Array.from({length: count}, (_, i) => ({id: String(i + 1), labelIds: ['INBOX']}));
  const props = {
    getProperty: k => data.has(k) ? data.get(k) : null,
    setProperty(k, v) {
      assert.ok(Buffer.byteLength(v) <= 9000, 'Apps Script property byte limit');
      calls.propertyWrites++;
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
      base64Decode: s => Buffer.from(s, 'base64'),
      sleep: () => {},
      newBlob: value => {
        const bytes = Buffer.from(value);
        return {
          getBytes: () => [...bytes],
          getDataAsString: charset => bytes.toString(/^iso-8859-1$/i.test(charset || '') ? 'latin1' : 'utf8')
        };
      }
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
          calls.writeAttempts++;
          if (settings.failWrite) {settings.failWrite = false; throw new Error('Temporary Gmail write failure');}
          if (settings.failWritesPersistently) throw new Error('429 Gmail rate limit exceeded');
          if (settings.failWritesFromAttempt && calls.writeAttempts >= settings.failWritesFromAttempt) {
            throw new Error('429 Gmail rate limit exceeded');
          }
          calls.writes.push(request);
          for (const id of request.ids) {
            const m = messages.find(m => m.id === id);
            m.labelIds = [...new Set([...m.labelIds, ...request.addLabelIds])].filter(id => !(request.removeLabelIds || []).includes(id));
          }
        }
      }
    }},
    ScriptApp: {getOAuthToken: () => 'gmail-oauth-token'},
    UrlFetchApp: {
      fetch(url, request) {
        if (url === 'https://gmail.googleapis.com/batch') {
          calls.gmailBatches++;
          assert.equal(request.headers.Authorization, 'Bearer gmail-oauth-token');
          const entries = [...String(request.payload).matchAll(
            /Content-ID:\s*<item-(\d+)>[\s\S]*?GET\s+([^\s]+)\s+HTTP\/1\.1/g
          )].map(match => {
            const parsed = new URL('https://gmail.googleapis.com' + match[2]);
            const pieces = parsed.pathname.split('/');
            return {index: Number(match[1]), id: decodeURIComponent(pieces[pieces.length - 1]),
              format: parsed.searchParams.get('format')};
          });
          calls.gmailBatchItems.push(entries.map(entry => ({id: entry.id, format: entry.format})));
          const outerStatus = settings.gmailOuterStatuses && settings.gmailOuterStatuses[calls.gmailBatches - 1];
          if (outerStatus) return textResponse('', outerStatus, {'Content-Type': 'application/json', 'Retry-After': '0'});

          const responseBoundary = 'response_' + calls.gmailBatches;
          const ordered = settings.reverseGmailBatchResponses ? entries.slice().reverse() : entries;
          const parts = ordered.map(entry => {
            let part = settings.gmailPartResponder && settings.gmailPartResponder({
              id: entry.id, format: entry.format, batchCall: calls.gmailBatches, index: entry.index
            });
            if (!part) part = {status: 200, message: ctx.Gmail.Users.Messages.get('me', entry.id, {format: entry.format})};
            const status = part.status || 200;
            const body = part.body || (part.message ? JSON.stringify(part.message) : JSON.stringify({error: {code: status}}));
            return '--' + responseBoundary + '\r\nContent-Type: application/http\r\n' +
              'Content-ID: <response-item-' + entry.index + '>\r\n\r\n' +
              'HTTP/1.1 ' + status + ' ' + (status === 200 ? 'OK' : 'Error') + '\r\n' +
              'Content-Type: application/json\r\n' +
              (part.retryAfter !== undefined ? 'Retry-After: ' + part.retryAfter + '\r\n' : '') +
              '\r\n' + body + '\r\n';
          });
          return textResponse(parts.join('') + '--' + responseBoundary + '--\r\n', 200,
            {'Content-Type': 'multipart/mixed; boundary="' + responseBoundary + '"'});
        }
        throw new Error('Unexpected UrlFetchApp.fetch URL: ' + url);
      },
      fetchAll(requests) {
        calls.fetchAll++;
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
  return textResponse(JSON.stringify(json), status, {});
}

function textResponse(text, status = 200, headers = {}) {
  return {getResponseCode: () => status, getContentText: () => text,
    getHeaders: () => headers, getAllHeaders: () => headers};
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

test('a transient grouped Gmail write retries without another paid request', () => {
  const f = fixture(1, {dryRun: false, failWrite: true}); let job = f.start();
  job = f.batch(job.id).job;
  assert.equal(job.processed, 1); assert.equal(f.calls.model, 1);
  assert.equal(f.calls.writeAttempts, 2); assert.equal(f.calls.writes.length, 1);
});

test('a transient model transport failure retries once and continues the batch', () => {
  const f = fixture(10, {failModelAt: 2}); let job = f.start();
  let batch = f.batch(job.id); job = batch.job;
  assert.equal(job.processed, 10); assert.equal(job.status, 'completed'); assert.equal(job.providerRetries, 10);
  assert.ok(batch.events.some(event => /temporarily unavailable|Retrying/i.test(event.message)));
  assert.equal(f.calls.model, 12); assert.equal(f.calls.fetchAll, 3);
});

test('ten metadata decisions are sent in one parallel HTTP wave', () => {
  const f = fixture(10); const started = f.start(); const writesBeforeBatch = f.calls.propertyWrites;
  const job = f.batch(started.id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 10);
  assert.equal(f.calls.model, 10); assert.equal(f.calls.fetchAll, 1);
  assert.equal(job.modelRequests, 10);
  assert.ok(f.calls.propertyWrites - writesBeforeBatch <= 16);
});

test('fifty messages use adaptive Gmail and Jev waves in one browser iteration', () => {
  const f = fixture(50); const started = f.start(); const writesBeforeBatch = f.calls.propertyWrites;
  const job = f.batch(started.id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 50);
  assert.deepEqual(f.calls.gmailBatchItems.map(batch => batch.length), [25, 25]);
  assert.equal(f.calls.fetchAll, 2); assert.equal(f.calls.model, 50);
  assert.ok(f.calls.propertyWrites - writesBeforeBatch <= 14);
  const stored = f.ctx.loadJob_();
  assert.equal(stored.gmailConcurrency, 35); assert.equal(stored.jevConcurrency, 35);
});

test('Gmail multipart responses are mapped by Content-ID even when reordered', () => {
  const subjects = [];
  const f = fixture(8, {reverseGmailBatchResponses: true, modelResponder({payload}) {
    subjects.push(payload.state.email.subject);
    return response({answers: {label: {choice: 'L0', confidence: 1, probabilities: {L0: 1}}}});
  }});
  const job = f.batch(f.start().id).job;
  assert.equal(job.status, 'completed');
  assert.deepEqual(subjects.sort(), Array.from({length: 8}, (_, i) => 'Message ' + (i + 1)).sort());
});

test('a partial Gmail 429 retries only the affected message with lower concurrency', () => {
  const f = fixture(10, {gmailPartResponder({id, format, batchCall}) {
    if (format === 'metadata' && id === '3' && batchCall === 1) return {status: 429, retryAfter: 0};
  }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'completed'); assert.equal(batch.job.processed, 10);
  assert.deepEqual(f.calls.gmailBatchItems.map(items => items.length), [10, 1]);
  assert.equal(f.ctx.loadJob_().gmailRateLimitRetries, 1);
  assert.ok(batch.events.some(event => /Gmail temporarily limited 1 message read/.test(event.message)));
});

test('Gmail userRateLimitExceeded 403 is treated as throttling, not lost authorization', () => {
  const f = fixture(4, {gmailPartResponder({id, format, batchCall}) {
    if (format === 'metadata' && id === '2' && batchCall === 1) {
      return {status: 403, body: JSON.stringify({error: {errors: [{reason: 'userRateLimitExceeded'}]}})};
    }
  }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'completed'); assert.equal(batch.job.processed, 4);
  assert.equal(f.ctx.loadJob_().gmailRateLimitRetries, 1);
  assert.equal(f.calls.model, 4);
});

test('an outer Gmail batch 429 retries the bounded wave once', () => {
  const f = fixture(10, {gmailOuterStatuses: [429]});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'completed'); assert.equal(batch.job.processed, 10);
  assert.deepEqual(f.calls.gmailBatchItems.map(items => items.length), [10, 10]);
  assert.equal(f.calls.model, 10);
});

test('a persistent Gmail 429 pauses safely before any paid model request', () => {
  const f = fixture(10, {gmailPartResponder({id, format}) {
    if (format === 'metadata' && id === '1') return {status: 429, retryAfter: 0};
  }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'paused'); assert.equal(batch.job.stopReason, 'gmail-temporary');
  assert.equal(batch.job.processed, 0); assert.equal(f.calls.model, 0);
  assert.deepEqual(f.calls.gmailBatchItems.map(items => items.length), [10, 1]);
});

test('a partial OpenRouter 429 retries only the affected decision and reduces concurrency', () => {
  const f = fixture(30, {modelResponder({call}) {
    if (call === 1) return response({error: 'rate limited'}, 429);
    return response({answers: {label: {choice: 'L0', confidence: 1, probabilities: {L0: 1}}},
      usage: {cost: 0.00001}});
  }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'completed'); assert.equal(batch.job.processed, 30);
  assert.equal(batch.job.providerRetries, 1); assert.equal(f.calls.model, 31);
  assert.equal(f.ctx.loadJob_().jevConcurrency, 17);
});

test('persistent OpenRouter 429 pauses after one probe without retrying the whole wave', () => {
  const f = fixture(10, {modelResponder() { return response({error: 'rate limited'}, 429); }});
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'paused'); assert.equal(batch.job.stopReason, 'provider-temporary');
  assert.equal(batch.job.processed, 0); assert.equal(batch.job.providerRetries, 1);
  assert.equal(f.calls.model, 11);
});

test('full-content fallbacks form one second parallel wave', () => {
  const f = fixture(10, {confidence: 0.5}); const job = f.batch(f.start().id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.fullBody, 10);
  assert.equal(f.calls.model, 20); assert.equal(f.calls.fetchAll, 2);
  assert.equal(job.modelRequests, 20);
});

test('fifty full-content fallbacks use a second adaptive Gmail batch wave', () => {
  const f = fixture(50, {confidence: 0.5}); const job = f.batch(f.start().id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.fullBody, 50);
  assert.deepEqual(f.calls.gmailBatchItems.map(batch => batch.length), [25, 25, 35, 15]);
  assert.equal(f.calls.model, 100); assert.equal(f.calls.fetchAll, 4);
});

test('low confidence requires full content, and archive uses the final confidence', () => {
  const f = fixture(1, {dryRun: false, archive: true, confidence: 0.8}); let job = f.start();
  job = f.batch(job.id).job;
  assert.equal(f.calls.full, 1); assert.equal(f.calls.model, 2); assert.equal(job.archived, 1);
  assert.ok(f.calls.writes[0].removeLabelIds.includes('INBOX'));
});

test('live mode applies one grouped Gmail write per final label', () => {
  const f = fixture(50, {dryRun: false}); const job = f.batch(f.start().id).job;
  assert.equal(job.processed, 50); assert.equal(f.calls.writes.length, 1);
  assert.equal(f.calls.writes[0].ids.length, 50);
  assert.equal(new Set(f.calls.writes[0].ids).size, 50);
});

test('persistent Gmail write throttling pauses with reusable decisions', () => {
  const f = fixture(5, {dryRun: false, failWritesPersistently: true}); let job = f.start();
  let batch = f.batch(job.id); job = batch.job;
  assert.equal(job.status, 'paused'); assert.equal(job.stopReason, 'gmail-temporary');
  assert.equal(job.processed, 0); assert.equal(f.calls.model, 5); assert.equal(f.calls.writeAttempts, 2);
  assert.ok(f.ctx.loadJob_().pending.every(item => item.final));

  f.settings.failWritesPersistently = false;
  f.ctx.resumeTriageJob(job.id); batch = f.batch(job.id); job = batch.job;
  assert.equal(job.processed, 5); assert.equal(f.calls.model, 5);
  assert.equal(f.calls.writes.length, 1);
});

test('a partially applied grouped write replays idempotently and preserves counters', () => {
  const settings = {dryRun: false, failWritesFromAttempt: 2, modelResponder({payload}) {
    const even = Number(payload.state.email.subject.split(' ').pop()) % 2 === 0;
    return response({answers: {label: {choice: even ? 'L1' : 'L0', confidence: 1,
      probabilities: even ? {L0: 0, L1: 1} : {L0: 1, L1: 0}}}, usage: {cost: 0.00001}});
  }};
  const f = fixture(6, settings);
  f.options.rules = [f.rules[0], {id: 'second', name: 'action', description: 'Action needed.', spam: false}];
  let job = f.start(); job = f.batch(job.id).job;
  assert.equal(job.status, 'paused'); assert.equal(job.processed, 0);
  assert.equal(f.calls.model, 6); assert.equal(f.calls.writes.length, 1);

  settings.failWritesFromAttempt = 0;
  f.ctx.resumeTriageJob(job.id); job = f.batch(job.id).job;
  assert.equal(job.processed, 6); assert.equal(f.calls.model, 6);
  assert.equal(job.labelCounts.safe, 3); assert.equal(job.labelCounts.second, 3);
  assert.equal(new Set(f.calls.writes.flatMap(write => write.ids)).size, 6);
});

test('unavailable required body uses the safe review fallback and later messages continue', () => {
  const f = fixture(19, {dryRun: false, confidence: 0.5, emptyBodyIds: ['1']}); let job = f.start();
  const events = [], results = [];
  for (let i = 0; i < 6 && job.status === 'running'; i++) {
    const batch = f.batch(job.id); job = batch.job; events.push(...batch.events); results.push(...batch.results);
  }
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 19);
  assert.equal(job.skipped, 0); assert.equal(job.failed, 0); assert.equal(job.target, 19);
  assert.equal(f.calls.model, 37); assert.equal(f.calls.full, 19); assert.equal(f.calls.writes.length, 1);
  assert.equal(f.calls.writes[0].ids.length, 19);
  assert.ok(f.calls.writes.some(request => request.ids.includes('1')));
  assert.ok(events.some(event => event.level === 'warn' && /safe “review” fallback/.test(event.message)));
  assert.ok(results.some(row => row.subject === 'Message 1' && row.action === 'review fallback applied'));
  assert.ok(Buffer.byteLength(f.data.get('JEV_CURRENT_JOB_V2')) <= 9000);
});

test('messages without content or a review fallback are skipped and count toward the limit', () => {
  const f = fixture(19, {dryRun: false, confidence: 0.5, emptyBodyIds: ['1'], limit: 10});
  f.options.rules = [{...f.rules[0], name: 'manual-check'}];
  let job = f.start();
  for (let i = 0; i < 4 && job.status === 'running'; i++) job = f.batch(job.id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.processed, 9);
  assert.equal(job.skipped, 1); assert.equal(job.target, 10); assert.equal(f.calls.writes.length, 1);
  assert.equal(f.calls.writes[0].ids.length, 9);
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

test('input token usage replaces the conservative cost estimate when provider cost is absent', () => {
  const f = fixture();
  const parsed = f.ctx.parseJevResponse_(response({answers: {label: {
    choice: 'L0', confidence: 1, probabilities: {L0: 1}
  }}, usage: {input_tokens: 1000, output_tokens: 20}}), f.rules, 0.5);
  assert.equal(parsed.ok, true);
  assert.equal(parsed.costSource, 'input_tokens');
  assert.equal(parsed.costUsd, 0.000042);
  assert.equal(parsed.inputTokens, 1000);
});

test('cost source totals distinguish provider reports from token calculations', () => {
  const f = fixture(1, {modelResponder() {
    return response({answers: {label: {choice: 'L0', confidence: 1, probabilities: {L0: 1}}},
      usage: {input_tokens: 1000}});
  }});
  const job = f.batch(f.start().id).job;
  assert.equal(job.spentUsd, 0.000042);
  assert.equal(job.reportedCostUsd, 0);
  assert.equal(job.tokenCalculatedCostUsd, 0.000042);
  assert.equal(job.estimatedCostUsd, 0);
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
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.state.email, 'cc'));
  assert.ok(!Object.prototype.hasOwnProperty.call(captured.state.email, 'reply_to'));
});

test('long message bodies keep useful head and tail context within the configured limit', () => {
  const f = fixture();
  const body = 'HEAD:' + 'a'.repeat(7000) + ':TAIL';
  const compact = f.ctx.compactMessageBody_(body);
  assert.ok(compact.length <= 5000);
  assert.match(compact, /^HEAD:/);
  assert.match(compact, /:TAIL$/);
  assert.match(compact, /Middle of long message omitted/);
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

test('the typed Jev choice remains authoritative when probability argmax differs', () => {
  const f = fixture();
  const rules = [f.rules[0], {...f.rules[0], id: 'second'}];
  const parsed = f.ctx.parseJevResponse_(response({answers: {label: {
    choice: 'L1', confidence: 0.2, probabilities: {L0: 0.55, L1: 0.45}
  }}}), rules, 0.01);
  assert.equal(parsed.ok, true); assert.equal(parsed.ruleId, 'second');
  assert.equal(parsed.choiceDiffersFromArgmax, true); assert.equal(parsed.probabilityArgmax, 'L0');
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
  assert.equal(f.calls.model, 7); assert.equal(f.calls.writes.length, 0);
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

test('image-heavy HTML preserves readable alt and title text', () => {
  const f = fixture(); const enc = s => Buffer.from(s).toString('base64url');
  const body = f.ctx.extractMessageText_({payload: {mimeType: 'text/html', body: {data: enc(
    '<html><body><img alt="Remove your background"><img title="Open editor"></body></html>'
  )}}});
  assert.equal(body, 'Remove your background Open editor');
});

test('Apps Script Byte[] Gmail bodies are decoded without a second base64 pass', () => {
  const f = fixture();
  const html = '<html><body><h1>Weekly Digest</h1><p>A small AI agent pattern I can reuse every Friday — письма.</p></body></html>';
  const bytes = [...Buffer.from(html)].map(value => value > 127 ? value - 256 : value);
  const extracted = f.ctx.extractMessageContent_({payload: {
    mimeType: 'text/html',
    headers: [{name: 'Content-Type', value: 'text/html; charset="UTF-8"'}],
    body: {data: bytes}
  }});
  assert.match(extracted.text, /Weekly Digest/);
  assert.match(extracted.text, /small AI agent pattern/);
  assert.match(extracted.text, /письма/);
  assert.equal(extracted.diagnostics.byteArrayParts, 1);
  assert.equal(extracted.diagnostics.decodeErrors, 0);
});

test('a low-confidence message with an Apps Script Byte[] HTML body reaches Jev full-content review', () => {
  let fullBody = '';
  const f = fixture(1, {modelResponder({payload}) {
    const isFull = payload.state.evidence_stage === 'full_body';
    if (isFull) fullBody = payload.state.email.body;
    const confidence = isFull ? 0.96 : 0.5;
    return response({answers: {label: {choice: 'L0', confidence, probabilities: {L0: 1}}}});
  }});
  const originalGet = f.ctx.Gmail.Users.Messages.get;
  f.ctx.Gmail.Users.Messages.get = (user, id, options) => {
    const message = originalGet(user, id, options);
    if (options.format === 'full') {
      const html = '<html><body><h1>Weekly Digest</h1><p>Three useful articles about AI automation.</p></body></html>';
      message.payload.mimeType = 'text/html';
      message.payload.headers.push({name: 'Content-Type', value: 'text/html; charset=UTF-8'});
      message.payload.body.data = [...Buffer.from(html)].map(value => value > 127 ? value - 256 : value);
    }
    return message;
  };
  const batch = f.batch(f.start().id);
  assert.equal(batch.job.status, 'completed');
  assert.equal(f.calls.full, 1);
  assert.equal(f.calls.model, 2);
  assert.ok(!batch.events.some(event => /Could not extract full text/.test(event.message)));
  assert.equal(batch.results[0].stage, 'full');
  assert.match(fullBody, /Weekly Digest/);
  assert.match(fullBody, /Three useful articles/);
});

test('MIME charset is honored for byte-array text bodies', () => {
  const f = fixture();
  const bytes = [...Buffer.from('Caf\xe9', 'latin1')].map(value => value > 127 ? value - 256 : value);
  const extracted = f.ctx.extractMessageContent_({payload: {
    mimeType: 'text/plain',
    headers: [{name: 'Content-Type', value: 'text/plain; charset=ISO-8859-1'}],
    body: {data: bytes}
  }});
  assert.equal(extracted.text, 'Café');
  assert.equal(extracted.diagnostics.decodedTextParts, 1);
});

test('decode failures are reported accurately instead of as empty visible HTML', () => {
  const f = fixture();
  const extracted = f.ctx.extractMessageContent_({payload: {
    mimeType: 'text/html',
    body: {data: {length: 1, 0: 'not-a-byte'}}
  }});
  assert.equal(extracted.text, '');
  assert.equal(extracted.reason, 'Gmail returned text body data, but it could not be decoded safely.');
  assert.equal(extracted.diagnostics.decodeErrors, 1);
  assert.equal(extracted.diagnostics.decodedHtmlParts, 0);
});

test('successfully decoded empty HTML keeps the precise empty-content reason', () => {
  const f = fixture(); const enc = s => Buffer.from(s).toString('base64url');
  const extracted = f.ctx.extractMessageContent_({payload: {
    mimeType: 'text/html',
    body: {data: enc('<html><head><style>.hidden{display:none}</style></head><body></body></html>')}
  }});
  assert.equal(extracted.text, '');
  assert.equal(extracted.reason, 'The HTML body decoded successfully but contained no readable visible text.');
  assert.equal(extracted.diagnostics.decodeErrors, 0);
  assert.equal(extracted.diagnostics.decodedHtmlParts, 1);
});

test('external Gmail text-part failures return safe MIME diagnostics instead of throwing', () => {
  const f = fixture();
  f.ctx.Gmail.Users.Messages.Attachments = {get() { throw new Error('Attachment temporarily unavailable'); }};
  const extracted = f.ctx.extractMessageContent_({id: '1', payload: {mimeType: 'multipart/alternative', parts: [
    {mimeType: 'text/html', body: {attachmentId: 'body'}}
  ]}});
  assert.equal(extracted.text, '');
  assert.equal(extracted.reason, 'An external Gmail text part could not be retrieved.');
  assert.equal(extracted.diagnostics.externalTextErrors, 1);
});

test('review fallback is never archived when full message text is unavailable', () => {
  const f = fixture(1, {dryRun: false, confidence: 0.5, emptyBody: true});
  f.options.mode = 'labels_archive';
  let job = f.start(); const first = f.batch(job.id); job = first.job;
  if (job.status === 'running') job = f.batch(job.id).job;
  assert.equal(job.status, 'completed'); assert.equal(job.archived, 0);
  assert.equal(first.results[0].action, 'review fallback applied');
  assert.ok(!f.calls.writes[0].removeLabelIds);
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
