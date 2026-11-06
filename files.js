// Чтение файлов прямо на телефоне. Библиотеки подгружаются только при первом файле такого типа.

const MAX_FILE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGE_SIDE = 1600;
const MAX_SCAN_PAGES = 5;
const MAX_TEXT_CHARS = 40000;

export class FileProblem extends Error {}

function canvasToJpeg(canvas) {
  return canvas.toDataURL('image/jpeg', 0.82);
}

async function readImage(file) {
  let bitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new FileProblem(`Не удалось открыть фото «${file.name}».`);
  }
  const scale = Math.min(1, MAX_IMAGE_SIDE / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  const context = canvas.getContext('2d');
  context.fillStyle = '#fff';
  context.fillRect(0, 0, canvas.width, canvas.height);
  context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close?.();
  return { name: file.name, images: [canvasToJpeg(canvas)], text: '' };
}

async function readPdf(file) {
  const pdfjs = await import('./vendor/pdf.min.js');
  pdfjs.GlobalWorkerOptions.workerSrc = new URL('./vendor/pdf.worker.min.js', import.meta.url).href;
  let doc;
  try {
    doc = await pdfjs.getDocument({ data: await file.arrayBuffer(), isEvalSupported: false }).promise;
  } catch (error) {
    if (error?.name === 'PasswordException') throw new FileProblem(`PDF «${file.name}» защищён паролем.`);
    throw new FileProblem(`Не удалось открыть PDF «${file.name}».`);
  }
  const pages = [];
  for (let number = 1; number <= doc.numPages; number += 1) {
    const page = await doc.getPage(number);
    const content = await page.getTextContent();
    pages.push(content.items.map((item) => `${item.str || ''}${item.hasEOL ? '\n' : ' '}`).join('').replace(/[ \t]+/g, ' ').trim());
    if (pages.join('').length > MAX_TEXT_CHARS) break;
  }
  const text = pages.join('\n\n').trim();
  if (text.length >= 30 * Math.min(doc.numPages, pages.length)) {
    return { name: file.name, images: [], text };
  }
  // В скане нет текста: страницы станут картинками и их прочитает модель.
  const images = [];
  for (let number = 1; number <= Math.min(doc.numPages, MAX_SCAN_PAGES); number += 1) {
    const page = await doc.getPage(number);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(2, MAX_IMAGE_SIDE / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.floor(viewport.width);
    canvas.height = Math.floor(viewport.height);
    await page.render({ canvas, canvasContext: canvas.getContext('2d'), viewport }).promise;
    images.push(canvasToJpeg(canvas));
  }
  const note = doc.numPages > MAX_SCAN_PAGES ? ` Прочитаны первые ${MAX_SCAN_PAGES} страниц из ${doc.numPages}.` : '';
  return { name: file.name, images, text: '', note };
}

let zipLoaded = null;
function loadZip() {
  if (!zipLoaded) {
    zipLoaded = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = new URL('./vendor/jszip.min.js', import.meta.url).href;
      script.onload = () => resolve(window.JSZip);
      script.onerror = () => reject(new FileProblem('Не удалось загрузить модуль чтения файлов.'));
      document.head.append(script);
    });
  }
  return zipLoaded;
}

const parseXml = (xml) => new DOMParser().parseFromString(xml, 'application/xml');
const allByName = (root, name) => [...root.getElementsByTagNameNS('*', name)];

function columnIndex(ref) {
  const letters = /^[A-Z]+/.exec(ref || '')?.[0] || 'A';
  return [...letters].reduce((sum, letter) => sum * 26 + letter.charCodeAt(0) - 64, 0) - 1;
}

