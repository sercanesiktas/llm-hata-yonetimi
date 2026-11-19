# llm-hata-yonetimi

Yapay zeka API'lerinden gelen hataları sınıflandıran ve buna göre yeniden deneyen ya da işi durduran küçük bir kütüphane. TypeScript ile yazılmıştır, çalışma zamanı bağımlılığı yoktur.

Her hata aynı tepkiyi hak etmez. Hız sınırında biraz bekleyip aynı isteği yeniden denemek doğrudur. Kota ya da bakiye bittiğinde ise sıradaki istek de aynı duvara çarpar, yeniden denemek ya da bir sonraki sağlayıcıya geçmek bir şey değiştirmez. Bu kütüphane aradaki farkı kodlar.

## Neden

Toplu çalışan bir işte üç hata sık görülür ve her biri ayrı bir tepki ister:

- **402 bakiye bitti.** Anahtar kelime listesinde yalnızca `429` olan bir "kota bitti" kuralı bu hatayı hiç yakalamaz. İş, her prompt için aynı hataya çarparak gece boyu çalışır.
- **429 hız sınırı.** `Queue full for IP: 1 requests already queued (max: 1)` gibi bir yanıt kota değil eşzamanlılık sınırıdır. İstekler arasına birkaç saniye koymak yeter, sağlayıcıyı kapatmak gerekmez.
- **429 kota.** `You exceeded your current quota` aynı durum kodunu taşır ama bu kez beklemek saatler sürer. Burada işi durdurmak doğrudur.

Bunlar [HayalAI sağlayıcı notlarında](https://github.com/sercanesiktas/hayalai/blob/main/SAGLAYICI-NOTLARI.md) gerçek servislerde gözlenmiş davranışlar olarak anlatılıyor. Kural şu soruya dayanır: sıradakini denemek bir şey değiştirir mi?

## Kurulum

Paket henüz npm'e yayımlanmamıştır.

```bash
git clone https://github.com/sercanesiktas/llm-hata-yonetimi.git
cd llm-hata-yonetimi
npm install
npm run build
```

Node.js 18 veya üzeri gerekir (`fetch` için).

## Kullanım

### Sınıflandırma

```ts
import { siniflandir } from 'llm-hata-yonetimi';

siniflandir({ status: 402, govde: 'Insufficient balance' });
// { tur: 'bakiye', yenidenDene: false, isiDurdur: true, sebep: '...' }

siniflandir({ status: 429, headers: { 'retry-after': '7' } });
// { tur: 'hiz', yenidenDene: true, isiDurdur: false, beklemeMs: 7000, sebep: '...' }
```

| Tür | Tipik durum | Yeniden dene | İşi durdur |
|---|---|---|---|
| `hiz` | 429, kuyruk dolu, `Retry-After` | evet | hayır |
| `kota` | 429, `exceeded your current quota`, günlük hak | hayır | **evet** |
| `bakiye` | 402, `insufficient balance` | hayır | **evet** |
| `yetki` | 401, 403 | hayır | **evet** |
| `gecici` | 500, 502, 503, 504, 408, ağ hatası | evet | hayır |
| `gecersiz` | 400, 404, 413, 422 | hayır | hayır |
| `diger` | diğer durum kodları | hayır | hayır |

### Yeniden deneme

```ts
import { yenidenDene, IsiDurdurHatasi } from 'llm-hata-yonetimi';

try {
  const yanit = await yenidenDene(async () => {
    const r = await fetch('https://api.ornek.com/gorsel', { method: 'POST', body });
    return { status: r.status, headers: Object.fromEntries(r.headers), govde: await r.text() };
  }, { maksDeneme: 4 });
} catch (e) {
  if (e instanceof IsiDurdurHatasi) {
    // kota, bakiye ya da yetki hatası: toplu işi burada kes
  }
  throw e;
}
```

`fetch` için hazır bir sarmalayıcı da vardır: `fetchIleDene(url, init, secenek)`.

- Başarılı (2xx) yanıt olduğu gibi döner.
- İşi durduracak hatada `IsiDurdurHatasi` atılır ve yeniden denenmez.
- Geçici hatalarda ve hız sınırında bekleyip tekrar denenir. Servis `Retry-After` verdiyse o süre, vermediyse `tabanMs` ile başlayan üstel geri çekilme kullanılır.
- Deneme hakkı bitince `DenemeHakkiBittiHatasi` atılır.
- Düzeltilmeden tekrarlanmayacak hatalarda (`gecersiz`) yanıt olduğu gibi döner, ne yapılacağına sen karar verirsin.
- `islem` fonksiyonu hata fırlatırsa bu ağ hatası (`status: 0`) sayılır.

| Seçenek | Varsayılan | Açıklama |
|---|---|---|
| `maksDeneme` | 4 | İlk istek dahil toplam deneme. |
| `tabanMs` | 500 | Üstel geri çekilmenin tabanı. |
| `azamiMs` | 30000 | Tek bir beklemenin üst sınırı. |
| `uyku`, `rastgele` | gerçek | Test için bekleme ve rastgelelik fonksiyonları. |
| `denemeOncesi` | yok | Her yeniden deneme öncesi çağrılır, günlük için. |

## Sınırlar

- Sınıflandırma durum koduna ve yanıt metnindeki İngilizce ifadelere dayanır. Sağlayıcı ifadesini değiştirirse bir hata yanlış sınıfa düşebilir. Belli olmayan 429 `hiz` sayılır ve yalnızca `maksDeneme` kadar denenir.
- Kota ve bakiye ifadeleri tek bir servis grubundan gözlenmiştir (Pollinations, Gemini, Cloudflare). Başka sağlayıcıların yanıt metinleri doğrulanmadı. Gerekirse `siniflandir` çıktısını kendi kuralınla sarmala.
- Cloudflare günlük hak örneği testlerde gerçek yanıt değil, aynı davranışı anlatan örnek bir metindir.
- Kütüphane bir devre kesici ya da günlük hız sınırlayıcı içermez. Tekrarlayan hatanın günlük dosyasını doldurmasını önlemek sana kalır.
- `Retry-After` süresine jitter eklenmez, yalnızca üstel geri çekilmeye eklenir.

## Test

```bash
npm test
```

Testler sınıflandırma tablosunu, sahte saatle yeniden deneme davranışını ve gerçek bir yerel HTTP sunucusuna karşı `fetch` sarmalayıcısını kapsar. Davranışı bilerek bozduğumda (kotayı yeniden denenir yapmak, iş durdurmayı kaldırmak) testler başarısız olur.

## Lisans

MIT, bkz. [LICENSE](LICENSE).
