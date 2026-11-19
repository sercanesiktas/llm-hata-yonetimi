import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { yenidenDene, fetchIleDene, IsiDurdurHatasi, DenemeHakkiBittiHatasi, type Yanit } from '../src/index.js';

function dizi(...yanitlar: Yanit[]) {
  const sayac = { cagri: 0 };
  return { sayac, islem: async () => yanitlar[Math.min(sayac.cagri++, yanitlar.length - 1)] };
}

function sahteUyku() {
  const beklemeler: number[] = [];
  return { beklemeler, uyku: async (ms: number) => { beklemeler.push(ms); } };
}

test('ilk denemede başarılıysa bekleme yok', async () => {
  const { islem, sayac } = dizi({ status: 200, govde: 'ok' });
  const u = sahteUyku();
  const y = await yenidenDene(islem, { uyku: u.uyku });
  assert.equal(y.status, 200);
  assert.equal(sayac.cagri, 1);
  assert.deepEqual(u.beklemeler, []);
});

test('hız sınırı: Retry-After kadar bekleyip yeniden dener', async () => {
  const { islem, sayac } = dizi(
    { status: 429, headers: { 'retry-after': '2' } },
    { status: 429, headers: { 'retry-after': '3' } },
    { status: 200 },
  );
  const u = sahteUyku();
  const y = await yenidenDene(islem, { uyku: u.uyku });
  assert.equal(y.status, 200);
  assert.equal(sayac.cagri, 3);
  assert.deepEqual(u.beklemeler, [2000, 3000]);
});

test('kota bitince tek istek atıp durur, tekrar denemez', async () => {
  const { islem, sayac } = dizi({ status: 429, govde: 'You exceeded your current quota' });
  const u = sahteUyku();
  await assert.rejects(() => yenidenDene(islem, { uyku: u.uyku }), (e: unknown) => {
    assert.ok(e instanceof IsiDurdurHatasi);
    assert.equal(e.siniflandirma.tur, 'kota');
    return true;
  });
  assert.equal(sayac.cagri, 1);
  assert.deepEqual(u.beklemeler, []);
});

test('bakiye bitince (402) tek istek atıp durur', async () => {
  const { islem, sayac } = dizi({ status: 402, govde: 'Insufficient balance' });
  await assert.rejects(() => yenidenDene(islem), IsiDurdurHatasi);
  assert.equal(sayac.cagri, 1);
});

test('yetki hatasında durur', async () => {
  const { islem, sayac } = dizi({ status: 401 });
  await assert.rejects(() => yenidenDene(islem), IsiDurdurHatasi);
  assert.equal(sayac.cagri, 1);
});

test('geçersiz istekte yanıtı olduğu gibi döner, yeniden denemez', async () => {
  const { islem, sayac } = dizi({ status: 400, govde: 'prompt too long' });
  const y = await yenidenDene(islem);
  assert.equal(y.status, 400);
  assert.equal(sayac.cagri, 1);
});

test('sunucu hatası: üstel geri çekilme, deneme hakkı bitince hata', async () => {
  const { islem, sayac } = dizi({ status: 503 });
  const u = sahteUyku();
  await assert.rejects(
    () => yenidenDene(islem, { maksDeneme: 4, tabanMs: 500, rastgele: () => 0, uyku: u.uyku }),
    (e: unknown) => e instanceof DenemeHakkiBittiHatasi && e.deneme === 4,
  );
  assert.equal(sayac.cagri, 4);
  assert.deepEqual(u.beklemeler, [500, 1000, 2000]);
});

test('azamiMs bekleme süresini sınırlar', async () => {
  const { islem } = dizi({ status: 429, headers: { 'retry-after': '120' } }, { status: 200 });
  const u = sahteUyku();
  await yenidenDene(islem, { azamiMs: 5000, uyku: u.uyku });
  assert.deepEqual(u.beklemeler, [5000]);
});

