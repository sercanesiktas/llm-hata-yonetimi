import { siniflandir, type Siniflandirma, type Yanit } from './siniflandir.js';

export class IsiDurdurHatasi extends Error {
  constructor(public readonly siniflandirma: Siniflandirma, public readonly yanit: Yanit) {
    super(`İş durduruldu (${siniflandirma.tur}): ${siniflandirma.sebep}`);
    this.name = 'IsiDurdurHatasi';
  }
}

export class DenemeHakkiBittiHatasi extends Error {
  constructor(public readonly siniflandirma: Siniflandirma, public readonly yanit: Yanit, public readonly deneme: number) {
    super(`${deneme} denemede başarısız (${siniflandirma.tur}): ${siniflandirma.sebep}`);
    this.name = 'DenemeHakkiBittiHatasi';
  }
}

export interface DeneSecenekleri {
  /** Toplam deneme sayısı, ilk istek dahil. Varsayılan 4. */
  maksDeneme?: number;
  /** Servis bekleme süresi vermezse üstel geri çekilmenin tabanı (ms). Varsayılan 500. */
  tabanMs?: number;
  /** Tek bir bekleme için üst sınır (ms). Varsayılan 30000. */
  azamiMs?: number;
  /** Bekleme fonksiyonu, testlerde sahtelenebilir. */
  uyku?: (ms: number) => Promise<void>;
  /** 0 ile 1 arası rastgele sayı, testlerde sabitlenebilir. Beklemeye yüzde 0-25 sapma ekler. */
  rastgele?: () => number;
  /** Her yeniden deneme öncesi çağrılır. */
  denemeOncesi?: (bilgi: { deneme: number; beklemeMs: number; siniflandirma: Siniflandirma }) => void;
}

const bekle = (ms: number): Promise<void> => new Promise((coz) => setTimeout(coz, ms));

/**
 * `islem` bir yanıt döner (HTTP durumu dahil). Başarılıysa (2xx) yanıtı verir. Hata ise sınıflandırır:
 * iş durmalıysa (kota, bakiye, yetki) `IsiDurdurHatasi` atar ve yeniden denemez, geçici hatalarda
 * bekleyip tekrar dener, deneme hakkı bitince `DenemeHakkiBittiHatasi` atar.
 * Düzeltilmeden tekrarlanmayacak hatalarda (`gecersiz`) yanıtı olduğu gibi döner, karar sende.
 */
export async function yenidenDene(islem: () => Promise<Yanit>, secenek: DeneSecenekleri = {}): Promise<Yanit> {
  const maks = secenek.maksDeneme ?? 4;
  const taban = secenek.tabanMs ?? 500;
  const azami = secenek.azamiMs ?? 30_000;
  const uyku = secenek.uyku ?? bekle;
  const rastgele = secenek.rastgele ?? Math.random;

  for (let deneme = 1; ; deneme++) {
    let yanit: Yanit;
    try {
      yanit = await islem();
    } catch {
      yanit = { status: 0 }; // bağlantı koptu, zaman aşımı
    }

    if (yanit.status >= 200 && yanit.status < 300) return yanit;

    const s = siniflandir(yanit);
    if (s.isiDurdur) throw new IsiDurdurHatasi(s, yanit);
    if (!s.yenidenDene) return yanit;
    if (deneme >= maks) throw new DenemeHakkiBittiHatasi(s, yanit, deneme);

    const geriCekilme = taban * 2 ** (deneme - 1);
    const hedef = s.beklemeMs ?? geriCekilme * (1 + 0.25 * rastgele());
    const beklemeMs = Math.min(hedef, azami);
    secenek.denemeOncesi?.({ deneme, beklemeMs, siniflandirma: s });
    await uyku(beklemeMs);
  }
}

/** fetch ile kullanmak için: Response'u Yanit biçimine çevirir. */
export async function fetchIleDene(url: string, init: RequestInit = {}, secenek: DeneSecenekleri = {}): Promise<Yanit> {
  return yenidenDene(async () => {
    const r = await fetch(url, init);
    const headers: Record<string, string> = {};
    r.headers.forEach((v, k) => { headers[k] = v; });
    return { status: r.status, headers, govde: await r.text() };
  }, secenek);
}
