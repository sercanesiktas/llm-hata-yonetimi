export type HataTuru =
  | 'hiz' // çok hızlı istek: biraz bekleyip aynı isteği tekrar dene
  | 'kota' // günlük ya da dönemlik hak bitti: beklemek saatler sürer
  | 'bakiye' // ödeme ya da bakiye bitti
  | 'yetki' // anahtar geçersiz ya da yetkisiz
  | 'gecici' // sunucu ya da ağ hatası: bekleyip tekrar dene
  | 'gecersiz' // istek hatalı: aynı istek hep aynı hatayı verir
  | 'diger';

export interface Yanit {
  /** HTTP durum kodu. Ağ hatası (bağlantı koptu, zaman aşımı) için 0 ver. */
  status: number;
  headers?: Record<string, string | undefined>;
  /** Yanıt gövdesi: metin ya da çözülmüş JSON. */
  govde?: unknown;
}

export interface Siniflandirma {
  tur: HataTuru;
  /** Aynı isteği bir süre sonra tekrar denemek anlamlı mı. */
  yenidenDene: boolean;
  /** Bütün iş durmalı mı: sıradaki istekler de aynı duvara çarpacak. */
  isiDurdur: boolean;
  /** Tavsiye edilen bekleme (ms). Servis bildirdiyse o değer. */
  beklemeMs?: number;
  sebep: string;
}

const KOTA = /exceed(?:ed)?\s+(?:your\s+)?(?:current\s+)?quota|quota\s+(?:exceeded|exhausted)|daily\s+(?:limit|quota|free)|neurons?|resets?\s+(?:daily|at|every)|billing|free\s+tier|out of (?:credits|quota)/i;
const BAKIYE = /insufficient\s+(?:balance|funds|credits?)|payment\s+required|out of credits|credit balance|no\s+credits?/i;
const HIZ = /queue\s+full|already\s+queued|too\s+many\s+requests|rate\s*limit|slow\s+down|requests?\s+per\s+(?:second|minute)|try\s+again\s+(?:in|later)/i;

function metneCevir(govde: unknown): string {
  if (govde === undefined || govde === null) return '';
  if (typeof govde === 'string') return govde;
  try {
    return JSON.stringify(govde);
  } catch {
    return String(govde);
  }
}

/** Retry-After başlığını ms'ye çevirir. Saniye sayısı ya da HTTP tarihi olabilir. */
export function retryAfterMs(deger: string | undefined, simdi: number = Date.now()): number | undefined {
  if (!deger) return undefined;
  const t = deger.trim();
  if (/^\d+(\.\d+)?$/.test(t)) return Math.round(Number(t) * 1000);
  const tarih = Date.parse(t);
  return Number.isNaN(tarih) ? undefined : Math.max(0, tarih - simdi);
}

function baslik(headers: Yanit['headers'], ad: string): string | undefined {
  if (!headers) return undefined;
  const anahtar = Object.keys(headers).find((k) => k.toLowerCase() === ad);
  return anahtar ? headers[anahtar] : undefined;
}

export function siniflandir(yanit: Yanit, simdi: number = Date.now()): Siniflandirma {
  const { status } = yanit;
  const metin = metneCevir(yanit.govde);
  const bekle = retryAfterMs(baslik(yanit.headers, 'retry-after'), simdi);

  if (status >= 200 && status < 300) {
    return { tur: 'diger', yenidenDene: false, isiDurdur: false, sebep: 'Başarılı yanıt, hata değil.' };
  }
  if (status === 402 || (status === 429 && BAKIYE.test(metin))) {
    return { tur: 'bakiye', yenidenDene: false, isiDurdur: true, sebep: 'Bakiye ya da ödeme bitti. Beklemek bir şey değiştirmez.' };
  }
  if (status === 429) {
    // kota ifadesi hız ifadesinden önce bakılır: "exceeded your current quota" aynı zamanda 429 döner
    if (KOTA.test(metin)) {
      return { tur: 'kota', yenidenDene: false, isiDurdur: true, sebep: 'Kota bitti. Hak yenilenene kadar sıradaki istekler de reddedilir.' };
    }
    if (HIZ.test(metin) || bekle !== undefined) {
      return { tur: 'hiz', yenidenDene: true, isiDurdur: false, beklemeMs: bekle, sebep: 'Hız sınırı. Biraz bekleyip yeniden dene.' };
    }
    return { tur: 'hiz', yenidenDene: true, isiDurdur: false, sebep: '429 ama nedeni belli değil, hız sınırı varsayıldı. Sınırlı sayıda yeniden dene.' };
  }
  if (status === 401 || status === 403) {
    return { tur: 'yetki', yenidenDene: false, isiDurdur: true, sebep: 'Anahtar geçersiz ya da yetkisiz. Her istek aynı hatayı verir.' };
  }
  if (status === 0 || status === 408 || status === 409 || status === 425 || (status >= 500 && status <= 599)) {
    return { tur: 'gecici', yenidenDene: true, isiDurdur: false, beklemeMs: bekle, sebep: status === 0 ? 'Ağ hatası ya da zaman aşımı.' : `Sunucu tarafı geçici hata (${status}).` };
  }
  if (status === 400 || status === 404 || status === 413 || status === 422) {
    return { tur: 'gecersiz', yenidenDene: false, isiDurdur: false, sebep: `İstek reddedildi (${status}). Aynı istek aynı sonucu verir, düzeltmeden tekrar deneme.` };
  }
  return { tur: 'diger', yenidenDene: false, isiDurdur: false, sebep: `Beklenmeyen durum kodu (${status}).` };
}
