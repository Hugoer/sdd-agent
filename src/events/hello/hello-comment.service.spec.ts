import { describe, expect, it } from 'vitest';
import { helloCommentBody } from './hello-comment.service.js';

describe('helloCommentBody', () => {
  it('is the fixed text naming the delivery', () => {
    expect(helloCommentBody('abc-123')).toBe(
      '👋 Hello from the GitHub AI Agent (walking skeleton). Webhook round trip OK — delivery `abc-123`.',
    );
  });
});
