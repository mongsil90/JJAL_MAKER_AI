// ===== DOM =====
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');

const bgInput = document.getElementById('bg-upload');
const galleryWrap = document.getElementById('sticker-gallery');

const modeViewRadio = document.getElementById('mode-view');
const modeEditRadio  = document.getElementById('mode-edit');

const fitBtn       = document.getElementById('fit-btn');
const zoom100Btn   = document.getElementById('zoom100-btn');
const viewZoomInBtn  = document.getElementById('view-zoom-in');
const viewZoomOutBtn = document.getElementById('view-zoom-out');

const stickerZoomInBtn  = document.getElementById('sticker-zoom-in');
const stickerZoomOutBtn = document.getElementById('sticker-zoom-out');
const rotLeftBtn  = document.getElementById('rot-left');
const rotRightBtn = document.getElementById('rot-right');
const deleteBtn   = document.getElementById('delete-btn');

const downloadBtn   = document.getElementById('download-btn');
const openNewTabBtn = document.getElementById('open-newtab-btn');
const shareBtn      = document.getElementById('share-btn');

// ===== 상태 =====
let background = null; // { img, w, h }
const stickers = [];   // [{ img, w, h, x, y, scale, rot }]
let active = -1;

// 레티나(DPR)
let cssSize = { w: 900, h: 600 };
function applyDPR() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  cssSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
  canvas.width  = Math.round(cssSize.w * dpr);
  canvas.height = Math.round(cssSize.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 논리좌표 = CSS 좌표
}

// 뷰(카메라) 변환
let view = { scale: 1, x: 0, y: 0 };
let mode = 'edit'; // 'edit' | 'view'

// 포인터/제스처 상태
const pointers = new Map(); // id -> {x,y} (screen coords)
let dragging = false;
let dragOffset = { x: 0, y: 0 }; // edit: 스티커 기준, view: 화면 기준

// 핀치 제스처 시작 상태
let gestureStart = null;
// 형태 예시:
// { type:'view', dist, centerScreen:{x,y}, view0:{scale,x,y} }
// { type:'sticker', dist, angle, scale0, rot0 }

//
// ===== 유틸 =====
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 동일 출처면 불필요. 외부 CDN 사용 시 필요할 수 있음.
    // img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}

function getCanvasPos(evt) {
  const r = canvas.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

function screenToWorld(p) {
  return { x: (p.x - view.x) / view.scale, y: (p.y - view.y) / view.scale };
}

//
// ===== 렌더링 =====
function drawScene(anyCtx, { showSelection = true } = {}) {
  anyCtx.save();
  anyCtx.translate(view.x, view.y);
  anyCtx.scale(view.scale, view.scale);

  // 배경
  if (background) {
    anyCtx.drawImage(background.img, 0, 0, cssSize.w, cssSize.h);
  } else {
    anyCtx.fillStyle = '#f1f5f9';
    anyCtx.fillRect(0, 0, cssSize.w, cssSize.h);
    anyCtx.fillStyle = '#64748b';
    anyCtx.font = '16px system-ui, sans-serif';
    anyCtx.textAlign = 'center';
    anyCtx.fillText('배경 이미지를 업로드하세요', cssSize.w / 2, cssSize.h / 2);
  }

  // 스티커
  stickers.forEach((s, i) => {
    anyCtx.save();
    anyCtx.translate(s.x, s.y);
    anyCtx.rotate(s.rot);
    anyCtx.scale(s.scale, s.scale);
    anyCtx.drawImage(s.img, -s.w / 2, -s.h / 2, s.w, s.h);

    if (showSelection && i === active) {
      anyCtx.lineWidth = 2 / s.scale;
      anyCtx.strokeStyle = '#0ea5e9';
      anyCtx.strokeRect(-s.w / 2, -s.h / 2, s.w, s.h);
    }
    anyCtx.restore();
  });

  anyCtx.restore();
}

function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawScene(ctx, { showSelection: true });
}

//
// ===== 히트 테스트(월드 좌표) =====
function hitTest(x, y) {
  // 위에서부터 선택되도록 뒤에서 앞으로 검사
  for (let i = stickers.length - 1; i >= 0; i--) {
    const s = stickers[i];
    const dx = x - s.x;
    const dy = y - s.y;
    const cos = Math.cos(-s.rot);
    const sin = Math.sin(-s.rot);
    const rx = (dx * cos - dy * sin) / s.scale;
    const ry = (dx * sin + dy * cos) / s.scale;
    if (Math.abs(rx) <= s.w / 2 && Math.abs(ry) <= s.h / 2) return i;
  }
  return -1;
}

