export class DevreAcikHatasi extends Error {
  constructor(public readonly kalanMs: number) {
    super(`Devre açık: art arda çok fazla hata alındı, ${Math.ceil(kalanMs / 1000)} saniye sonra yeniden denenecek.`);
    this.name = 'DevreAcikHatasi';
  }
}

export type DevreDurumu = 'kapali' | 'acik' | 'yari-acik';

export interface DevreKesiciSecenekleri {
  /** Devreyi açan art arda hata sayısı. Varsayılan 5. */
  esik?: number;
  /** Devre açıldıktan sonra yeni bir deneme izni verilene kadar geçecek süre (ms). Varsayılan 30000. */
  beklemeMs?: number;
  /** Bir hatanın sayılıp sayılmayacağına karar verir. Varsayılan: her hata sayılır. */
  sayilsin?: (hata: unknown) => boolean;
  /** Saat, testlerde sahtelenebilir. */
  simdi?: () => number;
  /** Durum değiştiğinde çağrılır, günlük için. */
  durumDegisti?: (yeni: DevreDurumu, eski: DevreDurumu) => void;
}

/**
 * Art arda `esik` kadar hata alınınca devreyi açar ve bir süre `islem`i hiç çağırmadan
 * `DevreAcikHatasi` atar. Süre dolunca tek bir deneme izni verilir (yarı açık): başarılı olursa devre
 * kapanır, başarısız olursa yeniden açılır. Başarılı her çağrı hata sayacını sıfırlar.
 *
 * `yenidenDene` ile birlikte kullanırken `yenidenDene`yi kesicinin içine koy: bir `yenidenDene`
 * çağrısı, kaç deneme yaptığından bağımsız olarak tek bir başarı ya da hata sayılır.
 */
export class DevreKesici {
  private readonly esik: number;
  private readonly beklemeMs: number;
  private readonly sayilsin: (hata: unknown) => boolean;
  private readonly simdi: () => number;
  private readonly durumDegisti?: (yeni: DevreDurumu, eski: DevreDurumu) => void;
  private hatalar = 0;
  private acilma = 0;
  private _durum: DevreDurumu = 'kapali';
  private denemeVar = false;

  constructor(secenek: DevreKesiciSecenekleri = {}) {
    this.esik = secenek.esik ?? 5;
    this.beklemeMs = secenek.beklemeMs ?? 30_000;
    this.sayilsin = secenek.sayilsin ?? (() => true);
    this.simdi = secenek.simdi ?? Date.now;
    this.durumDegisti = secenek.durumDegisti;
    if (!(this.esik >= 1)) throw new RangeError('esik 1 ya da daha büyük olmalı');
  }

  get durum(): DevreDurumu {
    return this._durum;
  }

  private degistir(yeni: DevreDurumu): void {
    if (yeni === this._durum) return;
    const eski = this._durum;
    this._durum = yeni;
    this.durumDegisti?.(yeni, eski);
  }

  async calistir<T>(islem: () => Promise<T>): Promise<T> {
    if (this._durum === 'acik') {
      const kalan = this.acilma + this.beklemeMs - this.simdi();
      if (kalan > 0) throw new DevreAcikHatasi(kalan);
      this.degistir('yari-acik');
    }
    if (this._durum === 'yari-acik') {
      // yarı açıkken yalnızca bir deneme geçer, diğerleri beklemeye devam eder
      if (this.denemeVar) throw new DevreAcikHatasi(this.beklemeMs);
      this.denemeVar = true;
    }

    try {
      const sonuc = await islem();
      this.hatalar = 0;
      this.denemeVar = false;
      this.degistir('kapali');
      return sonuc;
    } catch (hata) {
      const yariAcikti = this._durum === 'yari-acik';
      this.denemeVar = false;
      if (this.sayilsin(hata)) {
        this.hatalar++;
        if (yariAcikti || this.hatalar >= this.esik) {
          this.acilma = this.simdi();
          this.degistir('acik');
        }
      } else if (yariAcikti) {
        // sayılmayan bir hata devreyi kapatmaz ama deneme hakkını da kilitlemez
        this.acilma = this.simdi() - this.beklemeMs;
        this.degistir('acik');
      }
      throw hata;
    }
  }

  /** Devreyi elle kapatır ve sayacı sıfırlar. */
  sifirla(): void {
    this.hatalar = 0;
    this.denemeVar = false;
    this.degistir('kapali');
  }
}