export async function xlsxToText(buffer, JSZip) {
  const zip = await JSZip.loadAsync(buffer);
  const sharedFile = zip.file('xl/sharedStrings.xml');
  const shared = sharedFile
    ? allByName(parseXml(await sharedFile.async('string')), 'si').map((item) => allByName(item, 't').map((node) => node.textContent).join(''))
    : [];
  const book = parseXml(await zip.file('xl/workbook.xml').async('string'));
  const rels = parseXml(await zip.file('xl/_rels/workbook.xml.rels').async('string'));
  const targets = Object.fromEntries(allByName(rels, 'Relationship').map((rel) => [rel.getAttribute('Id'), rel.getAttribute('Target')]));
  const out = [];
  for (const sheet of allByName(book, 'sheet')) {
    const relId = sheet.getAttribute('r:id') || sheet.getAttributeNS('http://schemas.openxmlformats.org/officeDocument/2006/relationships', 'id');
    const target = String(targets[relId] || '').replace(/^\/?(xl\/)?/, '');
    const entry = zip.file(`xl/${target}`);
    if (!entry || sheet.getAttribute('state') === 'hidden') continue;
    const rows = [];
    for (const row of allByName(parseXml(await entry.async('string')), 'row')) {
      const cells = [];
      for (const cell of allByName(row, 'c')) {
        const type = cell.getAttribute('t');
        const value = allByName(cell, 'v')[0]?.textContent ?? '';
        let text = value;
        if (type === 's') text = shared[Number(value)] ?? '';
        else if (type === 'inlineStr') text = allByName(cell, 't').map((node) => node.textContent).join('');
        cells[columnIndex(cell.getAttribute('r'))] = String(text).replace(/\s+/g, ' ').trim();
      }
      const line = Array.from(cells, (cell) => cell ?? '').join(' | ').replace(/( \| )+$/, '');
      if (line.trim()) rows.push(line);
    }
    if (rows.length) out.push(`Лист «${sheet.getAttribute('name')}»:\n${rows.join('\n')}`);
  }
  return out.join('\n\n');
}

export async function docxToText(buffer, JSZip) {
  const zip = await JSZip.loadAsync(buffer);
  const doc = parseXml(await zip.file('word/document.xml').async('string'));
  return allByName(doc, 'p').map((paragraph) => allByName(paragraph, 't').map((node) => node.textContent).join('')).filter(Boolean).join('\n');
}

export async function readFile(file) {
  if (file.size > MAX_FILE_BYTES) throw new FileProblem(`Файл «${file.name}» больше 15 МБ.`);
  const name = file.name.toLowerCase();
  const extension = name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : '';
  if (file.type.startsWith('image/')) return readImage(file);
  if (extension === 'pdf' || file.type === 'application/pdf') return readPdf(file);
  if (['xlsx', 'xlsm'].includes(extension)) {
    const text = await xlsxToText(await file.arrayBuffer(), await loadZip()).catch((error) => {
      if (error instanceof FileProblem) throw error;
      throw new FileProblem(`Не удалось прочитать таблицу «${file.name}».`);
    });
    return { name: file.name, images: [], text };
  }
  if (extension === 'docx') {
    const text = await docxToText(await file.arrayBuffer(), await loadZip()).catch((error) => {
      if (error instanceof FileProblem) throw error;
      throw new FileProblem(`Не удалось прочитать документ «${file.name}».`);
    });
    return { name: file.name, images: [], text };
  }
  if (['xls', 'doc', 'ppt', 'pptx', 'heic', 'zip', 'rar'].includes(extension)) {
    throw new FileProblem(`Формат .${extension} не поддерживается. Подойдут фото, PDF, .xlsx, .docx, .txt и .csv.`);
  }
  const text = await file.text();
  if (text.includes('\u0000')) throw new FileProblem(`Формат файла «${file.name}» не поддерживается.`);
  return { name: file.name, images: [], text };
}

// Собирает все вложения в текст и картинки для совета.
export function combineFiles(files) {
  const text = files.filter((file) => file.text).map((file) => `Файл «${file.name}»:\n${file.text}`).join('\n\n');
  return {
    fileNames: files.map((file) => file.name),
    fileText: text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text,
    images: files.flatMap((file) => file.images).slice(0, 8),
  };
}
