import { useEffect, useRef, type RefObject } from 'react';
import type { DndGameView } from 'shared';

/**
 * 棋盤上的「動感」：走路與受擊震動。
 *
 * 伺服器送的是快照，棋子換格子時前端只會看到牠憑空出現在新位置。
 * 這裡把前後兩張快照比一比，自己補上中間的過程 —— 純視覺，不碰任何規則，
 * 也不需要伺服器多送東西（走的路徑是前端自己編的，伺服器只給起點與終點）。
 *
 * 作法是 FLIP：棋子已經被 React 畫在**終點**格了，我們用 transform 把牠推回
 * 起點，再沿著逐格路徑動回 0。所以動畫期間格子要暫時解除 overflow 裁切。
 */

/** 走路速度：每秒 4 格 */
const CELL_MS = 250;
/** 一次移動最多演這麼久 —— 鎖鏈拉過半場也不該讓人乾等 */
const MAX_WALK_MS = 2000;
/** 超過這個距離視為傳送（重生、放逐歸位），直接出現不用走 */
const TELEPORT_CELLS = 12;
/** 受擊震動的長度 */
const HIT_MS = 260;

/** 受擊：抖三下再加一層紅光，讓「這一下打中了」看得出來 */
const HIT_FRAMES: Keyframe[] = [
  { transform: 'translate(0, 0)', filter: 'none' },
  { transform: 'translate(-3px, 1px)', filter: 'brightness(1.9) drop-shadow(0 0 5px rgba(231, 76, 60, 0.95))' },
  { transform: 'translate(3px, -2px)', filter: 'brightness(1.9) drop-shadow(0 0 5px rgba(231, 76, 60, 0.95))' },
  { transform: 'translate(-2px, 1px)', filter: 'brightness(1.4) drop-shadow(0 0 4px rgba(231, 76, 60, 0.7))' },
  { transform: 'translate(2px, 0)', filter: 'none' },
  { transform: 'translate(0, 0)', filter: 'none' },
];

type Placement = { r: number; c: number; hp: number };

/**
 * 動畫期間把格子的裁切解除並墊高，否則棋子走出自己那一格就會被切掉。
 * 用行內樣式而不是 class：React 每次 render 都會重寫 className，但它的
 * style diff 是逐鍵比對的，overflow／zIndex 不在它的 style prop 裡，就不會被抹掉。
 * 同一格可能同時有走路與受擊兩段動畫，所以要記次數，最後一個結束才還原。
 */
const liftCount = new WeakMap<HTMLElement, number>();

function liftCell(el: HTMLElement): () => void {
  const cell = el.closest<HTMLElement>('.dnd-cell');
  if (!cell) return () => {};
  const n = (liftCount.get(cell) ?? 0) + 1;
  liftCount.set(cell, n);
  cell.style.overflow = 'visible';
  cell.style.zIndex = '5';
  return () => {
    const left = (liftCount.get(cell) ?? 1) - 1;
    if (left > 0) {
      liftCount.set(cell, left);
      return;
    }
    liftCount.delete(cell);
    cell.style.overflow = '';
    cell.style.zIndex = '';
  };
}

/**
 * 從起點走到終點的逐格路徑（不含起點）。
 * 每一步先補還差得比較多的那個軸，走出來是斜向的階梯，
 * 比「先走完橫的再走直的」那種 L 形自然得多。
 */
function walkPath(r0: number, c0: number, r1: number, c1: number): Array<{ r: number; c: number }> {
  const path: Array<{ r: number; c: number }> = [];
  let r = r0;
  let c = c0;
  while ((r !== r1 || c !== c1) && path.length < 64) {
    const dr = r1 - r;
    const dc = c1 - c;
    if (dr !== 0 && (Math.abs(dr) >= Math.abs(dc) || dc === 0)) r += Math.sign(dr);
    else c += Math.sign(dc);
    path.push({ r, c });
  }
  return path;
}

/** 一格在畫面上有多寬多高（含 grid 的 gap）。量兩個相鄰格子的差就好，不用去猜 CSS。 */
function cellStep(boardEl: HTMLElement, cols: number): { x: number; y: number } | null {
  const first = boardEl.children[0] as HTMLElement | undefined;
  const right = boardEl.children[1] as HTMLElement | undefined;
  const down = boardEl.children[cols] as HTMLElement | undefined;
  if (!first || !right || !down) return null;
  const base = first.getBoundingClientRect();
  const x = right.getBoundingClientRect().left - base.left;
  const y = down.getBoundingClientRect().top - base.top;
  return x > 0 && y > 0 ? { x, y } : null;
}

