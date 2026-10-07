import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ALIVIAH_SONG_EMAIL, CARLA_SONG_EMAIL, SIGNIN_SONGS, signinSongFor } from './carla-song';

const PUBLIC = path.join(process.cwd(), 'public');

test('the gate is the literal email — trimmed and case-folded, nothing looser', () => {
  assert.equal(signinSongFor('carla@simple.biz')?.email, CARLA_SONG_EMAIL);
  assert.equal(signinSongFor('  Carla@Simple.biz ')?.email, CARLA_SONG_EMAIL);
  assert.equal(signinSongFor('aliviah@simple.biz')?.email, ALIVIAH_SONG_EMAIL);
  assert.equal(signinSongFor(' ALIVIAH@simple.biz')?.email, ALIVIAH_SONG_EMAIL);
  assert.equal(signinSongFor('carlat@simple.biz'), null);
  assert.equal(signinSongFor('aliviahr@simple.biz'), null);
  assert.equal(signinSongFor('aliviah@simple.biz.'), null);
  assert.equal(signinSongFor('kaner@simple.biz'), null);
  assert.equal(signinSongFor(''), null);
  assert.equal(signinSongFor(null), null);
  assert.equal(signinSongFor(undefined), null);
});

test('each person has their own song', () => {
  const carla = signinSongFor(CARLA_SONG_EMAIL);
  assert.equal(carla?.title, "I Can't Stop The Loneliness");
  assert.equal(carla?.artist, 'Anri');
  assert.equal(carla?.src, '/sounds/carla-song.mp3');

  const aliviah = signinSongFor(ALIVIAH_SONG_EMAIL);
  assert.equal(aliviah?.title, 'Impostor Syndrome');
  assert.equal(aliviah?.artist, 'Sidney Gish');
  assert.equal(aliviah?.src, '/sounds/aliviah-song.mp3');
});

test('table emails are lower-case and unique, and no two people share a clip', () => {
  const emails = SIGNIN_SONGS.map((s) => s.email);
  for (const e of emails) assert.equal(e, e.trim().toLowerCase());
  assert.equal(new Set(emails).size, emails.length);
  assert.equal(new Set(SIGNIN_SONGS.map((s) => s.src)).size, SIGNIN_SONGS.length);
});

test('every listed cover art is committed', () => {
  for (const s of SIGNIN_SONGS) {
    assert.ok(fs.existsSync(path.join(PUBLIC, s.thumb)), `${s.thumb} missing`);
    if (s.thumbFallback) assert.ok(fs.existsSync(path.join(PUBLIC, s.thumbFallback)), `${s.thumbFallback} missing`);
  }
});

// The served file is a ~40s CUT, never the full purchased track
// (docs/features/login-carla-song.md § The clip). Carla's cut is 961,861 bytes;
// a full track is 3–6MB. A missing file is allowed — the player stands down.
test('a served clip, when present, is a cut and not the full track', () => {
  for (const s of SIGNIN_SONGS) {
    const file = path.join(PUBLIC, s.src);
    if (!fs.existsSync(file)) continue;
    assert.ok(fs.statSync(file).size <= 1_500_000, `${s.src} is over 1.5MB — is it the full track?`);
  }
});
