// ===== DOM =====
const canvas = document.getElementById('canvas');
const ctx = canvas.getContext('2d');
const bgInput = document.getElementById('bg-upload');
const galleryWrap = document.getElementById('sticker-gallery');
const downloadBtn = document.getElementById('download-btn');
const openNewTabBtn = document.getElementById('open-newtab-btn');
const btnZoomIn = document.getElementById('zoom-in');
const btnZoomOut = document.getElementById('zoom-out');
const btnRotL = document.getElementById('rot-left');
const btnRotR = document.getElementById('rot-right');
const deleteBtn = document.getElementById('delete-btn'); // 선택(있으면 사용)

// ===== 상태 =====
let background = null; // { img, w, h }
const stickers = [];   // [{ img, w, h, x, y, scale, rot }]
let active = -1;

// 드래그 & 포인터 제스처
let dragging = false;
const dragOffset = { x: 0, y: 0 };

// 멀티포인터(핀치/회전) 추적
const pointers = new Map(); // id -> {x,y}
let gestureStart = null;    // {dist, angle, scale0, rot0}

// DPR(레티나) 관리
let cssSize = { w: 900, h: 600 }; // CSS 크기(논리 좌표)
function applyDPR() {
  const dpr = Math.max(1, window.devicePixelRatio || 1);
  const rect = canvas.getBoundingClientRect();
  cssSize = { w: Math.round(rect.width), h: Math.round(rect.height) };
  canvas.width = Math.round(cssSize.w * dpr);
  canvas.height = Math.round(cssSize.h * dpr);
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0); // 논리좌표=CSS 좌표로 통일
}

// ===== 유틸 =====
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

function fileToImage(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = reject;
    img.src = url;
  });
}
function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    // 동일 출처면 crossOrigin 불필요. 외부 도메인 사용할 때만 아래 주석 해제.
    // img.crossOrigin = 'anonymous';
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}
function getCanvasPos(evt) {
  const r = canvas.getBoundingClientRect();
  return { x: evt.clientX - r.left, y: evt.clientY - r.top };
}

// ===== 장면 그리기(선택 표시 on/off 지원) =====
function drawScene(anyCtx, { showSelection = true } = {}) {
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
}

// ===== 화면 렌더 =====
function render() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  drawScene(ctx, { showSelection: true });
}

// ===== 히트 테스트 =====
function hitTest(x, y) {
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

// ===== 갤러리 생성 =====
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

        // 데스크톱 DnD
        img.addEventListener('dragstart', (e) => {
          e.dataTransfer.setData('text/uri-list', item.src);
          e.dataTransfer.setData('text/plain', item.src);
        });

        // 모바일: 탭으로 중앙에 추가
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
    p.className = 'hint';
    p.textContent = '갤러리를 불러오지 못했습니다. stickers/manifest.json 경로/대소문자를 확인하세요.';
    galleryWrap.appendChild(p);
  }
}

// ===== 스티커 추가 =====
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

// ===== 배경 업로드 & 캔버스 크기 =====
bgInput.addEventListener('change', async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const img = await fileToImage(file);

  // CSS 크기(논리 좌표) 결정: 배율 유지 + 최대 폭 제한
  const maxW = 1100;
  const ratio = img.width / img.height;
  const w = Math.min(img.width, maxW);
  const h = Math.round(w / ratio);

  // CSS 크기 지정 → applyDPR가 내부 비트맵을 설정
  canvas.style.width = w + 'px';
  canvas.style.height = h + 'px';
  applyDPR();

  background = { img, w: img.width, h: img.height };
  render();
});

// ===== 데스크톱: DnD로 추가 =====
canvas.addEventListener('dragover', (e) => e.preventDefault());
canvas.addEventListener('drop', async (e) => {
  e.preventDefault();
  const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
  if (!url) return;
  const p = getCanvasPos(e);
  const stickerImg = await loadImage(url);
  addStickerAt(p.x, p.y, stickerImg);
});

// ===== 포인터 이벤트(모바일/데스크톱 공통) =====
canvas.addEventListener('pointerdown', (e) => {
  canvas.setPointerCapture(e.pointerId);
  const p = getCanvasPos(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 1) {
    // 단일 포인터 → 선택 & 드래그 시작
    const i = hitTest(p.x, p.y);
    active = i;
    if (i !== -1) {
      // 선택한 스티커 최상단으로
      stickers.push(stickers.splice(i, 1)[0]);
      active = stickers.length - 1;
      const s = stickers[active];
      dragging = true;
      dragOffset.x = p.x - s.x;
      dragOffset.y = p.y - s.y;
      render();
    } else {
      render();
    }
  } else if (pointers.size === 2 && active !== -1) {
    // 두 손가락 → 핀치/회전 제스처 시작
    const pts = Array.from(pointers.values());
    gestureStart = {
      dist: Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y),
      angle: Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x),
      scale0: stickers[active].scale,
      rot0: stickers[active].rot
    };
    dragging = false; // 멀티터치 중에는 드래그 중지
  }
});