//
// ===== 갤러리 생성 (stickers/manifest.json) =====
async function buildGallery() {
  try {
    const res = await fetch('./stickers/manifest.json', { cache: 'no-cache' });
    if (!res.ok) throw new Error('stickers/manifest.json 로드 실패');
    const manifest = await res.json();

    for (const cat of (manifest.categories || [])) {
      for (const item of (cat.items || [])) {
        const img = document.createElement('img');
        img.src = item.thumb || item.src;
        img.alt = item.alt || item.title || item.id || 'sticker';
        img.width = 128; img.height = 110;
        img.loading = 'lazy'; img.decoding = 'async';
        img.draggable = true;

        // 데스크톱: 썸네일 DnD
        img.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/uri-list', item.src);
          e.dataTransfer.setData('text/plain', item.src);
        });

        // 모바일/데스크톱 공통: 탭/클릭으로 중앙에 추가
        img.addEventListener('click', async () => {
          const stickerImg = await loadImage(item.src);
          addStickerAt(cssSize.w / 2, cssSize.h / 2, stickerImg);
        });

        galleryWrap.appendChild(img);
      }
    }
  } catch (err) {
    console.error(err);
    const p = document.createElement('p');
    p.className = 'hint small';
    p.textContent = '갤러리를 불러오지 못했습니다. stickers/manifest.json 경로/대소문자 확인';
    galleryWrap.appendChild(p);
  }
}

//
// ===== 스티커 추가(월드 좌표) =====
function addStickerAt(x, y, stickerImg) {
  const s = {
    img: stickerImg,
    w: stickerImg.width,
    h: stickerImg.height,
    x, y,
    scale: Math.min(0.5, (cssSize.w * 0.25) / stickerImg.width),
    rot: 0
  };
  stickers.push(s);
  active = stickers.length - 1;
  render();
}

//
// ===== 배경 업로드 & 캔버스 크기 =====
bgInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = await fileToImage(file);

  // 비율 유지 + 최대 폭 제한
  const maxW = 1100;
  const ratio = img.width / img.height;
  const w = Math.min(img.width, maxW);
  const h = Math.round(w / ratio);

  canvas.style.width  = w + 'px';
  canvas.style.height = h + 'px';
  applyDPR();

  background = { img, w: img.width, h: img.height };

  // 배경 로드 시 뷰 초기화
  view = { scale: 1, x: 0, y: 0 };
  render();
});

//
// ===== 데스크톱 DnD로 스티커 추가 =====
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (!url) return;
  const pScreen = getCanvasPos(e);
  const p = screenToWorld(pScreen);
  const stickerImg = await loadImage(url);
  addStickerAt(p.x, p.y, stickerImg);
});

