import test from 'node:test';
import assert from 'node:assert/strict';
import { DevreKesici, DevreAcikHatasi, yenidenDene, DenemeHakkiBittiHatasi } from '../src/index.js';

const basarisiz = async (): Promise<never> => {
  throw new Error('hata');
};
const basarili = async (): Promise<string> => 'tamam';

function saat(baslangic = 1_000) {
  let t = baslangic;
  return { simdi: () => t, ilerle: (ms: number) => { t += ms; } };
}

test('eşiğe kadar hata geçer, eşikte devre açılır ve işlem hiç çağrılmaz', async () => {
  const k = new DevreKesici({ esik: 3, beklemeMs: 1000, simdi: saat().simdi });
  for (let i = 0; i < 3; i++) await assert.rejects(k.calistir(basarisiz), /hata/);
  assert.equal(k.durum, 'acik');
  let cagri = 0;
  await assert.rejects(k.calistir(async () => { cagri++; return 1; }), DevreAcikHatasi);
  assert.equal(cagri, 0);
});

test('başarılı çağrı hata sayacını sıfırlar', async () => {
  const k = new DevreKesici({ esik: 3, simdi: saat().simdi });
  await assert.rejects(k.calistir(basarisiz));
  await assert.rejects(k.calistir(basarisiz));
  assert.equal(await k.calistir(basarili), 'tamam');
  await assert.rejects(k.calistir(basarisiz));
  await assert.rejects(k.calistir(basarisiz));
  assert.equal(k.durum, 'kapali', 'sayaç sıfırlandığı için 2 hata devreyi açmamalı');
});

test('bekleme dolunca tek deneme geçer: başarılıysa devre kapanır', async () => {
  const s = saat();
  const k = new DevreKesici({ esik: 2, beklemeMs: 1000, simdi: s.simdi });
  await assert.rejects(k.calistir(basarisiz));
  await assert.rejects(k.calistir(basarisiz));
  s.ilerle(999);
  await assert.rejects(k.calistir(basarili), DevreAcikHatasi);
  s.ilerle(1);
  assert.equal(await k.calistir(basarili), 'tamam');
  assert.equal(k.durum, 'kapali');
});

test('yarı açık denemesi başarısız olursa devre hemen yeniden açılır', async () => {
  const s = saat();
  const k = new DevreKesici({ esik: 2, beklemeMs: 1000, simdi: s.simdi });
  await assert.rejects(k.calistir(basarisiz));
  await assert.rejects(k.calistir(basarisiz));
  s.ilerle(1000);
  await assert.rejects(k.calistir(basarisiz), /hata/);
  assert.equal(k.durum, 'acik');
  s.ilerle(500);
  await assert.rejects(k.calistir(basarili), DevreAcikHatasi);
});

test('yarı açıkken yalnızca bir deneme geçer, eşzamanlı diğerleri reddedilir', async () => {
  const s = saat();
  const k = new DevreKesici({ esik: 1, beklemeMs: 1000, simdi: s.simdi });
  await assert.rejects(k.calistir(basarisiz));
  s.ilerle(1000);
  let coz!: (v: string) => void;
  const ilk = k.calistir(() => new Promise<string>((r) => { coz = r; }));
  await assert.rejects(k.calistir(basarili), DevreAcikHatasi);
  assert.equal(k.durum, 'yari-acik');
  coz('bitti');
  assert.equal(await ilk, 'bitti');
  assert.equal(k.durum, 'kapali');
});

test('sayilsin: sayılmayan hata devreyi açmaz', async () => {
  const k = new DevreKesici({ esik: 2, simdi: saat().simdi, sayilsin: (h) => !(h instanceof TypeError) });
  for (let i = 0; i < 5; i++) await assert.rejects(k.calistir(async () => { throw new TypeError('istemci hatası'); }));
  assert.equal(k.durum, 'kapali');
});

test('durumDegisti her geçişi bildirir', async () => {
  const s = saat();
  const gecisler: string[] = [];
  const k = new DevreKesici({ esik: 1, beklemeMs: 100, simdi: s.simdi, durumDegisti: (y, e) => gecisler.push(`${e}>${y}`) });
  await assert.rejects(k.calistir(basarisiz));
  s.ilerle(100);
  await k.calistir(basarili);
  assert.deepEqual(gecisler, ['kapali>acik', 'acik>yari-acik', 'yari-acik>kapali']);
});

test('sifirla devreyi elle kapatır', async () => {
  const k = new DevreKesici({ esik: 1, simdi: saat().simdi });
  await assert.rejects(k.calistir(basarisiz));
  k.sifirla();
  assert.equal(await k.calistir(basarili), 'tamam');
});

test('esik 1den küçükse oluşturulamaz', () => {
  assert.throws(() => new DevreKesici({ esik: 0 }), RangeError);
});

test('yenidenDene ile: bir yenidenDene çağrısı tek hata sayılır', async () => {
  const k = new DevreKesici({ esik: 2, simdi: saat().simdi });
  const dene = () => k.calistir(() => yenidenDene(async () => ({ status: 503 }), { maksDeneme: 3, uyku: async () => {} }));
  await assert.rejects(dene(), DenemeHakkiBittiHatasi);
  assert.equal(k.durum, 'kapali', '3 deneme tek hata sayılmalı');
  await assert.rejects(dene(), DenemeHakkiBittiHatasi);
  assert.equal(k.durum, 'acik');
});