test('jitter beklemeye yüzde 25 e kadar ekler', async () => {
  const { islem } = dizi({ status: 503 }, { status: 200 });
  const u = sahteUyku();
  await yenidenDene(islem, { tabanMs: 1000, rastgele: () => 1, uyku: u.uyku });
  assert.deepEqual(u.beklemeler, [1250]);
});

test('islem fırlatırsa ağ hatası sayılır ve yeniden denenir', async () => {
  let n = 0;
  const u = sahteUyku();
  const y = await yenidenDene(async () => {
    if (n++ === 0) throw new Error('ECONNRESET');
    return { status: 200 };
  }, { uyku: u.uyku, rastgele: () => 0 });
  assert.equal(y.status, 200);
  assert.equal(n, 2);
});

test('denemeOncesi geri çağrısı bilgi alır', async () => {
  const { islem } = dizi({ status: 503 }, { status: 200 });
  const bilgiler: { deneme: number; beklemeMs: number; tur: string }[] = [];
  await yenidenDene(islem, {
    uyku: async () => {}, rastgele: () => 0, tabanMs: 100,
    denemeOncesi: (b) => bilgiler.push({ deneme: b.deneme, beklemeMs: b.beklemeMs, tur: b.siniflandirma.tur }),
  });
  assert.deepEqual(bilgiler, [{ deneme: 1, beklemeMs: 100, tur: 'gecici' }]);
});

test('toplu iş: kota görülünce bir sonraki istekler hiç atılmaz', async () => {
  // hayalai notlarındaki hata: bütün sağlayıcılar kapalıyken iş binlerce prompt için aynı isteği tekrarladı
  let cagri = 0;
  const islem = async (): Promise<Yanit> => { cagri++; return { status: 429, govde: 'exceeded your current quota' }; };
  let islenen = 0;
  try {
    for (let i = 0; i < 1000; i++) {
      await yenidenDene(islem, { uyku: async () => {} });
      islenen++;
    }
  } catch (e) {
    assert.ok(e instanceof IsiDurdurHatasi);
  }
  assert.equal(islenen, 0);
  assert.equal(cagri, 1);
});

// --- gerçek HTTP sunucusuna karşı fetch ---------------------------------------------------------------
async function sunucu(yanitlar: { status: number; headers?: Record<string, string>; govde?: string }[]) {
  let istek = 0;
  const s = createServer((_req, res) => {
    const y = yanitlar[Math.min(istek++, yanitlar.length - 1)];
    res.writeHead(y.status, y.headers);
    res.end(y.govde ?? '');
  });
  await new Promise<void>((coz) => s.listen(0, '127.0.0.1', coz));
  const port = (s.address() as AddressInfo).port;
  return { url: `http://127.0.0.1:${port}/`, istekSayisi: () => istek, kapat: () => new Promise<void>((c) => s.close(() => c())) };
}

test('fetch: 429 sonra 200', async () => {
  const s = await sunucu([{ status: 429, headers: { 'retry-after': '0' }, govde: 'Too many requests' }, { status: 200, govde: 'tamam' }]);
  try {
    const y = await fetchIleDene(s.url, {}, { uyku: async () => {} });
    assert.equal(y.status, 200);
    assert.equal(y.govde, 'tamam');
    assert.equal(s.istekSayisi(), 2);
  } finally { await s.kapat(); }
});

test('fetch: 402 iş durdurur, sunucuya tek istek gider', async () => {
  const s = await sunucu([{ status: 402, govde: 'Insufficient balance' }]);
  try {
    await assert.rejects(() => fetchIleDene(s.url, {}, { uyku: async () => {} }), IsiDurdurHatasi);
    assert.equal(s.istekSayisi(), 1);
  } finally { await s.kapat(); }
});

test('fetch: sunucu kapalıysa ağ hatası olarak yeniden dener ve vazgeçer', async () => {
  const s = await sunucu([{ status: 200 }]);
  const url = s.url;
  await s.kapat();
  await assert.rejects(
    () => fetchIleDene(url, {}, { maksDeneme: 2, uyku: async () => {}, rastgele: () => 0 }),
    DenemeHakkiBittiHatasi,
  );
});
