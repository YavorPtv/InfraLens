interface DownloadTextFileOptions {
  contents: string;
  fileName: string;
  mimeType: string;
}

export function downloadTextFile({
  contents,
  fileName,
  mimeType
}: DownloadTextFileOptions): void {
  const blob = new Blob([contents], {
    type: mimeType
  });
  const objectUrl = URL.createObjectURL(blob);
  const link = document.createElement("a");

  link.href = objectUrl;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(objectUrl);
}
