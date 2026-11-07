# Tek ödemede sepet (nokta-checkout)

Sitedeki sepeti Shopier'de **tek ödeme** sayfasına çevirir.

Shopier'de sepeti dışarıdan doldurmak mümkün olmadığı için, sepet için Shopier API'siyle
mağazada görünmeyen (`customListing`) tek bir "Nokta Sepeti" ürünü oluşturulur:

- **Fiyat** sunucuda, Shopier'deki güncel (indirimli) fiyatlardan hesaplanır; tarayıcıdan gelen fiyat kullanılmaz.
- **Numara ve stok** her ürün için Shopier'den kontrol edilir.
- **Başlık / açıklama** model + numara + adet listesini içerir; sipariş panelde bu adla görünür.
- **Stok 1**: ödendikten sonra aynı link ikinci kez kullanılamaz.
- Aynı sepet 2 saat içinde tekrar gönderilirse yeni ürün açılmaz, aynı link verilir.
- Ödenmeyen paketler 24 saat sonra (saatlik cron) silinir.
- `order.created` webhook'u paketi "ödendi" işaretler. `STOCK_SYNC = "on"` yapılırsa gerçek ürünlerin numara stoğu da düşülür (bir üründe denendikten sonra açın).

## Kurulum

Yükleme `.github/workflows/deploy-checkout.yml` ile yapılır. Depo sırları:
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, `SHOPIER_PAT`, `CHECKOUT_ADMIN_KEY`.

Shopier'de PAT oluşturmak için önce **iki adımlı doğrulama** açılmalı (Hesap Yönetimi → Hesap Güvenliği).
PAT hesaba tam erişim verir: yalnızca GitHub sırrı olarak saklanır, koda veya sohbete yazılmaz.

## Yönetim

`X-Admin-Key: <CHECKOUT_ADMIN_KEY>` başlığıyla:

- `GET /admin/product?id=51724140` — API'nin bir ürünü (fiyat, numaralar, stok) nasıl gördüğü
- `GET /admin/bundles` — son 50 paket ve durumları
- `POST /admin/setup-webhook` — sipariş bildirimini kurar (yükleme iş akışı bunu kendisi çağırır)

## Test

```
npm ci
npm test
```
