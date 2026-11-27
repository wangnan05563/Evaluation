/* ===== M9/FR-3.3（UI03）：复核列表虚拟滚动——div 行池 + 固定窗口，避免 <table> 整表布局 ===== */
const CT = { rowH: 44, over: 0, threshold: 120, liteLimit: 1000 };   // 行高 / 视口外余量 / 虚拟化阈值 / 紧凑只读阈值
let CT_SC = null, CT_VPH = 600;
const CT_TPL = document.createElement("template");
function ctScrollParent(el) {
  if (CT_SC && CT_SC.contains(el)) { if (!CT_VPH) { CT_VPH = CT_SC.clientHeight || 600; } return CT_SC; }   // 缓存：滚动容器/视口高每帧不再强制布局
  let p = el && el.parentElement;
  while (p) { const cs = getComputedStyle(p); if (/(auto|scroll)/.test(cs.overflowY)) { CT_SC = p; if (p.clientHeight > 0) { CT_VPH = p.clientHeight; } return p; } p = p.parentElement; }
  return null;
}
function ctWindow(total, scrollTop, viewportH) {
  const first = Math.max(0, Math.floor(scrollTop / CT.rowH) - CT.over);
  const count = Math.min(total - first, Math.ceil(viewportH / CT.rowH) + CT.over * 2);
  return { first, count };
}
function ctRowNode(rowHtmlFn, it, cur, showbSet) {
  const html = rowHtmlFn(it).replace("class=\"rowr", `class="rowr ${it.seq === cur ? "cur" : ""} ${showbSet && showbSet.has(it.seq) ? "showb" : ""}"`);
  CT_TPL.innerHTML = html;
  return CT_TPL.content.firstElementChild;
}
/* 虚拟渲染：body 高度=总行高，行节点绝对定位；固定 ~20 个节点，滚动只更新进出窗口的行。 */
function _ctAnchorWindow(arr, cur, first, count) {
  if (cur == null) return { first, count };
  const idx = arr.findIndex(x => x.seq === cur);
  if (idx < 0) return { first, count };
  if (idx < first) first = Math.max(0, idx - CT.over);
  else if (idx >= first + count) { first = Math.min(arr.length - 1, idx - count + 4); count = Math.min(arr.length - first, count); }
  return { first, count };
}
function _ctEnsureRows(body) {
  const rows = body.__ctRows;
  if (rows && body.contains(rows)) return rows;
  const fresh = document.createElement("div");
  fresh.className = "ct-rows"; fresh.setAttribute("role", "presentation");
  body.appendChild(fresh); body.__ctRows = fresh;
  return fresh;
}
function _ctPruneSlots(map, firstSeq, lastSeq) {
  for (const [seq, slot] of map) {
    if (seq < firstSeq || seq > lastSeq) { slot.el.remove(); map.delete(seq); }
  }
}
function _ctSlotMark(it, cur, showbSet) {
  return it.seq + "|" + (it.seq === cur ? "c" : "") + "|" + (showbSet && showbSet.has(it.seq) ? "s" : "") + "|" + (it.ok ? "d" : "");
}
function _ctEnsureSlot(map, it, newEls) {
  let slot = map.get(it.seq);
  if (slot) return slot;
  const el = document.createElement("div");
  el.className = "rowr";
  slot = { el, mark: "" };
  map.set(it.seq, slot);
  newEls.push(el);
  return slot;
}
function _ctUpdateSlot(slot, it, cur, showbSet, rowHtmlFn) {
  const mark = _ctSlotMark(it, cur, showbSet);
  if (slot.mark === mark) return;
  const fresh = ctRowNode(rowHtmlFn, it, cur, showbSet);
  for (const a of fresh.attributes) slot.el.setAttribute(a.name, a.value);
  slot.el.innerHTML = fresh.innerHTML;
  slot.mark = mark;
}
function _ctOrderBad(rows, map, arr, first, count) {
  if (rows.children.length !== count) return true;
  for (let i = 0; i < count; i++) {
    const it = arr[first + i], el = map.get(it.seq).el;
    if (rows.children[i] !== el) return true;
  }
  return false;
}
function _ctFixOrder(rows, map, arr, first, count) {
  const frag = document.createDocumentFragment();
  for (let i = 0; i < count; i++) frag.appendChild(map.get(arr[first + i].seq).el);
  rows.replaceChildren(frag);
}
function ctRenderVirtual(body, arr, rowHtmlFn, cur, showbSet) {
  const sc = ctScrollParent(body);
  const vpH = sc ? ((CT_VPH || sc.clientHeight) || 600) : 600;
  const st = sc ? sc.scrollTop : 0;
  let { first, count } = ctWindow(arr.length, st, vpH);
  ({ first, count } = _ctAnchorWindow(arr, cur, first, count));
  body.classList.add("virtual");
  const totalH = arr.length * CT.rowH;
  if (body.__ctTotalH !== totalH) { body.__ctTotalH = totalH; body.style.height = totalH + "px"; }
  const rows = _ctEnsureRows(body);
  const map = rows.__map || (rows.__map = new Map());
  const firstSeq = arr[first] ? arr[first].seq : -1;
  const lastSeq = arr[first + count - 1] ? arr[first + count - 1].seq : -1;
  _ctPruneSlots(map, firstSeq, lastSeq);
  const newEls = [];
  for (let i = 0; i < count; i++) {
    const it = arr[first + i];
    const slot = _ctEnsureSlot(map, it, newEls);
    _ctUpdateSlot(slot, it, cur, showbSet, rowHtmlFn);
  }
  if (newEls.length) {
    const frag = document.createDocumentFragment();
    for (const el of newEls) frag.appendChild(el);
    rows.appendChild(frag);
  }
  if (_ctOrderBad(rows, map, arr, first, count)) _ctFixOrder(rows, map, arr, first, count);
  if (rows.__first !== first) { rows.__first = first; rows.style.transform = `translateY(${first * CT.rowH}px)`; }
  if (sc && !body.__ctReflow && sc.clientHeight > 0 && sc.clientHeight !== vpH) {
    body.__ctReflow = 1;
    requestAnimationFrame(() => { body.__ctReflow = 0; if (sc.clientHeight > 0 && sc.clientHeight !== vpH) { CT_VPH = sc.clientHeight; render({ light: true }); } });
  }
  return { first, count };
}
function ctBindScroll(body, onWin) {
  const sc = ctScrollParent(body);
  if (!sc || sc.dataset.ctBound) return;
  sc.dataset.ctBound = "1";
  let raf = 0;
  sc.addEventListener("scroll", () => { if (!raf) raf = requestAnimationFrame(() => { raf = 0; onWin(); }); }, { passive: true });
}
