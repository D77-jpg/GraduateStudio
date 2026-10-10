"use client";

import { useCallback, useEffect, useRef, useState } from "react";

/**
 * ER 图画布:把 sql2er 生成的 SVG 变成可交互、可整理的画布。
 * - 自动整理布局:实体按「关系远近」分层排成整齐的列(组件内 BFS 分层,多组件纵向堆叠),
 *   属性椭圆跟随所属实体,关系菱形放到两实体中点;加载时自动执行,工具栏可再次整理。
 * - 滚轮缩放(以光标为锚点)、拖空白平移、拖节点微调(快照式回写,连线与文字跟随)。
 * - 导出 PNG / SVG:按当前内容包围盒裁切,手动调整不会被裁掉。
 */

type NodeType = "entity" | "attribute" | "relationship";

interface ErNode {
  el: SVGGraphicsElement;
  type: NodeType;
  cx: number;
  cy: number;
  texts: SVGGraphicsElement[];
  lines: Array<{ el: SVGLineElement; end: 1 | 2 }>;
  extras: Array<SVGGraphicsElement>;
}

interface LineInfo {
  el: SVGLineElement;
  labels: Array<{ el: SVGGraphicsElement; dx: number; dy: number }>;
}

interface NodeSnapshot {
  node: ErNode;
  rect?: { x: number; y: number };
  ellipse?: { cx: number; cy: number };
  polygonPoints?: Array<{ x: number; y: number }>;
  texts: Array<{ el: SVGGraphicsElement; x: number; y: number }>;
  lines: Array<{ el: SVGLineElement; end: 1 | 2; x1: number; y1: number; x2: number; y2: number }>;
  labels: Array<{ el: SVGGraphicsElement; x: number; y: number }>;
  extras: Array<{
    el: SVGGraphicsElement;
    kind: "path" | "line";
    x1: number;
    y1: number;
    x2: number;
    y2: number;
  }>;
}

interface DragState {
  kind: "node" | "pan";
  snapshot?: NodeSnapshot;
  origin: { x: number; y: number };
  startClient: { x: number; y: number };
  startView: { x: number; y: number };
}

function centerOf(el: SVGGraphicsElement): { x: number; y: number } {
  if (el instanceof SVGRectElement) {
    return {
      x: el.x.baseVal.value + el.width.baseVal.value / 2,
      y: el.y.baseVal.value + el.height.baseVal.value / 2,
    };
  }
  if (el instanceof SVGEllipseElement) {
    return { x: el.cx.baseVal.value, y: el.cy.baseVal.value };
  }
  if (el instanceof SVGPolygonElement) {
    const pts = el.points;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < pts.numberOfItems; i++) {
      const p = pts.getItem(i);
      sx += p.x;
      sy += p.y;
    }
    return { x: sx / pts.numberOfItems, y: sy / pts.numberOfItems };
  }
  const b = el.getBBox();
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
}

function attrNum(el: Element, name: string): number {
  return parseFloat(el.getAttribute(name) ?? "0") || 0;
}

