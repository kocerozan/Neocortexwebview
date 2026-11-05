import UIKit
import Photos

/// Örnek: bir butondan kamera webview'ini aç, sonucu galeriye kaydet.
final class ExampleViewController: UIViewController {
    @objc func openCamera() {
        let vc = NeoCortexWebViewController(url: NeoCortexConfig.webURL,
                                            title: "Gondol #8069",
                                            hint: "Rafı soldan sağa yavaşça tara.")
        vc.onResult = { [weak vc] result in
            PHPhotoLibrary.shared().performChanges({
                if let img = result.imageURL { PHAssetCreationRequest.creationRequestForAssetFromImage(atFileURL: img) }
                if let vid = result.videoURL { PHAssetCreationRequest.creationRequestForAssetFromVideo(atFileURL: vid) }
            })
            vc?.dismiss(animated: true)
        }
        present(vc, animated: true)
    }
}