/** 掃出這張快照裡每顆棋子的位置與血量 */
function placementsOf(game: DndGameView): Map<string, Placement> {
  const map = new Map<string, Placement>();
  for (let r = 0; r < game.board.length; r++) {
    const row = game.board[r];
    if (!row) continue;
    for (let c = 0; c < row.length; c++) {
      const piece = row[c]?.piece;
      if (piece) map.set(piece.id, { r, c, hp: piece.hp });
    }
  }
  return map;
}

/** 同一顆棋子的圖示與血條在 DOM 上是兩個元素，要一起動才不會分家 */
function elementsByPiece(boardEl: HTMLElement): Map<string, HTMLElement[]> {
  const map = new Map<string, HTMLElement[]>();
  for (const el of boardEl.querySelectorAll<HTMLElement>('[data-piece-id]')) {
    const id = el.dataset.pieceId;
    if (!id) continue;
    const list = map.get(id);
    if (list) list.push(el);
    else map.set(id, [el]);
  }
  return map;
}

export function useDndMotion(
  boardRef: RefObject<HTMLDivElement | null>,
  game: DndGameView | null | undefined,
): void {
  const prev = useRef<{ level: number; round: number; pieces: Map<string, Placement> } | null>(null);
  const running = useRef(new Map<string, Animation[]>());

  useEffect(() => {
    if (!game) {
      prev.current = null;
      return;
    }
    const pieces = placementsOf(game);
    const before = prev.current;
    prev.current = { level: game.level, round: game.roundCount, pieces };

    // 換樓層時全員重生、重開一局時輪數會倒退 —— 這兩種都不是「走過去」
    if (!before || before.level !== game.level || game.roundCount < before.round) return;

    const boardEl = boardRef.current;
    if (!boardEl) return;
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;

    const step = cellStep(boardEl, game.board[0]?.length ?? 0);
    if (!step) return;
    const elements = elementsByPiece(boardEl);

    for (const [id, at] of pieces) {
      const was = before.pieces.get(id);
      if (!was) continue;
      const els = elements.get(id);
      if (!els) continue;

      const distance = Math.abs(at.r - was.r) + Math.abs(at.c - was.c);
      const walking = distance > 0 && distance <= TELEPORT_CELLS;
      const hurt = at.hp < was.hp;
      if (!walking && !hurt) continue;

      // 上一段還沒演完就被新的快照追上時，直接接手，不要疊在一起抖
      for (const anim of running.current.get(id) ?? []) anim.cancel();
      const started: Animation[] = [];

      let walkMs = 0;
      if (walking) {
        const path = walkPath(was.r, was.c, at.r, at.c);
        walkMs = Math.min(path.length * CELL_MS, MAX_WALK_MS);
        const frames = [{ r: was.r, c: was.c }, ...path].map((p) => ({
          transform: `translate(${(p.c - at.c) * step.x}px, ${(p.r - at.r) * step.y}px)`,
        }));
        for (const el of els) {
          const restore = liftCell(el);
          const anim = el.animate(frames, { duration: walkMs, easing: 'linear' });
          anim.finished.then(restore, restore);
          started.push(anim);
        }
      }

      // 走到一半才挨打（踩到火牆之類）就等走完再抖，兩段 transform 疊在一起會互相蓋掉
      if (hurt) {
        for (const el of els) {
          const restore = liftCell(el);
          const anim = el.animate(HIT_FRAMES, { duration: HIT_MS, delay: walkMs, easing: 'ease-out' });
          anim.finished.then(restore, restore);
          started.push(anim);
        }
      }

      running.current.set(id, started);
    }
  }, [game, boardRef]);

  // 離開棋桌時把還在跑的動畫收乾淨，免得 finished 的還原跑在已卸載的節點上
  useEffect(() => {
    const animations = running.current;
    return () => {
      for (const list of animations.values()) for (const anim of list) anim.cancel();
      animations.clear();
    };
  }, []);
}