export function ErCanvas({ svg }: { svg: string }) {
  const containerRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const nodesRef = useRef<ErNode[]>([]);
  const linesRef = useRef<LineInfo[]>([]);
  const viewRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
  const dragRef = useRef<DragState | null>(null);
  const tidyRef = useRef<(() => void) | null>(null);
  const [zoom, setZoom] = useState(100);

  const applyView = useCallback(() => {
    const v = viewRef.current;
    const svgEl = svgRef.current;
    if (v && svgEl) {
      svgEl.setAttribute("viewBox", `${v.x} ${v.y} ${v.w} ${v.h}`);
      const base = parseFloat(svgEl.dataset.contentWidth ?? "1");
      setZoom(Math.round((base / v.w) * 100));
    }
  }, []);

  const fitToContent = useCallback(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return;
    // 排除背景大矩形,否则视口永远等于原始尺寸
    const bg = svgEl.querySelector("rect[fill='#ffffff'], rect[fill='#fff']");
    let bx = Infinity,
      by = Infinity,
      bx2 = -Infinity,
      by2 = -Infinity;
    for (const child of [...svgEl.children]) {
      if (child === bg) continue;
      const b = (child as SVGGraphicsElement).getBBox();
      bx = Math.min(bx, b.x);
      by = Math.min(by, b.y);
      bx2 = Math.max(bx2, b.x + b.width);
      by2 = Math.max(by2, b.y + b.height);
    }
    if (!isFinite(bx)) return;
    const pad = 60;
    viewRef.current = { x: bx - pad, y: by - pad, w: bx2 - bx + pad * 2, h: by2 - by + pad * 2 };
    svgEl.dataset.contentWidth = String(bx2 - bx + pad * 2);
    applyView();
  }, [applyView]);

  const zoomBy = useCallback(
    (factor: number) => {
      const v = viewRef.current;
      const svgEl = svgRef.current;
      if (!v || !svgEl) return;
      const base = parseFloat(svgEl.dataset.contentWidth ?? "1");
      const nw = Math.min(base * 3, Math.max(base * 0.06, v.w / factor));
      const ratio = nw / v.w;
      const cx = v.x + v.w / 2;
      const cy = v.y + v.h / 2;
      v.w = nw;
      v.h = v.h * ratio;
      v.x = cx - v.w / 2;
      v.y = cy - v.h / 2;
      applyView();
    },
    [applyView],
  );

  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const doc = new DOMParser().parseFromString(svg, "image/svg+xml");
    const svgEl = document.importNode(
      doc.documentElement as unknown as SVGSVGElement,
      true,
    ) as SVGSVGElement;
    svgEl.setAttribute("width", "100%");
    svgEl.setAttribute("height", "100%");
    svgEl.style.display = "block";
    container.replaceChildren(svgEl);
    svgRef.current = svgEl;

    // 分类节点
    const nodes: ErNode[] = [];
    const labelBgs: SVGRectElement[] = [];
    const bgRect = svgEl.querySelector("rect[fill='#ffffff'], rect[fill='#fff']");
    for (const child of [...svgEl.children] as SVGGraphicsElement[]) {
      if (child === bgRect) continue;
      if (child instanceof SVGRectElement) {
        // 小于 30px 的白色方块是基数标签(1/N)的底衬,不是实体
        if (+child.getAttribute("width")! < 30 && +child.getAttribute("height")! < 30) {
          labelBgs.push(child);
          continue;
        }
        const c = centerOf(child);
        nodes.push({
          el: child,
          type: "entity",
          cx: c.x,
          cy: c.y,
          texts: [],
          lines: [],
          extras: [],
        });
        child.dataset.erNode = "entity";
      } else if (child instanceof SVGEllipseElement) {
        const c = centerOf(child);
        nodes.push({
          el: child,
          type: "attribute",
          cx: c.x,
          cy: c.y,
          texts: [],
          lines: [],
          extras: [],
        });
        child.dataset.erNode = "attribute";
      } else if (child instanceof SVGPolygonElement) {
        const c = centerOf(child);
        nodes.push({
          el: child,
          type: "relationship",
          cx: c.x,
          cy: c.y,
          texts: [],
          lines: [],
          extras: [],
        });
        child.dataset.erNode = "relationship";
      }
    }

    // 自引用关系是 <path> 贝塞尔环:起点(或终点)落在实体中心 → 挂到该实体
    const pathExtras: Array<{ el: SVGPathElement; entity: ErNode }> = [];
    const loopPathEntity = new Map<SVGPathElement, ErNode>();
    for (const child of [...svgEl.children] as SVGGraphicsElement[]) {
      if (!(child instanceof SVGPathElement)) continue;
      const d = child.getAttribute("d") ?? "";
      const m = d.match(/M\s*([\d.-]+)[\s,]+([\d.-]+)/);
      if (!m) continue;
      const mx = parseFloat(m[1]);
      const my = parseFloat(m[2]);
      const owner = nodes.find((n) => n.type === "entity" && Math.hypot(n.cx - mx, n.cy - my) < 3);
      if (owner) {
        owner.extras.push(child);
        pathExtras.push({ el: child, entity: owner });
        loopPathEntity.set(child, owner);
        continue;
      }
      // 回程半弧:M 点不在实体中心(在环的外侧)→ 按包围盒中心就近挂到实体
      const bb = child.getBBox();
      const bc = { x: bb.x + bb.width / 2, y: bb.y + bb.height / 2 };
      const nearest = [...nodes]
        .filter((n) => n.type === "entity")
        .sort(
          (a, b) => Math.hypot(a.cx - bc.x, a.cy - bc.y) - Math.hypot(b.cx - bc.x, b.cy - bc.y),
        )[0];
      if (nearest && Math.hypot(nearest.cx - bc.x, nearest.cy - bc.y) < 900) {
        nearest.extras.push(child);
        loopPathEntity.set(child, nearest);
      }
    }

    // 连线并关联端点所属节点(端点与节点中心精确重合)
    const lines: LineInfo[] = [];
    for (const child of [...svgEl.children]) {
      if (!(child instanceof SVGLineElement)) continue;
      const line: LineInfo = { el: child, labels: [] };
      const x1 = attrNum(child, "x1");
      const y1 = attrNum(child, "y1");
      const x2 = attrNum(child, "x2");
      const y2 = attrNum(child, "y2");
      for (const node of nodes) {
        if (Math.hypot(x1 - node.cx, y1 - node.cy) < 2) {
          node.lines.push({ el: child, end: 1 });
        } else if (Math.hypot(x2 - node.cx, y2 - node.cy) < 2) {
          node.lines.push({ el: child, end: 2 });
        }
      }
      // 两端都落在同一节点 bbox 内的短线(PK 下划线等装饰)→ 整距跟随该节点
      const attached = nodes.some((n) => n.lines.some((l) => l.el === child));
      if (!attached) {
        const inside = nodes.filter((n) => {
          const nb = n.el.getBBox();
          const p1 =
            x1 >= nb.x - 2 &&
            x1 <= nb.x + nb.width + 2 &&
            y1 >= nb.y - 2 &&
            y1 <= nb.y + nb.height + 2;
          const p2 =
            x2 >= nb.x - 2 &&
            x2 <= nb.x + nb.width + 2 &&
            y2 >= nb.y - 2 &&
            y2 <= nb.y + nb.height + 2;
          return p1 && p2;
        });
        if (inside.length > 0) {
          inside[0].extras.push(child);
          lines.pop();
          continue;
        }
        // 短线且两端都不在任何节点内(自环标签下划线等)→ 就近节点整距跟随
        const len = Math.hypot(x2 - x1, y2 - y1);
        if (len < 200) {
          const mx = (x1 + x2) / 2;
          const my = (y1 + y2) / 2;
          const nearest = [...nodes].sort(
            (a, b) => Math.hypot(a.cx - mx, a.cy - my) - Math.hypot(b.cx - mx, b.cy - my),
          )[0];
          if (nearest && Math.hypot(nearest.cx - mx, nearest.cy - my) < 400) {
            nearest.extras.push(child);
            lines.pop();
            continue;
          }
        }
      }
      lines.push(line);
    }
    linesRef.current = lines;
    nodesRef.current = nodes;

    // 文本与连线不拦截指针
    for (const child of [...svgEl.children]) {
      if (child.tagName === "text" || child instanceof SVGLineElement) {
        (child as SVGGraphicsElement).style.pointerEvents = "none";
      }
    }

    // 文本归属:中心落在节点内的归节点,否则归最近连线(基数 1/N)
    for (const child of [...svgEl.children]) {
      if (child.tagName !== "text") continue;
      const text = child as SVGGraphicsElement;
      const b = text.getBBox();
      const tc = { x: b.x + b.width / 2, y: b.y + b.height / 2 };
      let owner: ErNode | null = null;
      for (const node of nodes) {
        const nb = node.el.getBBox();
        if (
          tc.x >= nb.x - 4 &&
          tc.x <= nb.x + nb.width + 4 &&
          tc.y >= nb.y - 4 &&
          tc.y <= nb.y + nb.height + 4
        ) {
          owner = node;
          break;
        }
      }
      if (owner) {
        owner.texts.push(text);
        continue;
      }
      let best: { line: LineInfo; dist: number } | null = null;
      for (const line of lines) {
        const mx = (attrNum(line.el, "x1") + attrNum(line.el, "x2")) / 2;
        const my = (attrNum(line.el, "y1") + attrNum(line.el, "y2")) / 2;
        const dist = Math.hypot(mx - tc.x, my - tc.y);
        if (!best || dist < best.dist) best = { line, dist };
      }
      if (best && best.dist < 120) {
        const mx = (attrNum(best.line.el, "x1") + attrNum(best.line.el, "x2")) / 2;
        const my = (attrNum(best.line.el, "y1") + attrNum(best.line.el, "y2")) / 2;
        best.line.labels.push({ el: text, dx: tc.x - mx, dy: tc.y - my });
      }
    }

    // 标签底衬矩形挂到对应连线(点到线段距离 ≤ 25px),移动时与文字同步
    for (const bg of labelBgs) {
      const cx = +bg.getAttribute("x")! + +bg.getAttribute("width")! / 2;
      const cy = +bg.getAttribute("y")! + +bg.getAttribute("height")! / 2;
      let best: { line: LineInfo; dist: number } | null = null;
      for (const line of lines) {
        const ax = attrNum(line.el, "x1");
        const ay = attrNum(line.el, "y1");
        const bx = attrNum(line.el, "x2");
        const by = attrNum(line.el, "y2");
        const abx = bx - ax;
        const aby = by - ay;
        const lenSq = abx * abx + aby * aby;
        const t =
          lenSq === 0 ? 0 : Math.max(0, Math.min(1, ((cx - ax) * abx + (cy - ay) * aby) / lenSq));
        const dist = Math.hypot(cx - (ax + abx * t), cy - (ay + aby * t));
        if (!best || dist < best.dist) best = { line, dist };
      }
      if (best && best.dist < 25) {
        best.line.labels.push({ el: bg, dx: 0, dy: 0 });
      }
      // 未挂上的底衬直接移除(残留原位会撑大内容包围盒,导致视野缩小与导出裁切)
      if (!best || best.dist >= 25) {
        bg.remove();
      }
    }

    const captureSnapshot = (node: ErNode): NodeSnapshot => {
      const snap: NodeSnapshot = { node, texts: [], lines: [], labels: [], extras: [] };
      if (node.el instanceof SVGRectElement) {
        snap.rect = { x: node.el.x.baseVal.value, y: node.el.y.baseVal.value };
      } else if (node.el instanceof SVGEllipseElement) {
        snap.ellipse = { cx: node.el.cx.baseVal.value, cy: node.el.cy.baseVal.value };
      } else if (node.el instanceof SVGPolygonElement) {
        const pts = node.el.points;
        snap.polygonPoints = [...Array(pts.numberOfItems)].map((_, i) => {
          const p = pts.getItem(i);
          return { x: p.x, y: p.y };
        });
      }
      for (const t of node.texts) {
        snap.texts.push({ el: t, x: attrNum(t, "x"), y: attrNum(t, "y") });
      }
      for (const lineRef of node.lines) {
        const info = lines.find((l) => l.el === lineRef.el);
        snap.lines.push({
          el: lineRef.el,
          end: lineRef.end,
          x1: attrNum(lineRef.el, "x1"),
          y1: attrNum(lineRef.el, "y1"),
          x2: attrNum(lineRef.el, "x2"),
          y2: attrNum(lineRef.el, "y2"),
        });
        if (info) {
          for (const label of info.labels) {
            snap.labels.push({
              el: label.el,
              x: attrNum(label.el, "x"),
              y: attrNum(label.el, "y"),
            });
          }
        }
      }
      for (const extra of node.extras) {
        if (extra instanceof SVGPathElement) {
          snap.extras.push({ el: extra, kind: "path", x1: 0, y1: 0, x2: 0, y2: 0 });
        } else if (extra instanceof SVGLineElement) {
          snap.extras.push({
            el: extra,
            kind: "line",
            x1: attrNum(extra, "x1"),
            y1: attrNum(extra, "y1"),
            x2: attrNum(extra, "x2"),
            y2: attrNum(extra, "y2"),
          });
        }
      }
      return snap;
    };

    const applyNodeDelta = (snap: NodeSnapshot, dx: number, dy: number) => {
      const node = snap.node;
      if (snap.rect && node.el instanceof SVGRectElement) {
        node.el.setAttribute("x", String(snap.rect.x + dx));
        node.el.setAttribute("y", String(snap.rect.y + dy));
      } else if (snap.ellipse && node.el instanceof SVGEllipseElement) {
        node.el.setAttribute("cx", String(snap.ellipse.cx + dx));
        node.el.setAttribute("cy", String(snap.ellipse.cy + dy));
      } else if (snap.polygonPoints && node.el instanceof SVGPolygonElement) {
        node.el.setAttribute(
          "points",
          snap.polygonPoints.map((p) => `${p.x + dx},${p.y + dy}`).join(" "),
        );
      }
      for (const t of snap.texts) {
        t.el.setAttribute("x", String(t.x + dx));
        t.el.setAttribute("y", String(t.y + dy));
      }
      for (const l of snap.lines) {
        if (l.end === 1) {
          l.el.setAttribute("x1", String(l.x1 + dx));
          l.el.setAttribute("y1", String(l.y1 + dy));
        } else {
          l.el.setAttribute("x2", String(l.x2 + dx));
          l.el.setAttribute("y2", String(l.y2 + dy));
        }
      }
      for (const label of snap.labels) {
        label.el.setAttribute("x", String(label.x + dx / 2));
        label.el.setAttribute("y", String(label.y + dy / 2));
      }
      for (const extra of snap.extras) {
        if (extra.kind === "path") {
          extra.el.setAttribute("transform", `translate(${dx},${dy})`);
        } else {
          extra.el.setAttribute("x1", String(extra.x1 + dx));
          extra.el.setAttribute("y1", String(extra.y1 + dy));
          extra.el.setAttribute("x2", String(extra.x2 + dx));
          extra.el.setAttribute("y2", String(extra.y2 + dy));
        }
      }
      node.cx += dx;
      node.cy += dy;
    };

    // ===== 自动整理布局:实体按 BFS 分层成列,属性跟随,菱形居中 =====
    const tidyLayout = () => {
      try {
        const entities = nodes.filter((n) => n.type === "entity");
        const diamonds = nodes.filter((n) => n.type === "relationship");
        const attrs = nodes.filter((n) => n.type === "attribute");
        const pos = new Map<ErNode, { x: number; y: number }>();
        for (const n of [...entities, ...attrs, ...diamonds]) pos.set(n, centerOf(n.el));
        const findEntityAt = (x: number, y: number) =>
          entities.find((e) => Math.hypot(pos.get(e)!.x - x, pos.get(e)!.y - y) < 3) ?? null;

        // 属性归属
        const attrOwner = new Map<ErNode, ErNode>();
        for (const a of attrs) {
          const l = a.lines[0];
          if (!l) continue;
          const other =
            l.end === 1
              ? { x: attrNum(l.el, "x2"), y: attrNum(l.el, "y2") }
              : { x: attrNum(l.el, "x1"), y: attrNum(l.el, "y1") };
          const owner = findEntityAt(other.x, other.y);
          if (owner) attrOwner.set(a, owner);
        }

        // 菱形连接的两个实体(端点匹配失败时兜底最近实体;完全失败则跳过该菱形)
        const diamondPair = new Map<ErNode, [ErNode, ErNode]>();
        for (const d of diamonds) {
          const others = d.lines
            .map((l) => {
              const other =
                l.end === 1
                  ? { x: attrNum(l.el, "x2"), y: attrNum(l.el, "y2") }
                  : { x: attrNum(l.el, "x1"), y: attrNum(l.el, "y1") };
              return (
                findEntityAt(other.x, other.y) ??
                [...entities].sort(
                  (p, q) =>
                    Math.hypot(pos.get(p)!.x - other.x, pos.get(p)!.y - other.y) -
                    Math.hypot(pos.get(q)!.x - other.x, pos.get(q)!.y - other.y),
                )[0] ??
                null
              );
            })
            .filter((e): e is ErNode => Boolean(e));
          if (others.length >= 2) {
            diamondPair.set(d, [others[0], others[1]]);
          } else if (others.length === 1) {
            diamondPair.set(d, [others[0], others[0]]);
          } else {
            // 自环菱形:它的连接是 <path> 弧而非 <line>;sql2er 布局中自环总是
            // 紧贴所属实体,按原始位置就近归属
            const dc = pos.get(d)!;
            const nearest = [...entities].sort(
              (a, b) =>
                Math.hypot(pos.get(a)!.x - dc.x, pos.get(a)!.y - dc.y) -
                Math.hypot(pos.get(b)!.x - dc.x, pos.get(b)!.y - dc.y),
            )[0];
            if (nearest) {
              diamondPair.set(d, [nearest, nearest]);
            }
          }
        }

        // 连通分量(实体经菱形相连)
        const compId = new Map<ErNode, number>();
        const components: ErNode[][] = [];
        for (const e of entities) {
          if (compId.has(e)) continue;
          const id = components.length;
          const comp = [e];
          compId.set(e, id);
          const queue = [e];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            for (const d of diamonds) {
              const pair = diamondPair.get(d);
              if (!pair) continue;
              const neighbor = pair[0] === cur ? pair[1] : pair[1] === cur ? pair[0] : null;
              if (neighbor && !compId.has(neighbor)) {
                compId.set(neighbor, id);
                comp.push(neighbor);
                queue.push(neighbor);
              }
            }
          }
          components.push(comp);
        }

        const entityLines = (e: ErNode) => e.lines.length;
        const COL_GAP = 320;
        const ROW_GAP = 170;

        // 每个组件的布局目标
        interface Placement {
          node: ErNode;
          target: { x: number; y: number };
        }
        const placements: Placement[] = [];
        let compTop = Math.min(...entities.map((e) => pos.get(e)!.y)) - 40;

        for (const comp of components) {
          // 根 = 连线最多的实体;BFS 无向分层
          const root = [...comp].sort((a, b) => entityLines(b) - entityLines(a))[0];
          const depth = new Map<ErNode, number>([[root, 0]]);
          const queue = [root];
          while (queue.length > 0) {
            const cur = queue.shift()!;
            const cd = depth.get(cur)!;
            for (const d of diamonds) {
              const pair = diamondPair.get(d);
              if (!pair) continue;
              const neighbor = pair[0] === cur ? pair[1] : pair[1] === cur ? pair[0] : null;
              if (neighbor && !depth.has(neighbor)) {
                depth.set(neighbor, cd + 1);
                queue.push(neighbor);
              }
            }
          }
          const columns = new Map<number, ErNode[]>();
          for (const e of comp) {
            const d = depth.get(e) ?? 0;
            if (!columns.has(d)) columns.set(d, []);
            columns.get(d)!.push(e);
          }
          const sortedCols = [...columns.keys()].sort((a, b) => a - b);
          // 列宽
          const colWidths = sortedCols.map((d) =>
            Math.max(...columns.get(d)!.map((e) => e.el.getBBox().width)),
          );
          const colX = new Map<number, number>();
          let x = 0;
          sortedCols.forEach((d, i) => {
            colX.set(d, x);
            x += colWidths[i] + COL_GAP;
          });
          const maxColHeight = Math.max(
            ...sortedCols.map((d) => {
              const list = columns.get(d)!;
              return list.reduce((sum, e) => sum + e.el.getBBox().height + ROW_GAP, -ROW_GAP);
            }),
          );
          let compPlacedAny = false;
          for (const d of sortedCols) {
            const list = [...columns.get(d)!].sort((a, b) => pos.get(a)!.y - pos.get(b)!.y);
            const colH = list.reduce((sum, e) => sum + e.el.getBBox().height + ROW_GAP, -ROW_GAP);
            let y = compTop + (maxColHeight - colH) / 2;
            for (const e of list) {
              const h = e.el.getBBox().height;
              const w = e.el.getBBox().width;
              placements.push({
                node: e,
                target: { x: colX.get(d)! + w / 2, y: y + h / 2 },
              });
              y += h + ROW_GAP;
              compPlacedAny = true;
            }
          }
          if (compPlacedAny) compTop += maxColHeight + 300;
        }

        // 应用实体位移
        const newCenter = new Map<ErNode, { x: number; y: number }>();
        for (const p of placements) {
          const cur = pos.get(p.node)!;
          const dx = p.target.x - cur.x;
          const dy = p.target.y - cur.y;
          applyNodeDelta(captureSnapshot(p.node), dx, dy);
          newCenter.set(p.node, { ...p.target });
        }

        // 属性跟随所属实体
        for (const a of attrs) {
          const owner = attrOwner.get(a);
          if (!owner) continue;
          const oc = newCenter.get(owner) ?? pos.get(owner)!;
          const dx = oc.x - pos.get(owner)!.x;
          const dy = oc.y - pos.get(owner)!.y;
          if (dx || dy) applyNodeDelta(captureSnapshot(a), dx, dy);
        }

        // 菱形放到两实体中点(自环放实体右侧)
        for (const d of diamonds) {
          const pair = diamondPair.get(d);
          if (!pair || !pair[0] || !pair[1]) continue;
          const curPos = pos.get(d)!;
          const a = newCenter.get(pair[0]) ?? pos.get(pair[0])!;
          const b = newCenter.get(pair[1]) ?? pos.get(pair[1])!;
          let target;
          if (pair[0] === pair[1]) {
            const eb = pair[0].el.getBBox();
            target = { x: a.x + eb.width / 2 + 110, y: a.y - 60 };
          } else {
            target = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
          }
          applyNodeDelta(captureSnapshot(d), target.x - curPos.x, target.y - curPos.y);
        }
        fitToContent();
      } catch (err) {
        console.error("[er-canvas] tidy layout failed:", err);
      }
    };
    tidyRef.current = tidyLayout;
    tidyLayout();

    // ===== 交互 =====
    const toSvgPoint = (clientX: number, clientY: number) => {
      const ctm = svgEl.getScreenCTM();
      if (!ctm) return { x: 0, y: 0 };
      const pt = new DOMPoint(clientX, clientY).matrixTransform(ctm.inverse());
      return { x: pt.x, y: pt.y };
    };

    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const v = viewRef.current;
      if (!v) return;
      const p = toSvgPoint(event.clientX, event.clientY);
      const factor = Math.exp(-event.deltaY * 0.0015);
      const base = parseFloat(svgEl.dataset.contentWidth ?? "1");
      const nw = Math.min(base * 3, Math.max(base * 0.06, v.w / factor));
      const ratio = nw / v.w;
      v.x = p.x - (p.x - v.x) * ratio;
      v.y = p.y - (p.y - v.y) * ratio;
      v.w = nw;
      v.h = v.h * ratio;
      applyView();
    };

    const onPointerDown = (event: PointerEvent) => {
      const target = event.target as Element;
      const nodeEl = target.closest("[data-er-node]");
      const p = toSvgPoint(event.clientX, event.clientY);
      if (nodeEl) {
        const node = nodesRef.current.find((n) => n.el === nodeEl);
        if (node) {
          dragRef.current = {
            kind: "node",
            snapshot: captureSnapshot(node),
            origin: { x: p.x, y: p.y },
            startClient: { x: event.clientX, y: event.clientY },
            startView: { ...viewRef.current! },
          };
          svgEl.style.cursor = "grabbing";
          svgEl.setPointerCapture(event.pointerId);
          event.preventDefault();
          return;
        }
      }
      dragRef.current = {
        kind: "pan",
        origin: { x: p.x, y: p.y },
        startClient: { x: event.clientX, y: event.clientY },
        startView: { ...viewRef.current! },
      };
      svgEl.setPointerCapture(event.pointerId);
    };

    const onPointerMove = (event: PointerEvent) => {
      const drag = dragRef.current;
      if (!drag) return;
      if (drag.kind === "pan") {
        const v = viewRef.current!;
        const svgW = svgEl.clientWidth || 1;
        const svgH = svgEl.clientHeight || 1;
        v.x = drag.startView.x - (event.clientX - drag.startClient.x) * (v.w / svgW);
        v.y = drag.startView.y - (event.clientY - drag.startClient.y) * (v.h / svgH);
        applyView();
        return;
      }
      const p = toSvgPoint(event.clientX, event.clientY);
      applyNodeDelta(drag.snapshot!, p.x - drag.origin.x, p.y - drag.origin.y);
    };

    const onPointerUp = (event: PointerEvent) => {
      dragRef.current = null;
      svgEl.style.cursor = "";
      try {
        svgEl.releasePointerCapture(event.pointerId);
      } catch {
        /* 指针已释放 */
      }
    };

    svgEl.addEventListener("wheel", onWheel, { passive: false });
    svgEl.addEventListener("pointerdown", onPointerDown);
    svgEl.addEventListener("pointermove", onPointerMove);
    svgEl.addEventListener("pointerup", onPointerUp);
    svgEl.addEventListener("pointercancel", onPointerUp);
    svgEl.style.touchAction = "none";
    svgEl.style.userSelect = "none";

    // 调试信标:捕获页面 JS 错误(排查渲染进程崩溃)
    const onError = (event: ErrorEvent) => {
      try {
        localStorage.setItem("erWindowError", String(event.message).slice(0, 300));
      } catch {
        /* 忽略 */
      }
    };
    window.addEventListener("error", onError);

    return () => {
      window.removeEventListener("error", onError);
      svgEl.removeEventListener("wheel", onWheel);
      svgEl.removeEventListener("pointerdown", onPointerDown);
      svgEl.removeEventListener("pointermove", onPointerMove);
      svgEl.removeEventListener("pointerup", onPointerUp);
      svgEl.removeEventListener("pointercancel", onPointerUp);
    };
  }, [svg, applyView, fitToContent]);

  const download = useCallback((blob: Blob, filename: string) => {
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }, []);

  /** 序列化当前内容(含手动调整),按内容包围盒裁切,不丢元素 */
  const serializeContent = useCallback(() => {
    const svgEl = svgRef.current;
    if (!svgEl) return null;
    const bg = svgEl.querySelector("rect[fill='#ffffff'], rect[fill='#fff']");
    let bx = Infinity,
      by = Infinity,
      bx2 = -Infinity,
      by2 = -Infinity;
    for (const child of [...svgEl.children]) {
      if (child === bg) continue;
      const b = (child as SVGGraphicsElement).getBBox();
      bx = Math.min(bx, b.x);
      by = Math.min(by, b.y);
      bx2 = Math.max(bx2, b.x + b.width);
      by2 = Math.max(by2, b.y + b.height);
    }
    if (!isFinite(bx)) return null;
    const pad = 40;
    const clone = svgEl.cloneNode(true) as SVGSVGElement;
    clone.setAttribute(
      "viewBox",
      `${bx - pad} ${by - pad} ${bx2 - bx + pad * 2} ${by2 - by + pad * 2}`,
    );
    clone.setAttribute("width", String(Math.round(bx2 - bx + pad * 2)));
    clone.setAttribute("height", String(Math.round(by2 - by + pad * 2)));
    clone.removeAttribute("style");
    return {
      text: new XMLSerializer().serializeToString(clone),
      w: Math.round(bx2 - bx + pad * 2),
      h: Math.round(by2 - by + pad * 2),
    };
  }, []);

  const exportSvg = useCallback(() => {
    const out = serializeContent();
    if (!out) return;
    download(new Blob([out.text], { type: "image/svg+xml;charset=utf-8" }), "概念ER图.svg");
  }, [download, serializeContent]);

  const exportPng = useCallback(() => {
    const out = serializeContent();
    if (!out) return;
    const blob = new Blob([out.text], { type: "image/svg+xml;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => {
      const scale = 2;
      const canvas = document.createElement("canvas");
      canvas.width = out.w * scale;
      canvas.height = out.h * scale;
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      canvas.toBlob((png) => {
        if (png) download(png, "概念ER图.png");
      }, "image/png");
      URL.revokeObjectURL(url);
    };
    img.src = url;
  }, [download, serializeContent]);

  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-1 rounded-md border border-zinc-200 p-1 dark:border-zinc-700">
          <button
            type="button"
            onClick={() => zoomBy(1.25)}
            className="h-7 w-7 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="放大"
          >
            ＋
          </button>
          <span className="w-12 text-center text-xs tabular-nums text-zinc-500 dark:text-zinc-400">
            {zoom}%
          </span>
          <button
            type="button"
            onClick={() => zoomBy(0.8)}
            className="h-7 w-7 rounded-lg text-sm text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="缩小"
          >
            －
          </button>
          <button
            type="button"
            onClick={fitToContent}
            className="rounded-lg px-2 py-1 text-xs text-zinc-600 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800"
            title="适应内容"
          >
            适应
          </button>
        </div>
        <button
          type="button"
          onClick={() => tidyRef.current?.()}
          className="rounded-lg border border-violet-300 px-3 py-1.5 text-xs font-medium text-violet-700 hover:bg-violet-50 dark:border-violet-500/40 dark:text-violet-300 dark:hover:bg-violet-500/10"
          title="实体按关系分层排列成整齐的列"
        >
          整理布局
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={exportPng}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-white dark:text-zinc-900"
          >
            导出 PNG
          </button>
          <button
            type="button"
            onClick={exportSvg}
            className="rounded-lg border border-zinc-200 px-3 py-1.5 text-xs font-medium text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-800"
          >
            导出 SVG
          </button>
        </div>
        <span className="text-[11px] text-zinc-400">
          滚轮缩放 · 拖空白平移 · 拖节点微调(连线与文字自动跟随)· 导出按内容完整裁切不丢元素
        </span>
      </div>

      <div
        ref={containerRef}
        className="mt-3 h-[72vh] overflow-hidden rounded-lg border border-zinc-200 bg-white dark:border-zinc-800 dark:bg-white [&_[data-er-node]]:cursor-grab"
      />
    </div>
  );
}
