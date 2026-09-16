import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suggestedWebhookFormat, webhookInput, webhookPayload, type WebhookBody } from './webhooks.js';

const body: WebhookBody = {
  type: 'wolf.notification',
  version: 1,
  id: '01J9ZQK7T0000000000000000N',
  occurredAt: '2026-09-16T10:00:00.000Z',
  notification: {
    kind: 'fired',
    severity: 'warning',
    title: 'Disk *almost* full',
    detail: 'C: at 97% <@everyone>',
    pc: { id: 'p', name: '@here Tower' },
  },
};

test('the format a URL suggests follows its host, and nothing else', () => {
  assert.equal(suggestedWebhookFormat('https://hooks.slack.com/services/T/B/x'), 'slack');
  assert.equal(suggestedWebhookFormat('https://discord.com/api/webhooks/1/x'), 'discord');
  assert.equal(suggestedWebhookFormat('https://discordapp.com/api/webhooks/1/x'), 'discord');
  assert.equal(suggestedWebhookFormat('https://hooks.slack.com.evil.example/x'), 'wolf');
  assert.equal(suggestedWebhookFormat('https://ha.example.com/api/webhook/x'), 'wolf');
  assert.equal(suggestedWebhookFormat('not a url'), 'wolf');
  assert.equal(webhookInput.parse({ name: 'x', url: 'https://ha.example.com/x' }).format, 'wolf');
});

test('WOLF format is the body itself; Slack and Discord get one escaped message that cannot mention anybody', () => {
  assert.equal(webhookPayload('wolf', body), body);

  const slack = webhookPayload('slack', body) as { text: string };
  assert.equal(slack.text, String.raw`*[WARNING] Disk \*almost\* full*` + '\n' + String.raw`C: at 97% \<\@everyone\>` + '\n' + String.raw`PC: \@here Tower`);

  const discord = webhookPayload('discord', body) as { content: string; allowed_mentions: unknown };
  assert.ok(discord.content.startsWith(String.raw`**[WARNING] Disk \*almost\* full**`));
  assert.deepEqual(discord.allowed_mentions, { parse: [] });

  const long = webhookPayload('discord', { ...body, notification: { ...body.notification, detail: 'x'.repeat(5000) } }) as {
    content: string;
  };
  assert.equal(long.content.length, 2000);
});