//
// ===== 포인터(터치/마우스) 이벤트 =====
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const pScreen = getCanvasPos(e);
  pointers.set(e.pointerId, pScreen);

  if (mode === 'edit') {
    const p = screenToWorld(pScreen);
    let i = hitTest(p.x, p.y);

    // 두 손가락으로 바로 시작한 경우: 중점 기준 자동 선택 시도
    if (i === -1 && pointers.size === 2) {
      const pts = Array.from(pointers.values());
      const midScreen = { x: (pts[0].x + pts[1].x)/2, y: (pts[0].y + pts[1].y)/2 };
      const mid = screenToWorld(midScreen);
      i = hitTest(mid.x, mid.y);
    }

    active = i;

    if (i !== -1 && pointers.size === 1) {
      // 단일 포인터 드래그(스티커 이동)
      stickers.push(stickers.splice(i, 1)[0]); // 최상단으로
      active = stickers.length - 1;
      const s = stickers[active];
      dragging = true;
      dragOffset = { x: p.x - s.x, y: p.y - s.y };
      render();
    }
  } else {
    // view 모드: 화면 드래그 준비
    dragging = true;
    dragOffset = { x: pScreen.x - view.x, y: pScreen.y - view.y };
  }

  // 두 손가락 핀치 시작: 편집/뷰 분기
  if (pointers.size === 2) {
    const pts = Array.from(pointers.values());
    const distScreen = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);

    if (mode === 'edit' && active !== -1) {
      // 편집 모드: 선택 스티커 핀치/회전 (월드 좌표 기준)
      const w0 = screenToWorld(pts[0]);
      const w1 = screenToWorld(pts[1]);
      const distWorld = Math.hypot(w1.x - w0.x, w1.y - w0.y);
      const angle = Math.atan2(w1.y - w0.y, w1.x - w0.x);
      const s = stickers[active];

      gestureStart = {
        type: 'sticker',
        dist: Math.max(distWorld, 1e-6),
        angle,
        scale0: s.scale,
        rot0: s.rot
      };
      dragging = false; // 멀티터치 동안 이동 중단
    } else {
      // 뷰 모드 또는 선택 없음 → 화면 핀치 줌
      const center = { x: (pts[0].x + pts[1].x)/2, y:(pts[0].y + pts[1].y)/2 };
      gestureStart = {
        type: 'view',
        dist: Math.max(distScreen, 1e-6),
        centerScreen: center,
        view0: { ...view }
      };
    }
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const pScreen = getCanvasPos(e);
  pointers.set(e.pointerId, pScreen);

  // 단일 포인터 드래그
  if (pointers.size === 1) {
    if (mode === 'edit' && dragging && active !== -1) {
      const p = screenToWorld(pScreen);
      const s = stickers[active];
      s.x = p.x - dragOffset.x;
      s.y = p.y - dragOffset.y;
      render();
    } else if (mode === 'view' && dragging) {
      view.x = pScreen.x - dragOffset.x;
      view.y = pScreen.y - dragOffset.y;
      render();
    }
    return;
  }

  // 두 손가락 제스처
  if (pointers.size === 2 && gestureStart) {
    const pts = Array.from(pointers.values());

    if (gestureStart.type === 'sticker' && active !== -1) {
      // 선택 스티커 핀치/회전 (월드 기준)
      const w0 = screenToWorld(pts[0]);
      const w1 = screenToWorld(pts[1]);
      const distW = Math.hypot(w1.x - w0.x, w1.y - w0.y);
      const angle = Math.atan2(w1.y - w0.y, w1.x - w0.x);

      const s = stickers[active];
      const scaleFactor = distW / gestureStart.dist;
      s.scale = clamp(gestureStart.scale0 * scaleFactor, 0.1, 6);
      s.rot   = gestureStart.rot0 + (angle - gestureStart.angle);

      render();
    } else if (gestureStart.type === 'view') {
      // 화면 핀치 줌 (중심 유지)
      const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
      const center = { x: (pts[0].x + pts[1].x)/2, y:(pts[0].y + pts[1].y)/2 };

      const factor   = dist / gestureStart.dist;
      const newScale = clamp(gestureStart.view0.scale * factor, 0.3, 4);

      const worldAtStart = screenToWorld(gestureStart.centerScreen);
      view.scale = newScale;
      view.x = center.x - worldAtStart.x * view.scale;
      view.y = center.y - worldAtStart.y * view.scale;

      render();
    }
  }
});

function endPointer(e) {
  canvas.releasePointerCapture?.(e.pointerId);
  pointers.delete(e.pointerId);
  if (pointers.size < 2) gestureStart = null;
  if (pointers.size === 0) dragging = false;
}
canvas.addEventListener('pointerup', endPointer);
canvas.addEventListener('pointercancel', endPointer);
canvas.addEventListener('pointerleave', endPointer);

//
// ===== 휠: 편집 모드=스티커 스케일, 뷰 모드=화면 줌 =====
canvas.addEventListener('wheel', (e) => {
  e.preventDefault();
  if (mode === 'edit') {
    if (active === -1) return;
    const s = stickers[active];
    const delta = -Math.sign(e.deltaY) * 0.08;
    s.scale = clamp(s.scale + delta, 0.1, 6);
  } else {
    const pScreen = getCanvasPos(e);
    const worldAtCursor = screenToWorld(pScreen);
    const factor = 1 + (-Math.sign(e.deltaY) * 0.15);
    const newScale = clamp(view.scale * factor, 0.3, 4);
    view.scale = newScale;
    // 커서 기준 줌
    view.x = pScreen.x - worldAtCursor.x * view.scale;
    view.y = pScreen.y - worldAtCursor.y * view.scale;
  }
  render();
}, { passive: false });

