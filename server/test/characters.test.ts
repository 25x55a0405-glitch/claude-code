import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import type { Settings, StarView } from '../src/types.ts';
import { startServer, type TestServer } from './helpers.ts';

let s: TestServer;
before(async () => { s = await startServer(); });
after(async () => { await s.close(); });

const NEW = ['star', 'sparkle', 'nova', 'comet'];

test('every new character saves in settings and on a Star, and a bad name is still refused', async () => {
  for (const character of NEW) {
    const set = await s.call<Settings>('PATCH', '/settings', { avatar: { character, color: 'sun' } });
    assert.equal(set.status, 200, character);
    assert.equal(set.body.avatar.character, character);
    assert.equal((await s.call<Settings>('GET', '/settings')).body.avatar.character, character);

    const made = await s.call<StarView>('POST', '/stars', { name: `S-${character}`, role: 'Tests', avatar: { character, color: 'mint' } });
    assert.equal(made.status, 200, character);
    assert.equal(made.body.avatar.character, character);
  }
  const badSettings = await s.call('PATCH', '/settings', { avatar: { character: 'dragon', color: 'sun' } });
  assert.equal(badSettings.status, 400);
  const badStar = await s.call('POST', '/stars', { name: 'Odd', role: 'Tests', avatar: { character: 'dragon', color: 'mint' } });
  assert.equal(badStar.status, 400);
});

test('templates keep the new characters, and an unknown one falls back to the default', async () => {
  const tpl = (character: string) => ({ format: 'sky.star', version: 1, name: `T-${character}`, role: 'Tests', avatar: { character, color: 'lilac' } });
  for (const character of NEW) {
    const out = await s.call<{ star: StarView }>('POST', '/templates/import', { template: tpl(character) });
    assert.equal(out.status, 200, character);
    assert.equal(out.body.star.avatar.character, character);
  }
  const odd = await s.call<{ star: StarView }>('POST', '/templates/import', { template: tpl('dragon') });
  assert.equal(odd.body.star.avatar.character, 'dot');
});