canvas.addEventListener('pointermove', (e) => {
  if (!pointers.has(e.pointerId)) return;
  const p = getCanvasPos(e);
  pointers.set(e.pointerId, p);

  if (pointers.size === 1 && dragging && active !== -1) {
    const s = stickers[active];
    s.x = p.x - dragOffset.x;
    s.y = p.y - dragOffset.y;
    render();
  } else if (pointers.size === 2 && gestureStart && active !== -1) {
    const pts = Array.from(pointers.values());
    const dist = Math.hypot(pts[1].x - pts[0].x, pts[1].y - pts[0].y);
    const angle = Math.atan2(pts[1].y - pts[0].y, pts[1].x - pts[0].x);

    const s = stickers[active];
    // 스케일: 거리 비율
    const scaleFactor = dist / Math.max(gestureStart.dist, 1e-6);
    s.scale = clamp(gestureStart.scale0 * scaleFactor, 0.1, 6);

    // 회전: 각도 차이
    s.rot = gestureStart.rot0 + (angle - gestureStart.angle);

    render();
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

// ===== 데스크톱 보조: 휠/키 =====
canvas.addEventListener('wheel', (e) => {
  if (active === -1) return;
  e.preventDefault();
  const s = stickers[active];
  const delta = -Math.sign(e.deltaY) * 0.08; // 위로 휠 = 확대
  s.scale = clamp(s.scale + delta, 0.1, 6);
  render();
}, { passive: false });

window.addEventListener('keydown', (e) => {
  if (active === -1) return;
  const s = stickers[active];
  if (e.key === '[') { s.rot -= Math.PI / 90; render(); }
  else if (e.key === ']') { s.rot += Math.PI / 90; render(); }
  else if (e.key === 'Delete' || e.key === 'Backspace') {
    stickers.splice(active, 1);
    active = -1;
    render();
  }
});

// ===== UI 버튼(모바일 보조/공통) =====
btnZoomIn?.addEventListener('click', () => {
  if (active === -1) return;
  const s = stickers[active];
  s.scale = clamp(s.scale + 0.1, 0.1, 6);
  render();
});
btnZoomOut?.addEventListener('click', () => {
  if (active === -1) return;
  const s = stickers[active];
  s.scale = clamp(s.scale - 0.1, 0.1, 6);
  render();
});
btnRotL?.addEventListener('click', () => {
  if (active === -1) return;
  stickers[active].rot -= Math.PI / 24;
  render();
});
btnRotR?.addEventListener('click', () => {
  if (active === -1) return;
  stickers[active].rot += Math.PI / 24;
  render();
});
deleteBtn?.addEventListener('click', () => {
  if (active !== -1) {
    stickers.splice(active, 1);
    active = -1;
    render();
  }
});

// ===== 선택 표시 제외하고 내보내기(오프스크린 캔버스) =====
function exportImageToDataURL() {
  // 1) 오프스크린 준비: 현재 내부 해상도와 동일
  const off = document.createElement('canvas');
  off.width = canvas.width;
  off.height = canvas.height;
  const offCtx = off.getContext('2d');

  // 2) 화면과 동일한 좌표계 세팅
  const dpr = canvas.width / cssSize.w; // 내부픽셀 / CSS픽셀
  offCtx.setTransform(dpr, 0, 0, dpr, 0, 0);

  // 3) 선택표시 없이 그리기
  drawScene(offCtx, { showSelection: false });

  // 4) PNG DataURL 반환
  return off.toDataURL('image/png');
}

// ===== 저장/공유 =====
downloadBtn?.addEventListener('click', () => {
  if (!background) return alert('먼저 배경 이미지를 업로드하세요.');
  const url = exportImageToDataURL();
  const a = document.createElement('a');
  a.href = url;
  a.download = 'stickered.png';
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent);
  if (isIOS) window.open(url, '_blank'); // iOS 대안
  else a.click();
});

openNewTabBtn?.addEventListener('click', () => {
  if (!background) return alert('먼저 배경 이미지를 업로드하세요.');
  const url = exportImageToDataURL();
  window.open(url, '_blank'); // iOS에서도 롱프레스로 저장 가능
});

// ===== 초기화 =====
function handleResize() {
  applyDPR();
  render();
}
window.addEventListener('resize', handleResize);

applyDPR();
buildGallery().then(render);
