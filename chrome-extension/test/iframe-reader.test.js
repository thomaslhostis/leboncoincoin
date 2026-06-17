'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { loadIframeReader, fakeDoc, fakeWindow } = require('./helpers');

test('iframe-reader : onglet réel avec __NEXT_DATA__ → LBC_ACCESSIBLE', () => {
  const { calls } = loadIframeReader({ window: fakeWindow(true), document: fakeDoc({ nextData: { props: {} } }) });
  assert.equal(calls.sendMessage.length, 1);
  assert.equal(calls.sendMessage[0].type, 'LBC_ACCESSIBLE');
});

test('iframe-reader : onglet réel sans __NEXT_DATA__ (page de challenge) → aucun message', () => {
  const { calls } = loadIframeReader({ window: fakeWindow(true), document: fakeDoc({}) });
  assert.equal(calls.sendMessage.length, 0);
});

test('iframe-reader : sous-cadre sans __NEXT_DATA__ → LBC_IFRAME_RESULT challenge:true', () => {
  const { calls } = loadIframeReader({ window: fakeWindow(false), document: fakeDoc({}) });
  assert.equal(calls.sendMessage.length, 1);
  const msg = calls.sendMessage[0];
  assert.equal(msg.type, 'LBC_IFRAME_RESULT');
  assert.equal(msg.ok, false);
  assert.equal(msg.challenge, true);
});

test('iframe-reader : sous-cadre avec annonces → LBC_IFRAME_RESULT ok + data', () => {
  const doc = fakeDoc({ nextData: { props: { pageProps: { searchData: { ads: [
    { list_id: 5, url: '/a/5', subject: 'X', price: [10] },
  ] } } } } });
  const { calls } = loadIframeReader({ window: fakeWindow(false), document: doc });
  assert.equal(calls.sendMessage.length, 1);
  const msg = calls.sendMessage[0];
  assert.equal(msg.type, 'LBC_IFRAME_RESULT');
  assert.equal(msg.ok, true);
  assert.equal(msg.data[0].id, '5');
});
