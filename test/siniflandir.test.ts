import test from 'node:test';
import assert from 'node:assert/strict';
import { siniflandir, retryAfterMs } from '../src/index.js';

// Yanıt metinlerinin bir kısmı HayalAI sağlayıcı notlarındaki gözlemlerdir
// (Pollinations 402/429, Gemini 429). Cloudflare örneği aynı davranışı anlatan örnek metindir.
const tablo: { ad: string; yanit: Parameters<typeof siniflandir>[0]; tur: string; dene: boolean; durdur: boolean }[] = [
  { ad: 'Pollinations 402 bakiye', yanit: { status: 402, govde: 'Insufficient balance' }, tur: 'bakiye', dene: false, durdur: true },
  { ad: 'Pollinations 429 kuyruk', yanit: { status: 429, govde: 'Queue full for IP: 1 requests already queued (max: 1)' }, tur: 'hiz', dene: true, durdur: false },
  { ad: 'Gemini 429 kota', yanit: { status: 429, govde: { error: { message: 'You exceeded your current quota, please check your plan and billing details.' } } }, tur: 'kota', dene: false, durdur: true },
  { ad: 'Cloudflare 429 günlük hak (örnek metin)', yanit: { status: 429, govde: 'daily free allocation of 10,000 neurons exceeded, resets at 00:00 UTC' }, tur: 'kota', dene: false, durdur: true },
  { ad: '429 + Retry-After', yanit: { status: 429, headers: { 'Retry-After': '7' } }, tur: 'hiz', dene: true, durdur: false },
  { ad: '429 nedeni belli değil', yanit: { status: 429 }, tur: 'hiz', dene: true, durdur: false },
  { ad: '429 gövdede bakiye', yanit: { status: 429, govde: 'You have insufficient credits' }, tur: 'bakiye', dene: false, durdur: true },
  { ad: '401', yanit: { status: 401 }, tur: 'yetki', dene: false, durdur: true },
  { ad: '403', yanit: { status: 403 }, tur: 'yetki', dene: false, durdur: true },
  { ad: '500', yanit: { status: 500 }, tur: 'gecici', dene: true, durdur: false },
  { ad: '503', yanit: { status: 503 }, tur: 'gecici', dene: true, durdur: false },
  { ad: 'ağ hatası', yanit: { status: 0 }, tur: 'gecici', dene: true, durdur: false },
  { ad: '408 zaman aşımı', yanit: { status: 408 }, tur: 'gecici', dene: true, durdur: false },
  { ad: '400', yanit: { status: 400, govde: 'prompt too long' }, tur: 'gecersiz', dene: false, durdur: false },
  { ad: '422', yanit: { status: 422 }, tur: 'gecersiz', dene: false, durdur: false },
  { ad: '418 bilinmeyen', yanit: { status: 418 }, tur: 'diger', dene: false, durdur: false },
];

for (const s of tablo) {
  test(`sınıflandır: ${s.ad}`, () => {
    const r = siniflandir(s.yanit);
    assert.equal(r.tur, s.tur);
    assert.equal(r.yenidenDene, s.dene);
    assert.equal(r.isiDurdur, s.durdur);
    assert.ok(r.sebep.length > 0);
  });
}

test('Retry-After değeri bekleme olarak döner, başlık adı büyük/küçük harfe duyarsız', () => {
  assert.equal(siniflandir({ status: 429, headers: { 'retry-after': '7' } }).beklemeMs, 7000);
  assert.equal(siniflandir({ status: 429, headers: { 'Retry-After': '2' } }).beklemeMs, 2000);
  assert.equal(siniflandir({ status: 503, headers: { 'Retry-After': '1' } }).beklemeMs, 1000);
});

test('kota ifadesi hız ifadesinden önce gelir', () => {
  const r = siniflandir({ status: 429, govde: 'Too many requests: you exceeded your current quota' });
  assert.equal(r.tur, 'kota');
});

test('başarılı yanıt hata sayılmaz', () => {
  const r = siniflandir({ status: 200 });
  assert.equal(r.yenidenDene, false);
  assert.equal(r.isiDurdur, false);
});

test('retryAfterMs: saniye, tarih, geçersiz', () => {
  const simdi = Date.parse('2026-01-01T00:00:00Z');
  assert.equal(retryAfterMs('120', simdi), 120_000);
  assert.equal(retryAfterMs('1.5', simdi), 1500);
  assert.equal(retryAfterMs('Thu, 01 Jan 2026 00:00:30 GMT', simdi), 30_000);
  assert.equal(retryAfterMs('Wed, 31 Dec 2025 00:00:00 GMT', simdi), 0);
  assert.equal(retryAfterMs('yarın', simdi), undefined);
  assert.equal(retryAfterMs(undefined, simdi), undefined);
});

test('gövde dairesel nesne olsa da çökmez', () => {
  const g: Record<string, unknown> = {};
  g.kendisi = g;
  assert.doesNotThrow(() => siniflandir({ status: 429, govde: g }));
});
