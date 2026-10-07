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
  assert.deepEqual(carla?.clip, { status: 'installed', src: '/sounds/carla-song.mp3' });

  const aliviah = signinSongFor(ALIVIAH_SONG_EMAIL);
  assert.equal(aliviah?.title, 'Impostor Syndrome');
  assert.equal(aliviah?.artist, 'Sidney Gish');
  assert.deepEqual(aliviah?.clip, { status: 'installed', src: '/sounds/aliviah-song.mp3' });
});

test('table emails are lower-case and unique, and no two people share a clip', () => {
  const emails = SIGNIN_SONGS.map((s) => s.email);
  for (const e of emails) assert.equal(e, e.trim().toLowerCase());
  assert.equal(new Set(emails).size, emails.length);
  assert.equal(new Set(SIGNIN_SONGS.map((s) => s.clip.src)).size, SIGNIN_SONGS.length);
});

test('every listed cover art is committed', () => {
  for (const s of SIGNIN_SONGS) {
    assert.ok(fs.existsSync(path.join(PUBLIC, s.thumb)), `${s.thumb} missing`);
    if (s.thumbFallback) assert.ok(fs.existsSync(path.join(PUBLIC, s.thumbFallback)), `${s.thumbFallback} missing`);
  }
});

// A row's clip state must match the disk both ways. An installed clip that is
// missing is a pill over silence; a pending row whose cut was committed is a
// song nobody hears. Either fails here, not on someone's sign-in.
test('an installed clip is committed, and a pending one is not', () => {
  for (const s of SIGNIN_SONGS) {
    const present = fs.existsSync(path.join(PUBLIC, s.clip.src));
    if (s.clip.status === 'installed') assert.ok(present, `${s.email}: ${s.clip.src} is installed but missing`);
    else assert.ok(!present, `${s.email}: ${s.clip.src} exists — flip the row to installed`);
  }
});

// The served file is a ~40s CUT, never the full purchased track
// (docs/features/login-carla-song.md § The clips). Carla's cut is 961,861 bytes;
// a full track is 3–6MB.
test('an installed clip is a cut and not the full track', () => {
  for (const s of SIGNIN_SONGS) {
    if (s.clip.status !== 'installed') continue;
    const size = fs.statSync(path.join(PUBLIC, s.clip.src)).size;
    assert.ok(size <= 1_500_000, `${s.clip.src} is ${size} bytes, over 1.5MB — is it the full track?`);
  }
});
