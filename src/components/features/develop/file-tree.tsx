"use client";

import { useMemo, useState } from "react";
import type { FileNodeDto } from "@/lib/develop";
import { FileCodeIcon, FolderIcon, FolderOpenIcon } from "@/components/icons";

interface TreeNode {
  name: string;
  path: string;
  type: "file" | "dir";
  children: TreeNode[];
}

function buildTree(nodes: FileNodeDto[]): TreeNode[] {
  const root: TreeNode = { name: "", path: "", type: "dir", children: [] };
  for (const node of nodes) {
    const segments = node.path.split("/");
    let current = root;
    for (let i = 0; i < segments.length; i++) {
      const isLast = i === segments.length - 1;
      const path = segments.slice(0, i + 1).join("/");
      let child = current.children.find((c) => c.name === segments[i] && c.path === path);
      if (!child) {
        child = {
          name: segments[i],
          path,
          type: isLast ? node.type : "dir",
          children: [],
        };
        current.children.push(child);
      }
      current = child;
    }
  }
  const sortRecursive = (items: TreeNode[]): TreeNode[] => {
    items.sort((a, b) =>
      a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1,
    );
    items.forEach((item) => sortRecursive(item.children));
    return items;
  };
  return sortRecursive(root.children);
}

function TreeItem({
  node,
  depth,
  collapsed,
  activePath,
  onToggle,
  onOpen,
}: {
  node: TreeNode;
  depth: number;
  collapsed: Set<string>;
  activePath: string | null;
  onToggle: (path: string) => void;
  onOpen: (path: string) => void;
}) {
  // 目录默认展开,collapsed 集合记录被手动折叠的目录
  const isOpen = !collapsed.has(node.path);
  const active = node.type === "file" && node.path === activePath;

  return (
    <div>
      <button
        type="button"
        onClick={() => (node.type === "dir" ? onToggle(node.path) : onOpen(node.path))}
        className={`flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-left text-[13px] transition-colors ${
          active
            ? "bg-violet-600/10 font-medium text-violet-700 dark:text-violet-300"
            : "text-zinc-700 hover:bg-zinc-100 dark:text-zinc-300 dark:hover:bg-zinc-800/70"
        }`}
        style={{ paddingLeft: `${8 + depth * 14}px` }}
        title={node.path}
      >
        {node.type === "dir" ? (
          isOpen ? (
            <FolderOpenIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          ) : (
            <FolderIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
          )
        ) : (
          <FileCodeIcon className="h-3.5 w-3.5 shrink-0 text-zinc-400" />
        )}
        <span className="truncate">{node.name}</span>
      </button>
      {node.type === "dir" && isOpen
        ? node.children.map((child) => (
            <TreeItem
              key={child.path}
              node={child}
              depth={depth + 1}
              collapsed={collapsed}
              activePath={activePath}
              onToggle={onToggle}
              onOpen={onOpen}
            />
          ))
        : null}
    </div>
  );
}

export function FileTree({
  tree,
  activePath,
  onOpen,
}: {
  tree: FileNodeDto[];
  activePath: string | null;
  onOpen: (path: string) => void;
}) {
  const nodes = useMemo(() => buildTree(tree), [tree]);
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  return (
    <div className="min-h-0 flex-1 overflow-y-auto py-2">
      {nodes.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-zinc-400">工作区为空</p>
      ) : (
        nodes.map((node) => (
          <TreeItem
            key={node.path}
            node={node}
            depth={0}
            collapsed={collapsed}
            activePath={activePath}
            onToggle={(path) =>
              setCollapsed((prev) => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              })
            }
            onOpen={onOpen}
          />
        ))
      )}
    </div>
  );
}
