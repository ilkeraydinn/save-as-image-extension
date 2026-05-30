# Save as Image (Görseli Farklı Kaydet) - Chrome Eklentisi

Bu Google Chrome eklentisi (Manifest V3), herhangi bir web sitesindeki görsele sağ tıkladığınızda açılan menüden görseli anında **JPG**, **PNG** veya **WEBP** formatına dönüştürüp indirmenizi sağlar.

## ✨ Özellikler

*   **Çoklu Format Desteği**: Görselleri tek tıkla JPG, PNG veya WEBP formatlarına dönüştürür.
*   **Akıllı Arka Plan Yönetimi**: Şeffaf arka plana sahip PNG veya WEBP görsellerini JPG'ye dönüştürürken arkalarına otomatik olarak temiz bir **beyaz arka plan** ekler (siyah lekeleri önler).
*   **Orijinal Dosya Adı Koruma**: İndirilen görsellerin adını orijinal dosya adına en yakın olacak şekilde korur ve yeni uzantıyı ekler.
*   **Manifest V3 & Offscreen API**: En modern Chrome eklentisi standartlarına uygundur. Arka planda çalışırken tarayıcınızı yormaz ve güvenlidir.
*   **CORS Desteği**: Güçlü izin yapılandırması sayesinde farklı sunucularda barındırılan görselleri de sorunsuz şekilde indirir.

---

## 📂 Dosya Yapısı (Folder Structure)

Eklenti klasörünün yapısı aşağıdaki gibidir:

```text
save-as-image-extension/
├── manifest.json       # Eklenti ayarları, izinler ve service worker tanımları
├── background.js       # Context menu yönetimi, indirme ve offscreen kontrolü
├── helpers.js          # Dosya adı temizleme ve formatlama yardımcı modülü
├── offscreen.html      # Offscreen Document için HTML taşıyıcı
├── offscreen.js        # Canvas kullanarak görseli çizen ve dönüştüren script
├── icon16.png          # Eklenti ikonu (16x16)
├── icon48.png          # Eklenti ikonu (48x48)
└── icon128.png         # Eklenti ikonu (128x128)
```

---

## 🚀 Kurulum Adımları (Installation Guide)

Eklentiyi Chrome tarayıcınıza yüklemek için aşağıdaki adımları takip edin:

1.  **Google Chrome** tarayıcınızı açın.
2.  Adres çubuğuna `chrome://extensions/` yazın ve Enter'a basın (Alternatif olarak: Sağ üstteki üç nokta menüsü -> Diğer Araçlar -> Uzantılar).
3.  Sayfanın sağ üst köşesinde bulunan **"Developer Mode" (Geliştirici Modu)** seçeneğini aktif hale getirin.
4.  Sol üst köşede beliren **"Load unpacked" (Paketlenmemiş öğe yükle)** butonuna tıklayın.
5.  Açılan dosya seçici penceresinden eklenti kodlarının bulunduğu klasörü seçin:
    `C:\Users\ilker\.gemini\antigravity\scratch\save-as-image-extension`
6.  Eklenti başarıyla yüklenecektir! Artık herhangi bir web sayfasındaki görsele sağ tıklayıp test edebilirsiniz.

---

## 🛠️ Nasıl Kullanılır?

1.  Herhangi bir web sitesine gidin (örneğin Wikipedia veya Unsplash).
2.  Bir görselin üzerine gelip **sağ tıklayın**.
3.  Açılan menüde **"Save as Image"** seçeneğini göreceksiniz.
4.  Mouse ile üzerine geldiğinizde açılan alt menüden istediğiniz formatı (**JPG**, **PNG**, **WEBP**) seçin.
5.  Görsel anında dönüştürülecek ve otomatik olarak indirilecektir!

---

## 🧠 Teknik Detaylar (Nasıl Çalışıyor?)

1.  **Context Menu tetiklenir**: Kullanıcı sağ tıklayıp bir format seçtiğinde `background.js` bunu yakalar.
2.  **Offscreen Document açılır**: Manifest V3 arka plan servisleri (Service Workers) DOM ağacına veya `<canvas>` elementine erişemez. Bu yüzden geçici bir `offscreen.html` (Offscreen Document) oluşturulur.
3.  **Çapraz Origin İndirme (Fetch)**: Görsel, `host_permissions` yetkileri sayesinde CORS kısıtlamalarına takılmadan arka planda indirilir (Blob formatında).
4.  **Canvas Dönüştürme**: İndirilen blob, offscreen belgesindeki bir HTML Canvas'a çizilir. Eğer hedef format **JPG** ise, saydamlığı korumak adına önce beyaz arka plan çizilir, ardından görsel üzerine yerleştirilir.
5.  **Otomatik İndirme**: Dönüştürülen görsel `data:URL` formatına çevrilerek `background.js`'e geri gönderilir ve `chrome.downloads` API'si ile bilgisayarınıza kaydedilir. İşlem tamamlandığında offscreen belgesi bellek harcamaması için otomatik olarak kapatılır.
