(function () {
  'use strict';

  // ---- 状態管理 ----
  const state = {
    images: [],       // { file: File, dataUrl: string }[]
    gasUrl: localStorage.getItem('gas_url') || '',
    history: JSON.parse(localStorage.getItem('upload_history') || '[]'),
  };

  // ---- DOM要素 ----
  const $ = (sel) => document.querySelector(sel);
  const inputCamera = $('#input-camera');
  const inputGallery = $('#input-gallery');
  const previewList = $('#preview-list');
  const btnSubmit = $('#btn-submit');
  const btnClear = $('#btn-clear');
  const btnNew = $('#btn-new');
  const btnSettings = $('#btn-settings');
  const btnSaveSettings = $('#btn-save-settings');
  const btnBack = $('#btn-back');
  const inputGasUrl = $('#input-gas-url');
  const screenMain = $('#screen-main');
  const screenSettings = $('#screen-settings');
  const processing = $('#processing');
  const processingText = $('#processing-text');
  const result = $('#result');
  const resultContent = $('#result-content');
  const captureArea = $('#capture-area');
  const historyList = $('#history-list');
  const historySection = $('#history-section');

  // ---- 初期化 ----
  function init() {
    inputGasUrl.value = state.gasUrl;
    renderHistory();

    inputCamera.addEventListener('change', handleCapture);
    inputGallery.addEventListener('change', handleGallerySelect);
    btnSubmit.addEventListener('click', handleSubmit);
    btnClear.addEventListener('click', clearImages);
    btnNew.addEventListener('click', resetToCapture);
    btnSettings.addEventListener('click', showSettings);
    btnSaveSettings.addEventListener('click', saveSettings);
    btnBack.addEventListener('click', hideSettings);

    // Service Worker登録
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('sw.js').catch(() => {});
    }
  }

  // ---- カメラ撮影 ----
  function handleCapture(e) {
    const file = e.target.files[0];
    if (!file) return;
    addImage(file);
    e.target.value = '';
  }

  // ---- ギャラリー選択（複数可） ----
  function handleGallerySelect(e) {
    const files = Array.from(e.target.files);
    files.forEach(addImage);
    e.target.value = '';
  }

  // ---- 画像追加 ----
  function addImage(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
      state.images.push({ file, dataUrl: e.target.result });
      renderPreviews();
    };
    reader.readAsDataURL(file);
  }

  // ---- プレビュー描画 ----
  function renderPreviews() {
    previewList.innerHTML = '';
    state.images.forEach((img, i) => {
      const div = document.createElement('div');
      div.className = 'preview-item';
      div.innerHTML =
        '<img src="' + img.dataUrl + '" alt="レシート ' + (i + 1) + '">' +
        '<span class="badge">' + (i + 1) + '/' + state.images.length + '</span>' +
        '<button class="btn-remove" data-idx="' + i + '">&times;</button>';
      previewList.appendChild(div);
    });

    // 削除ボタン
    previewList.querySelectorAll('.btn-remove').forEach((btn) => {
      btn.addEventListener('click', (e) => {
        const idx = parseInt(e.currentTarget.dataset.idx);
        state.images.splice(idx, 1);
        renderPreviews();
      });
    });

    const hasImages = state.images.length > 0;
    btnSubmit.hidden = !hasImages;
    btnClear.hidden = !hasImages;
  }

  // ---- 画像を縦に結合（長いレシート対応） ----
  function mergeImagesVertically(dataUrls) {
    return new Promise((resolve) => {
      if (dataUrls.length === 1) {
        resolve(dataUrls[0]);
        return;
      }

      const imgs = [];
      let loaded = 0;

      dataUrls.forEach((url, i) => {
        const img = new Image();
        img.onload = () => {
          imgs[i] = img;
          loaded++;
          if (loaded === dataUrls.length) {
            stitch(imgs, resolve);
          }
        };
        img.src = url;
      });
    });
  }

  function stitch(imgs, resolve) {
    // 最大幅に揃える
    const maxWidth = Math.max(...imgs.map((img) => img.naturalWidth));
    let totalHeight = 0;
    const scaled = imgs.map((img) => {
      const scale = maxWidth / img.naturalWidth;
      const h = img.naturalHeight * scale;
      totalHeight += h;
      return { img, w: maxWidth, h };
    });

    const canvas = document.createElement('canvas');
    canvas.width = maxWidth;
    canvas.height = totalHeight;
    const ctx = canvas.getContext('2d');

    let y = 0;
    scaled.forEach(({ img, w, h }) => {
      ctx.drawImage(img, 0, y, w, h);
      y += h;
    });

    // JPEG品質0.85で出力（サイズとのバランス）
    resolve(canvas.toDataURL('image/jpeg', 0.85));
  }

  // ---- 送信処理 ----
  async function handleSubmit() {
    if (state.images.length === 0) return;

    if (!state.gasUrl) {
      alert('先に設定からGoogle Apps Script URLを入力してください。');
      showSettings();
      return;
    }

    // UI切替
    captureArea.hidden = true;
    historySection.hidden = true;
    processing.hidden = false;
    processingText.textContent = 'レシートを結合中...';

    try {
      // 画像結合
      const dataUrls = state.images.map((img) => img.dataUrl);
      const merged = await mergeImagesVertically(dataUrls);

      processingText.textContent = 'OCR解析・自動分類中...';

      // Base64部分だけ抽出
      const base64 = merged.split(',')[1];

      // GASへ送信（CORS回避のためtext/plainで送信 - GAS側でJSONパース）
      const response = await fetch(state.gasUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({
          image: base64,
          mimeType: 'image/jpeg',
          timestamp: new Date().toISOString(),
        }),
      });

      const data = await response.json();

      if (data.success) {
        showResult(data);
        addToHistory(data);
      } else {
        showError(data.error || '処理に失敗しました');
      }
    } catch (err) {
      showError('通信エラー: ' + err.message);
    }

    processing.hidden = true;
  }

  // ---- 結果表示 ----
  function showResult(data) {
    resultContent.innerHTML =
      '<div class="result-card">' +
        '<h3>&#9989; アップロード完了</h3>' +
        '<div class="result-row"><span class="result-label">日付</span><span class="result-value">' + esc(data.date || '不明') + '</span></div>' +
        '<div class="result-row"><span class="result-label">店名</span><span class="result-value">' + esc(data.store || '不明') + '</span></div>' +
        '<div class="result-row"><span class="result-label">金額</span><span class="result-value">' + esc(data.amount || '不明') + '</span></div>' +
        '<div class="result-row"><span class="result-label">ジャンル</span><span class="result-value">' + esc(data.genre || '不明') + '</span></div>' +
        '<div class="result-row"><span class="result-label">ファイル名</span><span class="result-value">' + esc(data.fileName || '') + '</span></div>' +
        '<div class="result-row"><span class="result-label">保存先</span><span class="result-value">' + esc(data.folderPath || '') + '</span></div>' +
      '</div>';
    result.hidden = false;
  }

  function showError(msg) {
    resultContent.innerHTML =
      '<div class="result-card result-error">' +
        '<h3>&#10060; エラー</h3>' +
        '<p style="font-size:14px;margin-top:8px">' + esc(msg) + '</p>' +
      '</div>';
    result.hidden = false;
  }

  function esc(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
  }

  // ---- 履歴管理 ----
  function addToHistory(data) {
    state.history.unshift({
      fileName: data.fileName || '',
      genre: data.genre || '',
      date: new Date().toISOString(),
    });
    if (state.history.length > 20) state.history.pop();
    localStorage.setItem('upload_history', JSON.stringify(state.history));
    renderHistory();
  }

  function renderHistory() {
    historyList.innerHTML = '';
    state.history.forEach((item) => {
      const div = document.createElement('div');
      div.className = 'history-item';
      div.innerHTML =
        '<span class="history-name">' + esc(item.fileName) + '</span>' +
        '<span class="history-genre">' + esc(item.genre) + '</span>';
      historyList.appendChild(div);
    });
  }

  // ---- 画面遷移 ----
  function clearImages() {
    state.images = [];
    renderPreviews();
  }

  function resetToCapture() {
    clearImages();
    result.hidden = true;
    captureArea.hidden = false;
    historySection.hidden = false;
  }

  function showSettings() {
    screenMain.hidden = true;
    historySection.hidden = true;
    screenSettings.hidden = false;
  }

  function hideSettings() {
    screenSettings.hidden = true;
    screenMain.hidden = false;
    historySection.hidden = false;
  }

  function saveSettings() {
    const url = inputGasUrl.value.trim();
    if (url && !url.startsWith('https://script.google.com/')) {
      alert('Google Apps ScriptのURL（https://script.google.com/...）を入力してください。');
      return;
    }
    state.gasUrl = url;
    localStorage.setItem('gas_url', url);
    alert('設定を保存しました。');
    hideSettings();
  }

  // ---- 起動 ----
  init();
})();
