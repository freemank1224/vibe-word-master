/**
 * Compresses a base64 image (PNG/JPEG) and returns a WebP Blob.
 * @param base64Data The base64 string of the image.
 * @param maxWidth Optional max width for resizing.
 * @param maxHeight Optional max height for resizing.
 * @param quality Quality from 0 to 1.
 */
export const compressToWebP = async (
    base64Data: string, 
    maxWidth: number = 1024, 
    maxHeight: number = 1024, 
    quality: number = 0.8
): Promise<Blob> => {
    return new Promise((resolve, reject) => {
        const img = new Image();
        img.onload = () => {
            const canvas = document.createElement('canvas');
            let width = img.width;
            let height = img.height;

            // Calculate new dimensions
            if (width > height) {
                if (width > maxWidth) {
                    height *= maxWidth / width;
                    width = maxWidth;
                }
            } else {
                if (height > maxHeight) {
                    width *= maxHeight / height;
                    height = maxHeight;
                }
            }

            canvas.width = width;
            canvas.height = height;

            const ctx = canvas.getContext('2d');
            if (!ctx) {
                reject(new Error('Failed to get canvas context'));
                return;
            }

            ctx.drawImage(img, 0, 0, width, height);

            canvas.toBlob(
                (blob) => {
                    if (blob) {
                        resolve(blob);
                    } else {
                        reject(new Error('Canvas toBlob failed'));
                    }
                },
                'image/webp',
                quality
            );
        };
        img.onerror = (e) => reject(e);
        img.src = base64Data;
    });
};
