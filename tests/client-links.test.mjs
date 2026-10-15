import test from 'node:test';
import assert from 'node:assert/strict';

import { configureExternalLink } from '../src/client-links.mjs';

test('configureExternalLink points to a URL in a new tab safely', () => {
  const attributes = {};
  const element = {
    textContent: '',
    setAttribute(name, value) {
      attributes[name] = value;
    },
  };

  configureExternalLink(element, 'https://api.example.test');

  assert.equal(element.textContent, 'https://api.example.test');
  assert.equal(attributes.href, 'https://api.example.test');
  assert.equal(attributes.target, '_blank');
  assert.equal(attributes.rel, 'noopener noreferrer');
});