//
// ===== 키보드(데스크톱) =====
window.addEventListener('keydown', (e) => {
  if (mode === 'edit' && active !== -1) {
    const s = stickers[active];
    if (e.key === '[')       { s.rot -= Math.PI / 90; render(); }
    else if (e.key === ']')  { s.rot += Math.PI / 90; render(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') {
      stickers.splice(active, 1); active = -1; render();
    }
  }
});

//
// ===== 버튼들 =====
modeViewRadio.addEventListener('change', () => { if (modeViewRadio.checked) mode = 'view'; });
modeEditRadio.addEventListener('change', () => { if (modeEditRadio.checked) mode = 'edit'; });

fitBtn.addEventListener('click', () => {
  // 간단 맞춤(배경이 캔버스 크기에 꽉 차도록 그리므로 뷰 초기화로 충분)
  view = { scale: 1, x: 0, y: 0 };
  render();
});
zoom100Btn.addEventListener('click', () => { view.scale = 1; render(); });

viewZoomInBtn.addEventListener('click', () => {
  const center = { x: cssSize.w / 2, y: cssSize.h / 2 };
  const world  = screenToWorld(center);
  view.scale = clamp(view.scale * 1.2, 0.3, 4);
  view.x = center.x - world.x * view.scale;
  view.y = center.y - world.y * view.scale;
  render();
});
viewZoomOutBtn.addEventListener('click', () => {
  const center = { x: cssSize.w / 2, y: cssSize.h / 2 };
  const world  = screenToWorld(center);
  view.scale = clamp(view.scale / 1.2, 0.3, 4);
  view.x = center.x - world.x * view.scale;
  view.y = center.y - world.y * view.scale;
  render();
});

stickerZoomInBtn.addEventListener('click', () => {
  if (active === -1) return;
  stickers[active].scale = clamp(stickers[active].scale + 0.1, 0.1, 6);
  render();
});
stickerZoomOutBtn.addEventListener('click', () => {
  if (active === -1) return;
  stickers[active].scale = clamp(stickers[active].scale - 0.1, 0.1, 6);
  render();
});
rotLeftBtn.addEventListener('click', () => {
  if (active === -1) return;
  stickers[active].rot -= Math.PI / 24; render();
});
rotRightBtn.addEventListener('click', () => {
  if (active === -1) return;
  stickers[active].rot += Math.PI / 24; render();
});
deleteBtn.addEventListener('click', () => {
  if (active !== -1) { stickers.splice(active, 1); active = -1; render(); }
});

//
// ===== 오프스크린 렌더로 선택 표시 제외 저장(Blob) =====
function exportImageToBlob() {
  return new Promise((resolve) => {
    const off = document.createElement('canvas');
    off.width  = canvas.width;
    off.height = canvas.height;
    const offCtx = off.getContext('2d');

    // 화면과 동일한 좌표계(DPR) 적용
    const dpr = canvas.width / cssSize.w;
    offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
    // 선택 표시 없이 그리기(뷰 변환은 drawScene 내부에서 그대로 적용)
    drawScene(offCtx, { showSelection: false });

    off.toBlob((blob) => resolve(blob), 'image/png');
  });
}

// 저장(다운로드)
downloadBtn.addEventListener('click', async () => {
  if (!background) return alert('먼저 배경 이미지를 업로드하세요.');
  const blob = await exportImageToBlob();
  const url  = URL.createObjectURL(blob);

  // iOS는 a[download] 미지원 → 새 탭 열기 후 길게 눌러 저장
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) {
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  } else {
    const a = document.createElement('a');
    a.href = url;
    a.download = 'stickered.png';
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
});

// 새 탭으로 열기
openNewTabBtn.addEventListener('click', async () => {
  if (!background) return alert('먼저 배경 이미지를 업로드하세요.');
  const blob = await exportImageToBlob();
  const url  = URL.createObjectURL(blob);
  window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
});

// 공유(Web Share API)
shareBtn.addEventListener('click', async () => {
  if (!background) return alert('먼저 배경 이미지를 업로드하세요.');
  const blob = await exportImageToBlob();
  const file = new File([blob], 'stickered.png', { type: 'image/png' });

  if (navigator.canShare && navigator.canShare({ files: [file] })) {
    try {
      await navigator.share({ files: [file], title: '스티커 이미지', text: '에디터에서 만든 이미지' });
    } catch (_) {
      // 사용자가 취소한 경우 등 무시
    }
  } else {
    const url = URL.createObjectURL(blob);
    window.open(url, '_blank');
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }
});

//
// ===== 시작 =====
function handleResize() { applyDPR(); render(); }
window.addEventListener('resize', handleResize);

applyDPR();
buildGallery().then(render);
